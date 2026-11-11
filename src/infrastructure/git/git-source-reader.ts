import { spawnSync } from "node:child_process";
import type { SourceReaderPort } from "../../application/ports/source-reader.port.js";

/** Files larger than this are not read (as before, when each file was read on its own). */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Files asked for in one git process; keeps the memory of one answer bounded. */
const BATCH_SIZE = 1000;
const BATCH_MAX_BYTES = 1024 * 1024 * 1024;
const NEWLINE = 0x0a;

export class GitSourceReader implements SourceReaderPort {
  constructor(private readonly cwd?: string) {}

  getSource(rev: string, filePath: string): string | null {
    const result = spawnSync("git", ["show", `${rev}:${filePath}`], {
      encoding: "utf-8",
      cwd: this.cwd,
      maxBuffer: MAX_FILE_BYTES,
    });
    if (result.status !== 0) return null;
    return result.stdout;
  }

  /**
   * Many files in one git process (`git cat-file --batch`) instead of one
   * process per file: starting git is by far the slowest part of reading a repo.
   */
  getSources(rev: string, filePaths: string[]): Map<string, string | null> {
    const sources = new Map<string, string | null>();
    // A name with a line break cannot be sent on git's line-per-file input.
    const batchable = filePaths.filter((p) => !p.includes("\n"));
    for (const p of filePaths) if (p.includes("\n")) sources.set(p, this.getSource(rev, p));

    for (let i = 0; i < batchable.length; i += BATCH_SIZE) {
      const chunk = batchable.slice(i, i + BATCH_SIZE);
      const contents = this.readBatch(rev, chunk);
      chunk.forEach((p, n) => sources.set(p, contents ? contents[n] : this.getSource(rev, p)));
    }
    return sources;
  }

  listFiles(rev: string): string[] {
    const result = spawnSync("git", ["ls-tree", "-r", "--name-only", rev], {
      encoding: "utf-8",
      cwd: this.cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (result.status !== 0) return [];
    return result.stdout.split("\n").filter(Boolean);
  }

  /** One entry per path, in order; null for the whole batch when git's answer cannot be used. */
  private readBatch(rev: string, filePaths: string[]): (string | null)[] | null {
    const result = spawnSync("git", ["cat-file", "--batch"], {
      input: filePaths.map((p) => `${rev}:${p}\n`).join(""),
      cwd: this.cwd,
      maxBuffer: BATCH_MAX_BYTES,
    });
    if (result.status !== 0 || result.error) return null;

    // Each answer is "<sha> <type> <size>\n<contents>\n", or one line such as "<name> missing".
    const out = result.stdout;
    const contents: (string | null)[] = [];
    let pos = 0;
    for (let n = 0; n < filePaths.length; n++) {
      const lineEnd = out.indexOf(NEWLINE, pos);
      if (lineEnd === -1) return null;
      const header = out.toString("utf-8", pos, lineEnd).match(/^[0-9a-f]+ (\w+) (\d+)$/);
      pos = lineEnd + 1;
      if (!header) {
        contents.push(null);
        continue;
      }
      const size = Number(header[2]);
      if (pos + size > out.length) return null;
      contents.push(header[1] === "blob" && size <= MAX_FILE_BYTES ? out.toString("utf-8", pos, pos + size) : null);
      pos += size + 1;
    }
    return contents;
  }
}
