import { describe, it, expect, beforeAll } from "vitest";
import { TreeSitterEngine, receiverOf } from "../src/infrastructure/parsers/tree-sitter/engine.js";
import { TreeSitterCallGraph } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-call-graph.js";
import { Visibility, typeOfVariable } from "../src/infrastructure/parsers/tree-sitter/visibility.js";

let graph: TreeSitterCallGraph;
beforeAll(async () => {
  graph = new TreeSitterCallGraph(await TreeSitterEngine.load());
});

/** Callers of `target`, as "caller id". */
function callersOf(files: Record<string, string>, target: string): string[] {
  const r = graph.build({
    files: Object.entries(files).map(([path, source]) => ({ path, source })),
    changedIds: [target],
    removed: [],
    depth: 1,
  });
  return r.edges.filter((e) => e.to === target && e.kind === "calls").map((e) => e.from).sort();
}

describe("better name matching", () => {
  it("follows imports: only the module the file imports", () => {
    const files = {
      "auth/basic.py": "def login(u):\n    return u\n",
      "sso/oauth.py": "def login(u):\n    return u\n",
      "app/main.py": "from auth.basic import login\n\ndef run():\n    return login('a')\n",
    };
    expect(callersOf(files, "auth/basic.py#login")).toEqual(["app/main.py#run"]);
    expect(callersOf(files, "sso/oauth.py#login")).toEqual([]);
  });

  it("reads self.x() as the same class", () => {
    const src = "class A:\n    def save(self):\n        pass\n    def run(self):\n        self.save()\n\nclass B:\n    def save(self):\n        pass\n";
    expect(callersOf({ "m.py": src }, "m.py#A.save")).toEqual(["m.py#A.run"]);
    expect(callersOf({ "m.py": src }, "m.py#B.save")).toEqual([]);
  });

  it("reads this.x() the same way in Java", () => {
    const files = {
      "app/A.java": "class A {\n  void save() {}\n  void run() { this.save(); }\n}\n",
      "app/B.java": "class B {\n  void save() {}\n}\n",
    };
    expect(callersOf(files, "app/A.java#A.save")).toEqual(["app/A.java#A.run"]);
    expect(callersOf(files, "app/B.java#B.save")).toEqual([]);
  });

  it("uses a class name or a written-down variable type to pick the right method", () => {
    const files = {
      "app/Repo.java": "class Repo {\n  static Repo find() { return null; }\n}\n",
      "app/Cache.java": "class Cache {\n  static Cache find() { return null; }\n}\n",
      "app/Use.java": "class Use {\n  void a() { Repo.find(); }\n  void b(Cache c) { c.find(); }\n}\n",
    };
    expect(callersOf(files, "app/Repo.java#Repo.find")).toEqual(["app/Use.java#Use.a"]);
    expect(callersOf(files, "app/Cache.java#Cache.find")).toEqual(["app/Use.java#Use.b"]);
  });

  it("links a call nothing imports only when the name is unique in the repo", () => {
    const unique = {
      "lib/util.go": "package lib\n\nfunc Slugify(s string) string { return s }\n",
      "cmd/main.go": "package main\n\nfunc run() { Slugify(\"x\") }\n",
    };
    expect(callersOf(unique, "lib/util.go#Slugify")).toEqual(["cmd/main.go#run"]);

    const twice = { ...unique, "other/x.go": "package other\n\nfunc Slugify(s string) string { return s }\n" };
    expect(callersOf(twice, "lib/util.go#Slugify")).toEqual([]);
  });
});

describe("helpers", () => {
  it("receiverOf finds what a call is made on", () => {
    expect(receiverOf("self.repo.find(x)", "find")).toBe("self.repo");
    expect(receiverOf("this.save()", "save")).toBe("self");
    expect(receiverOf("$this->save()", "save")).toBe("self");
    expect(receiverOf("Svc::new()", "new")).toBe("Svc");
    expect(receiverOf("new Svc(1)", "Svc")).toBe("");
    expect(receiverOf("login(a)", "login")).toBe("");
  });

  it("typeOfVariable reads common declarations", () => {
    expect(typeOfVariable("c", "void b(Cache c) {")).toBe("Cache");
    expect(typeOfVariable("repo", "val repo: Repo = make()")).toBe("Repo");
    expect(typeOfVariable("svc", "svc = Svc(db)")).toBe("Svc");
    expect(typeOfVariable("$svc", "$svc = new Svc($db);")).toBe("Svc");
    expect(typeOfVariable("s", "s := Store{db: 1}")).toBe("Store");
    expect(typeOfVariable("x", "x = make()")).toBeNull();
  });

  it("Visibility: same folder, or named on an import line", () => {
    const v = new Visibility([
      { path: "web/app.js", source: "import { login } from '../auth/session';\nconst session = 1;\n" },
      { path: "web/util.js", source: "" },
    ]);
    expect(v.canSee("web/app.js", "web/util.js")).toBe(true);
    expect(v.canSee("web/app.js", "auth/session.js")).toBe(true);
    expect(v.canSee("web/app.js", "other/thing.js")).toBe(false);
  });
});

describe("arrow functions as class properties (roadmap 3)", () => {
  it("JavaScript: they are symbols, and this.handler() links inside the class", async () => {
    const engine = await TreeSitterEngine.load();
    const src = "class Form {\n  handler = () => {\n    this.validate();\n  };\n  validate = function () {};\n  count = 1;\n}\n";
    expect(engine.symbols("form.js", src).map((s) => `${s.kind} ${s.name}`)).toEqual(["class Form", "arrow Form.handler", "arrow Form.validate"]);
    expect(callersOf({ "form.js": src }, "form.js#Form.validate")).toEqual(["form.js#Form.handler"]);
  });
});

describe("field and property types (roadmap 22.1)", () => {
  const two = (ext: string, repo: string, cache: string) => ({ [`app/Repo${ext}`]: repo, [`app/Cache${ext}`]: cache });

  it("Java: a field's type picks the method, with or without this.", () => {
    const files = {
      ...two(".java", "class Repo {\n  void save() {}\n}\n", "class Cache {\n  void save() {}\n}\n"),
      "app/Svc.java":
        "class Svc {\n  private final Repo repo;\n  Svc(Repo repo) { this.repo = repo; }\n  void a() { repo.save(); }\n  void b() { this.repo.save(); }\n}\n",
    };
    expect(callersOf(files, "app/Repo.java#Repo.save")).toEqual(["app/Svc.java#Svc.a", "app/Svc.java#Svc.b"]);
    expect(callersOf(files, "app/Cache.java#Cache.save")).toEqual([]);
  });

  it("another method's local variable is not a field", () => {
    const files = {
      ...two(".java", "class Repo {\n  void save() {}\n}\n", "class Cache {\n  void save() {}\n}\n"),
      "app/Svc.java": "class Svc {\n  private Repo store;\n  void a() { Cache store = null; }\n  void b() { store.save(); }\n}\n",
    };
    expect(callersOf(files, "app/Repo.java#Repo.save")).toEqual(["app/Svc.java#Svc.b"]);
    expect(callersOf(files, "app/Cache.java#Cache.save")).toEqual([]);
  });

  it("Swift: a stored property, also used from an extension in another file", () => {
    const files = {
      ...two(".swift", "class Repo {\n  func save() {}\n}\n", "class Cache {\n  func save() {}\n}\n"),
      "app/Svc.swift": "final class Svc {\n  private let repo: Repo\n  func a() { repo.save() }\n}\n",
      "app/Svc+More.swift": "extension Svc {\n  func b() { self.repo.save() }\n}\n",
    };
    expect(callersOf(files, "app/Repo.swift#Repo.save")).toEqual(["app/Svc+More.swift#Svc.b", "app/Svc.swift#Svc.a"]);
    expect(callersOf(files, "app/Cache.swift#Cache.save")).toEqual([]);
  });

  it("Kotlin: a constructor property", () => {
    const files = {
      ...two(".kt", "class Repo {\n  fun save() {}\n}\n", "class Cache {\n  fun save() {}\n}\n"),
      "app/Svc.kt": "class Svc(private val repo: Repo) {\n  fun a() { repo.save() }\n}\n",
    };
    expect(callersOf(files, "app/Repo.kt#Repo.save")).toEqual(["app/Svc.kt#Svc.a"]);
    expect(callersOf(files, "app/Cache.kt#Cache.save")).toEqual([]);
  });

  it("Python: a field set in __init__", () => {
    const files = {
      "app/repo.py": "class Repo:\n    def save(self):\n        pass\n\nclass Cache:\n    def save(self):\n        pass\n",
      "app/svc.py": "from app.repo import Repo\n\nclass Svc:\n    def __init__(self):\n        self.repo = Repo()\n    def a(self):\n        self.repo.save()\n",
    };
    expect(callersOf(files, "app/repo.py#Repo.save")).toEqual(["app/svc.py#Svc.a"]);
    expect(callersOf(files, "app/repo.py#Cache.save")).toEqual([]);
  });

  it("Go: a struct field through the method's receiver", () => {
    const files = {
      "app/repo.go": "package app\n\ntype Repo struct{}\n\nfunc (r *Repo) Save() {}\n\ntype Cache struct{}\n\nfunc (c *Cache) Save() {}\n",
      "app/svc.go": "package app\n\ntype Svc struct {\n\trepo *Repo\n}\n\nfunc (s *Svc) A() { s.repo.Save() }\n",
    };
    expect(callersOf(files, "app/repo.go#Repo.Save")).toEqual(["app/svc.go#Svc.A"]);
    expect(callersOf(files, "app/repo.go#Cache.Save")).toEqual([]);
  });

  it("a variable of a library type is not linked to repo code", () => {
    const files = {
      "app/Box.java": "class Box {\n  void add(int x) {}\n}\n",
      "app/Use.java": "class Use {\n  void a(List<String> items) { items.add(\"x\"); }\n}\n",
    };
    expect(callersOf(files, "app/Box.java#Box.add")).toEqual([]);
  });
});

describe("missing definitions and calls (roadmap 22.2)", () => {
  it("Java: method references count as calls", () => {
    const files = {
      "app/A.java": "class A {\n  void check(int x) {}\n  void run() { items.forEach(this::check); }\n}\n",
      "app/Order.java": "class Order {\n  int total() { return 1; }\n}\n",
      "app/B.java": "class B {\n  void run() { orders.map(Order::total); }\n}\n",
    };
    expect(callersOf(files, "app/A.java#A.check")).toEqual(["app/A.java#A.run"]);
    expect(callersOf(files, "app/Order.java#Order.total")).toEqual(["app/B.java#B.run"]);
  });

  it("Swift: a type with extensions is one call target", () => {
    const files = {
      "app/Session.swift": "class Session {\n  init() {}\n}\n",
      "app/Session+A.swift": "extension Session {\n  func a() {}\n}\n",
      "app/Session+B.swift": "extension Session {\n  func b() {}\n}\n",
      "app/Use.swift": "class Use {\n  func run() { let s = Session() }\n}\n",
    };
    expect(callersOf(files, "app/Session.swift#Session")).toEqual(["app/Use.swift#Use.run"]);
  });

  it("Swift: a method added to a library type by an extension is still linked", () => {
    const files = {
      "app/String+Slug.swift": "extension String {\n  func slug() -> String { self }\n}\n",
      "app/Use.swift": "class Use {\n  func run(name: String) { name.slug() }\n}\n",
    };
    expect(callersOf(files, "app/String+Slug.swift#String.slug")).toEqual(["app/Use.swift#Use.run"]);
  });
});

describe("interfaces and implementations (roadmap 22.3)", () => {
  const build = (files: Record<string, string>, changed: string[], depth = 1) =>
    graph.build({ files: Object.entries(files).map(([path, source]) => ({ path, source })), changedIds: changed, removed: [], depth });
  const implementsOf = (files: Record<string, string>) =>
    [...graph.link(Object.entries(files).map(([path, source]) => ({ path, source }))).collector.calls.values()]
      .filter((e) => e.kind === "implements")
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();

  it("Java: implements and extends, through a chain of parents", () => {
    const files = {
      "app/Crud.java": "interface Crud {\n  void save(Order o);\n}\n",
      "app/OrderRepo.java": "interface OrderRepo extends Crud {\n  void find(int id);\n}\n",
      "app/JpaOrderRepo.java": "class JpaOrderRepo implements OrderRepo {\n  public void save(Order o) {}\n  public void find(int id) {}\n}\n",
    };
    expect(implementsOf(files)).toEqual([
      "app/JpaOrderRepo.java#JpaOrderRepo.find -> app/OrderRepo.java#OrderRepo.find",
      "app/JpaOrderRepo.java#JpaOrderRepo.save -> app/Crud.java#Crud.save",
    ]);
  });

  it("Swift (protocol through an extension), Kotlin, C#, Rust", () => {
    expect(
      implementsOf({
        "app/Repo.swift": "protocol Repo {\n  func save()\n}\n",
        "app/Disk.swift": "final class Disk {\n}\nextension Disk: Repo {\n  func save() {}\n}\n",
      }),
    ).toEqual(["app/Disk.swift#Disk.save -> app/Repo.swift#Repo.save"]);
    expect(
      implementsOf({ "app/a.kt": "interface Repo {\n  fun save()\n}\nclass Disk : Repo {\n  override fun save() {}\n}\n" }),
    ).toEqual(["app/a.kt#Disk.save -> app/a.kt#Repo.save"]);
    expect(
      implementsOf({ "app/a.cs": "interface IRepo {\n  void Save();\n}\nclass Disk : IRepo {\n  public void Save() {}\n}\n" }),
    ).toEqual(["app/a.cs#Disk.Save -> app/a.cs#IRepo.Save"]);
    expect(
      implementsOf({ "src/a.rs": "trait Repo {\n    fn save(&self);\n}\nstruct Disk;\nimpl Repo for Disk {\n    fn save(&self) {}\n}\n" }),
    ).toEqual(["src/a.rs#Disk.save -> src/a.rs#Repo.save"]);
  });

  it("a changed implementation shows who calls the interface, at depth 1", () => {
    const files = {
      "app/OrderRepo.java": "interface OrderRepo {\n  void save(Order o);\n}\n",
      "app/JpaOrderRepo.java": "class JpaOrderRepo implements OrderRepo {\n  public void save(Order o) {}\n}\n",
      "app/OrderService.java": "class OrderService {\n  private OrderRepo repo;\n  void place(Order o) { repo.save(o); }\n}\n",
    };
    const r = build(files, ["app/JpaOrderRepo.java#JpaOrderRepo.save"]);
    expect(r.nodes.map((n) => n.id).sort()).toEqual([
      "app/JpaOrderRepo.java#JpaOrderRepo.save",
      "app/OrderRepo.java#OrderRepo.save",
      "app/OrderService.java#OrderService.place",
    ]);
    expect(r.edges.map((e) => `${e.from} ${e.kind} ${e.to}`).sort()).toEqual([
      "app/JpaOrderRepo.java#JpaOrderRepo.save implements app/OrderRepo.java#OrderRepo.save",
      "app/OrderService.java#OrderService.place calls app/OrderRepo.java#OrderRepo.save",
    ]);
  });

  it("inherited methods: this.x() and child.x() find the parent's method", () => {
    const files = {
      "app/Base.java": "class Base {\n  void audit() {}\n}\n",
      "app/Other.java": "class Other {\n  void audit() {}\n}\n",
      "app/Child.java": "class Child extends Base {\n  void run() { this.audit(); }\n}\n",
      "app/Use.java": "class Use {\n  void go(Child c) { c.audit(); }\n}\n",
    };
    expect(callersOf(files, "app/Base.java#Base.audit")).toEqual(["app/Child.java#Child.run", "app/Use.java#Use.go"]);
    expect(callersOf(files, "app/Other.java#Other.audit")).toEqual([]);
  });

  it("a method inherited from a library type is not linked to repo code", () => {
    const files = {
      "app/OrderRepo.java": "interface OrderRepo extends JpaRepository<Order, Long> {\n  void custom();\n}\n",
      "app/Cache.java": "class Cache {\n  void findById(long id) {}\n}\n",
      "app/Use.java": "class Use {\n  private OrderRepo repo;\n  void go() { repo.findById(1); }\n}\n",
    };
    expect(callersOf(files, "app/Cache.java#Cache.findById")).toEqual([]);
  });
});
