import { spawnSync } from "node:child_process";

function run(args: string[], cwd?: string): string {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf-8",
    cwd,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git command failed: ${args.join(" ")}\n${result.stderr ?? ""}`.trim()
    );
  }
  return result.stdout;
}

/** Return the raw unified diff between two refs (triple-dot merge-base diff). */
export function gitDiff(base: string, head: string, cwd?: string): string {
  return run(["git", "diff", `${base}...${head}`], cwd);
}

/**
 * Return the contents of a file at a specific revision, or null if the file
 * does not exist in that revision.
 */
export function gitShow(
  rev: string,
  filePath: string,
  cwd?: string
): string | null {
  const result = spawnSync("git", ["show", `${rev}:${filePath}`], {
    encoding: "utf-8",
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/** Return the merge-base commit of two refs. */
export function gitMergeBase(a: string, b: string, cwd?: string): string {
  return run(["git", "merge-base", a, b], cwd).trim();
}

/** Resolve a ref to its full SHA. */
export function gitRevParse(ref: string, cwd?: string): string {
  return run(["git", "rev-parse", ref], cwd).trim();
}
