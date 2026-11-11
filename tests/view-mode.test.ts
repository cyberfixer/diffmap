import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/interfaces/server/server.js";
import { configFromEnv } from "../src/interfaces/server/config.js";
import { ReviewMergeRequestUseCase } from "../src/application/use-cases/review-merge-request.js";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../src/infrastructure/parsers/typescript/ts-morph.adapter.js";
import { TsMorphCallGraph } from "../src/infrastructure/parsers/typescript/ts-morph-call-graph.js";
import { FileViewedStore } from "../src/infrastructure/storage/file-viewed-store.js";
import { HostError, type MergeRequestHostPort, type MergeRequestInfo } from "../src/application/ports/merge-request.port.js";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";

const GOOD = "glpat-goodtoken123";
const NARROW = "glpat-readapionly1";
let repo: FixtureRepo;
let server: Server;
let base = "";
const dataDir = mkdtempSync(join(tmpdir(), "diffmap-view-"));
const writes: string[] = [];

beforeAll(async () => {
  repo = createFixtureRepo();
  repo.write("src/a.ts", "export function a() {\n  return 1;\n}\n");
  repo.commit("initial");
  const baseSha = repo.git("rev-parse", "HEAD");
  repo.write("src/a.ts", "export function a() {\n  return 2;\n}\n");
  repo.commit("change");
  const headSha = repo.git("rev-parse", "HEAD");
  const mr: MergeRequestInfo = {
    projectPath: "team/api", iid: 7, title: "Return two", webUrl: "https://gitlab.test/team/api/-/merge_requests/7", state: "opened",
    author: { name: "Sara", username: "sara" }, sourceBranch: "f", targetBranch: "main",
    diffRefs: { baseSha, headSha, startSha: baseSha }, cloneUrl: "",
  };

  const hostFor = (token: () => Promise<string>): MergeRequestHostPort => ({
    currentUser: async () => {
      const t = await token();
      if (t !== GOOD && t !== NARROW) throw new HostError("unauthorized", 401);
      return { name: "Ali", username: "ali" };
    },
    tokenScopes: async () => ((await token()) === GOOD ? ["read_api", "read_repository"] : ["read_api"]),
    getMergeRequest: async () => mr,
    listDiscussions: async () => [
      { id: "d1", resolved: false, position: null, notes: [{ id: 1, author: { name: "Sara", username: "sara" }, body: "Looks good", createdAt: "t" }] },
    ],
    getApprovals: async () => ({ userHasApproved: false, userCanApprove: true, approvedBy: [] }),
    createDiscussion: async () => { writes.push("comment"); throw new Error("must not be called"); },
    reply: async () => { writes.push("reply"); throw new Error("must not be called"); },
    approve: async () => { writes.push("approve"); throw new Error("must not be called"); },
    unapprove: async () => { writes.push("unapprove"); throw new Error("must not be called"); },
  });

  server = createApp({
    // view mode: no GITLAB_CLIENT_ID / GITLAB_CLIENT_SECRET
    config: configFromEnv({ GITLAB_URL: "https://gitlab.test", PUBLIC_URL: "http://map.test", DATA_DIR: dataDir }),
    hostFor,
    review: new ReviewMergeRequestUseCase({ prepare: async () => repo.dir }, (dir, b, h) =>
      new AnalyzeRangeUseCase(new GitDiffReader(dir), new GitSourceReader(dir), [new TsMorphAdapter()], [new TsMorphCallGraph()]).execute(b, h),
    ),
    viewed: new FileViewedStore(join(dataDir, "viewed.json")),
    log: () => {},
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  repo?.cleanup();
  rmSync(dataDir, { recursive: true, force: true });
});

const get = (path: string, cookie = "") => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
const signIn = (token: string, returnTo = "/") =>
  fetch(base + "/auth/token", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token, returnTo }),
  });
const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];

async function openMap(cookie: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const html = await (await get("/team/api/-/merge_requests/7", cookie)).text();
    if (!html.includes('id="s1"')) return html;
    await get("/api/team/api/-/merge_requests/7/status", cookie);
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("never ready");
}

describe("view-only mode (no GitLab application)", () => {
  it("starts without client id and secret, but not with only one of them", () => {
    expect(configFromEnv({ GITLAB_URL: "x", PUBLIC_URL: "y" }).mode).toBe("view");
    expect(configFromEnv({ GITLAB_URL: "x", PUBLIC_URL: "y", GITLAB_CLIENT_ID: "i", GITLAB_CLIENT_SECRET: "s" }).mode).toBe("full");
    expect(() => configFromEnv({ GITLAB_URL: "x", PUBLIC_URL: "y", GITLAB_CLIENT_ID: "i" })).toThrow(/both/);
  });

  it("asks for a personal token, with a link that creates one with the right scopes", async () => {
    const html = await (await get("/team/api/-/merge_requests/7")).text().catch(() => "");
    const page = await (await get("/auth/login?returnTo=%2Fteam%2Fapi%2F-%2Fmerge_requests%2F7")).text();
    expect(html).toBe(""); // the MR page redirects; the body is empty
    expect(page).toContain('name="token" type="password"');
    expect(page).toContain("personal_access_tokens?name=diffmap&amp;scopes=read_api,read_repository");
    expect(page).toContain('value="/team/api/-/merge_requests/7"');
  });

  it("refuses a wrong token or one without read_repository, and says why", async () => {
    const bad = await signIn("glpat-wrongtoken99");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("did not accept this token");

    const narrow = await signIn(NARROW);
    expect(await narrow.text()).toContain("missing the scope read_repository");
  });

  it("signs in with a good token and shows the map read-only", async () => {
    const r = await signIn(GOOD, "/team/api/-/merge_requests/7");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/team/api/-/merge_requests/7");

    const html = await openMap(cookieOf(r));
    expect(html).toContain("!7 · Return two");
    expect(html).toContain(">View only<");
    expect(html).not.toContain('id="approve"');
    expect(html).not.toContain('<span class="chint">'); // no "click a line number to comment" hint
    expect(html).toContain('"readOnly":true');
    expect(html).not.toContain('class="cbtn fcomment"'); // no "Comment" next to file names
    expect(html).toContain("Looks good"); // existing comments are still shown
    expect(html).toContain('<body class="mr">'); // no "mr-write": line numbers are not clickable
  });

  it("refuses comments, replies and approvals on the server too", async () => {
    const cookie = cookieOf(await signIn(GOOD));
    const api = "/api/team/api/-/merge_requests/7";
    for (const [path, body] of [
      ["/discussions", { body: "x" }],
      ["/discussions/d1/notes", { body: "x" }],
      ["/approve", {}],
      ["/unapprove", {}],
    ] as const) {
      const r = await fetch(base + api + path, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(r.status).toBe(403);
    }
    expect(writes).toEqual([]);
  });

  it("still remembers what each person marked as viewed", async () => {
    const cookie = cookieOf(await signIn(GOOD));
    const r = await fetch(base + "/api/team/api/-/merge_requests/7/viewed", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "file:src/a.ts", rev: "abc", viewed: true }),
    });
    expect(await r.json()).toEqual({ viewed: { "file:src/a.ts": "abc" } });
  });
});
