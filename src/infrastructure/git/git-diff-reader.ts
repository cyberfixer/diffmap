import { spawnSync } from "node:child_process";
import type { DiffReaderPort } from "../../application/ports/diff-reader.port.js";
import type { FileChange } from "../../domain/file-change.js";
import type { RangeInfo } from "../../domain/analysis-result.js";
import { parseDiffText } from "../parsers/diff/parse-diff.adapter.js";

export class GitDiffReader implements DiffReaderPort {
  constructor(private readonly cwd?: string) {}

  getFileChanges(base: string, head: string): FileChange[] {
    const diffText = this.run([
      "git", "diff", `${base}...${head}`,
    ]);
    return parseDiffText(diffText);
  }

  getMergeBase(a: string, b: string): string {
    return this.run(["git", "merge-base", a, b]).trim();
  }

  resolveRef(ref: string): string {
    return this.run(["git", "rev-parse", ref]).trim();
  }

  describeRange(base: string, head: string, mergeBase: string): RangeInfo {
    // A branch name when the ref is (or points at) a branch, else a short SHA.
    const name = (ref: string): string => {
      const branch = this.tryRun(["git", "rev-parse", "--abbrev-ref", ref]).trim();
      if (branch && branch !== "HEAD") return branch;
      return this.tryRun(["git", "rev-parse", "--short", ref]).trim() || ref;
    };
    const subjects = this.tryRun(["git", "log", "--reverse", "--format=%s", `${mergeBase}..${head}`])
      .split("\n")
      .filter(Boolean);
    return {
      baseName: name(base),
      headName: name(head),
      commits: subjects.length,
      title: subjects[0] ?? null,
    };
  }

  private tryRun(args: string[]): string {
    try {
      return this.run(args);
    } catch {
      return "";
    }
  }

  private run(args: string[]): string {
    const result = spawnSync(args[0], args.slice(1), {
      encoding: "utf-8",
      cwd: this.cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(
        `${args.join(" ")} failed:\n${result.stderr ?? ""}`.trim()
      );
    }
    return result.stdout;
  }
}
