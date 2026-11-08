import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { GitHubClient, githubApiUrl } from "../src/infrastructure/github/github-client.js";
import { GitHubOAuth } from "../src/infrastructure/github/github-oauth.js";
import { readZipEntry } from "../src/infrastructure/storage/zip.js";
import { configFromEnv } from "../src/interfaces/server/config.js";
import { HostError, PositionRejectedError, type MergeRequestInfo } from "../src/application/ports/merge-request.port.js";

/** A fetch that records requests and answers from a route table ("METHOD /path"). */
function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body && String(init.body).startsWith("{") ? JSON.parse(String(init.body)) : init.body ?? null;
    calls.push({ method, url, body, headers: init.headers as Record<string, string> });
    const key = `${method} ${url.replace(/^https:\/\/(api\.github\.com|github\.com|blob\.test)/, "")}`;
    const route = routes[key];
    const [status, data] = route ? route(body) : [404, { message: "Not Found" }];
    if (data instanceof Uint8Array) return new Response(data, { status });
    return new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

// ── a tiny zip writer for the artifact tests ──
function zip(name: string, content: Buffer, deflate: boolean): Uint8Array {
  const data = deflate ? deflateRawSync(content) : content;
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = local.length + n.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12);
  end.writeUInt32LE(cdStart, 16);
  return new Uint8Array(Buffer.concat([local, n, data, central, n, end]));
}

const PR = {
  number: 42,
  title: "Trim emails",
  html_url: "https://github.com/acme/api/pull/42",
  state: "open",
  user: { login: "sara", name: "Sara K" },
  head: { ref: "fix-trim", sha: "h".repeat(40), label: "sara:fix-trim", repo: { full_name: "sara/api" } },
  base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/api" } },
};
const R = "/repos/acme/api";
const client = (f: ReturnType<typeof fakeFetch>) => new GitHubClient("https://github.com", async () => "tok", f.impl);

describe("GitHub settings", () => {
  it("uses api.github.com for github.com and /api/v3 for GitHub Enterprise", () => {
    expect(githubApiUrl("https://github.com")).toBe("https://api.github.com");
    expect(githubApiUrl("https://ghe.acme.lan/")).toBe("https://ghe.acme.lan/api/v3");
  });

  it("CODE_HOST=github defaults to github.com and reads GITHUB_* settings", () => {
    const c = configFromEnv({ CODE_HOST: "github", PUBLIC_URL: "http://x" });
    expect([c.codeHost, c.hostUrl, c.mode, c.host.name, c.host.refPrefix]).toEqual(["github", "https://github.com", "view", "GitHub", "#"]);
    expect(configFromEnv({ CODE_HOST: "github", PUBLIC_URL: "http://x", GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s" }).mode).toBe("full");
    expect(() => configFromEnv({ CODE_HOST: "bitbucket", PUBLIC_URL: "http://x" })).toThrow(/gitlab or github/);
  });
});

describe("GitHubClient", () => {
  it("reads a pull request, including one from a fork", async () => {
    const f = fakeFetch({ [`GET ${R}/pulls/42`]: () => [200, PR] });
    const mr = await client(f).getMergeRequest("acme/api", 42);
    expect(mr).toMatchObject({
      projectPath: "acme/api",
      iid: 42,
      title: "Trim emails",
      state: "opened",
      author: { name: "Sara K", username: "sara" },
      sourceBranch: "sara:fix-trim",
      targetBranch: "main",
      cloneUrl: "https://github.com/acme/api.git",
      fetchRef: "refs/pull/42/head",
      gitUser: "x-access-token",
    });
    expect(f.calls[0].headers.Authorization).toBe("Bearer tok");
    expect(f.calls[0].headers["User-Agent"]).toBe("diffmap");
  });

  it("groups review comments into threads and keeps conversation comments", async () => {
    const u = { login: "ali", name: null };
    const f = fakeFetch({
      [`GET ${R}/pulls/42/comments?per_page=100&page=1`]: () => [200, [
        { id: 1, body: "Why?", user: u, created_at: "t1", path: "a.py", line: 5, side: "RIGHT" },
        { id: 2, body: "Because", user: { login: "sara" }, created_at: "t2", path: "a.py", line: 5, side: "RIGHT", in_reply_to_id: 1 },
        { id: 3, body: "Old line", user: u, created_at: "t3", path: "a.py", line: 9, side: "LEFT" },
        { id: 4, body: "Outdated", user: u, created_at: "t4", path: "a.py", line: null },
      ]],
      [`GET ${R}/issues/42/comments?per_page=100&page=1`]: () => [200, [{ id: 9, body: "LGTM", user: u, created_at: "t9" }]],
    });
    const ds = await client(f).listDiscussions("acme/api", 42);
    expect(ds.map((d) => [d.id, d.position, d.notes.map((n) => n.body)])).toEqual([
      ["rc-1", { path: "a.py", oldLine: null, newLine: 5 }, ["Why?", "Because"]],
      ["rc-3", { path: "a.py", oldLine: 9, newLine: null }, ["Old line"]],
      ["rc-4", null, ["Outdated"]],
      ["issue-9", null, ["LGTM"]],
    ]);
    expect(ds[0].notes[0].author).toEqual({ name: "ali", username: "ali" });
  });

  const mr = { projectPath: "acme/api", iid: 42, diffRefs: { baseSha: "b", headSha: "h".repeat(40), startSha: "b" } } as MergeRequestInfo;

  it("posts line comments on the head commit, and reports lines outside the diff", async () => {
    const f = fakeFetch({
      [`POST ${R}/pulls/42/comments`]: (b) => ((b as { line: number }).line === 999
        ? [422, { message: "pull_request_review_thread.line must be part of the diff" }]
        : [201, { id: 7, body: "hi", user: { login: "me" }, created_at: "t", path: "a.py", line: 4 }]),
      [`POST ${R}/issues/42/comments`]: () => [201, { id: 8, body: "general", user: { login: "me" }, created_at: "t" }],
    });
    const c = client(f);
    const d = await c.createDiscussion(mr, { body: "hi", position: { path: "a.py", oldLine: 3, newLine: 4 } });
    expect(d.id).toBe("rc-7");
    expect(f.calls[0].body).toEqual({ body: "hi", commit_id: "h".repeat(40), path: "a.py", line: 4, side: "RIGHT" });

    await c.createDiscussion(mr, { body: "old", position: { path: "a.py", oldLine: 6, newLine: null } });
    expect(f.calls[1].body).toMatchObject({ line: 6, side: "LEFT" });

    await expect(c.createDiscussion(mr, { body: "x", position: { path: "a.py", oldLine: null, newLine: 999 } })).rejects.toBeInstanceOf(PositionRejectedError);
    expect((await c.createDiscussion(mr, { body: "general" })).id).toBe("issue-8");
  });

  it("replies in a review thread, or with a new conversation comment", async () => {
    const f = fakeFetch({
      [`POST ${R}/pulls/42/comments/1/replies`]: () => [201, { id: 5, body: "ok", user: { login: "me" }, created_at: "t" }],
      [`POST ${R}/issues/42/comments`]: () => [201, { id: 6, body: "ok", user: { login: "me" }, created_at: "t" }],
    });
    expect((await client(f).reply("acme/api", 42, "rc-1", "ok")).id).toBe(5);
    expect((await client(f).reply("acme/api", 42, "issue-9", "ok")).id).toBe(6);
  });

  it("counts each person's latest decision, and authors can't approve their own PR", async () => {
    const reviews = [
      { id: 1, user: { login: "ali" }, state: "APPROVED" },
      { id: 2, user: { login: "bo" }, state: "APPROVED" },
      { id: 3, user: { login: "bo" }, state: "CHANGES_REQUESTED" },
      { id: 4, user: { login: "ali" }, state: "COMMENTED" },
    ];
    const routes = (me: string) => fakeFetch({
      [`GET ${R}/pulls/42/reviews?per_page=100&page=1`]: () => [200, reviews],
      ["GET /user"]: () => [200, { login: me }],
      [`GET ${R}/pulls/42`]: () => [200, PR],
    });
    expect(await client(routes("ali")).getApprovals("acme/api", 42)).toEqual({
      userHasApproved: true,
      userCanApprove: true,
      approvedBy: [{ name: "ali", username: "ali" }],
    });
    expect((await client(routes("sara")).getApprovals("acme/api", 42)).userCanApprove).toBe(false);
  });

  it("approves with a review, and explains when GitHub won't let you dismiss it", async () => {
    const posted: unknown[] = [];
    const f = fakeFetch({
      [`POST ${R}/pulls/42/reviews`]: (b) => (posted.push(b), [200, { id: 10 }]),
      [`GET ${R}/pulls/42/reviews?per_page=100&page=1`]: () => [200, [{ id: 10, user: { login: "ali" }, state: "APPROVED" }]],
      ["GET /user"]: () => [200, { login: "ali" }],
      [`GET ${R}/pulls/42`]: () => [200, PR],
      [`PUT ${R}/pulls/42/reviews/10/dismissals`]: () => [403, { message: "Must have push access" }],
    });
    expect((await client(f).approve(mr)).userHasApproved).toBe(true);
    expect(posted).toEqual([{ commit_id: "h".repeat(40), event: "APPROVE" }]);
    const err = await client(f).unapprove(mr).catch((e) => e);
    expect(err).toBeInstanceOf(HostError);
    expect(err.userMessage).toContain("write access");
  });

  it("downloads the diffmap-index artifact of a successful run for the head commit", async () => {
    const scip = Buffer.from("SCIP-BYTES");
    const f = fakeFetch({
      [`GET ${R}/actions/runs?head_sha=${"h".repeat(40)}&per_page=20`]: () => [200, { workflow_runs: [
        { id: 2, status: "completed", conclusion: "failure" },
        { id: 1, status: "completed", conclusion: "success" },
      ] }],
      [`GET ${R}/actions/runs/1/artifacts`]: () => [200, { artifacts: [
        { name: "coverage", expired: false, archive_download_url: "https://blob.test/cov.zip" },
        { name: "diffmap-index", expired: false, archive_download_url: "https://blob.test/idx.zip" },
      ] }],
      ["GET /idx.zip"]: () => [200, zip("index.scip", scip, true)],
    });
    expect(await client(f).findIndex(mr)).toEqual({ state: "found", data: new Uint8Array(scip) });
  });

  it("says pending while a run for the head commit is still going", async () => {
    const f = fakeFetch({
      [`GET ${R}/actions/runs?head_sha=${"h".repeat(40)}&per_page=20`]: () => [200, { workflow_runs: [{ id: 3, status: "in_progress", conclusion: null }] }],
    });
    expect(await client(f).findIndex(mr)).toEqual({ state: "pending" });
  });
});

describe("readZipEntry", () => {
  it("reads stored and deflated files, also inside a folder", () => {
    expect(Buffer.from(readZipEntry(zip("index.scip", Buffer.from("abc"), false), "index.scip")!).toString()).toBe("abc");
    expect(Buffer.from(readZipEntry(zip("out/index.scip", Buffer.from("x".repeat(500)), true), "index.scip")!).toString()).toBe("x".repeat(500));
    expect(readZipEntry(zip("other.txt", Buffer.from("a"), false), "index.scip")).toBeNull();
  });
});

describe("GitHubOAuth", () => {
  const s = { githubUrl: "https://github.com", clientId: "cid", clientSecret: "sec", redirectUri: "http://map.test/auth/callback" };

  it("sends people to GitHub's authorize page with PKCE and the repo scope", () => {
    const u = new URL(new GitHubOAuth(s).authorizeUrl("st", "ch"));
    expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "cid", scope: "repo", state: "st", code_challenge: "ch" });
  });

  it("exchanges the code, and treats GitHub's 200-with-error as a failure", async () => {
    const ok = fakeFetch({ ["POST /login/oauth/access_token"]: () => [200, { access_token: "gho_x", token_type: "bearer" }] });
    const t = await new GitHubOAuth(s, ok.impl).exchange("c", "v");
    expect(t.accessToken).toBe("gho_x");
    expect(t.refreshToken).toBeNull();

    const bad = fakeFetch({ ["POST /login/oauth/access_token"]: () => [200, { error: "bad_verification_code", error_description: "The code is incorrect" }] });
    await expect(new GitHubOAuth(s, bad.impl).exchange("c", "v")).rejects.toThrow(/code is incorrect/);
  });
});
