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

describe("AnalyzeRangeUseCase output shape", () => {
  it("returns valid AnalysisResult JSON", () => {
    repo = createFixtureRepo();
    repo.write("src/math.ts", `export function square(n: number): number {\n  return n * n;\n}\n`);
    repo.commit("initial");

    repo.write("src/math.ts", `export function square(n: number): number {\n  return n ** 2;\n}\n`);
    repo.commit("use ** operator");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");

    expect(typeof result.base).toBe("string");
    expect(typeof result.head).toBe("string");
    expect(result.base).toHaveLength(40);
    expect(result.head).toHaveLength(40);
    expect(Array.isArray(result.symbols)).toBe(true);

    const sym = result.symbols[0];
    expect(sym).toMatchObject({
      file: "src/math.ts",
      name: "square",
      kind: "function",
      status: "modified",
    });
    expect(sym.baseRange).not.toBeNull();
    expect(sym.headRange).not.toBeNull();
    expect(sym.baseRange!.start).toBeGreaterThanOrEqual(1);
    expect(sym.baseRange!.end).toBeGreaterThanOrEqual(sym.baseRange!.start);
  });

  it("ignores non-TypeScript files", () => {
    repo = createFixtureRepo();
    repo.write("README.md", "# initial\n");
    repo.commit("initial");

    repo.write("README.md", "# updated\n");
    repo.commit("update readme");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    expect(result.symbols).toHaveLength(0);
  });

  it("handles arrow functions assigned to variables", () => {
    repo = createFixtureRepo();
    repo.write("src/arrows.ts", `export const double = (n: number): number => n * 2;\n`);
    repo.commit("initial");

    repo.write("src/arrows.ts", `export const double = (n: number): number => n + n;\n`);
    repo.commit("change double impl");

    const result = makeAnalyzer(repo.dir).execute("HEAD~1", "HEAD");
    const sym = result.symbols.find((s) => s.name === "double");

    expect(sym).toBeDefined();
    expect(sym!.kind).toBe("arrow");
    expect(sym!.status).toBe("modified");
  });
});
