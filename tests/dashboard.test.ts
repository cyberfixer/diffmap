import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/interfaces/server/server.js";
import { configFromEnv } from "../src/interfaces/server/config.js";
import { ReviewMergeRequestUseCase } from "../src/application/use-cases/review-merge-request.js";
import type { MergeRequestHostPort, MergeRequestInfo } from "../src/application/ports/merge-request.port.js";
import type { AnalysisResult } from "../src/domain/analysis-result.js";
import { FileViewedStore } from "../src/infrastructure/storage/file-viewed-store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "diffmap-dash-"));
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const mrOf = (projectPath: string, iid: number, title: string): MergeRequestInfo => ({
  projectPath, iid, title, webUrl: "", state: "opened", author: { name: "Sara K", username: "sara" },
  sourceBranch: "f", targetBranch: "main", diffRefs: { baseSha: `b${iid}`, headSha: `h${iid}`, startSha: `b${iid}` }, cloneUrl: "",
});
const EMPTY: AnalysisResult = { base: "b", head: "h", symbols: [], nodes: [], edges: [], files: [], exactness: { exact: 0, total: 0 } };

/** A service whose analyses end at once: review 1 works, review 2 fails. */
async function start(adminUsers: string) {
  const host = {
    currentUser: async () => ({ name: "Ali R", username: "Ali" }),
    getMergeRequest: async (_p: string, iid: number) => mrOf("team/api", iid, iid === 2 ? "<img src=x onerror=alert(1)>" : "Trim emails"),
    listDiscussions: async () => [],
    getApprovals: async () => ({ userHasApproved: false, userCanApprove: true, approvedBy: [] }),
  } as unknown as MergeRequestHostPort;
  const server = createApp({
    config: configFromEnv({ GITLAB_URL: "https://gitlab.test", GITLAB_CLIENT_ID: "c", GITLAB_CLIENT_SECRET: "s", PUBLIC_URL: "http://map.test", ADMIN_USERS: adminUsers }),
    oauth: {
      authorizeUrl: (state) => `https://gitlab.test/oauth/authorize?state=${state}`,
      exchange: async () => ({ accessToken: "A", refreshToken: "R", expiresAt: Date.now() + 3600_000 }),
      refresh: async () => ({ accessToken: "A", refreshToken: "R", expiresAt: Date.now() + 3600_000 }),
    },
    hostFor: () => host,
    viewed: new FileViewedStore(join(dataDir, `viewed-${servers.length}.json`)),
    review: new ReviewMergeRequestUseCase({ prepare: async () => "/nowhere" }, (_dir, base) => {
      if (base === "b2") throw new Error("This change is too big");
      return EMPTY;
    }),
    workers: () => ({ running: 1, waiting: 2, max: 2, memoryMb: 2048 }),
    storage: async () => ({ projects: [{ name: "team_api", bytes: 5 * 1024 * 1024, lastUsed: Date.now() }], totalBytes: 5 * 1024 * 1024, maxBytes: 15 * 1024 ** 3 }),
    log: () => {},
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, cookie = "") => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const login = await get("/auth/login?returnTo=/");
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const cookie = (await get(`/auth/callback?code=good&state=${state}`)).headers.get("set-cookie")!.split(";")[0];
  /** Open a review and wait until its analysis has ended, one way or the other. */
  const open = async (iid: number) => {
    await get(`/team/api/-/merge_requests/${iid}`, cookie);
    for (let i = 0; i < 100; i++) {
      const s = await (await get(`/api/team/api/-/merge_requests/${iid}/status`, cookie)).json();
      if (s.state === "ready" || s.state === "error") return;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error("the analysis never ended");
  };
  return { get, cookie, open };
}

describe("dashboard", () => {
  it("is for signed-in people listed in ADMIN_USERS only", async () => {
    const app = await start("sara, someone-else");
    // Not signed in: sign in first (the page), or a plain refusal (the data).
    const page = await app.get("/dashboard");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/auth/login?returnTo=%2Fdashboard");
    expect((await app.get("/api/dashboard")).status).toBe(401);
    // Signed in as @Ali, who is not on the list.
    const refused = await app.get("/dashboard", app.cookie);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("ADMIN_USERS");
    const data = await app.get("/api/dashboard", app.cookie);
    expect(data.status).toBe(403);
    expect(JSON.stringify(await data.json())).not.toContain("team/api");
    // ...and gets no link to it.
    expect(await (await app.get("/", app.cookie)).text()).not.toContain("/dashboard");
  });

  it("shows what is running, what ran and how it ended", async () => {
    // The list ignores case and a leading @.
    const app = await start("@ali");
    expect(await (await app.get("/", app.cookie)).text()).toContain('href="/dashboard"');
    await app.open(1);
    await app.open(2);
    await app.get("/team/api/-/merge_requests/1", app.cookie); // again: from memory

    const d = await (await app.get("/api/dashboard", app.cookie)).json();
    expect(d.review.totals).toEqual({ analysed: 1, failed: 1, servedFromMemory: 1 });
    expect(d.review.running).toEqual([]);
    expect(d.review.cached).toBe(1);
    // Newest first.
    expect(d.review.recent.map((a: { iid: number; ok: boolean; error?: string }) => [a.iid, a.ok, a.error])).toEqual([
      [2, false, "This change is too big"],
      [1, true, undefined],
    ]);
    const ok = d.review.recent[1];
    expect(ok).toMatchObject({ projectPath: "team/api", title: "Trim emails", changedFiles: 0, indexState: "unsupported" });
    expect(ok.totalMs).toBe(ok.downloadMs + ok.analysisMs);
    expect(d.workers).toEqual({ running: 1, waiting: 2, max: 2, memoryMb: 2048 });
    expect(d.storage.projects[0].name).toBe("team_api");
    expect(d.counters).toEqual({ mapsOpened: 1, signIns: 1 });
    expect(d.signedIn).toBe(1);
    expect(d.log.map((l: { text: string }) => l.text)).toContain("sign-in: @Ali");

    // The page carries the same data; a title is never written into it as HTML.
    const page = await app.get("/dashboard", app.cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Latest analyses");
    expect(html).not.toContain("<img src=x");
  });
});
