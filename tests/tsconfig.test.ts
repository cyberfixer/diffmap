import { describe, it, expect, afterEach } from "vitest";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../src/infrastructure/parsers/typescript/ts-morph.adapter.js";
import { TsMorphCallGraph } from "../src/infrastructure/parsers/typescript/ts-morph-call-graph.js";
import { isTsConfig } from "../src/infrastructure/parsers/typescript/tsconfig-resolution.js";

let repo: FixtureRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const SERVICE = (body: string) => `export class OrderService {\n  process(id: number) {\n    return ${body};\n  }\n}\n`;
const PROCESSOR = (from: string, name = "OrderProcessor") =>
  `import { OrderService } from "${from}";\nexport class ${name} {\n  constructor(private readonly orderService: OrderService) {}\n  handle(job: { id: number }) {\n    return this.orderService.process(job.id);\n  }\n}\n`;

/** Write the files, change the service's method, and return who calls it. */
function callersAfterChange(files: Record<string, string>, service: string): string[] {
  repo = createFixtureRepo();
  for (const [path, source] of Object.entries(files)) repo.write(path, source);
  repo.write(service, SERVICE("id"));
  repo.commit("initial");
  repo.write(service, SERVICE("id + 1"));
  repo.commit("change");
  const result = new AnalyzeRangeUseCase(new GitDiffReader(repo.dir), new GitSourceReader(repo.dir), [new TsMorphAdapter()], [new TsMorphCallGraph()]).execute("HEAD~1", "HEAD");
  const target = `${service}#OrderService.process`;
  return result.edges.filter((e) => e.to === target && e.kind === "calls").map((e) => e.from).sort();
}

describe("imports written the way tsconfig.json allows", () => {
  it("a relative import (no tsconfig needed)", () => {
    expect(callersAfterChange({ "src/processors/order.processor.ts": PROCESSOR("../services/order.service") }, "src/services/order.service.ts")).toEqual([
      "src/processors/order.processor.ts#OrderProcessor.handle",
    ]);
  });

  it("baseUrl: import from \"src/...\"", () => {
    expect(
      callersAfterChange(
        { "tsconfig.json": '{ "compilerOptions": { "baseUrl": "./" } }\n', "src/processors/order.processor.ts": PROCESSOR("src/services/order.service") },
        "src/services/order.service.ts",
      ),
    ).toEqual(["src/processors/order.processor.ts#OrderProcessor.handle"]);
  });

  it("paths: import from \"@app/...\", in a tsconfig with comments and trailing commas", () => {
    const tsconfig = `{\n  // aliases\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@app/*": ["src/*"], },\n  },\n}\n`;
    expect(
      callersAfterChange({ "tsconfig.json": tsconfig, "src/processors/order.processor.ts": PROCESSOR("@app/services/order.service") }, "src/services/order.service.ts"),
    ).toEqual(["src/processors/order.processor.ts#OrderProcessor.handle"]);
  });

  it("a monorepo: aliases in tsconfig.base.json, projects that extend it and add their own", () => {
    const files = {
      // Nx-style root: no tsconfig.json, the aliases every project shares.
      "tsconfig.base.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@acme/orders": ["libs/orders/src/index.ts"] } } }\n',
      "libs/orders/src/index.ts": 'export * from "./order.service";\n',
      // A project that extends it (without ".json") and adds an alias of its own, relative to itself.
      "apps/worker/tsconfig.json": '{ "extends": "../../tsconfig.base", "compilerOptions": { "paths": { "@acme/orders": ["../../libs/orders/src/index.ts"], "~/*": ["./src/*"] } } }\n',
      "apps/worker/src/order.processor.ts": PROCESSOR("@acme/orders"),
      "apps/worker/src/jobs.ts": 'import { OrderProcessor } from "~/order.processor";\nexport const run = (p: OrderProcessor) => p.handle({ id: 1 });\n',
      // A project with no tsconfig of its own: the root's aliases.
      "apps/api/src/orders.controller.ts": PROCESSOR("@acme/orders", "OrdersController"),
    };
    expect(callersAfterChange(files, "libs/orders/src/order.service.ts")).toEqual([
      "apps/api/src/orders.controller.ts#OrdersController.handle",
      "apps/worker/src/order.processor.ts#OrderProcessor.handle",
    ]);
  });

  it("knows which files are tsconfig files", () => {
    expect(["tsconfig.json", "apps/a/tsconfig.app.json", "tsconfig.base.json", "web/jsconfig.json"].every(isTsConfig)).toBe(true);
    expect(["package.json", "src/tsconfig.ts", "tsconfig.json.bak"].some(isTsConfig)).toBe(false);
  });
});
