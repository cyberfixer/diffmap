import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { TreeSitterEngine } from "../src/infrastructure/parsers/tree-sitter/engine.js";
import { TreeSitterCallGraph, acceptsLabels } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-call-graph.js";
import { TreeSitterHighlighter } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-highlighter.js";
import { Visibility, typeOfVariable } from "../src/infrastructure/parsers/tree-sitter/visibility.js";
import { loadLanguageSupport } from "../src/infrastructure/language-support.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";

let engine: TreeSitterEngine;
let graph: TreeSitterCallGraph;
beforeAll(async () => {
  engine = await TreeSitterEngine.load();
  graph = new TreeSitterCallGraph(engine);
});

const names = (src: string) => engine.symbols("a.swift", src).map((s) => `${s.name} ${s.range.start}-${s.range.end}`);
const lines = (...l: string[]) => l.join("\n") + "\n";

/** Every link in the files, as "caller -> target". */
function links(files: Record<string, string>): string[] {
  const { collector } = graph.link(Object.entries(files).map(([path, source]) => ({ path, source })));
  return [...collector.calls.values()].filter((e) => e.kind === "calls").map((e) => `${e.from} -> ${e.to}`).sort();
}

/** Who uses `target`, as "caller id". */
const usersOf = (files: Record<string, string>, target: string): string[] =>
  links(files).filter((l) => l.endsWith(` -> ${target}`)).map((l) => l.split(" -> ")[0]);

/** What `caller` uses, as "target id". */
const usedBy = (files: Record<string, string>, caller: string): string[] =>
  links(files).filter((l) => l.startsWith(`${caller} -> `)).map((l) => l.split(" -> ")[1]);

describe("Swift symbols", () => {
  it("names methods with their argument labels, so same-named methods are separate symbols", () => {
    const src = lines(
      "class List: UIViewController, UITableViewDataSource {", //                                     1
      "  override init(frame: CGRect) { super.init(frame: frame) }", //                               2
      "  required init?(coder: NSCoder) { fatalError() }", //                                         3
      "  override func viewDidLoad() { super.viewDidLoad() }", //                                     4
      "  func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int { 1 }", //             5
      "  func tableView(_ t: UITableView, cellForRowAt i: IndexPath) -> UITableViewCell { Cell() }", // 6
      "  func show(item: Item, animated: Bool = true) {}", //                                         7
      "  subscript(i: Int, key k: String) -> Int { i }", //                                           8
      "  static func == (l: List, r: List) -> Bool { true }", //                                      9
      "}", //                                                                                         10
    );
    expect(names(src)).toEqual([
      "List 1-10",
      "List.init(frame:) 2-2",
      "List.init(coder:) 3-3",
      "List.viewDidLoad 4-4",
      "List.tableView(_:numberOfRowsInSection:) 5-5",
      "List.tableView(_:cellForRowAt:) 6-6",
      "List.show(item:animated:) 7-7",
      "List.subscript(_:key:) 8-8",
      "List.==(_:_:) 9-9",
    ]);
  });

  it("properties with code are symbols: computed, set up by a closure, with observers, protocol requirements", () => {
    const src = lines(
      "protocol Titled {", //                          1
      "  var title: String { get }", //                2
      "}", //                                          3
      "final class Screen: UIViewController {", //     4
      "  let id = 1", //                               5
      "  var total: Int { items.count }", //           6
      "  lazy var table: UITableView = {", //          7
      "    let t = UITableView()", //                  8
      "    return t", //                               9
      "  }()", //                                      10
      "  var items: [Item] = [] {", //                 11
      "    didSet { table.reloadData() }", //          12
      "  }", //                                        13
      "  var onTap: () -> Void = { print(1) }", //     14
      "  func run() {", //                             15
      "    let local = { print(2) }", //               16
      "    local()", //                                17
      "  }", //                                        18
      "}", //                                          19
      "let formatter: DateFormatter = {", //           20
      "  DateFormatter()", //                          21
      "}()", //                                        22
    );
    expect(names(src)).toEqual([
      "Titled 1-3",
      "Titled.title 2-2",
      "Screen 4-19",
      "Screen.total 6-6",
      "Screen.table 7-10",
      "Screen.items 11-13",
      "Screen.onTap 14-14",
      "Screen.run 15-18",
      "formatter 20-22",
    ]);
  });

  it("reads current Swift: macros, package access, raw strings, typed throws", () => {
    const src = lines(
      "package struct Api {", //                                1
      "  package func load() throws(ApiError) -> Int { 1 }", // 2
      '  let query = #"{ "a": 1 }"#', //                        3
      "  func after() {}", //                                   4
      "}", //                                                   5
      "#Preview {", //                                          6
      "  ContentView()", //                                     7
      "}", //                                                   8
      "@Test func adds() {", //                                 9
      "  #expect(add(1, 2) == 3)", //                           10
      "}", //                                                   11
      "func add(_ a: Int, _ b: Int) -> Int { a + b }", //       12
    );
    expect(names(src)).toEqual(["Api 1-5", "Api.load 2-2", "Api.after 4-4", "adds 9-11", "add(_:_:) 12-12"]);
    // The call inside the #expect macro is seen.
    expect(usersOf({ "a.swift": src }, "a.swift#add(_:_:)")).toEqual(["a.swift#adds"]);
  });

  it("works around what the grammar cannot read (try await in a condition, #if in a type, as? T ?? d, Swift 6)", () => {
    const src = lines(
      "final class Loader {", //                              1
      "  func load() async {", //                             2
      "    if let item = try? await fetch() { show(item) }", // 3
      "  }", //                                               4
      "  #if DEBUG", //                                       5
      "  func debug() {}", //                                 6
      "  #endif", //                                          7
      "  func fetch() async throws -> Int? { 1 }", //         8
      "  func show(_ i: Int) {}", //                          9
      '  func name(_ d: [String: Any]) -> String { d["n"] as? String ?? "" }', // 10
      "  func last() {}", //                                  11
      "}", //                                                 12
    );
    expect(names(src)).toEqual([
      "Loader 1-12", "Loader.load 2-4", "Loader.debug 6-6", "Loader.fetch 8-8", "Loader.show(_:) 9-9", "Loader.name(_:) 10-10", "Loader.last 11-11",
    ]);
    expect(usedBy({ "a.swift": src }, "a.swift#Loader.load")).toEqual(["a.swift#Loader.fetch", "a.swift#Loader.show(_:)"]);
    // More of the same, from Swift 6 code.
    const six = lines(
      "final class Sync {", //                                                       1
      "  func run() {", //                                                           2
      "    do { try push() } catch SyncError.offline, SyncError.busy(_) { retry() }", // 3
      "    let n = unsafe count(1)", //                                              4
      "    observe { (self: Self, _) in self.retry() }", //                          5
      "    if let id = try? (item as? Row)?.id { open(id) }", //                     6
      "  }", //                                                                      7
      "  /// Pushes, or lets the caller catch errors, then { retries }.", //         8
      "  func push() throws {}", //                                                  9
      "  func retry() {}", //                                                        10
      "  func count(_ i: Int) -> Int { i }", //                                      11
      "  func open(_ id: Int) {}", //                                                12
      "}", //                                                                        13
      "@available(iOS 17, *)", //                                                    14
      "#Preview {", //                                                               15
      "  SyncView()", //                                                             16
      "}", //                                                                        17
      "struct After {}", //                                                          18
    );
    expect(names(six)).toEqual([
      "Sync 1-13", "Sync.run 2-7", "Sync.push 9-9", "Sync.retry 10-10", "Sync.count(_:) 11-11", "Sync.open(_:) 12-12", "After 18-18",
    ]);
    expect(usedBy({ "a.swift": six }, "a.swift#Sync.run")).toEqual([
      "a.swift#Sync.count(_:)", "a.swift#Sync.open(_:)", "a.swift#Sync.push", "a.swift#Sync.retry",
    ]);
    // Colours still come from the text as written.
    const out = new TreeSitterHighlighter(engine).highlight("a.swift", src.split("\n"))!;
    expect(out[2].find((t) => t.text === "try")?.kind).toBe("keyword");
  });
});

describe("Swift: a change is mapped to the method it is in", () => {
  let repo: FixtureRepo | null = null;
  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  it("a change in the second tableView(...) method marks that one, with its own lines", async () => {
    const before = lines(
      "class List: UITableViewController {", //                                                          1
      "  override func tableView(_ t: UITableView, numberOfRowsInSection s: Int) -> Int {", //           2
      "    return 1", //                                                                                 3
      "  }", //                                                                                          4
      "  override func tableView(_ t: UITableView, didSelectRowAt i: IndexPath) {", //                   5
      "    show(i.row)", //                                                                              6
      "  }", //                                                                                          7
      "  func show(_ row: Int) {}", //                                                                   8
      "}", //                                                                                            9
    );
    repo = createFixtureRepo();
    repo.write("App/List.swift", before);
    repo.commit("initial");
    repo.write("App/List.swift", before.replace("show(i.row)", "show(i.row + 1)"));
    repo.commit("change");

    const langs = await loadLanguageSupport();
    const r = new AnalyzeRangeUseCase(new GitDiffReader(repo.dir), new GitSourceReader(repo.dir), langs.parsers, langs.graphs).execute("HEAD~1", "HEAD");

    expect(r.symbols.map((s) => `${s.status} ${s.name} ${s.headRange?.start}-${s.headRange?.end}`)).toEqual([
      "modified List.tableView(_:didSelectRowAt:) 5-7",
    ]);
    expect(r.symbols[0].diff.filter((l) => l.type !== "ctx").map((l) => l.text.trim())).toEqual(["show(i.row)", "show(i.row + 1)"]);
    expect(r.edges).toContainEqual(
      expect.objectContaining({ from: "App/List.swift#List.tableView(_:didSelectRowAt:)", to: "App/List.swift#List.show(_:)", kind: "calls" }),
    );
  });
});

describe("two methods with one name (they differ by parameter type): the one the change is in", () => {
  let repo: FixtureRepo | null = null;
  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  it("Swift inits with the same labels, Java overloads", async () => {
    const swift = lines(
      "final class Player {", //                                        1
      "  convenience init(attachment: Preview, behavior: Int) {", //     2
      "    self.init(source: 1)", //                                     3
      "  }", //                                                          4
      "  convenience init(attachment: Stream, behavior: Int) {", //      5
      "    self.init(source: 2)", //                                     6
      "  }", //                                                          7
      "  init(source: Int) {}", //                                       8
      "}", //                                                            9
    );
    const java = "class Svc {\n  void save(Order o) {\n    a();\n  }\n  void save(Invoice i) {\n    b();\n  }\n  void a() {}\n  void b() {}\n}\n";
    repo = createFixtureRepo();
    repo.write("App/Player.swift", swift);
    repo.write("app/Svc.java", java);
    repo.commit("initial");
    repo.write("App/Player.swift", swift.replace("self.init(source: 2)", "self.init(source: 3)"));
    repo.write("app/Svc.java", java.replace("    b();", "    b();\n    b();"));
    repo.commit("change");

    const langs = await loadLanguageSupport();
    const r = new AnalyzeRangeUseCase(new GitDiffReader(repo.dir), new GitSourceReader(repo.dir), langs.parsers, langs.graphs).execute("HEAD~1", "HEAD");
    const shown = r.symbols.map((s) => `${s.status} ${s.name} ${s.baseRange?.start}-${s.baseRange?.end} > ${s.headRange?.start}-${s.headRange?.end}: ${s.diff.filter((l) => l.type !== "ctx").map((l) => l.text.trim()).join(" | ")}`);
    expect(shown.sort()).toEqual([
      "modified Player.init(attachment:behavior:) 5-7 > 5-7: self.init(source: 2) | self.init(source: 3)",
      "modified Svc.save 5-7 > 5-8: b();",
    ]);
  });
});

describe("Swift: a changed signature is a modified method", () => {
  let repo: FixtureRepo | null = null;
  afterEach(() => {
    repo?.cleanup();
    repo = null;
  });

  it("a new parameter renames the method (labels are part of the name); it is modified, not added", async () => {
    const before = lines(
      "struct Store {", //                             1
      "  func load(_ id: Int) -> Int { id }", //       2
      "  func load(_ id: Int, cache: Bool) -> Int {", // 3
      "    return id", //                              4
      "  }", //                                        5
      "  func drop(_ id: Int) {}", //                  6
      "}", //                                          7
    );
    const after = before
      .replace("func load(_ id: Int, cache: Bool) -> Int {", "func load(_ id: Int, cache: Bool, retry: Int = 0) -> Int {")
      .replace("  func drop(_ id: Int) {}\n", "");
    repo = createFixtureRepo();
    repo.write("App/Store.swift", before);
    repo.write("App/Use.swift", "struct Use {\n  let store = Store()\n  func a() { _ = store.load(1, cache: true) }\n  func b() { store.drop(1) }\n}\n");
    repo.commit("initial");
    repo.write("App/Store.swift", after);
    repo.commit("change");

    const langs = await loadLanguageSupport();
    const r = new AnalyzeRangeUseCase(new GitDiffReader(repo.dir), new GitSourceReader(repo.dir), langs.parsers, langs.graphs).execute("HEAD~1", "HEAD");

    expect(r.symbols.map((s) => `${s.status} ${s.name} ${s.baseRange?.start}-${s.baseRange?.end} > ${s.headRange?.start}-${s.headRange?.end}`).sort()).toEqual([
      "modified Store.load(_:cache:retry:) 3-5 > 3-5",
      "removed Store.drop(_:) 6-6 > undefined-undefined",
    ]);
    const edges = r.edges.map((e) => `${e.kind} ${e.from.split("#")[1]} -> ${e.to.split("#")[1]}`).sort();
    expect(edges).toEqual(["calls Use.a -> Store.load(_:cache:retry:)", "calls-removed Use.b -> Store.drop(_:)"]);
  });
});

describe("Swift calls", () => {
  it("super.x() is the parent's x, never a sibling's or the type's own", () => {
    const files = {
      "App/Base.swift": "class Base: UIViewController {\n  override func viewDidLoad() { super.viewDidLoad() }\n  func bind() {}\n}\n",
      "App/A.swift": "class A: Base {\n  override func viewDidLoad() { super.viewDidLoad() }\n  override func bind() { super.bind() }\n}\n",
      "App/B.swift": "class B: UIViewController {\n  override func viewDidLoad() { super.viewDidLoad() }\n}\n",
    };
    expect(usersOf(files, "App/Base.swift#Base.viewDidLoad")).toEqual(["App/A.swift#A.viewDidLoad"]);
    expect(usersOf(files, "App/Base.swift#Base.bind")).toEqual(["App/A.swift#A.bind"]);
    // UIViewController's viewDidLoad is not repo code: B's and Base's super calls link to nothing.
    expect(usersOf(files, "App/A.swift#A.viewDidLoad")).toEqual([]);
    expect(usersOf(files, "App/B.swift#B.viewDidLoad")).toEqual([]);
  });

  it("a plain x() in a type is the type's own x, also from an extension in another folder", () => {
    const files = {
      "App/Screens/Home.swift": "final class Home {\n  func show() { setup() }\n}\nfinal class Other {\n  func setup() {}\n}\n",
      "App/Extensions/Home+Setup.swift": "extension Home {\n  func setup() { layout() }\n  func layout() {}\n}\n",
      "App/Screens/Settings.swift": "final class Settings {\n  func layout() {}\n}\n",
    };
    expect(usedBy(files, "App/Screens/Home.swift#Home.show")).toEqual(["App/Extensions/Home+Setup.swift#Home.setup"]);
    expect(usedBy(files, "App/Extensions/Home+Setup.swift#Home.setup")).toEqual(["App/Extensions/Home+Setup.swift#Home.layout"]);
  });

  it("a closure the code holds (a parameter, a stored property) is not a function of that name elsewhere", () => {
    const files = {
      "App/Loader.swift": lines(
        "final class Loader {",
        "  let onDone: () -> Void",
        "  func load(completion: @escaping (Int) -> Void) {",
        "    completion(1)",
        "    onDone()",
        "  }",
        "}",
      ),
      "App/Other.swift": "func completion(_ x: Int) {}\nfunc onDone() {}\n",
    };
    expect(usedBy(files, "App/Loader.swift#Loader.load(completion:)")).toEqual([]);
  });

  it("let image = image(named:) still calls the function", () => {
    const files = {
      "App/Images.swift": "func image(named name: String) -> UIImage? { nil }\n",
      "App/Use.swift": 'final class Use {\n  func run() {\n    if let image = image(named: "a") { print(image) }\n  }\n}\n',
    };
    expect(usersOf(files, "App/Images.swift#image(named:)")).toEqual(["App/Use.swift#Use.run"]);
  });

  it("Svc(a: 1) links to the type and to the init that takes those labels; a bare .init(...) to nothing", () => {
    const files = {
      "App/Svc.swift": "final class Svc {\n  init(a: Int) {}\n  init(b: String) {}\n}\n",
      "App/Svc+Json.swift": "extension Svc {\n  convenience init(json: Data) { self.init(a: 1) }\n}\n",
      "App/Use.swift": 'final class Use {\n  func a() { _ = Svc(a: 1) }\n  func j() { _ = Svc(json: Data()) }\n  func i() { take(.init(b: "x")) }\n}\n',
    };
    expect(usedBy(files, "App/Use.swift#Use.a")).toEqual(["App/Svc.swift#Svc", "App/Svc.swift#Svc.init(a:)"]);
    expect(usedBy(files, "App/Use.swift#Use.j")).toEqual(["App/Svc+Json.swift#Svc.init(json:)", "App/Svc.swift#Svc"]);
    expect(usedBy(files, "App/Use.swift#Use.i")).toEqual([]);
    // self.init(a:) inside the convenience init is the type's own.
    expect(usedBy(files, "App/Svc+Json.swift#Svc.init(json:)")).toEqual(["App/Svc.swift#Svc.init(a:)"]);
  });

  it("argument labels pick the method; a method that cannot take them is not linked", () => {
    const files = {
      "App/Store.swift": lines(
        "final class Store {",
        "  func load(_ id: Int) {}",
        "  func load(_ id: Int, cache: Bool) {}",
        "  func open(deepLink: URL) {}",
        "}",
      ),
      "App/Use.swift": lines(
        "final class Use {",
        "  let store = Store()",
        "  func a() { store.load(1) }",
        "  func b() { store.load(1, cache: true) }",
        "  func c() { UIApplication.shared.open(url, options: [:]) }",
        "}",
      ),
    };
    expect(usedBy(files, "App/Use.swift#Use.a")).toEqual(["App/Store.swift#Store.load(_:)"]);
    expect(usedBy(files, "App/Use.swift#Use.b")).toEqual(["App/Store.swift#Store.load(_:cache:)"]);
    expect(usedBy(files, "App/Use.swift#Use.c")).toEqual([]);
  });

  it("when the type's own methods of that name cannot take the labels, a parent's that can is meant", () => {
    const files = {
      "App/Request.swift": "class Request {\n  func validate(statusCode: Int, response: Int) -> Bool { true }\n}\n",
      "App/Download.swift": lines(
        "final class Download: Request {",
        "  func validate() -> Bool { self.validate(statusCode: 200, response: 1) }",
        "  func check() -> Bool { validate(statusCode: 200, response: 1) }",
        "}",
      ),
    };
    expect(usedBy(files, "App/Download.swift#Download.validate")).toEqual(["App/Request.swift#Request.validate(statusCode:response:)"]);
    expect(usedBy(files, "App/Download.swift#Download.check")).toEqual(["App/Request.swift#Request.validate(statusCode:response:)"]);
  });

  it("a trailing closure fills a closure parameter, whatever attributes it has; overloads in other files are all kept", () => {
    const files = {
      "Source/Request.swift": lines(
        "public class Request {",
        "  func onCreation(on queue: DispatchQueue = .main, perform handler: @escaping @Sendable (Int) -> Void) -> Self { self }",
        "  func response(queue: DispatchQueue = .main, completionHandler: @escaping (Int) -> Void) -> Self { self }",
        "}",
        "public class Session {",
        "  func request(_ url: String, method: String = \"GET\") -> Request { Request() }",
        "}",
      ),
      "Tests/Helpers.swift": "extension Session {\n  func request(_ endpoint: Endpoint, method: String = \"GET\") -> Request { Request() }\n}\n",
      "Tests/RequestTests.swift": lines(
        "final class RequestTests: XCTestCase {",
        "  let session = Session()",
        "  func testIt() {",
        "    session.request(\"u\").onCreation { _ in }.response { _ in }",
        "  }",
        "}",
      ),
    };
    expect(usedBy(files, "Tests/RequestTests.swift#RequestTests.testIt")).toEqual([
      "Source/Request.swift#Request.onCreation(on:perform:)",
      "Source/Request.swift#Request.response(queue:completionHandler:)",
      "Source/Request.swift#Session.request(_:method:)",
      "Tests/Helpers.swift#Session.request(_:method:)",
    ]);
  });

  it("a protocol's method with a default implementation that adds default values", () => {
    const files = {
      "App/Fonts.swift": lines(
        "protocol AppFont {",
        "  func font(size: Int?) -> Int",
        "}",
        "extension AppFont {",
        "  func font(size: Int? = nil) -> Int { size ?? 1 }",
        "}",
        "enum Heading: AppFont { case large }",
      ),
      "App/Use.swift": "struct Use {\n  func a() { _ = Heading.large.font() }\n}\n",
    };
    expect(usedBy(files, "App/Use.swift#Use.a")).toEqual(["App/Fonts.swift#AppFont.font(size:)"]);
  });

  it("acceptsLabels: defaults, trailing closures, variadics", () => {
    // "label" a required value, "label?" one with a default, "label..." variadic, "{label" one that takes a closure
    const sig = (...ps: string[]) =>
      ps.map((s) => ({ label: s.replace(/[{?.]/g, ""), optional: s.endsWith("?"), variadic: s.endsWith("..."), closure: s.startsWith("{") }));
    expect(acceptsLabels(sig("_", "cache?"), ["_"])).toBe(true); // load(1), cache has a default
    expect(acceptsLabels(sig("_", "cache"), ["_"])).toBe(false); // cache is required
    expect(acceptsLabels(sig("_", "cache?"), ["cache"])).toBe(false); // the first value is missing
    expect(acceptsLabels(sig("withDuration", "{animations", "{completion?"), ["withDuration"], 2)).toBe(true);
    expect(acceptsLabels(sig("withDuration", "{animations", "{completion?"), ["withDuration"], 1)).toBe(true);
    expect(acceptsLabels(sig("deepLink"), ["_", "options"])).toBe(false);
    expect(acceptsLabels(sig("_..."), ["_", "_", "_"])).toBe(true); // log(1, 2, 3) for log(_ xs: Int...)
    expect(acceptsLabels(sig("of..."), ["of", "_", "_"])).toBe(true); // isAny(of: a, b, c) for isAny(of xs: Self...)
    expect(acceptsLabels(sig(), [], 1)).toBe(false); // f { } for func f()
    expect(acceptsLabels(sig("to", "clamped?"), [], 1)).toBe(false); // xs.map { } is not map(to:clamped:)
    expect(acceptsLabels(sig("{_", "retries?"), [], 1)).toBe(true); // run { } for run(_ work: () -> Void, retries: Int = 1)
    // withEnv(language: .en) { } for withEnv(api: Api = .live, language: Language = .en, locale: Locale = .current, body: () -> Void)
    expect(acceptsLabels(sig("{api?", "{language?", "{locale?", "{body"), ["language"], 1)).toBe(true);
    expect(acceptsLabels(sig("{api?", "{language?", "{locale?", "{body"), ["language"])).toBe(false); // body is missing
  });

  it("an implicit member with its type written nearby: a declared type, an assignment, a return type", () => {
    const files = {
      "App/Tab.swift": "struct Tab {\n  init(_ i: Int) {}\n  static func home() -> Tab { .init(0) }\n  static func me() -> Self { .init(1) }\n}\n",
      "App/Other.swift": "struct Other {\n  init(_ i: Int) {}\n  static func home() -> Other { Other(0) }\n}\n",
      "App/Use.swift": lines(
        "final class Use {",
        "  var tab: Tab = .init(1)",
        "  var text: NSAttributedString = .init(2)",
        "  func a() { tab = .home() }",
        "  func b() { let t: Tab? = .init(3) }",
        "  func c() -> Tab { return .home() }",
        "  func d() { show(.home()) }",
        "}",
      ),
    };
    expect(usedBy(files, "App/Use.swift#Use")).toEqual(["App/Tab.swift#Tab.init(_:)"]);
    expect(usedBy(files, "App/Use.swift#Use.a")).toEqual(["App/Tab.swift#Tab.home"]);
    expect(usedBy(files, "App/Use.swift#Use.b")).toEqual(["App/Tab.swift#Tab.init(_:)"]);
    expect(usedBy(files, "App/Use.swift#Use.c")).toEqual(["App/Tab.swift#Tab.home"]);
    expect(usedBy(files, "App/Use.swift#Use.d")).toEqual([]); // show(.home()): two types have a home()
    expect(usedBy(files, "App/Tab.swift#Tab.home")).toEqual(["App/Tab.swift#Tab.init(_:)"]);
    expect(usedBy(files, "App/Tab.swift#Tab.me")).toEqual(["App/Tab.swift#Tab.init(_:)"]);
  });

  it(".make() is a static member; an enum case of the same name as a method is not that method", () => {
    const files = {
      "App/Theme.swift": "struct Theme {\n  static func dark(contrast: Int) -> Theme { Theme() }\n}\n",
      "App/Mock.swift": "enum Action { case load(Int) }\nfinal class Mock {\n  func load(_ id: Int) {}\n}\n",
      "App/Use.swift": "final class Use {\n  func a() { apply(.dark(contrast: 1)) }\n  func b() { expect(.load(1)) }\n}\n",
    };
    expect(usedBy(files, "App/Use.swift#Use.a")).toEqual(["App/Theme.swift#Theme.dark(contrast:)"]);
    expect(usedBy(files, "App/Use.swift#Use.b")).toEqual([]);
  });

  it("subscripts, closures run on the spot and defer are not calls", () => {
    const src = lines(
      "final class Use {",
      "  func items(_ i: Int) -> Int { i }",
      "  func table() {}",
      "  func run(rows: [Int]) {",
      "    defer { print(1) }",
      "    let x = rows[0]",
      "    let t: Int = { 1 }()",
      "  }",
      "}",
      "func `defer`() {}",
    );
    expect(usedBy({ "a.swift": src }, "a.swift#Use.run(rows:)")).toEqual([]);
  });

  it("a chain over several lines: each call is reported on its own line", () => {
    const src = lines(
      "struct Row: View {", //                1
      "  var body: some View {", //           2
      "    Text(title)", //                   3
      "      .card()", //                     4
      "      .onTapGesture { open() }", //    5
      "  }", //                               6
      "  func open() {}", //                  7
      "}", //                                 8
      "extension View {", //                  9
      "  func card() -> some View { self }", // 10
      "}", //                                 11
    );
    const { collector } = graph.link([{ path: "a.swift", source: src }]);
    const sites = [...collector.calls.values()].map((e) => `${e.to} @${e.sites.map((s) => `${s.line} ${s.text.trim()}`).join("|")}`).sort();
    expect(sites).toEqual(["a.swift#Row.open @5 .onTapGesture { open() }", "a.swift#View.card @4 .card()"]);
  });

  it("a class built on a UIKit class reaches what the repo adds to UIKit's parents", () => {
    const files = {
      "App/UIView+Pin.swift": "extension UIView {\n  func pin() {}\n}\n",
      "App/Cell.swift": "final class Cell: UITableViewCell {\n  let label = UILabel()\n  func setup() {\n    pin()\n    label.pin()\n  }\n}\n",
      "App/Other.swift": "final class Other {\n  func pin() {}\n}\n",
    };
    const { collector } = graph.link(Object.entries(files).map(([path, source]) => ({ path, source })));
    const edge = [...collector.calls.values()].find((e) => e.from === "App/Cell.swift#Cell.setup");
    expect(edge?.to).toBe("App/UIView+Pin.swift#UIView.pin");
    expect(edge?.sites.map((s) => s.line)).toEqual([4, 5]);
    expect(usersOf(files, "App/Other.swift#Other.pin")).toEqual([]);
  });
});

describe("Swift uses that are not calls", () => {
  it("#selector(x) and a function passed by name count as uses", () => {
    const files = {
      "App/Form.swift": lines(
        "final class Form: UIViewController {",
        "  func setup() {",
        "    button.addTarget(self, action: #selector(didTapSave), for: .touchUpInside)",
        "    center.addObserver(self, selector: #selector(refresh(_:)), name: .x, object: nil)",
        "  }",
        "  @objc private func didTapSave() {}",
        "  @objc func refresh(_ note: Notification) {}",
        "  @objc func refresh(_ note: Notification, twice: Bool) {}",
        "}",
      ),
      "App/FormView.swift": lines(
        "struct FormView: View {",
        "  var body: some View {",
        '    Button("Save", action: save)',
        "  }",
        "  private func save() {}",
        "}",
      ),
    };
    expect(usedBy(files, "App/Form.swift#Form.setup")).toEqual(["App/Form.swift#Form.didTapSave", "App/Form.swift#Form.refresh(_:)"]);
    expect(usersOf(files, "App/FormView.swift#FormView.save")).toEqual(["App/FormView.swift#FormView.body"]);
    // ...also through something whose type is written down: action: model.stop
    const more = {
      "App/Model.swift": "final class Model {\n  func stop() {}\n}\nfinal class Other {\n  func stop() {}\n}\n",
      "App/StopView.swift": "struct StopView: View {\n  let model = Model()\n  var body: some View {\n    Button(\"Stop\", action: model.stop)\n  }\n}\n",
    };
    expect(usersOf(more, "App/Model.swift#Model.stop")).toEqual(["App/StopView.swift#StopView.body"]);
    expect(usersOf(more, "App/Model.swift#Other.stop")).toEqual([]);
  });

  it("reading a property with code is a use: a SwiftUI subview, a view model's computed value", () => {
    const files = {
      "App/ProfileView.swift": lines(
        "struct ProfileView: View {",
        "  @StateObject private var model = ProfileModel()",
        "  let title: String",
        "  var body: some View {",
        "    VStack {",
        "      header",
        "      Text(model.fullName)",
        "      Text(title)",
        "    }",
        "  }",
        "  private var header: some View { Text(title) }",
        "}",
      ),
      "App/ProfileModel.swift": lines(
        "final class ProfileModel: ObservableObject {",
        "  var first = \"\"",
        "  var fullName: String { first + \"!\" }",
        "}",
        "final class Other {",
        "  var fullName: String { \"\" }",
        "  var title: String { \"\" }",
        "}",
      ),
    };
    expect(usedBy(files, "App/ProfileView.swift#ProfileView.body")).toEqual([
      "App/ProfileModel.swift#ProfileModel.fullName",
      "App/ProfileView.swift#ProfileView.header",
    ]);
    // `title` is ProfileView's own plain stored property, not Other.title; Other.fullName is not ProfileModel's.
    expect(usersOf(files, "App/ProfileModel.swift#Other.title")).toEqual([]);
    expect(usersOf(files, "App/ProfileModel.swift#Other.fullName")).toEqual([]);
  });

  it("a local of the same name is not the property; a write to a property with observers is a use", () => {
    const src = lines(
      "final class List {",
      "  var total: Int { 1 }",
      "  var items: [Int] = [] {",
      "    didSet { print(items) }",
      "  }",
      "  func a() {",
      "    let total = 2",
      "    print(total)",
      "  }",
      "  func b(total: Int) { print(total) }",
      "  func c() { print(total) }",
      "  func d() { items = [1] }",
      "  func e() -> Int { items[0] }",
      "}",
    );
    expect(usersOf({ "a.swift": src }, "a.swift#List.total")).toEqual(["a.swift#List.c"]);
    expect(usersOf({ "a.swift": src }, "a.swift#List.items")).toEqual(["a.swift#List.d", "a.swift#List.e"]);
  });

  it("a protocol's property requirement is implemented by the type's property", () => {
    const files = {
      "App/Titled.swift": "protocol Titled {\n  var title: String { get }\n}\n",
      "App/Screen.swift": "struct Screen: Titled {\n  var title: String { \"Home\" }\n}\n",
    };
    const { collector } = graph.link(Object.entries(files).map(([path, source]) => ({ path, source })));
    expect([...collector.calls.values()].map((e) => `${e.kind} ${e.from} -> ${e.to}`)).toEqual([
      "implements App/Screen.swift#Screen.title -> App/Titled.swift#Titled.title",
    ]);
  });
});

describe("Swift modules: files see each other without imports", () => {
  it("across folders of the app; a method of something nobody typed only when one fits", () => {
    const files = {
      "App/Features/Home/HomeView.swift": "struct HomeView {\n  func run(x: Thing, xs: [Thing]) {\n    track(\"home\")\n    xs.first?.refresh()\n    xs.map { $0 }\n  }\n}\n",
      "App/Core/Analytics.swift": "func track(_ event: String) {}\n",
      "App/Models/Thing.swift": "struct Thing {\n  func refresh() {}\n  func map(_ f: (Int) -> Int) {}\n}\nstruct Box {\n  func map(_ f: (Int) -> Int) {}\n}\n",
      // Not meant by `.padding(8)` or `xs.first`-like calls on things nobody typed:
      "App/Models/Style.swift": "struct Style {\n  var padding: Int { 4 }\n  func scaled(to range: ClosedRange<Double>, clamped: Bool = true) {}\n}\n",
      "App/Features/Home/Row.swift": "struct Row {\n  func body(x: Unknown) {\n    x.padding(8)\n    x.scaled { $0 }\n  }\n}\n",
    };
    expect(usedBy(files, "App/Features/Home/Row.swift#Row.body(x:)")).toEqual([]);
    expect(usedBy(files, "App/Features/Home/HomeView.swift#HomeView.run(x:xs:)")).toEqual([
      "App/Core/Analytics.swift#track(_:)",
      "App/Models/Thing.swift#Thing.refresh",
    ]);
  });

  it("a module is a folder named after an import; tests see the app through @testable import", () => {
    const files = {
      "Sources/Networking/Client.swift": "public struct Client {\n  public func send() {}\n}\npublic func ping() {}\n",
      "App/Sync.swift": "import Networking\nfunc sync() { ping() }\nfunc local() {}\n",
      "App/Offline.swift": "func ping() {}\nfunc offline() { ping() }\n",
      "AppTests/SyncTests.swift": "@testable import App\nfinal class SyncTests: XCTestCase {\n  func testSync() { sync() }\n}\n",
      "Sources/Networking/Retry.swift": "func retry() { local() }\n",
    };
    // App/Sync.swift is in the same folder as App/Offline.swift, whose ping() is nearer than the package's.
    expect(usedBy(files, "App/Offline.swift#offline")).toEqual(["App/Offline.swift#ping"]);
    expect(usedBy(files, "AppTests/SyncTests.swift#SyncTests.testSync")).toEqual(["App/Sync.swift#sync"]);

    const v = new Visibility(Object.entries(files).map(([path, source]) => ({ path, source })), () => true);
    expect(v.canSee("AppTests/SyncTests.swift", "App/Sync.swift")).toBe(true); // @testable import App
    expect(v.canSee("App/Sync.swift", "Sources/Networking/Client.swift")).toBe(true); // import Networking
    expect(v.canSee("App/Offline.swift", "Sources/Networking/Client.swift")).toBe(false); // no import
    expect(v.canSee("Sources/Networking/Retry.swift", "App/Sync.swift")).toBe(false); // a package does not see the app
    expect(v.canSee("App/Sync.swift", "AppTests/SyncTests.swift")).toBe(false);
  });

  it("a folder named after a framework its files import is not that framework", () => {
    const files = {
      "App/Extensions/UIKit/UIView+Round.swift": "import UIKit\nextension UIView {\n  func round() { clip() }\n}\n",
      "App/Helpers/Clip.swift": "import Foundation\nextension UIView {\n  func clip() {}\n}\n",
    };
    expect(usersOf(files, "App/Helpers/Clip.swift#UIView.clip")).toEqual(["App/Extensions/UIKit/UIView+Round.swift#UIView.round"]);
  });

  it("of two types with one name, the nearer one (two sample apps in one repo)", () => {
    const files = {
      "Examples/A/ContentView.swift": "struct ContentView {}\n",
      "Examples/A/App.swift": "struct AppA {\n  func body() { _ = ContentView() }\n}\n",
      "Examples/B/Views/ContentView.swift": "struct ContentView {}\n",
      "Examples/B/App.swift": "struct AppB {\n  func body() { _ = ContentView() }\n}\n",
    };
    expect(usedBy(files, "Examples/A/App.swift#AppA.body")).toEqual(["Examples/A/ContentView.swift#ContentView"]);
    expect(usedBy(files, "Examples/B/App.swift#AppB.body")).toEqual(["Examples/B/Views/ContentView.swift#ContentView"]);
  });
});

describe("Swift variable types", () => {
  it("casts, generic types, @Environment(T.self)", () => {
    expect(typeOfVariable("cell", 'let cell = table.dequeueReusableCell(withIdentifier: "c", for: i) as! ItemCell')).toBe("ItemCell");
    expect(typeOfVariable("vc", "guard let vc = segue.destination as? DetailController else { return }")).toBe("DetailController");
    expect(typeOfVariable("theme", "@Environment(Theme.self) private var theme")).toBe("Theme");
    expect(typeOfVariable("values", "private let values = TestObserver<Int, Never>()", true)).toBe("TestObserver");
    expect(typeOfVariable("table", "var table = GetTable<Row>(1)")).toBe(null); // C#: a method call, not a type
  });

  it("a cast and a field of a parent class give the type", () => {
    const files = {
      "App/ItemCell.swift": "final class ItemCell: UITableViewCell {\n  func configure() {}\n}\n",
      "App/OtherCell.swift": "final class OtherCell: UITableViewCell {\n  func configure() {}\n}\n",
      "App/Base.swift": "class Base {\n  let store = Store()\n}\nfinal class Store {\n  func save() {}\n}\nfinal class Cache {\n  func save() {}\n}\n",
      "App/List.swift": lines(
        "final class List: Base {",
        "  func cell(_ t: UITableView) {",
        '    let cell = t.dequeueReusableCell(withIdentifier: "c") as! ItemCell',
        "    cell.configure()",
        "  }",
        "  func keep() { store.save() }",
        "}",
      ),
    };
    expect(usedBy(files, "App/List.swift#List.cell(_:)")).toEqual(["App/ItemCell.swift#ItemCell.configure"]);
    expect(usedBy(files, "App/List.swift#List.keep")).toEqual(["App/Base.swift#Store.save"]);
  });

  it("a case of an enum is of that enum's type", () => {
    const files = {
      "App/Font.swift": "enum AppFont {\n  case title, body\n  func scaled() -> Int { 1 }\n}\nstruct Other {\n  func scaled() -> Int { 2 }\n}\n",
      "App/Use.swift": "struct Use {\n  func a() { _ = AppFont.title.scaled() }\n  func b() {\n    let f = AppFont.body\n    _ = f.scaled()\n  }\n}\n",
    };
    expect(usersOf(files, "App/Font.swift#AppFont.scaled")).toEqual(["App/Use.swift#Use.a", "App/Use.swift#Use.b"]);
    expect(usersOf(files, "App/Font.swift#Other.scaled")).toEqual([]);
  });

  it("a property set up by a closure keeps its declared type", () => {
    const files = {
      "App/Table.swift": "final class Table {\n  func reload() {}\n}\nfinal class Grid {\n  func reload() {}\n}\n",
      "App/Screen.swift": "final class Screen {\n  private lazy var table: Table = {\n    Table()\n  }()\n  func refresh() { table.reload() }\n}\n",
    };
    expect(usedBy(files, "App/Screen.swift#Screen.refresh")).toEqual(["App/Screen.swift#Screen.table", "App/Table.swift#Table.reload"]);
  });

  it("a computed property with its attributes on the line above keeps its declared type", () => {
    const files = {
      "App/Env.swift": "final class Env {\n  private static var _shared: Env?\n  @objc\n  class var shared: Env { _shared! }\n  let speech: Speech\n}\n",
      "App/Speech.swift": "final class Speech {\n  func stop() {}\n}\n",
      "App/Chat/Player.swift": "final class Player {\n  func stop() {}\n}\n",
      "App/Chat/Screen.swift": "final class Screen {\n  func quiet() { Env.shared.speech.stop() }\n}\n",
    };
    expect(usedBy(files, "App/Chat/Screen.swift#Screen.quiet")).toEqual(["App/Env.swift#Env.shared", "App/Speech.swift#Speech.stop"]);
  });
});

describe("Swift highlighting", () => {
  it("colours attributes and the names of methods being called", () => {
    const out = new TreeSitterHighlighter(engine).highlight("a.swift", ["@MainActor func load() { api.fetch(id: 1) }"])!;
    const kinds = Object.fromEntries(out[0].filter((t) => t.kind !== "plain").map((t) => [t.text, t.kind]));
    expect(kinds).toMatchObject({ "@MainActor": "decorator", func: "keyword", load: "function", fetch: "function", "1": "number" });
  });
});
