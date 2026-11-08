import { describe, it, expect, afterEach } from "vitest";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../src/infrastructure/parsers/typescript/ts-morph.adapter.js";

function makeAnalyzer(cwd: string) {
  return new AnalyzeRangeUseCase(
    new GitDiffReader(cwd),
    new GitSourceReader(cwd),
    [new TsMorphAdapter()],
  );
}

let repo: FixtureRepo | null = null;

afterEach(() => {
  repo?.cleanup();
  repo = null;
});

const V1 = `\
export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  multiply(a: number, b: number): number {
    return a * b;
  }
}
`;

const V2 = `\
export function add(a: number, b: number): number {
  return a + b + 0; // modified
}

export class Calculator {
  multiply(a: number, b: number): number {
    return a * b * 1; // modified
  }

  divide(a: number, b: number): number {
    return a / b;
  }
}
`;

describe("TypeScript symbol analysis", () => {
  it("detects modified functions and methods", () => {
    repo = createFixtureRepo();
    repo.write("src/calc.ts", V1);
    repo.commit("initial");

    repo.write("src/calc.ts", V2);
    repo.commit("modify add and multiply, add divide");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const byName = Object.fromEntries(result.symbols.map((s) => [s.name, s]));

    expect(byName["add"].status).toBe("modified");
    expect(byName["add"].kind).toBe("function");

    expect(byName["Calculator.multiply"].status).toBe("modified");
    expect(byName["Calculator.multiply"].kind).toBe("method");

    expect(byName["Calculator.divide"].status).toBe("added");
    expect(byName["Calculator.divide"].kind).toBe("method");
    expect(byName["Calculator.divide"].baseRange).toBeNull();
    expect(byName["Calculator.divide"].headRange).not.toBeNull();
  });

  it("marks an existing function as modified when lines are only added", () => {
    repo = createFixtureRepo();
    repo.write("src/svc.ts", `export function update(id: number) {\n  return id;\n}\n`);
    repo.commit("initial");

    repo.write(
      "src/svc.ts",
      `export function update(id: number) {\n  if (id < 0) throw new Error("bad");\n  return id;\n}\n`
    );
    repo.commit("add guard");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const sym = result.symbols.find((s) => s.name === "update");

    expect(sym!.status).toBe("modified");
    expect(sym!.baseRange).not.toBeNull();
    expect(sym!.headRange).not.toBeNull();
  });

  it("marks an existing function as modified when lines are only removed", () => {
    repo = createFixtureRepo();
    repo.write(
      "src/svc.ts",
      `export function update(id: number) {\n  console.log(id);\n  return id;\n}\n`
    );
    repo.commit("initial");

    repo.write("src/svc.ts", `export function update(id: number) {\n  return id;\n}\n`);
    repo.commit("drop log");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const sym = result.symbols.find((s) => s.name === "update");

    expect(sym!.status).toBe("modified");
  });

  it("marks a deleted function as removed", () => {
    repo = createFixtureRepo();
    repo.write("src/utils.ts", `export function greet(name: string): string {\n  return 'Hello ' + name;\n}\n`);
    repo.commit("initial");

    repo.write("src/utils.ts", `// greet removed\n`);
    repo.commit("remove greet");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const greet = result.symbols.find((s) => s.name === "greet");

    expect(greet).toBeDefined();
    expect(greet!.status).toBe("removed");
    expect(greet!.headRange).toBeNull();
  });

  it("marks a new file's function as added", () => {
    repo = createFixtureRepo();
    repo.write("README.md", "# diffmap\n");
    repo.commit("initial");

    repo.write("src/new.ts", `export function newThing(): void {\n  console.log('hello');\n}\n`);
    repo.commit("add new file");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const newThing = result.symbols.find((s) => s.name === "newThing");

    expect(newThing).toBeDefined();
    expect(newThing!.status).toBe("added");
    expect(newThing!.baseRange).toBeNull();
  });

  it("captures top-level changes outside any symbol", () => {
    repo = createFixtureRepo();
    repo.write("src/config.ts", `export const VERSION = '1.0.0';\n`);
    repo.commit("initial");

    repo.write("src/config.ts", `export const VERSION = '2.0.0';\n`);
    repo.commit("bump version");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const topLevel = result.symbols.find((s) => s.kind === "top-level");

    expect(topLevel).toBeDefined();
    expect(topLevel!.file).toBe("src/config.ts");
  });
});
