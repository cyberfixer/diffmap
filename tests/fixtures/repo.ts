import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface FixtureRepo {
  dir: string;
  /** Write a file (relative to repo root) and stage it. */
  write(relPath: string, content: string): void;
  /** Create a commit with all staged changes. */
  commit(message: string): string;
  cleanup(): void;
}

/** Create a temporary git repository for tests. Returns a FixtureRepo handle. */
export function createFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), "gitmap-test-"));

  function git(...args: string[]): string {
    const result = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        // Stable identity so commits work without global git config
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.invalid",
        GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
      },
    });
    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed:\n${result.stderr}`.trim()
      );
    }
    return result.stdout.trim();
  }

  git("init", "-b", "main");

  return {
    dir,
    write(relPath: string, content: string): void {
      const full = join(dir, relPath);
      mkdirSync(join(dir, relPath, ".."), { recursive: true });
      writeFileSync(full, content, "utf-8");
      git("add", relPath);
    },
    commit(message: string): string {
      return git("commit", "-m", message);
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
