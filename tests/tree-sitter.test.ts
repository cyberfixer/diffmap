import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { TreeSitterEngine } from "../src/infrastructure/parsers/tree-sitter/engine.js";
import { TreeSitterCallGraph } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-call-graph.js";
import { TreeSitterHighlighter } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-highlighter.js";
import { loadLanguageSupport } from "../src/infrastructure/language-support.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";

let engine: TreeSitterEngine;
beforeAll(async () => {
  engine = await TreeSitterEngine.load();
});

const names = (path: string, src: string) => engine.symbols(path, src).map((s) => `${s.kind} ${s.name} ${s.range.start}-${s.range.end}`);

describe("tree-sitter symbols", () => {
  it("Python: classes, methods, functions", () => {
    expect(names("a.py", "class Svc:\n    def update(self, id):\n        return self.find(id)\n\ndef login(e):\n    return e\n")).toEqual([
      "class Svc 1-3", "method Svc.update 2-3", "function login 5-6",
    ]);
  });

  it("Java: classes, interfaces, enums, constructors, methods", () => {
    const src = "class Svc {\n  Svc(int a) {}\n  int update(int id) { return find(id); }\n}\ninterface P { boolean verify(String t); }\nenum E { A }\n";
    expect(names("A.java", src)).toEqual([
      "class Svc 1-4", "method Svc.Svc 2-2", "method Svc.update 3-3", "interface P 5-5", "method P.verify 5-5", "enum E 6-6",
    ]);
  });

  it("Go: functions, methods named after their receiver, structs and interfaces", () => {
    const src = "package m\n\ntype Svc struct {\n\tdb int\n}\n\nfunc (s *Svc) Update(id int) int {\n\treturn id\n}\n\nfunc Login() {}\n\ntype P interface {\n\tVerify()\n}\n";
    expect(names("a.go", src)).toEqual(["struct Svc 3-5", "method Svc.Update 7-9", "function Login 11-11", "interface P 13-15"]);
  });

  it("JavaScript: arrow functions in variables count, plain variables do not", () => {
    expect(names("a.js", "const go = (x) => x;\nconst n = 1;\nclass A { run() {} }\n")).toEqual([
      "arrow go 1-1", "class A 3-3", "method A.run 3-3",
    ]);
  });

  it("Rust, Ruby, C#, PHP, Kotlin, C++", () => {
    expect(names("a.rs", "struct Svc;\nimpl Svc {\n    fn update(&self) {}\n}\nfn login() {}\n")).toEqual([
      "struct Svc 1-1", "method Svc.update 3-3", "function login 5-5",
    ]);
    expect(names("a.rb", "class Svc\n  def update(id)\n    id\n  end\nend\n")).toEqual(["class Svc 1-5", "method Svc.update 2-4"]);
    expect(names("a.cs", "namespace App {\n  class Svc {\n    void Update() {}\n  }\n}\n")).toEqual(["class App.Svc 2-4", "method App.Svc.Update 3-3"]);
    expect(names("a.php", "<?php\nclass Svc {\n  function update($id) { return $id; }\n}\n")).toEqual(["class Svc 2-4", "method Svc.update 3-3"]);
    expect(names("a.kt", "class Svc {\n    fun update(id: Int): Int {\n        return id\n    }\n}\n")).toEqual(["class Svc 1-5", "method Svc.update 2-4"]);
    expect(names("a.cpp", "class Svc {\n public:\n  int update(int id) { return id; }\n};\nint Svc::run() { return 1; }\n")).toEqual([
      "class Svc 1-4", "method Svc.update 3-3", "function Svc.run 5-5",
    ]);
  });

  it("Swift: structs, enums, extensions, protocol methods, init, computed properties, subscripts (roadmap 22.2)", () => {
    const src = [
      "protocol Repo {", //                      1
      "  func save(_ o: Order) -> Bool", //       2
      "}", //                                     3
      "struct Order {", //                        4
      "  let id: Int", //                         5
      "  var total: Int {", //                    6
      "    return 1", //                          7
      "  }", //                                   8
      "  init(id: Int) { self.id = id }", //      9
      "  subscript(i: Int) -> Int { i }", //      10
      "}", //                                     11
      "enum Status { case a }", //                12
      "extension Order: Repo {", //               13
      "  func save(_ o: Order) -> Bool { true }", // 14
      "}", //                                     15
    ].join("\n");
    expect(names("a.swift", src)).toEqual([
      "interface Repo 1-3", "method Repo.save 2-2",
      "struct Order 4-11", "method Order.total 6-8", "method Order.init 9-9", "method Order.subscript 10-10",
      "enum Status 12-12",
      "method Order.save 14-14",
    ]);
  });

  it("Kotlin: interfaces, enums, secondary constructors, properties with a getter (roadmap 22.2)", () => {
    const src = "interface Repo {\n  fun save()\n}\nenum class E { A }\nclass S(val r: Repo) {\n  constructor() : this(R())\n  val total: Int\n    get() = 1\n  val plain = 2\n}\n";
    expect(names("a.kt", src)).toEqual([
      "interface Repo 1-3", "method Repo.save 2-2", "enum E 4-4", "class S 5-10", "method S.constructor 6-6", "method S.total 7-8",
    ]);
  });

  it("C#: properties with code, not auto-properties (roadmap 22.2)", () => {
    const src = "class S {\n  public int Total { get { return Calc(); } }\n  public int Fast => Calc();\n  public int Auto { get; set; }\n}\n";
    expect(names("a.cs", src)).toEqual(["class S 1-5", "method S.Total 2-2", "method S.Fast 3-3"]);
  });

  it("ignores files of unknown languages", () => {
    expect(engine.symbols("notes.txt", "def x(): pass")).toEqual([]);
  });
});

describe("tree-sitter call graph", () => {
  const files = [
    { path: "auth.py", source: "def login(email):\n    return check(email)\n\ndef check(e):\n    return e\n" },
    { path: "checkout.py", source: "from auth import login\n\nclass Cart:\n    def pay(self):\n        user = login('a')\n        return user\n" },
  ];

  it("links calls to definitions by name, with the call line", () => {
    const g = new TreeSitterCallGraph(engine).build({ files, changedIds: ["auth.py#login"], removed: [], depth: 1 });
    expect(g.edges).toContainEqual({ from: "checkout.py#Cart.pay", to: "auth.py#login", kind: "calls", sites: [{ line: 5, text: "        user = login('a')" }] });
    expect(g.edges).toContainEqual(expect.objectContaining({ from: "auth.py#login", to: "auth.py#check" }));
    const caller = g.nodes.find((n) => n.id === "checkout.py#Cart.pay")!;
    expect(caller.code).toEqual(["    def pay(self):", "        user = login('a')", "        return user"]);
  });

  it("flags calls to a name that only a removed symbol had", () => {
    const g = new TreeSitterCallGraph(engine).build({
      files: [{ path: "use.py", source: "def use():\n    return legacy_hash('x')\n" }],
      changedIds: [],
      removed: [{ id: "hash.py#legacy_hash", name: "legacy_hash" }],
      depth: 1,
    });
    expect(g.edges).toEqual([expect.objectContaining({ from: "use.py#use", to: "hash.py#legacy_hash", kind: "calls-removed" })]);
  });
});

describe("tree-sitter highlighter", () => {
  it("colours keywords, strings, comments, numbers and called functions, line by line", () => {
    const hl = new TreeSitterHighlighter(engine);
    const out = hl.highlight("a.py", ["def go(x):  # note", "    return run('é', 42)"])!;
    const kinds = out.map((line) => line.filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`));
    expect(kinds[0]).toEqual(["keyword:def", "function:go", "comment:# note"]);
    expect(kinds[1]).toEqual(["keyword:return", "function:run", "string:'é'", "number:42"]);
    expect(out.map((l) => l.map((t) => t.text).join(""))).toEqual(["def go(x):  # note", "    return run('é', 42)"]);
  });

  it("keeps multi-line comments split per line", () => {
    const out = new TreeSitterHighlighter(engine).highlight("A.java", ["/* a", "b */ int x = 1;"])!;
    expect(out[0]).toEqual([{ text: "/* a", kind: "comment" }]);
    expect(out[1][0]).toEqual({ text: "b */", kind: "comment" });
  });
});

describe("analysing a Python repo end to end", () => {
  let repo: FixtureRepo | null = null;
  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  it("finds the changed function and its caller, and still shows files it can't parse", async () => {
    repo = createFixtureRepo();
    repo.write("auth.py", "def login(email):\n    return email\n");
    repo.write("checkout.py", "from auth import login\n\ndef pay():\n    return login('a')\n");
    repo.write("config.yml", "ttl: 3600\n");
    repo.commit("initial");
    repo.write("auth.py", "def login(email):\n    return email.strip()\n");
    repo.write("config.yml", "ttl: 900\n");
    repo.commit("change");

    const langs = await loadLanguageSupport();
    const r = new AnalyzeRangeUseCase(new GitDiffReader(repo.dir), new GitSourceReader(repo.dir), langs.parsers, langs.graphs).execute("HEAD~1", "HEAD");

    expect(r.symbols.map((s) => `${s.status} ${s.name}`)).toEqual(["modified login"]);
    expect(r.edges).toContainEqual(expect.objectContaining({ from: "checkout.py#pay", to: "auth.py#login", kind: "calls" }));
    expect(r.files.map((f) => f.path).sort()).toEqual(["auth.py", "config.yml"]);
  });
});
