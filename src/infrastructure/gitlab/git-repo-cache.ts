import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MergeRequestInfo, RepoCachePort } from "../../application/ports/merge-request.port.js";

/**
 * One bare git repository per project under `root`. Each MR fetches only what
 * it is missing (the target branch and GitLab's refs/merge-requests/<iid>/head),
 * authenticated with the signed-in user's token, which is never stored on disk.
 */
export class GitRepoCache implements RepoCachePort {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  async prepare(mr: MergeRequestInfo, token: string): Promise<string> {
    const gitDir = join(this.root, mr.projectPath.replace(/[^A-Za-z0-9._-]/g, "_") + ".git");
    return this.locked(gitDir, async () => {
      if (!existsSync(join(gitDir, "HEAD"))) {
        mkdirSync(gitDir, { recursive: true });
        await git(["init", "--bare", "-q"], gitDir);
      }
      const shas = [mr.diffRefs.baseSha, mr.diffRefs.headSha];
      const missing = () => shas.filter((s) => !hasCommit(gitDir, s));
      if (missing().length === 0) return gitDir;

      const auth = ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`];
      await git(
        [
          ...auth,
          "fetch", "-q", "--no-tags", mr.cloneUrl,
          `+refs/heads/${mr.targetBranch}:refs/heads/${mr.targetBranch}`,
          `+refs/merge-requests/${mr.iid}/head:refs/merge-requests/${mr.iid}/head`,
        ],
        gitDir,
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

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : // Never echo the auth header back.
          reject(new Error(`git ${args.find((a) => !a.startsWith("http.extraHeader") && a !== "-c")} failed: ${err.trim().slice(0, 300)}`)),
    );
  });
}
