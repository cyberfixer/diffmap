import { describe, it, expect, beforeAll } from "vitest";
import { TreeSitterEngine, receiverOf } from "../src/infrastructure/parsers/tree-sitter/engine.js";
import { TreeSitterCallGraph, lastAccess, assignedExpr } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-call-graph.js";
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
    expect(callersOf(files, "app/String+Slug.swift#String.slug")).toEqual(["app/Use.swift#Use.run(name:)"]);
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

describe("return types and chains (roadmap 22.4)", () => {
  const repoAndCache = {
    "app/Order.java": "class Order {\n  int total() { return 1; }\n}\n",
    "app/Invoice.java": "class Invoice {\n  int total() { return 2; }\n}\n",
    "app/Repo.java": "class Repo {\n  Order find(int id) { return null; }\n  Invoice bill(int id) { return null; }\n}\n",
  };

  it("Java: var o = repo.find(id); o.total() and repo.find(id).total()", () => {
    const files = {
      ...repoAndCache,
      "app/Use.java":
        "class Use {\n  private Repo repo;\n  int a() { var o = repo.find(1); return o.total(); }\n  int b() { return repo.find(1).total(); }\n  int c() { return this.repo.bill(1).total(); }\n}\n",
    };
    expect(callersOf(files, "app/Order.java#Order.total")).toEqual(["app/Use.java#Use.a", "app/Use.java#Use.b"]);
    expect(callersOf(files, "app/Invoice.java#Invoice.total")).toEqual(["app/Use.java#Use.c"]);
  });

  it("Swift: let o = try await repo.find(); chains over lines; -> Self", () => {
    const files = {
      "app/Order.swift": "struct Order {\n  func total() -> Int { 1 }\n}\n",
      "app/Invoice.swift": "struct Invoice {\n  func total() -> Int { 2 }\n}\n",
      "app/Repo.swift": "class Repo {\n  func find() async throws -> Order? { nil }\n  func validate() -> Self { self }\n}\n",
      "app/Use.swift":
        "class Use {\n  let repo = Repo()\n  func a() async throws {\n    let o = try await repo.find()\n    o?.total()\n  }\n  func b() {\n    repo.validate()\n      .find()\n      .total()\n  }\n}\n",
    };
    expect(callersOf(files, "app/Order.swift#Order.total")).toEqual(["app/Use.swift#Use.a", "app/Use.swift#Use.b"]);
    expect(callersOf(files, "app/Invoice.swift#Invoice.total")).toEqual([]);
  });

  it("Go: o, err := svc.Load(); o.Total()", () => {
    const files = {
      "app/types.go": "package app\n\ntype Order struct{}\n\nfunc (o *Order) Total() int { return 1 }\n\ntype Invoice struct{}\n\nfunc (i *Invoice) Total() int { return 2 }\n\ntype Svc struct{}\n\nfunc (s *Svc) Load() (*Order, error) { return nil, nil }\n",
      "app/use.go": "package app\n\nfunc run(svc *Svc) {\n\to, err := svc.Load()\n\to.Total()\n}\n",
    };
    expect(callersOf(files, "app/types.go#Order.Total")).toEqual(["app/use.go#run"]);
    expect(callersOf(files, "app/types.go#Invoice.Total")).toEqual([]);
  });

  it("a value from a library function is a library type; a library method's result is unknown", () => {
    const files = {
      "app/Box.swift": "class Box {\n  func fulfill() {}\n}\n",
      "app/Use.swift": "class Use {\n  func a() {\n    let e = expectation(description: \"x\")\n    e.fulfill()\n  }\n}\n",
    };
    expect(callersOf(files, "app/Box.swift#Box.fulfill")).toEqual([]);
    const java = {
      ...repoAndCache,
      "app/Use.java": "class Use {\n  void a(List<Order> items) { items.get(0).total(); }\n}\n",
    };
    // items.get(0) could be anything: name matching still links (to both, as before).
    expect(callersOf(java, "app/Order.java#Order.total")).toEqual(["app/Use.java#Use.a"]);
  });

  it("a global: let AF = Session.default; AF.request()", () => {
    const files = {
      "app/Session.swift": "class Session {\n  static let `default` = Session()\n  func request() {}\n}\n",
      "app/Other.swift": "class Other {\n  func request() {}\n}\n",
      "app/AF.swift": "public let AF = Session.default\n",
      "app/Use.swift": "class Use {\n  func a() { AF.request() }\n}\n",
    };
    expect(callersOf(files, "app/Session.swift#Session.request")).toEqual(["app/Use.swift#Use.a"]);
    expect(callersOf(files, "app/Other.swift#Other.request")).toEqual([]);
  });

  it("lastAccess and assignedExpr", () => {
    expect(lastAccess("a.getB().run(x)")).toEqual({ recv: "a.getB()", name: "run", isCall: true });
    expect(lastAccess("$a->b")).toEqual({ recv: "$a", name: "b", isCall: false });
    expect(lastAccess("repo")).toEqual({ recv: "", name: "repo", isCall: false });
    expect(lastAccess("o?.total")).toEqual({ recv: "o", name: "total", isCall: false });
    expect(assignedExpr("o", "var o = repo.find(1, 2);")).toBe("repo.find(1, 2)");
    expect(assignedExpr("o", "o, err := svc.Load()")).toBe("svc.Load()");
    expect(assignedExpr("o", "guard let o = try await api.load() else {")).toBe("api.load()");
    expect(assignedExpr("o", "if (o == null) {")).toBeNull();
  });
});

describe("overloads by argument count (roadmap 22.5)", () => {
  // Parameters without a written-down type, so only the argument count can tell.
  it("of several same-named methods, keeps those that accept the arguments", () => {
    const files = {
      "app/mail.py": "class Mail:\n    def send(self, to):\n        pass\n",
      "app/sms.py": "class Sms:\n    def send(self, to, text):\n        pass\n",
      "app/use.py": "def a(x):\n    x.send('a')\n\ndef b(x):\n    x.send('a', 'b')\n",
    };
    expect(callersOf(files, "app/mail.py#Mail.send")).toEqual(["app/use.py#a"]);
    expect(callersOf(files, "app/sms.py#Sms.send")).toEqual(["app/use.py#b"]);
  });

  it("default values, varargs and trailing closures", () => {
    const files = {
      "app/A.swift": "class A {\n  func load(_ id: Int, cache: Bool = true) {}\n}\n",
      "app/B.swift": "class B {\n  func load(_ id: Int, cache: Bool, done: () -> Void) {}\n}\n",
      "app/Use.swift": "class Use {\n  func a() { each { x in x.load(1) } }\n  func b() { each { x in x.load(1, cache: false) { } } }\n}\n",
    };
    expect(callersOf(files, "app/A.swift#A.load(_:cache:)")).toEqual(["app/Use.swift#Use.a"]);
    expect(callersOf(files, "app/B.swift#B.load(_:cache:done:)")).toEqual(["app/Use.swift#Use.b"]);
  });

  it("when none fit, keeps them all (the count may be wrong)", () => {
    const files = {
      "app/mail.py": "class Mail:\n    def send(self, to):\n        pass\n",
      "app/sms.py": "class Sms:\n    def send(self, to):\n        pass\n",
      "app/use.py": "def a(x):\n    x.send('a', 'b', 'c')\n",
    };
    expect(callersOf(files, "app/mail.py#Mail.send")).toEqual(["app/use.py#a"]);
    expect(callersOf(files, "app/sms.py#Sms.send")).toEqual(["app/use.py#a"]);
  });
});

describe("same-named classes (roadmap 22.6)", () => {
  const two = {
    "src/com/shop/order/Order.java": "package com.shop.order;\nclass Order {\n  int total() { return 1; }\n}\n",
    "src/com/shop/legacy/Order.java": "package com.shop.legacy;\nclass Order {\n  int total() { return 2; }\n}\n",
  };

  it("Java: the class the file imports", () => {
    const files = {
      ...two,
      "src/com/shop/web/Use.java": "package com.shop.web;\nimport com.shop.order.Order;\nclass Use {\n  int a(Order o) { return o.total(); }\n}\n",
    };
    expect(callersOf(files, "src/com/shop/order/Order.java#Order.total")).toEqual(["src/com/shop/web/Use.java#Use.a"]);
    expect(callersOf(files, "src/com/shop/legacy/Order.java#Order.total")).toEqual([]);
  });

  it("Java: a wildcard import picks the package", () => {
    const files = {
      ...two,
      "src/com/shop/web/Use.java": "package com.shop.web;\nimport com.shop.legacy.*;\nclass Use {\n  int a(Order o) { return o.total(); }\n}\n",
    };
    expect(callersOf(files, "src/com/shop/legacy/Order.java#Order.total")).toEqual(["src/com/shop/web/Use.java#Use.a"]);
    expect(callersOf(files, "src/com/shop/order/Order.java#Order.total")).toEqual([]);
  });

  it("Python: from app.models import Order", () => {
    const files = {
      "app/models.py": "class Order:\n    def total(self):\n        return 1\n",
      "old/models.py": "class Order:\n    def total(self):\n        return 2\n",
      "app/use.py": "from app.models import Order\nfrom old import models\n\ndef a():\n    return Order().total()\n",
    };
    expect(callersOf(files, "app/models.py#Order.total")).toEqual(["app/use.py#a"]);
    expect(callersOf(files, "old/models.py#Order.total")).toEqual([]);
  });
});

describe("names written with what they belong to (roadmap 30)", () => {
  const RUST = {
    "keys/src/address.rs": [
      "pub struct DeviceId(u8);",
      "impl DeviceId {",
      "    pub fn new(id: u8) -> Self { DeviceId(id) }",
      "    pub fn again(&self) -> Self { Self::new(self.0) }",
      "    pub fn take(&self) -> u8 { self.0 }",
      "}",
      "pub struct Addr { name: String }",
      "impl Addr {",
      "    pub fn new(name: String) -> Self { Addr { name } }",
      "    pub fn clone(&self) -> Self { Addr::new(self.name.to_string()) }",
      "}",
      "pub fn parse(s: &str) -> u8 { 1 }",
      "",
    ].join("\n"),
    "proto/src/use.rs": [
      "use keys::address::{DeviceId, Addr};",
      "use keys::address;",
      "fn typed() { let d = DeviceId::new(1); }",
      "fn full_path() { let d = keys::address::DeviceId::new(2); }",
      "fn generic() { let d = DeviceId::new::<u8>(3); }",
      "fn through_module() { let p = address::parse(\"1\"); }",
      "fn library() { let v: Vec<u8> = Vec::new(); let s = String::new(); let b = Box::new(1); }",
      "fn standard(x: Option<u8>) { let y = std::mem::take(&mut x); }",
      "fn unknown(thing: &Thing) { let c = thing.clone(); }",
      "",
    ].join("\n"),
  };

  it("Rust: Type::new(...) is new called on Type, by any path", () => {
    expect(callersOf(RUST, "keys/src/address.rs#DeviceId.new")).toEqual([
      "keys/src/address.rs#DeviceId.again", // Self::new
      "proto/src/use.rs#full_path",
      "proto/src/use.rs#generic",
      "proto/src/use.rs#typed",
    ]);
    // Another type's new, and the library's Vec::new, String::new and Box::new, are not it.
    expect(callersOf(RUST, "keys/src/address.rs#Addr.new")).toEqual(["keys/src/address.rs#Addr.clone"]);
  });

  it("Rust: module::function(...) is a plain function; std:: is never repo code", () => {
    expect(callersOf(RUST, "keys/src/address.rs#parse")).toEqual(["proto/src/use.rs#through_module"]);
    expect(callersOf(RUST, "keys/src/address.rs#DeviceId.take")).toEqual([]);
  });

  it("Rust: a name every type has is not linked on something of unknown type", () => {
    expect(callersOf(RUST, "keys/src/address.rs#Addr.clone")).toEqual([]);
  });

  it("C++: Svc::make(...) is make called on Svc; ns::run() a plain function; std:: is left out", () => {
    const files = {
      "svc.cpp": "class Svc {\npublic:\n  static int make(int x) { return x; }\n};\nclass Other {\npublic:\n  static int make(int x) { return x; }\n};\nnamespace util {\nint run() { return 1; }\nint move(int x) { return x; }\n}\n",
      "use.cpp": '#include "svc.cpp"\nint a() { return Svc::make(1); }\nint b() { return util::run(); }\nint c(int x) { return std::move(x); }\n',
    };
    expect(callersOf(files, "svc.cpp#Svc.make")).toEqual(["use.cpp#a"]);
    expect(callersOf(files, "svc.cpp#Other.make")).toEqual([]);
    expect(callersOf(files, "svc.cpp#util.run")).toEqual(["use.cpp#b"]);
    expect(callersOf(files, "svc.cpp#util.move")).toEqual([]);
  });

  it("Rust, Java: a method a known type does not write is not another type's (derives, Lombok)", () => {
    const java = {
      "app/Param.java": "import lombok.Getter;\n@Getter\npublic class Param {\n  private String note;\n}\n",
      "app/Apply.java": "public class Apply {\n  private String note;\n  public String getNote() { return note; }\n}\n",
      "app/Use.java": "public class Use {\n  void a(Param param) { param.getNote(); }\n  void b(Apply apply) { apply.getNote(); }\n}\n",
    };
    expect(callersOf(java, "app/Apply.java#Apply.getNote")).toEqual(["app/Use.java#Use.b"]);
    const rust = {
      "src/a.rs": "#[derive(Debug)]\npub struct Key(u8);\npub struct Token(u8);\nimpl Token {\n    pub fn serialize(&self) -> u8 { self.0 }\n}\n",
      "src/use.rs": "use crate::a::{Key, Token};\nfn a(key: &Key) { key.serialize(); }\nfn b(token: &Token) { token.serialize(); }\n",
    };
    expect(callersOf(rust, "src/a.rs#Token.serialize")).toEqual(["src/use.rs#b"]);
  });
});

describe("Kotlin the bundled grammar cannot read (roadmap 31)", () => {
  // Each line below made the whole file read badly: methods after it fell out of their class.
  const QUERY = [
    "fun interface Lease {", //                                              1
    "  fun release()", //                                                    2
    "}", //                                                                  3
    "class Query {", //                                                      4
    "  fun where(predicate: () -> Op): Query = this", //                     5
    "  infix fun eq(other: Query): Op = Op()", //                            6
    "  fun <T> typed(): T where T : Any = TODO()", //                        7
    "}", //                                                                  8
    "class Internal {", //                                                   9
    "  fun launch() {}", //                                                  10
    "}", //                                                                  11
    "",
  ].join("\n");
  const USE = [
    "class Use(val internal: Internal, val open: Query) {", //               1
    "  fun assign(view: Holder) {", //                                       2
    "    view.get().visible = true", //                                      3
    "    find<Holder>(1).visible = if (view.ready()) true else false", //    4
    "  }", //                                                                5
    "  fun keywordNames() {", //                                             6
    "    internal.launch()", //                                              7
    "    open.typed<Int>()", //                                              8
    "  }", //                                                                9
    "  fun infix(a: Query, b: Query) {", //                                  10
    "    val op = a eq b", //                                                11
    "    a.where { a eq b }", //                                             12
    "  }", //                                                                13
    "  fun newer(edit: Outer.Inner.() -> Unit, pairs: List<Pair<Int, Query>>) {", // 14
    "    for (i in 0..<10) { pairs.map { (_, q): Pair<Int, Query> -> q.typed<Int>() } }", // 15
    "  }", //                                                                16
    "  fun last(view: Holder) { view.ready() }", //                          17
    "}", //                                                                  18
    "class Holder {", //                                                     19
    "  fun get(): Holder = this", //                                         20
    "  fun ready(): Boolean = true", //                                      21
    "}", //                                                                  22
    "",
  ].join("\n");
  const files = { "q/Query.kt": QUERY, "q/Use.kt": USE };

  it("keeps every method in its class, under the name the file writes", async () => {
    const engine = await TreeSitterEngine.load();
    expect(engine.symbols("q/Query.kt", QUERY).map((s) => `${s.name} ${s.range.start}`)).toEqual([
      "Lease 1", "Lease.release 2", "Query 4", "Query.where 5", "Query.eq 6", "Query.typed 7", "Internal 9", "Internal.launch 10",
    ]);
    expect(engine.symbols("q/Use.kt", USE).map((s) => s.name)).toEqual([
      "Use", "Use.assign", "Use.keywordNames", "Use.infix", "Use.newer", "Use.last", "Holder", "Holder.get", "Holder.ready",
    ]);
  });

  it("still reads the calls on those lines", () => {
    expect(callersOf(files, "q/Use.kt#Holder.get")).toEqual(["q/Use.kt#Use.assign"]);
    // The right-hand side of the assignment on line 4, and the last method of the class.
    expect(callersOf(files, "q/Use.kt#Holder.ready")).toEqual(["q/Use.kt#Use.assign", "q/Use.kt#Use.last"]);
    expect(callersOf(files, "q/Query.kt#Internal.launch")).toEqual(["q/Use.kt#Use.keywordNames"]);
    expect(callersOf(files, "q/Query.kt#Query.where")).toEqual(["q/Use.kt#Use.infix"]);
    expect(callersOf(files, "q/Query.kt#Query.eq")).toEqual(["q/Use.kt#Use.infix"]);
    expect(callersOf(files, "q/Query.kt#Query.typed")).toEqual(["q/Use.kt#Use.keywordNames", "q/Use.kt#Use.newer"]);
  });

  it("leaves real keywords alone", async () => {
    const engine = await TreeSitterEngine.load();
    const src = "private enum class Kind { A, B }\ninternal open class Base {\n  open fun run(x: Int) = if (x > 0) x else 0\n  private external fun native(): Int\n}\n";
    expect(engine.symbols("k.kt", src).map((s) => `${s.kind} ${s.name}`)).toEqual(["enum Kind", "class Base", "method Base.run", "method Base.native"]);
  });
});

describe("each language keeps to its own rules (roadmap 32)", () => {
  it("a call is only linked to code of its own language family", () => {
    const files = {
      "ios/Key.swift": "class Key {\n  func serialize() -> Int { 1 }\n}\n",
      "rust/key.rs": "pub struct Key(u8);\nimpl Key {\n    pub fn serialize(&self) -> u8 { self.0 }\n}\n",
      "web/key.js": "function serialize(k) {\n  return k;\n}\n",
      "java/Key.java": "public class Key {\n  public int serialize() { return 1; }\n}\n",
      // Three languages have a Key with serialize(): the name of the type is not enough to tell them apart.
      "java/Use.java": "public class Use {\n  void run(Key key) { key.serialize(); }\n}\n",
      "kotlin/Use.kt": "class UseKt {\n  fun run(key: Key) { key.serialize() }\n}\n",
      "web/use.js": "function run(k) {\n  return serialize(k);\n}\n",
    };
    // Java and Kotlin call each other; neither reaches Swift, Rust or JavaScript.
    expect(callersOf(files, "java/Key.java#Key.serialize")).toEqual(["java/Use.java#Use.run", "kotlin/Use.kt#UseKt.run"]);
    expect(callersOf(files, "ios/Key.swift#Key.serialize")).toEqual([]);
    expect(callersOf(files, "rust/key.rs#Key.serialize")).toEqual([]);
    expect(callersOf(files, "web/key.js#serialize")).toEqual(["web/use.js#run"]);
  });

  it("a variable's type is read only in the forms its language writes", () => {
    // `x: T` is Kotlin, Swift, Python, Rust and Scala; in Java it is the middle of `a ? x : T`.
    expect(typeOfVariable("svc", "return ok ? svc : Other;", ["typeFirst", "constructed"])).toBeNull();
    expect(typeOfVariable("svc", "val svc: Svc = make()", ["cast", "colonType", "constructed"])).toBe("Svc");
    // `T x` is Java, C#, C, C++ and PHP; in Kotlin `Svc svc` declares nothing.
    expect(typeOfVariable("svc", "Svc svc = make();", ["typeFirst", "constructed"])).toBe("Svc");
    expect(typeOfVariable("svc", "Svc svc = make();", ["cast", "colonType", "constructed"])).toBeNull();
    // Java's `for (T x : list)`.
    expect(typeOfVariable("item", "for (OrderItem item : items) {", ["typeFirst", "loopVariable", "constructed"])).toBe("OrderItem");
    expect(typeOfVariable("item", "for (OrderItem item : items) {", ["typeFirst", "constructed"])).toBeNull();
    // Go's `svc *Svc` and Ruby's `Svc.new` are theirs alone.
    expect(typeOfVariable("svc", "func run(svc *Svc) {", ["constructed", "goParam"])).toBe("Svc");
    expect(typeOfVariable("svc", "@svc = Svc.new", ["rubyNew"])).toBe("Svc");
    expect(typeOfVariable("svc", "@svc = Svc.new", ["typeFirst", "constructed"])).toBeNull();
  });

  it("every language says which family it is in and how it writes types", async () => {
    const { LANGUAGES } = await import("../src/infrastructure/parsers/tree-sitter/languages.js");
    expect(LANGUAGES.map((l) => l.id)).toEqual(["javascript", "python", "java", "go", "c_sharp", "php", "ruby", "rust", "kotlin", "swift", "objc", "scala", "c", "cpp"]);
    for (const l of LANGUAGES) expect(l.variableTypes?.length, l.id).toBeGreaterThan(0);
    const family = (id: string) => LANGUAGES.find((l) => l.id === id)!.family;
    expect([family("java"), family("kotlin"), family("scala")]).toEqual(["jvm", "jvm", "jvm"]);
    expect([family("c"), family("cpp")]).toEqual(["c", "c"]);
    expect([family("swift"), family("objc")]).toEqual(["apple", "apple"]);
    expect(family("go")).toBeUndefined();
  });
});

describe("Swift: a library type the repo only adds to (roadmap 34)", () => {
  // The repo adds `ignoreValues` to the library's Signal; `observe` and `filter` stay the library's own.
  const files = {
    "App/Signal+Extras.swift": "extension Signal {\n  func ignoreValues() -> Signal { self }\n}\n",
    "App/TestObserver.swift": "class CombineTestObserver {\n  func observe(_ publisher: Int) {}\n}\n",
    "App/Discovery.swift": "class DiscoveryController {\n  func filter(with params: Int) {}\n}\n",
    "App/Router.swift": [
      "class Router {",
      "  let done: Signal<Int, Never>",
      "  init(deepLink: Signal<Int, Never>) {",
      "    self.done = deepLink.filter { $0 == 1 }.ignoreValues()",
      "  }",
      "  func watch(observer: Int) {",
      "    self.done.observe(observer)",
      "    self.done.ignoreValues()",
      "  }",
      "}",
      "",
    ].join("\n"),
  };

  it("does not tie the library's own methods to another type's", () => {
    expect(callersOf(files, "App/TestObserver.swift#CombineTestObserver.observe(_:)")).toEqual([]);
    expect(callersOf(files, "App/Discovery.swift#DiscoveryController.filter(with:)")).toEqual([]);
  });

  it("still links the methods the repo adds to it", () => {
    expect(callersOf(files, "App/Signal+Extras.swift#Signal.ignoreValues")).toEqual([
      "App/Router.swift#Router.init(deepLink:)",
      "App/Router.swift#Router.watch(observer:)",
    ]);
  });
});

describe("Objective-C, and Objective-C with Swift (roadmap 35)", () => {
  const STORE = [
    '#import "Store.h"', //                                                        1
    '#import "App-Swift.h"', //                                                    2
    "@implementation Store", //                                                    3
    "- (instancetype)initWithName:(NSString *)name {", //                          4
    "    self = [super init];", //                                                 5
    "    return self;", //                                                         6
    "}", //                                                                        7
    "- (void)saveItem:(Item *)item completion:(void (^)(BOOL))completion {", //    8
    "    Cache *cache = [[Cache alloc] initWithSize:10];", //                      9
    '    [cache storeItem:item forKey:@"k"];', //                                  10
    "    [self flush];", //                                                        11
    '    [Logger logMessage:@"saved"];', //                                        12
    "    helper(1);", //                                                           13
    "    [self.button addTarget:self action:@selector(didTap:) forControlEvents:1];", // 14
    "}", //                                                                        15
    "- (void)flush {}", //                                                         16
    "- (void)didTap:(id)sender {}", //                                             17
    "+ (Store *)sharedStore { return [Store new]; }", //                           18
    "@end", //                                                                     19
    "static void helper(int x) {}", //                                             20
    "",
  ].join("\n");
  const SWIFT = [
    "class Cache: NSObject {",
    "  @objc init(size: Int) {}",
    "  @objc",
    "  func storeItem(_ item: Item, forKey key: String) {}",
    "}",
    "class Logger: NSObject {",
    "  @objc static func logMessage(_ text: String) {}",
    "}",
    "class Screen {",
    '  let store = Store(name: "main")',
    "  func run(item: Item) {",
    "    store.saveItem(item) { ok in }",
    "    store.flush()",
    "    let shared = Store.sharedStore()",
    "  }",
    "}",
    "",
  ].join("\n");
  const files = { "App/Store.m": STORE, "App/Cache.swift": SWIFT };

  it("names methods the way Swift sees them", async () => {
    const engine = await TreeSitterEngine.load();
    expect(engine.symbols("App/Store.m", STORE).map((s) => `${s.kind} ${s.name} ${s.range.start}`)).toEqual([
      "class Store 3", "method Store.init(name:) 4", "method Store.saveItem(_:completion:) 8", "method Store.flush 16",
      "method Store.didTap(_:) 17", "method Store.sharedStore 18", "function helper 20",
    ]);
  });

  it("links calls inside Objective-C: messages, C functions, @selector", () => {
    expect(callersOf(files, "App/Store.m#Store.flush")).toEqual(["App/Cache.swift#Screen.run(item:)", "App/Store.m#Store.saveItem(_:completion:)"]);
    expect(callersOf(files, "App/Store.m#helper")).toEqual(["App/Store.m#Store.saveItem(_:completion:)"]);
    expect(callersOf(files, "App/Store.m#Store.didTap(_:)")).toEqual(["App/Store.m#Store.saveItem(_:completion:)"]);
  });

  it("links Objective-C to Swift: alloc/init, methods, class methods", () => {
    const m = "App/Store.m#Store.saveItem(_:completion:)";
    expect(callersOf(files, "App/Cache.swift#Cache.init(size:)")).toEqual([m]);
    expect(callersOf(files, "App/Cache.swift#Cache.storeItem(_:forKey:)")).toEqual([m]);
    expect(callersOf(files, "App/Cache.swift#Logger.logMessage(_:)")).toEqual([m]);
  });

  it("links Swift to Objective-C: methods with a trailing closure, class methods, the class", () => {
    const run = "App/Cache.swift#Screen.run(item:)";
    expect(callersOf(files, "App/Store.m#Store.saveItem(_:completion:)")).toEqual([run]);
    expect(callersOf(files, "App/Store.m#Store.sharedStore")).toEqual([run]);
    expect(callersOf(files, "App/Store.m#Store")).toEqual(["App/Cache.swift#Screen"]);
  });
});

describe("Objective-C calls Swift by the name Objective-C sees (roadmap 39)", () => {
  const SWIFT = [
    "class ThreadList: UIViewController {",
    "  @objc(presentThread:)",
    "  func presentView(_ thread: Thread) {}",
    "  @objc func present(view: UIView) {}",
    "  @objc func move(to point: Int) {}",
    "  @objc func show(_ view: UIView, animated: Bool) {}",
    "  @objc func save(_ item: Int) throws {}",
    "  @objc func load() async {}",
    "  @IBAction func didTap(_ sender: Any) {}",
    "  func hidden(view: UIView) {}",
    "  @objc var isEnabled: Bool { get { true } set {} }",
    "  @objc(isOn) var on: Bool { true }",
    "  @objc init(name: String) {}",
    "}",
    "@objc(MYStore) class Store: NSObject {",
    "  @objc func flush() {}",
    "}",
    "@objcMembers class Cache: NSObject {",
    "  func store(item: Int) {}",
    "}",
    "class Screen {",
    "  func run(list: ThreadList, thread: Thread) {",
    "    list.presentView(thread)",
    "  }",
    "}",
    "",
  ].join("\n");
  const OBJC = [
    '#import "App-Swift.h"',
    "@implementation Inbox",
    "- (void)open:(ThreadList *)list thread:(Thread *)thread {",
    "    [list presentThread:thread];",
    "    [list performSelector:@selector(presentThread:) withObject:thread afterDelay:0];",
    "    [list presentView:thread];",
    "    [list presentWithView:nil];",
    "    [list moveTo:1];",
    "    [list show:nil animated:YES];",
    "    [list save:1 error:nil];",
    "    [list loadWithCompletionHandler:nil];",
    "    [list hiddenWithView:nil];",
    "    [list setIsEnabled:[list isEnabled]];",
    "    [list isOn];",
    "    [[ThreadList alloc] initWithName:@\"a\"];",
    "    [list.button addTarget:self action:@selector(didTap:) forControlEvents:1];",
    "}",
    "- (void)flush {",
    "    MYStore *store = [MYStore new];",
    "    [store flush];",
    "    [self.cache storeWithItem:1];",
    "}",
    "@end",
    "",
  ].join("\n");
  const files = { "App/ThreadList.swift": SWIFT, "App/Inbox.m": OBJC };
  const open = "App/Inbox.m#Inbox.open(_:thread:)";
  const swift = (name: string) => `App/ThreadList.swift#${name}`;

  it("links a message and a @selector to the name @objc(..) gives (Fahad's presentThread:), not to the Swift name", async () => {
    const { collector } = graph.link(Object.entries(files).map(([path, source]) => ({ path, source })));
    const sites = collector.calls.get(`${open}>${swift("ThreadList.presentView(_:)")}>calls`)?.sites.map((s) => s.line);
    // Lines 4 and 5 call it as presentThread:; line 6 writes presentView:, which Objective-C cannot call.
    expect(sites).toEqual([4, 5]);
  });

  it("links to the selector Swift makes for an @objc method: With, prepositions, throws, async", () => {
    for (const target of ["present(view:)", "move(to:)", "show(_:animated:)", "save(_:)", "load", "init(name:)", "didTap(_:)"]) {
      expect(callersOf(files, swift(`ThreadList.${target}`)), target).toEqual([open]);
    }
    // Not seen by Objective-C (no @objc): no selector is made up for it.
    expect(callersOf(files, swift("ThreadList.hidden(view:)"))).toEqual([]);
  });

  it("links a property's getter and setter, also under the name @objc(..) gives", () => {
    expect(callersOf(files, swift("ThreadList.isEnabled"))).toEqual([open]);
    expect(callersOf(files, swift("ThreadList.on"))).toEqual([open]);
  });

  it("reads a type by its Objective-C name, and an @objcMembers class's methods by their selectors", () => {
    expect(callersOf(files, swift("Store.flush"))).toEqual(["App/Inbox.m#Inbox.flush"]);
    expect(callersOf(files, swift("Cache.store(item:)"))).toEqual(["App/Inbox.m#Inbox.flush"]);
  });

  it("gives the page the words Objective-C writes for them, where they are not their own", () => {
    const { meta } = graph.link(Object.entries(files).map(([path, source]) => ({ path, source })));
    const words = (name: string) => meta.get(swift(name))?.objcNames;
    expect(["ThreadList.presentView(_:)", "ThreadList.present(view:)", "ThreadList.isEnabled", "ThreadList.on", "ThreadList.init(name:)", "Store", "ThreadList.show(_:animated:)"].map(words)).toEqual([
      ["presentThread"], ["presentWithView"], ["setIsEnabled"], ["isOn"], ["initWithName"], ["MYStore"], undefined,
    ]);
  });

  it("leaves Swift calls as they were", () => {
    expect(callersOf(files, swift("ThreadList.presentView(_:)"))).toEqual(["App/Inbox.m#Inbox.open(_:thread:)", "App/ThreadList.swift#Screen.run(list:thread:)"]);
    const swiftOnly = { "App/ThreadList.swift": SWIFT + "class Other {\n  func go(list: ThreadList) {\n    list.presentThread(nil)\n  }\n}\n" };
    expect(callersOf(swiftOnly, swift("ThreadList.presentView(_:)"))).toEqual(["App/ThreadList.swift#Screen.run(list:thread:)"]);
  });

  it("adds a @selector to another object's method only for Swift code Objective-C reaches by name, and with a colon", () => {
    const more = {
      "App/Cell.m": "@implementation FancyCell\n- (void)setSeparatorInset:(UIEdgeInsets)inset {}\n@end\n",
      "App/Feed.m": "@implementation Feed\n- (void)configure:(UITableViewCell *)cell {\n    if ([cell respondsToSelector:@selector(setSeparatorInset:)]) { }\n}\n@end\n",
      "App/Cache.swift": "class Cache: NSObject {\n  @objc func reloadData() {}\n}\n",
      "App/List.m": "@implementation List\n- (void)refresh {\n    [self.tableView performSelector:@selector(reloadData) withObject:nil afterDelay:0];\n}\n@end\n",
    };
    // As before: a UIKit selector sent to a UIKit object is not the repo's only method of that name.
    expect(callersOf(more, "App/Cell.m#FancyCell.setSeparatorInset(_:)")).toEqual([]);
    expect(callersOf(more, "App/Cache.swift#Cache.reloadData")).toEqual([]);
  });

  it("puts `error:` of a throwing method before its trailing closures, as the compiler does", () => {
    const loader = {
      "App/Loader.swift": "class Loader: NSObject {\n  @objc func fetch(id: Int, completion: @escaping () -> Void) throws {}\n  @objc func run(completion: (() -> Void)?) throws {}\n}\n",
      "App/Caller.m": [
        "@implementation Caller",
        "- (void)go:(Loader *)loader {",
        "    NSError *e;",
        "    [loader fetchWithId:1 error:&e completion:^{}];", // 4: the selector Swift makes
        "    [loader fetchWithId:1 completion:^{} error:&e];", // 5: no such selector
        "    [loader runAndReturnError:&e completion:nil];", // 6
        "}",
        "@end",
        "",
      ].join("\n"),
    };
    const { collector } = graph.link(Object.entries(loader).map(([path, source]) => ({ path, source })));
    const lines = (to: string) => collector.calls.get(`App/Caller.m#Caller.go(_:)>App/Loader.swift#${to}>calls`)?.sites.map((x) => x.line);
    expect([lines("Loader.fetch(id:completion:)"), lines("Loader.run(completion:)")]).toEqual([[4], [6]]);
  });

  it("reads `override` as a modifier, and names without their backticks", async () => {
    const engine = await TreeSitterEngine.load();
    const src = '@objcMembers class A: NSObject {\n  @available(*, deprecated, message: "do not override") func stop(now: Bool) {}\n  func h(`default`: Int) {}\n  override func viewDidLoad() {}\n}\n';
    expect(engine.symbols("a.swift", src).map((s) => [s.name, s.objcNames])).toEqual([
      ["A", undefined], ["A.stop(now:)", ["stopWithNow(_:)"]], ["A.h(`default`:)", ["hWithDefault(_:)"]], ["A.viewDidLoad", undefined],
    ]);
  });

  it("links an Objective-C call to removed Swift code by its Objective-C name", () => {
    const r = graph.build({
      files: [{ path: "App/Inbox.m", source: "@implementation Inbox\n- (void)open:(id)list {\n    [list presentThread:nil];\n    [list presentView:nil];\n}\n@end\n" }],
      changedIds: [],
      removed: [{ id: "App/List.swift#List.presentView(_:)", name: "List.presentView(_:)", objcNames: ["presentThread(_:)"] }],
      depth: 1,
    });
    // Line 3 calls it; line 4 writes its Swift name, which Objective-C cannot call.
    expect(r.edges.filter((e) => e.kind === "calls-removed").map((e) => `${e.from} ${e.sites!.map((x) => x.line)}`)).toEqual(["App/Inbox.m#Inbox.open(_:) 3"]);
  });

  it("makes the selectors the Swift compiler makes", async () => {
    const { objcSelector } = await import("../src/infrastructure/parsers/tree-sitter/languages/swift.js");
    expect([
      objcSelector("reload", []),
      objcSelector("reload", ["_"]),
      objcSelector("present", ["view"]),
      objcSelector("present", ["_", "animated"]),
      objcSelector("move", ["to"]),
      objcSelector("moveTo", ["point"]),
      objcSelector("init", ["name"]),
      objcSelector("init", ["withName"]),
      objcSelector("save", [], true),
      objcSelector("save", ["_"], true),
      objcSelector("load", [], false, true),
      objcSelector("load", ["id"], true, true),
      // lib/Sema/TypeCheckDeclObjC.cpp: the error parameter goes before trailing closures.
      objcSelector("fetch", ["id", "completion"], true, false, 1),
      objcSelector("run", ["completion"], true, false, 1),
      objcSelector("h", ["`default`"]),
    ]).toEqual([
      "reload", "reload:", "presentWithView:", "present:animated:", "moveTo:", "moveToPoint:", "initWithName:", "initWithName:",
      "saveAndReturnError:", "save:error:", "loadWithCompletionHandler:", "loadWithId:completionHandler:",
      "fetchWithId:error:completion:", "runAndReturnError:completion:", "hWithDefault:",
    ]);
  });
});

describe("where a type is used, in every language (roadmap 41)", () => {
  /** Who writes the type `target`, when only it changed. */
  function usersOf(files: Record<string, string>, target: string, kind = "uses-type"): string[] {
    const r = graph.build({ files: Object.entries(files).map(([path, source]) => ({ path, source })), changedIds: [target], removed: [], depth: 1 });
    return r.edges.filter((e) => e.to === target && e.kind === kind).map((e) => e.from.split("#")[1]).sort();
  }
  const cases: [string, Record<string, string>, string, string[]][] = [
    ["Java: field, parameter, generic, enum constant", {
      "app/Order.java": "public class Order {\n  int total;\n}\n",
      "app/Kind.java": "public enum Kind { ONLINE, SHOP }\n",
      "app/Pay.java": "public class Pay {\n  private Order last;\n  java.util.List<Order> all(Order o) { Kind k = Kind.ONLINE; return null; }\n}\n",
    }, "app/Order.java#Order", ["Pay", "Pay.all"]],
    ["Java: an enum through one of its constants", {
      "app/Kind.java": "public enum Kind { ONLINE, SHOP }\n",
      "app/Pay.java": "public class Pay {\n  boolean online(Object k) { return k == Kind.ONLINE; }\n}\n",
    }, "app/Kind.java#Kind", ["Pay.online"]],
    ["Kotlin: constructor property, nullable field, return type", {
      "app/Order.kt": "data class Order(val total: Int)\n",
      "app/Pay.kt": "class Pay(val o: Order) {\n  private var last: Order? = null\n  fun all(): List<Order> = listOf()\n}\n",
    }, "app/Order.kt#Order", ["Pay", "Pay.all"]],
    ["Swift: protocol adopted, optional field, array return", {
      "App/Order.swift": "struct Order {\n  let total: Int\n}\nprotocol Repo {}\n",
      "App/Pay.swift": "class Pay: Repo {\n  var last: Order?\n  func all() -> [Order] { [] }\n}\n",
    }, "App/Order.swift#Order", ["Pay", "Pay.all"]],
    ["Rust: field, reference, Kind::Online", {
      "src/order.rs": "pub struct Order { pub total: u32 }\npub enum Kind { Online, Shop }\n",
      "src/pay.rs": "use crate::order::{Order, Kind};\npub struct Pay { last: Order }\nimpl Pay {\n  fn all(&self, o: &Order) -> Kind { Kind::Online }\n}\n",
    }, "src/order.rs#Kind", ["Pay.all"]],
    ["C#: base list, field, generic", {
      "App/Order.cs": "public class Order { public int Total; }\n",
      "App/Pay.cs": "public class Pay {\n  private Order last;\n  List<Order> All() { return null; }\n}\n",
    }, "App/Order.cs#Order", ["Pay", "Pay.All"]],
    ["Python: annotations and a base class", {
      "app/order.py": "class Order:\n    total: int\n",
      "app/pay.py": "from app.order import Order\n\nclass Pay(Order):\n    def all(self, o: Order) -> list[Order]:\n        return []\n",
    }, "app/order.py#Order", ["Pay", "Pay.all"]],
    ["Go: a field and a parameter, not the methods' own receiver", {
      "app/order.go": "package app\ntype Order struct { Total int }\nfunc (o *Order) Sum() int { return o.Total }\n",
      "app/pay.go": "package app\ntype Pay struct { last Order }\nfunc (p *Pay) All(o Order) []Order { return nil }\n",
    }, "app/order.go#Order", ["Pay", "Pay.All"]],
    ["C++: a field and a parameter; std::string is not the repo's string", {
      "src/order.hpp": "class Order { public: int total; };\nclass string {};\n",
      "src/pay.cpp": '#include "order.hpp"\nclass Pay {\n  Order last;\n  std::string name;\n  int all(const Order& o) { return 0; }\n};\n',
    }, "src/order.hpp#Order", ["Pay", "Pay.all"]],
  ];
  for (const [what, files, target, expected] of cases) {
    it(what, () => expect(usersOf(files, target)).toEqual(expected));
  }

  it("C++: std::string is not linked to a class of the repo named string", () => {
    const files = { "src/s.hpp": "class string {};\n", "src/pay.cpp": '#include "s.hpp"\nclass Pay {\n  std::string name;\n};\n' };
    expect(usersOf(files, "src/s.hpp#string")).toEqual([]);
  });

  it("a removed type still written is a use of removed code", () => {
    const r = graph.build({
      files: [{ path: "app/Pay.java", source: "public class Pay {\n  private Order last;\n}\n" }],
      changedIds: [],
      removed: [{ id: "app/Order.java#Order", name: "Order" }],
      depth: 1,
    });
    expect(r.edges.map((e) => `${e.from.split("#")[1]} ${e.kind} ${e.to.split("#")[1]}`)).toEqual(["Pay calls-removed Order"]);
  });

  it("a changed method does not bring in the types it mentions", () => {
    const files = {
      "app/Order.java": "public class Order {\n  int total;\n}\n",
      "app/Pay.java": "public class Pay {\n  int all(Order o) { return 1; }\n}\n",
    };
    const r = graph.build({ files: Object.entries(files).map(([path, source]) => ({ path, source })), changedIds: ["app/Pay.java#Pay.all"], removed: [], depth: 1 });
    expect(r.nodes.map((n) => n.id)).toEqual(["app/Pay.java#Pay.all"]);
  });
});
