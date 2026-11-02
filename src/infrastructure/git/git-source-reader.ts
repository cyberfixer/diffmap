import { spawnSync } from "node:child_process";
import type { SourceReaderPort } from "../../application/ports/source-reader.port.js";

export class GitSourceReader implements SourceReaderPort {
  constructor(private readonly cwd?: string) {}

  getSource(rev: string, filePath: string): string | null {
    const result = spawnSync("git", ["show", `${rev}:${filePath}`], {
      encoding: "utf-8",
      cwd: this.cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) return null;
    return result.stdout;
  }
}
