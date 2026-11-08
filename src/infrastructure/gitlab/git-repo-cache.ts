import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MergeRequestInfo, Progress, RepoCachePort } from "../../application/ports/merge-request.port.js";

/**
 * One bare git repository per project under `root`. Each MR fetches only what
 * it is missing (the target branch and GitLab's refs/merge-requests/<iid>/head),
 * authenticated with the signed-in user's token, which is never stored on disk.
 */
export class GitRepoCache implements RepoCachePort {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  async prepare(mr: MergeRequestInfo, token: string, onProgress: (p: Progress) => void = () => {}): Promise<string> {
    const gitDir = join(this.root, mr.projectPath.replace(/[^A-Za-z0-9._-]/g, "_") + ".git");
    onProgress({ step: "Waiting for another download of this project", percent: null, detail: "" });
    return this.locked(gitDir, async () => {
      const firstTime = !existsSync(join(gitDir, "HEAD"));
      const step = firstTime ? "Downloading the code (first time for this project)" : "Fetching new commits";
      onProgress({ step: "Checking the code", percent: null, detail: "" });
      if (firstTime) {
        mkdirSync(gitDir, { recursive: true });
        await git(["init", "--bare", "-q"], gitDir);
      }
      const shas = [mr.diffRefs.baseSha, mr.diffRefs.headSha];
      const missing = () => shas.filter((s) => !hasCommit(gitDir, s));
      if (missing().length === 0) return gitDir;

      const auth = ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`];
      onProgress({ step, percent: null, detail: "Connecting to GitLab" });
      const report = (line: string) => {
        const p = parseGitProgress(line);
        if (p) onProgress({ step, ...p });
      };
      await git(
        [
          ...auth,
          "fetch", "--progress", "--no-tags", mr.cloneUrl,
          `+refs/heads/${mr.targetBranch}:refs/heads/${mr.targetBranch}`,
          `+refs/merge-requests/${mr.iid}/head:refs/merge-requests/${mr.iid}/head`,
        ],
        gitDir,
        report,
      );
      // The base may be gone from the branch (force-push); ask for the commits directly.
      if (missing().length) await git([...auth, "fetch", "-q", "--no-tags", mr.cloneUrl, ...missing()], gitDir).catch(() => {});
      if (missing().length) throw new Error(`Could not fetch commits ${missing().join(", ")} for ${mr.projectPath}.`);
      return gitDir;
    });
  }

  /** Run one task per repository at a time. */
  private locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.locks.set(key, next);
    return next;
  }
}

function hasCommit(gitDir: string, sha: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: gitDir }).status === 0;
}

/**
 * Turn one git progress line into something to show, e.g.
 * "Receiving objects:  45% (450/1000), 12.30 MiB | 3.10 MiB/s" ->
 * { percent: 45, detail: "Receiving objects 45% · 12.30 MiB" }.
 */
export function parseGitProgress(line: string): { percent: number; detail: string } | null {
  const m = line.match(/(Counting|Compressing|Receiving|Resolving|Enumerating) (objects|deltas):\s+(\d+)%(?:[^,]*,\s*([\d.]+ [KMG]iB))?/);
  if (!m) return null;
  const percent = Number(m[3]);
  // Receiving is the long part; the other phases count towards the bar less.
  const weight: Record<string, [number, number]> = {
    Enumerating: [0, 2], Counting: [2, 5], Compressing: [5, 10], Receiving: [10, 90], Resolving: [90, 100],
  };
  const [from, to] = weight[m[1]];
  return {
    percent: Math.round(from + ((to - from) * percent) / 100),
    detail: `${m[1]} ${m[2]} ${percent}%${m[4] ? ` · ${m[4]}` : ""}`,
  };
}

function git(args: string[], cwd: string, onLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let err = "";
    p.stderr.on("data", (d) => {
      const text = String(d);
      err = (err + text).slice(-4000);
      if (onLine) for (const line of text.split(/[\r\n]+/)) if (line) onLine(line);
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : // Never echo the auth header back.
          reject(new Error(`git ${args.find((a) => !a.startsWith("http.extraHeader") && a !== "-c")} failed: ${err.trim().slice(0, 300)}`)),
    );
  });
}
