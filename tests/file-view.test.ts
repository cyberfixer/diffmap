import { describe, it, expect, afterEach } from "vitest";
import { buildFileView } from "../src/application/file-view.js";
import type { FileChange } from "../src/domain/file-change.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../src/infrastructure/parsers/typescript/ts-morph.adapter.js";

describe("buildFileView", () => {
  it("interleaves deleted lines at their original position", () => {
    const head = "a\nB2\nc\nd\n"; // base was: a, b, c, x, d
    const fc: FileChange = {
      path: "f.ts",
      basePath: "f.ts",
      headPath: "f.ts",
      removedLines: new Set([2, 4]),
      addedLines: new Set([2]),
      lines: [
        { type: "ctx", oldLine: 1, newLine: 1, text: "a" },
        { type: "del", oldLine: 2, newLine: null, text: "b" },
        { type: "add", oldLine: null, newLine: 2, text: "B2" },
        { type: "ctx", oldLine: 3, newLine: 3, text: "c" },
        { type: "del", oldLine: 4, newLine: null, text: "x" },
        { type: "ctx", oldLine: 5, newLine: 4, text: "d" },
      ],
    };

    const view = buildFileView(fc, null, head)!;

    expect(view.status).toBe("modified");
    expect(view.lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      "ctx:a",
      "del:b",
      "add:B2",
      "ctx:c",
      "del:x",
      "ctx:d",
    ]);
    expect(view.lines.at(-1)).toMatchObject({ oldLine: 5, newLine: 4 });
  });

  it("keeps lines deleted at the very end of the file", () => {
    const fc: FileChange = {
      path: "f.ts",
      basePath: "f.ts",
      headPath: "f.ts",
      removedLines: new Set([2]),
      addedLines: new Set(),
      lines: [
        { type: "ctx", oldLine: 1, newLine: 1, text: "a" },
        { type: "del", oldLine: 2, newLine: null, text: "gone" },
      ],
    };
    const view = buildFileView(fc, null, "a\n")!;
    expect(view.lines.map((l) => l.type)).toEqual(["ctx", "del"]);
  });

  it("shows a deleted file entirely as removed lines", () => {
    const fc: FileChange = {
      path: "old.ts",
      basePath: "old.ts",
      headPath: null,
      removedLines: new Set([1, 2]),
      addedLines: new Set(),
      lines: [],
    };
    const view = buildFileView(fc, "x\ny\n", null)!;
    expect(view.status).toBe("deleted");
    expect(view.lines.map((l) => l.type)).toEqual(["del", "del"]);
  });
});

let repo: FixtureRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

describe("AnalysisResult.files", () => {
  it("contains the whole changed file, with unchanged lines as context", () => {
    repo = createFixtureRepo();
    const v1 = "// header\nimport x from 'y';\n\nexport function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n";
    repo.write("src/m.ts", v1);
    repo.commit("initial");
    repo.write("src/m.ts", v1.replace("return 1;", "return 10;"));
    repo.commit("change a");

    const result = new AnalyzeRangeUseCase(
      new GitDiffReader(repo.dir),
      new GitSourceReader(repo.dir),
      [new TsMorphAdapter()],
    ).execute("HEAD~1", "HEAD");

    expect(result.files).toHaveLength(1);
    const lines = result.files[0].lines;
    expect(lines.filter((l) => l.type !== "del")).toHaveLength(10); // every head line
    expect(lines.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["  return 10;"]);
    expect(lines.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["  return 1;"]);
    expect(lines[0]).toMatchObject({ type: "ctx", text: "// header" });
  });
});
