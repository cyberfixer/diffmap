import { describe, it, expect, afterEach } from "vitest";
import { decodeScip, symbolName } from "../src/infrastructure/scip/scip-index.js";
import { loadLanguageSupport, withIndex } from "../src/infrastructure/language-support.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";

// ── a tiny SCIP (protobuf) writer, so tests can state exactly what an indexer would emit ──
const varint = (n: number): number[] => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
};
const bytes = (field: number, data: number[]) => [...varint(field * 8 + 2), ...varint(data.length), ...data];
const str = (field: number, s: string) => bytes(field, [...new TextEncoder().encode(s)]);
const num = (field: number, n: number) => [...varint(field * 8), ...varint(n)];

const occ = (line: number, symbol: string, def = false) =>
  bytes(2, [...bytes(1, [...varint(line), ...varint(0), ...varint(5)]), ...str(2, symbol), ...(def ? num(3, 1) : [])]);
const info = (symbol: string, implementsSym?: string) =>
  bytes(3, [...str(1, symbol), ...(implementsSym ? bytes(4, [...str(1, implementsSym), ...num(3, 1)]) : [])]);
const doc = (path: string, parts: number[][]) => bytes(2, [...str(1, path), ...parts.flat()]);
const index = (...docs: number[][]) => new Uint8Array([...str(1, "metadata-ignored"), ...docs.flat()]);

const S = (desc: string) => `scip-java maven . . ${desc}`;

describe("decodeScip", () => {
  it("reads documents, definitions, references and implements links", () => {
    const idx = decodeScip(index(doc("A.java", [occ(0, S("A#"), true), occ(3, S("B#run()."))]), doc("B.java", [info(S("B#"), S("P#"))])));
    expect(idx.documents.map((d) => d.path)).toEqual(["A.java", "B.java"]);
    expect(idx.documents[0].occurrences).toEqual([
      { line: 0, symbol: S("A#"), roles: 1 },
      { line: 3, symbol: S("B#run()."), roles: 0 },
    ]);
    expect(idx.documents[1].symbols).toEqual([{ symbol: S("B#"), implements: [S("P#")] }]);
  });

  it("merges concatenated index files", () => {
    const a = index(doc("A.java", [occ(0, S("A#"), true)]));
    const b = index(doc("A.java", [occ(5, S("A#x()."))]), doc("C.java", []));
    const idx = decodeScip(new Uint8Array([...a, ...b]));
    expect(idx.documents.map((d) => [d.path, d.occurrences.length])).toEqual([["A.java", 2], ["C.java", 0]]);
  });

  it("finds the name at the end of a symbol", () => {
    expect(symbolName("scip-typescript npm app 1.0.0 src/`auth.ts`/AuthService#login().")).toBe("login");
    expect(symbolName("scip-java maven com.acme svc 1.0 com/acme/Svc#`<init>`().")).toBe("<init>");
    expect(symbolName("scip-clang cxx . . app/Svc#update(abc123).")).toBe("update");
    expect(symbolName("scip-typescript npm app 1.0.0 src/`types.ts`/Status#Active.")).toBe("Active");
  });
});

describe("exact calls from an index", () => {
  let repo: FixtureRepo | null = null;
  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  const P = "interface P {\n  void update();\n}\n";
  const A = (body: string) => `class A implements P {\n  public void update() {\n    ${body}\n  }\n}\n`;
  const B = (body: string) => `class B {\n  void update() {\n    ${body}\n  }\n}\n`;
  // The variable's type isn't written down, so only a compiler (the index) knows it is an A.
  // `a` has no written-down type, so name matching can't tell A.update from B.update.
  const USE = "class Use {\n  void run() {\n    Factory.each(a ->\n    a.update());\n  }\n}\n";

  // What scip-java would write for the new code: Use.run calls A.update, A.update implements P.update.
  const scip = index(
    doc("P.java", [occ(0, S("P#"), true), occ(1, S("P#update()."), true)]),
    doc("A.java", [occ(0, S("A#"), true), occ(0, S("P#")), occ(1, S("A#update()."), true), info(S("A#update()."), S("P#update()."))]),
    doc("B.java", [occ(0, S("B#"), true), occ(1, S("B#update()."), true)]),
    doc("Use.java", [occ(0, S("Use#"), true), occ(1, S("Use#run()."), true), occ(3, S("A#update()."))]),
  );

  async function analyse(withScip: boolean) {
    repo = createFixtureRepo();
    repo.write("P.java", P);
    repo.write("A.java", A("int x = 1;"));
    repo.write("B.java", B("int y = 1;"));
    repo.write("Use.java", USE);
    repo.commit("initial");
    repo.write("A.java", A("int x = 2;"));
    repo.write("B.java", B("int y = 2;"));
    repo.write("P.java", "interface P {\n  void update(); // changed\n}\n");
    repo.commit("change");
    const langs = withIndex(await loadLanguageSupport(), withScip ? decodeScip(scip) : null);
    return new AnalyzeRangeUseCase(new GitDiffReader(repo.dir), new GitSourceReader(repo.dir), langs.parsers, langs.graphs).execute("HEAD~1", "HEAD");
  }

  const into = (r: Awaited<ReturnType<typeof analyse>>, id: string) =>
    r.edges.filter((e) => e.to === id).map((e) => `${e.kind} ${e.from}`).sort();

  it("without an index, a.update() is linked to every update() (name matching)", async () => {
    const r = await analyse(false);
    expect(into(r, "A.java#A.update")).toContain("calls Use.java#Use.run");
    expect(into(r, "B.java#B.update")).toContain("calls Use.java#Use.run");
    expect(r.exactness).toEqual({ exact: 0, total: 3 });
  });

  it("with an index, a.update() is linked only to A.update, and A implements P", async () => {
    const r = await analyse(true);
    expect(into(r, "A.java#A.update")).toEqual(["calls Use.java#Use.run"]);
    expect(into(r, "B.java#B.update")).toEqual([]);
    expect(into(r, "P.java#P.update")).toEqual(["implements A.java#A.update"]);
    expect(r.edges.find((e) => e.to === "A.java#A.update")!.sites).toEqual([{ line: 4, text: "    a.update());" }]);
    expect(r.exactness).toEqual({ exact: 3, total: 3 });
  });
});
