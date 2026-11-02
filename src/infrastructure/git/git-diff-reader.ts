import { spawnSync } from "node:child_process";
import type { DiffReaderPort } from "../../application/ports/diff-reader.port.js";
import type { FileChange } from "../../domain/file-change.js";
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
