import { extname } from "node:path";
import type { CallGraphInput, CallGraphPort, CallGraphResult } from "../../application/ports/call-graph.port.js";
import { CallCollector, walkNeighbourhood } from "../../application/call-graph-walk.js";
import { innermostAtLine } from "../../application/symbol-mapping.js";
import type { GraphEdge, GraphNode } from "../../domain/graph.js";
import type { SymbolInfo, SymbolKind } from "../../domain/symbol.js";
import { ROLE_DEFINITION, ROLE_IMPORT, isLocal, symbolName, type ScipIndex } from "./scip-index.js";

export interface ListedSymbol extends SymbolInfo {
  labels?: string[];
}

/** Finds diffmap's symbols (functions, classes...) in many files at once. */
export type ListSymbols = (files: { path: string; source: string }[]) => Map<string, ListedSymbol[]>;

const simple = (name: string): string => name.split(".").pop()!;

const TYPE_ONLY = new Set<SymbolKind>(["interface", "enum", "struct", "trait"]);

/** "...Svc#`<constructor>`()." -> "...Svc#": a constructor call counts as a use of its class. */
const ownerOfConstructor = (symbol: string): string | null => {
  const m = symbol.match(/^(.*[#.])`?<?(constructor|init)>?`?\(\)\.$/);
  return m ? m[1] : null;
};

/**
 * Exact call graph from a SCIP index made by a compiler-based indexer in CI.
 * Files the index covers are linked from its definitions and references
 * (including "implements" relationships); every other file falls back to the
 * usual builders. Calls into removed code always come from the fallbacks,
 * since the index is made from the new code, where that code no longer exists.
 */
export class ScipCallGraph implements CallGraphPort {
  readonly supportedExtensions: readonly string[];

  constructor(
    private readonly index: ScipIndex,
    private readonly fallbacks: CallGraphPort[],
    private readonly listSymbols: ListSymbols,
  ) {
    const exts = new Set(fallbacks.flatMap((f) => f.supportedExtensions));
    for (const d of index.documents) exts.add(extname(d.path).toLowerCase());
    this.supportedExtensions = [...exts];
  }

  isExact(path: string): boolean {
    return (
      this.index.documents.some((d) => d.path === path) ||
      this.fallbacks.some((f) => f.supportedExtensions.includes(extname(path).toLowerCase()) && f.isExact?.(path) === true)
    );
  }

  build(input: CallGraphInput): CallGraphResult {
    const docs = new Map(this.index.documents.map((d) => [d.path, d]));
    const mine = input.files.filter((f) => docs.has(f.path));
    const rest = input.files.filter((f) => !docs.has(f.path));

    // ── symbols of indexed files ──
    const listed = this.listSymbols(mine);
    const meta = new Map<string, GraphNode>();
    const linesOf = new Map<string, string[]>();
    const symbolsIn = new Map<string, (ListedSymbol & { id: string })[]>();
    for (const f of mine) {
      linesOf.set(f.path, f.source.split("\n").map((l) => l.replace(/\r$/, "")));
      const list: (ListedSymbol & { id: string })[] = [];
      for (const s of listed.get(f.path) ?? []) {
        const id = `${f.path}#${s.name}`;
        if (meta.has(id)) continue;
        meta.set(id, { id, file: f.path, name: s.name, kind: s.kind, changed: false, line: s.range.start, endLine: s.range.end, labels: s.labels ?? [] });
        list.push({ ...s, id });
      }
      symbolsIn.set(f.path, list);
    }

    // ── which diffmap symbol each SCIP definition belongs to ──
    // Local symbols ("local 3") are only unique inside one file, so they are keyed by file.
    const keyOf = (path: string, symbol: string) => (isLocal(symbol) ? `${path}|${symbol}` : symbol);
    const nodeOf = new Map<string, string>(); // SCIP symbol -> diffmap id
    const resolve = (path: string, symbol: string): string | undefined => {
      const direct = nodeOf.get(keyOf(path, symbol));
      if (direct) return direct;
      const owner = ownerOfConstructor(symbol);
      return owner ? nodeOf.get(owner) : undefined;
    };
    for (const f of mine) {
      for (const o of docs.get(f.path)!.occurrences) {
        if (!(o.roles & ROLE_DEFINITION) || nodeOf.has(keyOf(f.path, o.symbol))) continue;
        const line = o.line + 1;
        const sym = innermostAtLine(symbolsIn.get(f.path) ?? [], line);
        if (!sym) continue;
        const header = line - sym.range.start <= 3; // the name sits in the first lines (after decorators)
        // A local has no name in SCIP; read it from the code, so that a variable or
        // parameter on the symbol's first lines is not taken for the symbol itself.
        const written = o.endColumn === undefined ? undefined : linesOf.get(f.path)![o.line]?.slice(o.column, o.endColumn);
        if (isLocal(o.symbol) && written !== undefined && /^[\x20-\x7e]*$/.test(linesOf.get(f.path)![o.line]) && written !== simple(sym.name)) continue;
        const name = isLocal(o.symbol) ? null : symbolName(o.symbol);
        // Only the symbol's own name counts, not a field or variable defined inside it.
        // Locals have no name in SCIP: accept them on the symbol's first lines.
        if (name === simple(sym.name) || (header && (name === null || /^(<init>|<constructor>|constructor|__init__|init)$/.test(name)))) {
          nodeOf.set(keyOf(f.path, o.symbol), sym.id);
        }
      }
    }

    // ── references -> edges ──
    const collector = new CallCollector();
    for (const f of mine) {
      const doc = docs.get(f.path)!;
      const lines = linesOf.get(f.path)!;
      for (const o of doc.occurrences) {
        if (o.roles & (ROLE_DEFINITION | ROLE_IMPORT)) continue;
        const to = resolve(f.path, o.symbol);
        // Mentioning an interface or enum as a type is not "using" it; only implementing counts.
        if (!to || TYPE_ONLY.has(meta.get(to)!.kind)) continue;
        const from = innermostAtLine(symbolsIn.get(f.path) ?? [], o.line + 1)?.id;
        if (from) collector.add(from, to, "calls", o.line + 1, lines[o.line] ?? "");
      }
      for (const s of doc.symbols) {
        const from = resolve(f.path, s.symbol);
        if (!from) continue;
        const line = meta.get(from)!.line;
        for (const target of s.implements) {
          const to = resolve(f.path, target);
          if (to) collector.add(from, to, "implements" as GraphEdge["kind"], line, lines[line - 1] ?? "");
        }
      }
    }
    const exact = walkNeighbourhood({ meta, linesOf, calls: collector.calls, changedIds: input.changedIds, depth: input.depth });

    // ── everything else from the usual builders ──
    // They see every file (so calls into indexed code still resolve) but only
    // report calls made from files the index does not cover, plus calls into
    // removed code, which the index (made from the new code) cannot know.
    const nodes = new Map(exact.nodes.map((n) => [n.id, n]));
    const edges = [...exact.edges];
    const restPaths = new Set(rest.map((f) => f.path));
    for (const fb of this.fallbacks) {
      const files = input.files.filter((f) => fb.supportedExtensions.includes(extname(f.path).toLowerCase()));
      if (!files.some((f) => restPaths.has(f.path)) && input.removed.length === 0) continue;
      const r = fb.build({ ...input, files });
      const byId = new Map(r.nodes.map((n) => [n.id, n]));
      for (const e of r.edges) {
        const fromFile = byId.get(e.from)?.file ?? e.from.split("#")[0];
        if (e.kind !== "calls-removed" && !restPaths.has(fromFile)) continue;
        edges.push(e);
        for (const id of [e.from, e.to]) {
          const n = byId.get(id);
          if (n && !nodes.has(id)) nodes.set(id, n);
        }
      }
    }
    return { nodes: [...nodes.values()], edges };
  }
}
