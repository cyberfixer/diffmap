import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitLabClient } from "../src/infrastructure/gitlab/gitlab-client.js";
import { GitLabOAuth, pkcePair } from "../src/infrastructure/gitlab/gitlab-oauth.js";
import { GitRepoCache, parseGitProgress } from "../src/infrastructure/git/git-repo-cache.js";
import { ReviewMergeRequestUseCase, quoteLine } from "../src/application/use-cases/review-merge-request.js";
import {
  PositionRejectedError,
  type MergeRequestHostPort,
  type MergeRequestInfo,
} from "../src/application/ports/merge-request.port.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";

interface Call { method: string; url: string; headers: Record<string, string>; body: string | null }

/** A fetch that records requests and answers from a route table. */
function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? String(init.body) : null;
    calls.push({ method, url, headers: init.headers as Record<string, string>, body });
    const path = url.replace(/^https:\/\/gitlab\.test/, "");
    const route = routes[`${method} ${path}`];
    const [status, data] = route ? route(body && body.startsWith("{") ? JSON.parse(body) : body) : [404, { message: "404" }];
    if (data instanceof Uint8Array) return new Response(data, { status });
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const MR_JSON = {
  iid: 42,
  title: "Shorter token lifetime",
  web_url: "https://gitlab.test/team/api/-/merge_requests/42",
  state: "opened",
  author: { name: "Sara K", username: "sara" },
  source_branch: "feature/tokens",
  target_branch: "main",
  project_id: 7,
  diff_refs: { base_sha: "b".repeat(40), head_sha: "h".repeat(40), start_sha: "s".repeat(40) },
};
const PROJECT_JSON = { http_url_to_repo: "https://gitlab.test/team/api.git", path_with_namespace: "team/api" };
const MR_PATH = "/api/v4/projects/team%2Fapi/merge_requests/42";

const mrRoutes = {
  [`GET ${MR_PATH}`]: () => [200, MR_JSON] as [number, unknown],
  "GET /api/v4/projects/7": () => [200, PROJECT_JSON] as [number, unknown],
};

describe("GitLabClient", () => {
  it("reads a merge request as the signed-in user", async () => {
    const f = fakeFetch(mrRoutes);
    const mr = await new GitLabClient("https://gitlab.test/", async () => "tok", f.impl).getMergeRequest("team/api", 42);

    expect(mr).toMatchObject({
      projectPath: "team/api",
      iid: 42,
      title: "Shorter token lifetime",
      author: { name: "Sara K", username: "sara" },
      sourceBranch: "feature/tokens",
      targetBranch: "main",
      cloneUrl: "https://gitlab.test/team/api.git",
    });
    expect(mr.diffRefs.headSha).toBe("h".repeat(40));
    expect(f.calls[0].headers.Authorization).toBe("Bearer tok");
  });

  it("keeps line positions and drops system notes from discussions", async () => {
    const f = fakeFetch({
      [`GET ${MR_PATH}/discussions?per_page=100&page=1`]: () => [
        200,
        [
          { id: "d1", notes: [{ id: 1, body: "added 1 commit", system: true, author: { name: "x", username: "x" }, created_at: "t" }] },
          {
            id: "d2",
            notes: [
              {
                id: 2, body: "Why 900?", system: false, resolvable: true, resolved: false,
                author: { name: "Ali", username: "ali" }, created_at: "2026-11-01T10:00:00Z",
                position: { new_path: "src/config.ts", old_path: "src/config.ts", new_line: 2, old_line: null },
              },
            ],
          },
          { id: "d3", notes: [{ id: 3, body: "LGTM", system: false, author: { name: "Ali", username: "ali" }, created_at: "t" }] },
        ],
      ],
    });
    const ds = await new GitLabClient("https://gitlab.test", async () => "t", f.impl).listDiscussions("team/api", 42);

    expect(ds.map((d) => d.id)).toEqual(["d2", "d3"]);
    expect(ds[0].position).toEqual({ path: "src/config.ts", oldLine: null, newLine: 2 });
    expect(ds[0].resolved).toBe(false);
    expect(ds[1].position).toBeNull();
  });

  it("posts a line comment with the MR's diff refs, and reports a refused line", async () => {
    const posted: unknown[] = [];
    const f = fakeFetch({
      ...mrRoutes,
      [`POST ${MR_PATH}/discussions`]: (body) => {
        posted.push(body);
        const b = body as { position?: { new_line?: number } };
        if (b.position?.new_line === 999) return [400, { message: "line_code can't be blank" }];
        return [201, { id: "d9", notes: [{ id: 9, body: "hi", system: false, author: { name: "Me", username: "me" }, created_at: "t" }] }];
      },
    });
    const client = new GitLabClient("https://gitlab.test", async () => "t", f.impl);
    const mr = await client.getMergeRequest("team/api", 42);

    const d = await client.createDiscussion(mr, { body: "hi", position: { path: "a.ts", oldLine: 3, newLine: 4 } });
    expect(d.id).toBe("d9");
    expect(posted[0]).toEqual({
      body: "hi",
      position: {
        position_type: "text",
        base_sha: "b".repeat(40),
        start_sha: "s".repeat(40),
        head_sha: "h".repeat(40),
        old_path: "a.ts",
        new_path: "a.ts",
        old_line: 3,
        new_line: 4,
      },
    });

    await expect(
      client.createDiscussion(mr, { body: "x", position: { path: "a.ts", oldLine: null, newLine: 999 } })
    ).rejects.toBeInstanceOf(PositionRejectedError);
  });

  it("approves at the head commit", async () => {
    const approvals = { user_has_approved: true, user_can_approve: true, approved_by: [{ user: { name: "Me", username: "me" } }] };
    const f = fakeFetch({
      ...mrRoutes,
      [`POST ${MR_PATH}/approve`]: () => [201, {}],
      [`GET ${MR_PATH}/approvals`]: () => [200, approvals],
    });
    const client = new GitLabClient("https://gitlab.test", async () => "t", f.impl);
    const a = await client.approve(await client.getMergeRequest("team/api", 42));

    expect(a).toEqual({ userHasApproved: true, userCanApprove: true, approvedBy: [{ name: "Me", username: "me" }] });
    expect(f.calls.find((c) => c.url.endsWith("/approve"))!.body).toBe(JSON.stringify({ sha: "h".repeat(40) }));
  });
});

describe("finding the exact index from CI", () => {
  const head = "h".repeat(40);
  const P = "/api/v4/projects/team%2Fapi";
  const mr = { projectPath: "team/api", iid: 42, diffRefs: { baseSha: "b", headSha: head, startSha: "s" } } as MergeRequestInfo;

  it("downloads index.scip from the newest successful diffmap-index job for the head commit", async () => {
    const f = fakeFetch({
      [`GET ${P}/pipelines?sha=${head}&order_by=id&sort=desc&per_page=10`]: () => [200, [{ id: 9 }, { id: 8 }]],
      [`GET ${P}/pipelines/9/jobs?per_page=100`]: () => [200, [{ id: 90, name: "test", status: "success" }]],
      [`GET ${P}/pipelines/8/jobs?per_page=100`]: () => [200, [{ id: 80, name: "diffmap-index", status: "success" }]],
      [`GET ${P}/jobs/80/artifacts/index.scip`]: () => [200, new Uint8Array([1, 2, 3])],
    });
    const r = await new GitLabClient("https://gitlab.test", async () => "t", f.impl).findIndex(mr);
    expect(r).toEqual({ state: "found", data: new Uint8Array([1, 2, 3]) });
  });

  it("says pending while the job runs, and none when there is no such job", async () => {
    const running = fakeFetch({
      [`GET ${P}/pipelines?sha=${head}&order_by=id&sort=desc&per_page=10`]: () => [200, [{ id: 9 }]],
      [`GET ${P}/pipelines/9/jobs?per_page=100`]: () => [200, [{ id: 90, name: "diffmap-index", status: "running" }]],
    });
    expect(await new GitLabClient("https://gitlab.test", async () => "t", running.impl).findIndex(mr)).toEqual({ state: "pending" });

    const none = fakeFetch({ [`GET ${P}/pipelines?sha=${head}&order_by=id&sort=desc&per_page=10`]: () => [200, []] });
    expect(await new GitLabClient("https://gitlab.test", async () => "t", none.impl).findIndex(mr)).toEqual({ state: "none" });
  });
});

describe("GitLabOAuth", () => {
  const settings = {
    gitlabUrl: "https://gitlab.test",
    clientId: "cid",
    clientSecret: "secret",
    redirectUri: "https://map.test/auth/callback",
  };

  it("builds a PKCE authorize URL on the self-hosted GitLab", () => {
    const { challenge } = pkcePair();
    const url = new URL(new GitLabOAuth(settings).authorizeUrl("st", challenge));
    expect(url.origin + url.pathname).toBe("https://gitlab.test/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://map.test/auth/callback");
    expect(url.searchParams.get("scope")).toBe("api");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges the code for tokens", async () => {
    const f = fakeFetch({
      "POST /oauth/token": () => [200, { access_token: "A", refresh_token: "R", expires_in: 60 }],
    });
    const t = await new GitLabOAuth(settings, f.impl).exchange("code1", "ver1");
    expect(t.accessToken).toBe("A");
    expect(t.refreshToken).toBe("R");
    const sent = new URLSearchParams(f.calls[0].body!);
    expect(sent.get("code")).toBe("code1");
    expect(sent.get("code_verifier")).toBe("ver1");
    expect(sent.get("client_secret")).toBe("secret");
  });
});

describe("GitRepoCache", () => {
  let remote: FixtureRepo | null = null;
  let cacheDir: string | null = null;
  afterEach(() => {
    remote?.cleanup();
    if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
    remote = null;
    cacheDir = null;
  });

  it("fetches the target branch and the MR head from the remote", async () => {
    remote = createFixtureRepo();
    remote.write("a.ts", "export const a = 1;\n");
    remote.commit("base");
    const base = remote.git("rev-parse", "HEAD");
    remote.git("checkout", "-q", "-b", "feature");
    remote.write("a.ts", "export const a = 2;\n");
    remote.commit("change");
    const head = remote.git("rev-parse", "HEAD");
    remote.git("update-ref", "refs/merge-requests/5/head", head);
    remote.git("checkout", "-q", "main");

    cacheDir = mkdtempSync(join(tmpdir(), "diffmap-cache-"));
    const mr: MergeRequestInfo = {
      projectPath: "team/api", iid: 5, title: "t", webUrl: "", state: "opened",
      author: { name: "a", username: "a" }, sourceBranch: "feature", targetBranch: "main",
      diffRefs: { baseSha: base, headSha: head, startSha: base }, cloneUrl: remote.dir,
      fetchRef: "refs/merge-requests/5/head", gitUser: "oauth2",
    };
    const cache = new GitRepoCache(cacheDir);
    const steps: string[] = [];
    const dir = await cache.prepare(mr, "tok", (p) => steps.push(p.step));

    expect(dir).toBe(join(cacheDir, "team_api.git"));
    expect(steps).toContain("Downloading the code (first time for this project)");
    // Second call is a no-op because both commits are present.
    expect(await cache.prepare(mr, "tok")).toBe(dir);
  });

  /** A fake project copy of `bytes` bytes, last used `ageMs` ago. */
  function fakeRepo(name: string, bytes: number, ageMs: number, now: number) {
    const dir = join(cacheDir!, name);
    mkdirSync(join(dir, "objects"), { recursive: true });
    writeFileSync(join(dir, "objects", "pack"), Buffer.alloc(bytes));
    writeFileSync(join(dir, "diffmap-used"), "");
    const t = (now - ageMs) / 1000;
    utimesSync(join(dir, "diffmap-used"), t, t);
  }

  it("removes the least recently used projects until the cache fits its limit", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "diffmap-cache-"));
    const now = Date.now();
    const day = 24 * 3600_000;
    fakeRepo("old.git", 1000, 30 * day, now);
    fakeRepo("older.git", 1000, 60 * day, now);
    fakeRepo("new.git", 1000, 1 * day, now);
    const cache = new GitRepoCache(cacheDir, { maxBytes: 2500 });

    expect(await cache.trim(now)).toEqual(["older.git"]);
    expect(existsSync(join(cacheDir, "old.git"))).toBe(true);
    expect(existsSync(join(cacheDir, "new.git"))).toBe(true);
    // Under the limit now: nothing more goes.
    expect(await cache.trim(now)).toEqual([]);
  });

  it("never removes a project used in the last hour, even over the limit", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "diffmap-cache-"));
    const now = Date.now();
    fakeRepo("busy.git", 5000, 10 * 60_000, now);
    const cache = new GitRepoCache(cacheDir, { maxBytes: 100 });
    expect(await cache.trim(now)).toEqual([]);
    expect(existsSync(join(cacheDir, "busy.git"))).toBe(true);
  });

  it("drops stale review refs once a day but keeps the one just fetched", async () => {
    remote = createFixtureRepo(); // its commits are dated 2024, so "old"
    remote.write("a.ts", "export const a = 1;\n");
    remote.commit("base");
    cacheDir = mkdtempSync(join(tmpdir(), "diffmap-cache-"));
    const gitDir = join(cacheDir, "p.git");
    mkdirSync(gitDir);
    const run = (...args: string[]) => remote!.git("--git-dir", gitDir, ...args);
    run("init", "--bare", "-q");
    run("fetch", "-q", remote.dir, "+refs/heads/main:refs/heads/main");
    const head = run("rev-parse", "main");
    for (const ref of ["refs/merge-requests/1/head", "refs/merge-requests/2/head", "refs/pull/3/head"]) run("update-ref", ref, head);

    const cache = new GitRepoCache(cacheDir, { maxBytes: Infinity });
    expect(await cache.tidy(gitDir, "refs/merge-requests/2/head")).toBe(2);
    expect(run("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main\nrefs/merge-requests/2/head");
    // Already tidied today.
    run("update-ref", "refs/pull/4/head", head);
    expect(await cache.tidy(gitDir, "refs/merge-requests/2/head")).toBe(0);
  });
});

describe("ReviewMergeRequestUseCase", () => {
  const mr: MergeRequestInfo = {
    projectPath: "team/api", iid: 42, title: "t", webUrl: "", state: "opened",
    author: { name: "a", username: "a" }, sourceBranch: "f", targetBranch: "main",
    diffRefs: { baseSha: "b", headSha: "h", startSha: "s" }, cloneUrl: "",
  };

  function fakeHost(rejectLine = false) {
    const created: unknown[] = [];
    const host = {
      getMergeRequest: async () => mr,
      listDiscussions: async () => [],
      getApprovals: async () => ({ userHasApproved: false, userCanApprove: true, approvedBy: [] }),
      createDiscussion: async (_mr: MergeRequestInfo, c: { body: string; position?: unknown }) => {
        if (c.position && rejectLine) throw new PositionRejectedError("no");
        created.push(c);
        return { id: "d", resolved: false, position: null, notes: [] };
      },
    } as unknown as MergeRequestHostPort;
    return { host, created };
  }

  it("analyses once per base..head", async () => {
    let runs = 0;
    const uc = new ReviewMergeRequestUseCase(
      { prepare: async () => "/repo" },
      () => (runs++, { base: "b", head: "h", symbols: [], nodes: [], edges: [], files: [] }),
    );
    const { host } = fakeHost();
    expect((await uc.open(host, "t", "team/api", 42, { wait: true })).ready).toBe(true);
    expect((await uc.open(host, "t", "team/api", 42)).ready).toBe(true);
    expect(runs).toBe(1);
  });

  it("reports progress while the code downloads, then ready", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const uc = new ReviewMergeRequestUseCase(
      {
        prepare: async (_mr, _t, onProgress) => {
          onProgress?.({ step: "Downloading the code (first time for this project)", percent: 40, detail: "Receiving objects 50%" });
          await gate;
          return "/repo";
        },
      },
      async () => ({ base: "b", head: "h", symbols: [], nodes: [], edges: [], files: [] }),
    );
    const { host } = fakeHost();

    const first = await uc.open(host, "t", "team/api", 42);
    expect(first.ready).toBe(false);
    const p = await uc.progress(host, "t", "team/api", 42);
    expect(p).toMatchObject({ state: "downloading", percent: 40, detail: "Receiving objects 50%" });

    release();
    await new Promise((r) => setTimeout(r, 10));
    expect((await uc.progress(host, "t", "team/api", 42)).state).toBe("ready");
  });

  it("uses the CI index when there is one, and picks it up later if it was still building", async () => {
    const given: (Uint8Array | undefined)[] = [];
    const uc = new ReviewMergeRequestUseCase({ prepare: async () => "/repo" }, async (_d, _b, _h, index) => {
      given.push(index);
      return { base: "b", head: "h", symbols: [], nodes: [], edges: [], files: [] };
    });
    let lookup: "pending" | "found" = "pending";
    const { host } = fakeHost();
    host.findIndex = async () => (lookup === "found" ? { state: "found", data: new Uint8Array([7]) } : { state: "pending" });

    const first = await uc.open(host, "t", "team/api", 42, { wait: true });
    expect(first.ready && first.indexState).toBe("pending");
    expect(given).toEqual([undefined]);

    lookup = "found";
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000; // a minute later
    try {
      const second = await uc.open(host, "t", "team/api", 42, { wait: true });
      expect(second.ready && second.indexState).toBe("found");
      expect(given).toEqual([undefined, new Uint8Array([7])]);
    } finally {
      Date.now = realNow;
    }
  });

  it("tries again after a failure seen while waiting", async () => {
    let attempts = 0;
    const uc = new ReviewMergeRequestUseCase(
      { prepare: async () => { if (++attempts === 1) throw new Error("GitLab is down"); return "/repo"; } },
      () => ({ base: "b", head: "h", symbols: [], nodes: [], edges: [], files: [] }),
    );
    const { host } = fakeHost();
    await expect(uc.open(host, "t", "team/api", 42, { wait: true })).rejects.toThrow("GitLab is down");
    expect((await uc.open(host, "t", "team/api", 42, { wait: true })).ready).toBe(true);
    expect(attempts).toBe(2);
  });

  it("keeps the most recently opened analyses when the cache is full", async () => {
    let runs = 0;
    let current = mr;
    const uc = new ReviewMergeRequestUseCase(
      { prepare: async () => "/repo" },
      () => (runs++, { base: "b", head: "h", symbols: [], nodes: [], edges: [], files: [] }),
    );
    const { host } = fakeHost();
    host.getMergeRequest = async () => current;
    const openSha = async (head: string) => {
      current = { ...mr, diffRefs: { ...mr.diffRefs, headSha: head } };
      await uc.open(host, "t", "team/api", 42, { wait: true });
    };
    for (let i = 0; i < 20; i++) await openSha(`h${i}`); // full
    await openSha("h0"); // opened again: now the most recent
    await openSha("new"); // pushes out h1, the one unopened longest
    expect(runs).toBe(21);
    await openSha("h0");
    expect(runs).toBe(21);
    await openSha("h1");
    expect(runs).toBe(22);
  });

  it("reports a failure once, then tries again", async () => {
    let attempts = 0;
    const uc = new ReviewMergeRequestUseCase(
      { prepare: async () => { attempts++; throw new Error("GitLab is down"); } },
      () => { throw new Error(); },
    );
    const { host } = fakeHost();
    await uc.open(host, "t", "team/api", 42);
    await new Promise((r) => setTimeout(r, 10));
    expect(await uc.progress(host, "t", "team/api", 42)).toMatchObject({ state: "error", error: "GitLab is down" });
    await uc.progress(host, "t", "team/api", 42);
    expect(attempts).toBe(2);
  });

  it("falls back to a general comment that quotes the line", async () => {
    const uc = new ReviewMergeRequestUseCase({ prepare: async () => "" }, () => { throw new Error(); });
    const { host, created } = fakeHost(true);
    const position = { path: "src/app.ts", oldLine: 12, newLine: 12 };
    const r = await uc.comment(host, "team/api", 42, { body: "Needs the ttl", position, code: "new SessionStore(db)" });

    expect(r.fallback).toBe(true);
    expect(created).toEqual([{ body: quoteLine(position, "new SessionStore(db)", "Needs the ttl") }]);
    expect(quoteLine(position, "x", "y")).toBe("**`src/app.ts:12`**\n```\nx\n```\n\ny");
  });
});

describe("parseGitProgress", () => {
  it("turns git's progress lines into a percentage and a short detail", () => {
    expect(parseGitProgress("Receiving objects:  50% (500/1000), 12.30 MiB | 3.10 MiB/s")).toEqual({
      percent: 50,
      detail: "Receiving objects 50% · 12.30 MiB",
    });
    expect(parseGitProgress("Resolving deltas: 100% (20/20), done.")).toEqual({ percent: 100, detail: "Resolving deltas 100%" });
    expect(parseGitProgress("remote: Enumerating objects: 5, done.")).toBeNull();
  });
});
