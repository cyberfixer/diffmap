import { describe, it, expect, afterEach } from "vitest";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";
import { analyzeRange } from "../src/analyzer/index.js";

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
  it("detects modified functions and methods", async () => {
    repo = createFixtureRepo();
    repo.write("src/calc.ts", V1);
    repo.commit("initial");

    repo.write("src/calc.ts", V2);
    repo.commit("modify add and multiply, add divide");

    const result = await analyzeRange("HEAD~1", "HEAD", repo.dir);

    const byName = Object.fromEntries(
      result.symbols.map((s) => [s.name, s])
    );

    expect(byName["add"].status).toBe("modified");
    expect(byName["add"].kind).toBe("function");

    expect(byName["Calculator.multiply"].status).toBe("modified");
    expect(byName["Calculator.multiply"].kind).toBe("method");

    expect(byName["Calculator.divide"].status).toBe("added");
    expect(byName["Calculator.divide"].kind).toBe("method");
    expect(byName["Calculator.divide"].baseRange).toBeNull();
    expect(byName["Calculator.divide"].headRange).not.toBeNull();
  });

  it("marks a deleted function as removed", async () => {
    repo = createFixtureRepo();
    repo.write("src/utils.ts", `export function greet(name: string): string {\n  return 'Hello ' + name;\n}\n`);
    repo.commit("initial");

    repo.write("src/utils.ts", `// greet removed\n`);
    repo.commit("remove greet");

    const result = await analyzeRange("HEAD~1", "HEAD", repo.dir);
    const greet = result.symbols.find((s) => s.name === "greet");

    expect(greet).toBeDefined();
    expect(greet!.status).toBe("removed");
    expect(greet!.headRange).toBeNull();
  });

  it("marks a new file's function as added", async () => {
    repo = createFixtureRepo();
    // Need an initial commit so HEAD~1 exists
    repo.write("README.md", "# gitmap\n");
    repo.commit("initial");

    repo.write("src/new.ts", `export function newThing(): void {\n  console.log('hello');\n}\n`);
    repo.commit("add new file");

    const result = await analyzeRange("HEAD~1", "HEAD", repo.dir);
    const newThing = result.symbols.find((s) => s.name === "newThing");

    expect(newThing).toBeDefined();
    expect(newThing!.status).toBe("added");
    expect(newThing!.baseRange).toBeNull();
  });

  it("captures top-level changes outside any symbol", async () => {
    repo = createFixtureRepo();
    repo.write("src/config.ts", `export const VERSION = '1.0.0';\n`);
    repo.commit("initial");

    repo.write("src/config.ts", `export const VERSION = '2.0.0';\n`);
    repo.commit("bump version");

    const result = await analyzeRange("HEAD~1", "HEAD", repo.dir);
    const topLevel = result.symbols.find((s) => s.kind === "top-level");

    expect(topLevel).toBeDefined();
    expect(topLevel!.file).toBe("src/config.ts");
  });
});
