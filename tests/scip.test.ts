import { ScipCallGraph } from "../src/infrastructure/scip/scip-call-graph.js";
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
      { line: 0, symbol: S("A#"), roles: 1, column: 0, endColumn: 5 },
      { line: 3, symbol: S("B#run()."), roles: 0, column: 0, endColumn: 5 },
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

describe("locals in an index", () => {
  // An occurrence at given columns (the helper above always writes columns 0 to 5).
  const occAt = (line: number, from: number, to: number, symbol: string, def = false) =>
    bytes(2, [...bytes(1, [...varint(line), ...varint(from), ...varint(to)]), ...str(2, symbol), ...(def ? num(3, 1) : [])]);

  it("a variable on a function's first lines is not the function; a nested function is", async () => {
    const source = "def outer():\n    app = make()\n    def inner():\n        app.run()\n    inner()\n";
    const scip = decodeScip(
      index(
        doc("a.py", [
          occAt(0, 4, 9, "scip-python python . . a/outer().", true),
          occAt(1, 4, 7, "local 1", true), // app
          occAt(2, 8, 13, "local 2", true), // inner: indexers give nested functions a local symbol
          occAt(3, 8, 11, "local 1"), // inner reads app
          occAt(4, 4, 9, "local 2"), // outer calls inner
        ]),
      ),
    );
    const langs = await loadLanguageSupport();
    const files = [{ path: "a.py", source }];
    const ids = langs.listSymbols(files).get("a.py")!.map((s) => `a.py#${s.name}`);
    const inner = ids.find((id) => id.endsWith("inner"))!;
    const edges = new ScipCallGraph(scip, [], langs.listSymbols)
      .build({ files, changedIds: ids, removed: [], depth: 1 })
      .edges.map((e) => `${e.from} -> ${e.to}`);
    expect(edges).toEqual([`a.py#outer -> ${inner}`]);
  });
});

describe("a Rust index (rust-analyzer)", () => {
  const occAt = (line: number, from: number, to: number, symbol: string, def = false) =>
    bytes(2, [...bytes(1, [...varint(line), ...varint(from), ...varint(to)]), ...str(2, symbol), ...(def ? num(3, 1) : [])]);
  const R = (desc: string) => `rust-analyzer cargo app 0.1.0 ${desc}`;

  // `s` could be any Store: only the compiler knows `run` reaches Store::save and not Cache::save.
  const source = [
    "pub trait Store {", //                 1
    "    fn save(&self);", //               2
    "}", //                                 3
    "pub struct Disk;", //                  4
    "impl Store for Disk {", //             5
    "    fn save(&self) {", //              6
    "        let n = 1;", //                7
    "    }", //                             8
    "}", //                                 9
    "pub struct Cache;", //                 10
    "impl Cache {", //                      11
    "    pub fn save(&self) {}", //         12
    "}", //                                 13
    "pub fn run<S: Store>(s: &S) {", //     14
    "    s.save();", //                     15
    "}", //                                 16
    "",
  ].join("\n");
  // What rust-analyzer writes: definitions, the call in `run`, and no "implements" relationships.
  const scip = decodeScip(
    index(
      doc("src/lib.rs", [
        occAt(0, 10, 15, R("Store#"), true),
        occAt(1, 7, 11, R("Store#save()."), true),
        occAt(3, 11, 15, R("Disk#"), true),
        occAt(4, 5, 10, R("Store#")),
        occAt(4, 15, 19, R("Disk#")),
        occAt(5, 7, 11, R("impl#[Disk][Store]save()."), true),
        occAt(6, 12, 13, "local 1", true),
        occAt(9, 11, 16, R("Cache#"), true),
        occAt(10, 5, 10, R("Cache#")),
        occAt(11, 11, 15, R("impl#[Cache]save()."), true),
        occAt(13, 7, 10, R("run()."), true),
        occAt(13, 14, 19, R("Store#")),
        occAt(14, 6, 10, R("Store#save().")),
      ]),
    ),
  );

  it("links calls exactly and keeps the trait's implementations", async () => {
    const langs = await loadLanguageSupport();
    const files = [{ path: "src/lib.rs", source }];
    const graph = withIndex(langs, scip).graphs.find((g) => g.supportedExtensions.includes(".rs"))!;
    expect(graph.isExact?.("src/lib.rs")).toBe(true);
    const id = (name: string) => `src/lib.rs#${name}`;
    const edges = (changed: string) =>
      graph
        .build({ files, changedIds: [id(changed)], removed: [], depth: 1 })
        .edges.map((e) => `${e.from.split("#")[1]} ${e.kind} ${e.to.split("#")[1]}`)
        .sort();
    // The trait's method changed: its caller, and the method that implements it. Not Cache.save.
    expect(edges("Store.save")).toEqual(["Disk.save implements Store.save", "run calls Store.save"]);
    // The implementation changed: who calls the trait method reaches it.
    expect(edges("Disk.save")).toEqual(["Disk.save implements Store.save", "run calls Store.save"]);
    // Same name, other type: nobody calls it.
    expect(edges("Cache.save")).toEqual([]);
  });
});

