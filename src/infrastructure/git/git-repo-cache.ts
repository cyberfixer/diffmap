import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MergeRequestInfo, Progress, RepoCachePort } from "../../application/ports/merge-request.port.js";

export interface RepoCacheLimits {
  /** Total size of all project copies; above it the least recently used projects are removed. */
  maxBytes: number;
  /** A project used this recently is never removed, even over the limit (default 1 hour). */
  keepRecentMs?: number;
  /** Review refs (merge or pull requests) whose newest commit is older than this are dropped (default 30 days). */
  reviewRefMaxAgeMs?: number;
}

/** The room the code cache takes, for the dashboard. */
export interface RepoCacheUsage {
  /** Biggest first. `name` is the project's path with "/" written as "_". */
  projects: { name: string; bytes: number; lastUsed: number }[];
  totalBytes: number;
  /** The limit (CACHE_MAX_GB), or null for none. */
  maxBytes: number | null;
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Files diffmap keeps inside each bare repo; their times say when it was last used / tidied. */
const USED_MARK = "diffmap-used";
const TIDIED_MARK = "diffmap-tidied";
/** Measuring the whole cache walks every file, so do it at most this often. */
const TRIM_EVERY_MS = 10 * 60_000;

/**
 * One bare git repository per project under `root`. Each review fetches only what
 * it is missing (the target branch and the host's review ref, e.g.
 * refs/merge-requests/<iid>/head on GitLab or refs/pull/<n>/head on GitHub),
 * authenticated with the signed-in user's token, which is never stored on disk.
 *
 * The cache stays under `limits.maxBytes`: after a review, projects that have
 * not been used for the longest time are deleted (they are downloaded again
 * if someone opens them later). Once a day per project, review refs older than
 * `reviewRefMaxAgeMs` are dropped and git compacts what is left.
 */
export class GitRepoCache implements RepoCachePort {
  private locks = new Map<string, Promise<unknown>>();
  private trimming: Promise<void> | null = null;
  private lastTrim = 0;
  private readonly keepRecentMs: number;
  private readonly reviewRefMaxAgeMs: number;

  constructor(
    private readonly root: string,
    private readonly limits: RepoCacheLimits = { maxBytes: Infinity },
  ) {
    this.keepRecentMs = limits.keepRecentMs ?? HOUR;
    this.reviewRefMaxAgeMs = limits.reviewRefMaxAgeMs ?? 30 * DAY;
  }

  async prepare(mr: MergeRequestInfo, token: string, onProgress: (p: Progress) => void = () => {}): Promise<string> {
    const gitDir = join(this.root, mr.projectPath.replace(/[^A-Za-z0-9._-]/g, "_") + ".git");
    onProgress({ step: "Waiting for another download of this project", percent: null, detail: "" });
    const fetched = await this.locked(gitDir, async () => {
      const did = await this.fetch(gitDir, mr, token, onProgress);
      writeFileSync(join(gitDir, USED_MARK), "");
      return did;
    });
    // Housekeeping runs after the review has its code, so it never slows it down.
    if (fetched) {
      this.locked(gitDir, () => this.tidy(gitDir, mr.fetchRef)).catch(() => {});
      this.trimSoon();
    }
    return gitDir;
  }

  /** Fetch whatever of the MR's base and head is missing; returns whether anything was fetched. */
  private async fetch(gitDir: string, mr: MergeRequestInfo, token: string, onProgress: (p: Progress) => void): Promise<boolean> {
    const firstTime = !existsSync(join(gitDir, "HEAD"));
    const step = firstTime ? "Downloading the code (first time for this project)" : "Fetching new commits";
    onProgress({ step: "Checking the code", percent: null, detail: "" });
    if (firstTime) {
      mkdirSync(gitDir, { recursive: true });
      await git(["init", "--bare", "-q"], gitDir);
    }
    const shas = [mr.diffRefs.baseSha, mr.diffRefs.headSha];
    const missing = () => shas.filter((s) => !hasCommit(gitDir, s));
    if (missing().length === 0) return false;

    const auth = ["-c", `http.extraHeader=Authorization: Basic ${Buffer.from(`${mr.gitUser}:${token}`).toString("base64")}`];
    onProgress({ step, percent: null, detail: "Connecting to the code host" });
    const report = (line: string) => {
      const p = parseGitProgress(line);
      if (p) onProgress({ step, ...p });
    };
    await git(
      [
        ...auth,
        "fetch", "--progress", "--no-tags", mr.cloneUrl,
        `+refs/heads/${mr.targetBranch}:refs/heads/${mr.targetBranch}`,
        `+${mr.fetchRef}:${mr.fetchRef}`,
      ],
      gitDir,
      report,
    );
    // The base may be gone from the branch (force-push); ask for the commits directly.
    if (missing().length) await git([...auth, "fetch", "-q", "--no-tags", mr.cloneUrl, ...missing()], gitDir).catch(() => {});
    if (missing().length) throw new Error(`Could not fetch commits ${missing().join(", ")} for ${mr.projectPath}.`);
    return true;
  }

  /**
   * Once a day per project: drop review refs whose newest commit is older than
   * `reviewRefMaxAgeMs` (closed or stale reviews), then let git compact the repo.
   * `keepRef` (the review just fetched) is always kept.
   */
  async tidy(gitDir: string, keepRef: string, now = Date.now()): Promise<number> {
    const mark = join(gitDir, TIDIED_MARK);
    const last = await stat(mark).then((s) => s.mtimeMs, () => 0);
    if (now - last < DAY) return 0;
    writeFileSync(mark, "");
    const lines = (await gitOut(["for-each-ref", "--format=%(committerdate:unix) %(refname)", "refs/merge-requests", "refs/pull"], gitDir))
      .split("\n")
      .filter(Boolean);
    const old = lines
      .map((l) => l.split(" "))
      .filter(([when, ref]) => ref !== keepRef && now - Number(when) * 1000 > this.reviewRefMaxAgeMs)
      .map(([, ref]) => ref);
    if (old.length) await git(["update-ref", "--stdin"], gitDir, undefined, old.map((r) => `delete ${r}\n`).join(""));
    await git(["gc", "-q", "--auto"], gitDir);
    if (old.length) await git(["gc", "-q"], gitDir);
    return old.length;
  }

  private measured: { at: number; usage: Promise<RepoCacheUsage> } | null = null;

  /** How much room each project's code takes. Measuring walks every file, so an answer is kept for a minute. */
  usage(now = Date.now()): Promise<RepoCacheUsage> {
    if (this.measured && now - this.measured.at < 60_000) return this.measured.usage;
    const usage = (async (): Promise<RepoCacheUsage> => {
      const names = (await readdir(this.root).catch(() => [] as string[])).filter((n) => n.endsWith(".git"));
      const projects = await Promise.all(
        names.map(async (name) => {
          const dir = join(this.root, name);
          return { name: name.slice(0, -".git".length), bytes: await sizeOf(dir), lastUsed: await lastUsed(dir) };
        }),
      );
      projects.sort((a, b) => b.bytes - a.bytes);
      return { projects, totalBytes: projects.reduce((sum, p) => sum + p.bytes, 0), maxBytes: Number.isFinite(this.limits.maxBytes) ? this.limits.maxBytes : null };
    })();
    this.measured = { at: now, usage };
    return usage;
  }

  /** Start a trim unless one ran recently or is running. */
  private trimSoon(): void {
    if (this.limits.maxBytes === Infinity || this.trimming || Date.now() - this.lastTrim < TRIM_EVERY_MS) return;
    this.lastTrim = Date.now();
    this.trimming = this.trim()
      .then(() => {}, (err: unknown) => console.error(`diffmap: cleaning the code cache failed: ${err instanceof Error ? err.message : err}`))
      .finally(() => (this.trimming = null));
  }

  /**
   * Delete the least recently used projects until the cache fits `maxBytes`.
   * Projects used within `keepRecentMs` are kept, so a review in progress never
   * loses its code. Returns the names of the removed projects.
   */
  async trim(now = Date.now()): Promise<string[]> {
    const names = (await readdir(this.root).catch(() => [] as string[])).filter((n) => n.endsWith(".git"));
    const repos = await Promise.all(
      names.map(async (name) => {
        const dir = join(this.root, name);
        return { name, dir, bytes: await sizeOf(dir), used: await lastUsed(dir) };
      }),
    );
    let total = repos.reduce((sum, r) => sum + r.bytes, 0);
    const removed: string[] = [];
    for (const r of repos.sort((a, b) => a.used - b.used)) {
      if (total <= this.limits.maxBytes) break;
      if (now - r.used < this.keepRecentMs) continue;
      const gone = await this.locked(r.dir, async () => {
        // Someone may have opened it while we were measuring.
        if (now - (await lastUsed(r.dir)) < this.keepRecentMs) return false;
        await rm(r.dir, { recursive: true, force: true });
        return true;
      });
      if (gone) {
        total -= r.bytes;
        removed.push(r.name);
      }
    }
    if (removed.length) console.log(`diffmap: code cache over its limit; removed ${removed.join(", ")}`);
    return removed;
  }

  /** Run one task per repository at a time. */
  private locked<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.locks.set(key, next);
    // Forget the lock once nothing is queued behind it.
    next.catch(() => {}).finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    });
    return next;
  }
}

/** When a project was last used: our mark, or HEAD for repos from before marks existed. */
async function lastUsed(dir: string): Promise<number> {
  for (const f of [USED_MARK, "HEAD"]) {
    const t = await stat(join(dir, f)).then((s) => s.mtimeMs, () => null);
    if (t !== null) return t;
  }
  return 0;
}

/** Bytes used by everything under `dir`. */
async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await sizeOf(p);
    else total += await lstat(p).then((s) => s.size, () => 0);
  }
  return total;
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

function git(args: string[], cwd: string, onLine?: (line: string) => void, input?: string): Promise<void> {
  return run(args, cwd, onLine, input).then(() => {});
}

function gitOut(args: string[], cwd: string): Promise<string> {
  return run(args, cwd);
}

function run(args: string[], cwd: string, onLine?: (line: string) => void, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Only open stdin when there is something to send.
    const p = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout!.on("data", (d) => (out += String(d)));
    p.stderr!.on("data", (d) => {
      const text = String(d);
      err = (err + text).slice(-4000);
      if (onLine) for (const line of text.split(/[\r\n]+/)) if (line) onLine(line);
    });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve(out)
        : // Never echo the auth header back.
          reject(new Error(`git ${args.find((a) => !a.startsWith("http.extraHeader") && a !== "-c")} failed: ${err.trim().slice(0, 300)}`)),
    );
    if (p.stdin) {
      // If git exits before reading its input, the write fails with EPIPE. Without
      // this handler that error takes down the whole server; the exit code already
      // tells us whether git succeeded.
      p.stdin.on("error", () => {});
      p.stdin.end(input);
    }
  });
}
