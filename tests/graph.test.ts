import { describe, it, expect, afterEach } from "vitest";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../src/infrastructure/parsers/typescript/ts-morph.adapter.js";
import { TsMorphCallGraph } from "../src/infrastructure/parsers/typescript/ts-morph-call-graph.js";

function makeAnalyzer(cwd: string) {
  return new AnalyzeRangeUseCase(
    new GitDiffReader(cwd),
    new GitSourceReader(cwd),
    [new TsMorphAdapter()],
    [new TsMorphCallGraph()],
  );
}

let repo: FixtureRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const SERVICE_V1 = `export class TasksService {
  findOne(id: number) {
    return { id };
  }
  update(id: number) {
    return this.findOne(id);
  }
}
`;

const SERVICE_V2 = `export class TasksService {
  findOne(id: number) {
    return { id };
  }
  update(id: number) {
    if (id < 0) throw new Error("bad");
    return this.findOne(id);
  }
}
`;

const CONTROLLER = `import { TasksService } from "./tasks.service";

@Controller("tasks")
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Patch(":id")
  update(id: number) {
    return this.service.update(id);
  }
}
`;

describe("symbol diffs", () => {
  it("attaches the symbol's own add/del/context lines", () => {
    repo = createFixtureRepo();
    repo.write("src/tasks.service.ts", SERVICE_V1);
    repo.commit("initial");
    repo.write("src/tasks.service.ts", SERVICE_V2);
    repo.commit("guard");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const sym = result.symbols.find((s) => s.name === "TasksService.update")!;

    expect(sym.id).toBe("src/tasks.service.ts#TasksService.update");
    const added = sym.diff.filter((l) => l.type === "add");
    expect(added).toHaveLength(1);
    expect(added[0].text).toContain("throw new Error");
    expect(added[0].oldLine).toBeNull();
    expect(sym.diff.some((l) => l.type === "ctx")).toBe(true);
  });
});

describe("call graph", () => {
  it("links a changed method to its caller in another file", () => {
    repo = createFixtureRepo();
    repo.write("src/tasks.service.ts", SERVICE_V1);
    repo.write("src/tasks.controller.ts", CONTROLLER);
    repo.commit("initial");
    repo.write("src/tasks.service.ts", SERVICE_V2);
    repo.commit("guard");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const byId = new Map(result.nodes.map((n) => [n.id, n]));

    const changed = byId.get("src/tasks.service.ts#TasksService.update")!;
    const caller = byId.get("src/tasks.controller.ts#TasksController.update")!;
    const callee = byId.get("src/tasks.service.ts#TasksService.findOne")!;

    expect(changed.changed).toBe(true);
    expect(changed.status).toBe("modified");
    expect(caller.changed).toBe(false);
    expect(caller.labels).toEqual(['@Patch(":id")']);
    expect(callee.changed).toBe(false);

    expect(result.edges).toContainEqual({
      from: caller.id,
      to: changed.id,
      kind: "calls",
    });
    expect(result.edges).toContainEqual({
      from: changed.id,
      to: callee.id,
      kind: "calls",
    });
  });

  it("ignores calls into external packages", () => {
    repo = createFixtureRepo();
    repo.write(
      "src/a.ts",
      `import { pick } from "lodash";\nexport function a(o: object) {\n  return pick(o, "x");\n}\n`
    );
    repo.commit("initial");
    repo.write(
      "src/a.ts",
      `import { pick } from "lodash";\nexport function a(o: object) {\n  return pick(o, "y");\n}\n`
    );
    repo.commit("change");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    expect(result.nodes.map((n) => n.name)).toEqual(["a"]);
    expect(result.edges).toHaveLength(0);
  });

  it("flags callers that still call a removed symbol", () => {
    repo = createFixtureRepo();
    repo.write(
      "src/svc.ts",
      `export class Svc {\n  count() {\n    return 1;\n  }\n  other() {\n    return 2;\n  }\n}\n`
    );
    repo.write(
      "src/use.ts",
      `import { Svc } from "./svc";\nexport function use(s: Svc) {\n  return s.count();\n}\n`
    );
    repo.commit("initial");

    repo.write(
      "src/svc.ts",
      `export class Svc {\n  other() {\n    return 2;\n  }\n}\n`
    );
    repo.commit("drop count");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const removed = result.nodes.find((n) => n.name === "Svc.count")!;

    expect(removed.status).toBe("removed");
    expect(result.edges).toContainEqual({
      from: "src/use.ts#use",
      to: "src/svc.ts#Svc.count",
      kind: "calls-removed",
    });
  });
});
