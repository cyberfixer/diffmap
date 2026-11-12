/**
 * Reads SCIP indexes (https://github.com/sourcegraph/scip): the "who defines and
 * who uses which symbol" files that compiler-based indexers write
 * (scip-typescript, scip-java, scip-clang, rust-analyzer, ...). Only the fields diffmap needs
 * are decoded; the format is protobuf, read here by hand to avoid a dependency.
 *
 * Several index files can simply be concatenated (`cat a.scip b.scip`):
 * protobuf merges them into one index with all documents.
 */

export const ROLE_DEFINITION = 1;
export const ROLE_IMPORT = 2;

export interface ScipOccurrence {
  line: number; // 0-based, as in SCIP
  /** Where on the line it is written (0-based, end not included), when it sits on one line. */
  column?: number;
  endColumn?: number;
  symbol: string;
  roles: number;
}

export interface ScipSymbol {
  symbol: string;
  implements: string[]; // symbols this one implements (is_implementation relationships)
}

export interface ScipDocument {
  path: string; // relative to the project root
  occurrences: ScipOccurrence[];
  symbols: ScipSymbol[];
}

export interface ScipIndex {
  documents: ScipDocument[];
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}

  done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.end) throw new Error("SCIP: truncated varint");
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 63) throw new Error("SCIP: bad varint");
    }
  }

  /** A length-delimited field as a sub-reader over the same bytes. */
  sub(): Reader {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error("SCIP: truncated field");
    const r = new Reader(this.buf, this.pos);
    r.pos = start;
    return r;
  }

  string(): string {
    const r = this.sub();
    return new TextDecoder().decode(this.buf.subarray(r.pos, r.end));
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint(); // read first: `pos += varint()` would use the old pos
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`SCIP: unsupported wire type ${wire}`);
  }

  /** Each field as [number, wireType]; the caller reads or skips its value. */
  *fields(): Generator<[number, number]> {
    while (!this.done()) {
      const tag = this.varint();
      yield [Math.floor(tag / 8), tag & 7];
    }
  }
}

function readInts(r: Reader, wire: number, into: number[]): void {
  if (wire === 2) {
    const s = r.sub();
    while (!s.done()) into.push(s.varint());
  } else into.push(r.varint());
}

function readOccurrence(r: Reader): ScipOccurrence | null {
  const range: number[] = [];
  let symbol = "";
  let roles = 0;
  for (const [f, w] of r.fields()) {
    if (f === 1) readInts(r, w, range);
    else if (f === 2 && w === 2) symbol = r.string();
    else if (f === 3 && w === 0) roles = r.varint();
    else r.skip(w);
  }
  if (range.length < 3 || !symbol) return null;
  // [line, start, end] on one line, or [line, start, endLine, end].
  const endColumn = range.length === 3 ? range[2] : range[2] === range[0] ? range[3] : undefined;
  return { line: range[0], symbol, roles, ...(endColumn !== undefined ? { column: range[1], endColumn } : {}) };
}

function readSymbol(r: Reader): ScipSymbol {
  const out: ScipSymbol = { symbol: "", implements: [] };
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) out.symbol = r.string();
    else if (f === 4 && w === 2) {
      // Relationship { 1: symbol, 3: is_implementation }
      const rel = r.sub();
      let sym = "";
      let impl = false;
      for (const [rf, rw] of rel.fields()) {
        if (rf === 1 && rw === 2) sym = rel.string();
        else if (rf === 3 && rw === 0) impl = rel.varint() !== 0;
        else rel.skip(rw);
      }
      if (impl && sym) out.implements.push(sym);
    } else r.skip(w);
  }
  return out;
}

function readDocument(r: Reader): ScipDocument {
  const doc: ScipDocument = { path: "", occurrences: [], symbols: [] };
  for (const [f, w] of r.fields()) {
    if (f === 1 && w === 2) doc.path = r.string();
    else if (f === 2 && w === 2) {
      const o = readOccurrence(r.sub());
      if (o) doc.occurrences.push(o);
    } else if (f === 3 && w === 2) doc.symbols.push(readSymbol(r.sub()));
    else r.skip(w);
  }
  return doc;
}

/** Decode one or more concatenated SCIP index files. */
export function decodeScip(buf: Uint8Array): ScipIndex {
  const r = new Reader(buf);
  const documents: ScipDocument[] = [];
  for (const [f, w] of r.fields()) {
    if (f === 2 && w === 2) documents.push(readDocument(r.sub()));
    else r.skip(w);
  }
  // The same file may appear in two indexes (e.g. two indexer runs): merge them.
  const byPath = new Map<string, ScipDocument>();
  for (const d of documents) {
    const prev = byPath.get(d.path);
    if (!prev) byPath.set(d.path, d);
    else {
      prev.occurrences.push(...d.occurrences);
      prev.symbols.push(...d.symbols);
    }
  }
  return { documents: [...byPath.values()] };
}

/** True for SCIP symbols that are local to one file (parameters, local variables). */
export const isLocal = (symbol: string): boolean => symbol.startsWith("local ");

/**
 * The name at the end of a SCIP symbol:
 * "scip-typescript npm app 1.0 src/`auth.ts`/AuthService#login()." -> "login",
 * "... com/acme/Svc#`<init>`()." -> "<init>".
 */
export function symbolName(symbol: string): string {
  const parts = [...symbol.matchAll(/(`[^`]+`|[\w$<>-]+)(\([^)]*\))?[#./:!\]]?/g)].map((m) => m[1].replace(/`/g, ""));
  return parts[parts.length - 1] ?? "";
}
