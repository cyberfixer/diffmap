import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, parseMergeRequestLink } from "../src/interfaces/server/server.js";
import { ReviewMergeRequestUseCase } from "../src/application/use-cases/review-merge-request.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../src/infrastructure/parsers/typescript/ts-morph.adapter.js";
import { TsMorphCallGraph } from "../src/infrastructure/parsers/typescript/ts-morph-call-graph.js";
import {
  HostError,
  PositionRejectedError,
  type MergeRequestHostPort,
  type MergeRequestInfo,
  type NewComment,
} from "../src/application/ports/merge-request.port.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";

let repo: FixtureRepo;
let server: Server;
let base = "";
let mr: MergeRequestInfo;
const posted: NewComment[] = [];
let approved = false;

beforeAll(async () => {
  repo = createFixtureRepo();
  repo.write("src/auth.ts", "export function login(email: string) {\n  return email;\n}\n");
  repo.write("src/checkout.ts", 'import { login } from "./auth";\nexport function pay() {\n  return login("a");\n}\n');
  repo.commit("initial");
  const baseSha = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "-b", "feature/creds");
  repo.write("src/auth.ts", "export function login(email: string) {\n  return email.trim();\n}\n");
  repo.commit("Trim the email");
  const headSha = repo.git("rev-parse", "HEAD");

  mr = {
    projectPath: "team/api", iid: 42, title: "Trim emails on login", webUrl: "https://gitlab.test/team/api/-/merge_requests/42",
    state: "opened", author: { name: "Sara K", username: "sara" }, sourceBranch: "feature/creds", targetBranch: "main",
    diffRefs: { baseSha, headSha, startSha: baseSha }, cloneUrl: "",
  };

  const host: MergeRequestHostPort = {
    currentUser: async () => ({ name: "Ali R", username: "ali" }),
    getMergeRequest: async (path) => {
      if (path !== "team/api") throw new HostError("nope", 404);
      return mr;
    },
    listDiscussions: async () => [
      {
        id: "d1", resolved: false, position: { path: "src/auth.ts", oldLine: null, newLine: 2 },
        notes: [{ id: 1, author: { name: "Sara K", username: "sara" }, body: "Why trim here?", createdAt: "2026-11-01T10:00:00Z" }],
      },
    ],
    createDiscussion: async (_mr, c) => {
      if (c.position?.path === "src/checkout.ts") throw new PositionRejectedError("not in diff");
      posted.push(c);
      return { id: "d" + posted.length, resolved: false, position: c.position ?? null, notes: [{ id: 9, author: { name: "Ali R", username: "ali" }, body: c.body, createdAt: "t" }] };
    },
    reply: async (_p, _i, _d, body) => ({ id: 10, author: { name: "Ali R", username: "ali" }, body, createdAt: "t" }),
    getApprovals: async () => ({ userHasApproved: approved, userCanApprove: true, approvedBy: approved ? [{ name: "Ali R", username: "ali" }] : [] }),
    approve: async () => ((approved = true), host.getApprovals("", 0)),
    unapprove: async () => ((approved = false), host.getApprovals("", 0)),
  };

  server = createApp({
    config: { gitlabUrl: "https://gitlab.test", clientId: "c", clientSecret: "s", publicUrl: "http://map.test", port: 0, cacheDir: "" },
    oauth: {
      authorizeUrl: (state) => `https://gitlab.test/oauth/authorize?state=${state}`,
      exchange: async (code) => {
        if (code !== "good") throw new Error("bad code");
        return { accessToken: "A", refreshToken: "R", expiresAt: Date.now() + 3600_000 };
      },
      refresh: async () => ({ accessToken: "A2", refreshToken: "R2", expiresAt: Date.now() + 3600_000 }),
    },
    hostFor: () => host,
    review: new ReviewMergeRequestUseCase({ prepare: async () => repo.dir }, (dir, b, h) =>
      new AnalyzeRangeUseCase(new GitDiffReader(dir), new GitSourceReader(dir), [new TsMorphAdapter()], [new TsMorphCallGraph()]).execute(b, h),
    ),
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  repo?.cleanup();
});

const get = (path: string, cookie = "") => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
const postJson = (path: string, cookie: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Go through the GitLab sign-in and return the session cookie. */
async function signIn(returnTo = "/"): Promise<string> {
  const login = await get(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const cb = await get(`/auth/callback?code=good&state=${state}`);
  expect(cb.status).toBe(302);
  expect(cb.headers.get("location")).toBe(returnTo);
  return cb.headers.get("set-cookie")!.split(";")[0];
}

describe("gitmap service", () => {
  it("sends you to GitLab to sign in when you open an MR, then back to it", async () => {
    const r = await get("/team/api/-/merge_requests/42");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/auth/login?returnTo=%2Fteam%2Fapi%2F-%2Fmerge_requests%2F42");

    const cookie = await signIn("/team/api/-/merge_requests/42");
    expect(cookie).toMatch(/^gitmap_session=/);
  });

  it("refuses a callback with an unknown state", async () => {
    expect((await get("/auth/callback?code=good&state=forged")).status).toBe(400);
  });

  it("opens the MR as a map with its title, approve button and comments", async () => {
    const cookie = await signIn();
    const r = await get("/team/api/-/merge_requests/42", cookie);
    const html = await r.text();

    expect(r.status).toBe(200);
    expect(html).toContain("!42 · Trim emails on login");
    expect(html).toContain("Sara K · feature/creds → main · 1 commit");
    expect(html).toContain('id="approve"');
    expect(html).toContain(">Approve</button>");
    expect(html).toContain("Why trim here?");
    expect(html).toContain("/api/team/api/-/merge_requests/42");
    expect(html).toContain('class="card in"');
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("shows a friendly page for an MR you can't see", async () => {
    const cookie = await signIn();
    const r = await get("/other/proj/-/merge_requests/1", cookie);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("can't see it");
  });

  it("posts line comments, quotes lines GitLab refuses, and replies", async () => {
    const cookie = await signIn();
    const api = "/api/team/api/-/merge_requests/42";

    const a = await postJson(`${api}/discussions`, cookie, { body: "Nice", position: { path: "src/auth.ts", oldLine: null, newLine: 2 } });
    expect(a.status).toBe(201);
    expect((await a.json()).fallback).toBe(false);

    const b = await postJson(`${api}/discussions`, cookie, {
      body: "Callers need updating", code: '  return login("a");', outside: true,
      position: { path: "src/checkout.ts", oldLine: 3, newLine: 3 },
    });
    expect((await b.json()).fallback).toBe(true);
    expect(posted.at(-1)!.body).toContain("`src/checkout.ts:3`");
    expect(posted.at(-1)!.position).toBeUndefined();

    const c = await postJson(`${api}/discussions/d1/notes`, cookie, { body: "Because of pasted emails" });
    expect((await c.json()).body).toBe("Because of pasted emails");
  });

  it("approves and revokes", async () => {
    const cookie = await signIn();
    const api = "/api/team/api/-/merge_requests/42";
    expect((await (await postJson(`${api}/approve`, cookie, {})).json()).userHasApproved).toBe(true);
    expect((await (await postJson(`${api}/unapprove`, cookie, {})).json()).userHasApproved).toBe(false);
  });

  it("rejects API calls without a session or without JSON", async () => {
    const api = "/api/team/api/-/merge_requests/42/discussions";
    expect((await postJson(api, "", { body: "x" })).status).toBe(401);
    const cookie = await signIn();
    const r = await fetch(base + api, { method: "POST", headers: { cookie, "Content-Type": "text/plain" }, body: "x" });
    expect(r.status).toBe(415);
  });

  it("turns a pasted GitLab link into the map URL", async () => {
    const cookie = await signIn();
    const r = await get("/go?url=" + encodeURIComponent("https://gitlab.test/team/api/-/merge_requests/42/diffs#abc"), cookie);
    expect(r.headers.get("location")).toBe("/team/api/-/merge_requests/42");
    expect(parseMergeRequestLink("group/sub/proj/-/merge_requests/7")).toEqual({ projectPath: "group/sub/proj", iid: 7 });
    expect(parseMergeRequestLink("https://gitlab.test/team/api")).toBeNull();
  });

  it("signs out", async () => {
    const cookie = await signIn();
    const r = await fetch(base + "/auth/logout", { method: "POST", redirect: "manual", headers: { cookie } });
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await get("/team/api/-/merge_requests/42", cookie)).status).toBe(302);
  });
});
