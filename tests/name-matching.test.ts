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
