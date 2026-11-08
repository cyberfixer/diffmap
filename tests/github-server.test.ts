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

let repo: FixtureRepo;
let server: Server;
let base = "";
const dataDir = mkdtempSync(join(tmpdir(), "diffmap-gh-"));

beforeAll(async () => {
  repo = createFixtureRepo();
  repo.write("src/a.ts", "export function a() {\n  return 1;\n}\n");
  repo.commit("initial");
  const baseSha = repo.git("rev-parse", "HEAD");
  repo.write("src/a.ts", "export function a() {\n  return 2;\n}\n");
  repo.commit("change");
  const headSha = repo.git("rev-parse", "HEAD");
  const pr: MergeRequestInfo = {
    projectPath: "acme/api", iid: 42, title: "Return two", webUrl: "https://github.com/acme/api/pull/42", state: "opened",
    author: { name: "Sara", username: "sara" }, sourceBranch: "fix", targetBranch: "main",
    diffRefs: { baseSha, headSha, startSha: baseSha }, cloneUrl: "", fetchRef: "refs/pull/42/head", gitUser: "x-access-token",
  };
  const hostFor = (token: () => Promise<string>): MergeRequestHostPort => ({
    currentUser: async () => {
      if ((await token()) !== "github_pat_goodtoken") throw new HostError("bad", 401);
      return { name: "Ali", username: "ali" };
    },
    getMergeRequest: async (path, n) => {
      if (path !== "acme/api" || n !== 42) throw new HostError("nope", 404);
      return pr;
    },
    listDiscussions: async () => [],
    getApprovals: async () => ({ userHasApproved: false, userCanApprove: true, approvedBy: [] }),
    createDiscussion: async () => { throw new Error("no"); },
    reply: async () => { throw new Error("no"); },
    approve: async () => { throw new Error("no"); },
    unapprove: async () => { throw new Error("no"); },
  });
  server = createApp({
    config: configFromEnv({ CODE_HOST: "github", PUBLIC_URL: "http://map.test", DATA_DIR: dataDir }),
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

describe("the service for GitHub (CODE_HOST=github)", () => {
  it("talks about GitHub and pull requests on its pages", async () => {
    const page = await (await get("/")).text();
    expect(page).toContain("Review pull requests as a map");
    expect(page).toContain("Create a token in GitHub");
    expect(page).toContain("https://github.com/settings/personal-access-tokens/new");
  });

  it("opens /owner/repo/pull/N like github.com, as the map", async () => {
    expect((await get("/acme/api/pull/42")).headers.get("location")).toBe("/auth/login?returnTo=%2Facme%2Fapi%2Fpull%2F42");

    const r = await fetch(base + "/auth/token", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "github_pat_goodtoken", returnTo: "/acme/api/pull/42" }),
    });
    const cookie = r.headers.get("set-cookie")!.split(";")[0];

    const home = await (await get("/go?url=" + encodeURIComponent("https://github.com/acme/api/pull/42/files"), cookie)).headers.get("location");
    expect(home).toBe("/acme/api/pull/42");

    let html = "";
    for (let i = 0; i < 100 && !html.includes('class="card in"'); i++) {
      html = await (await get("/acme/api/pull/42", cookie)).text();
      if (!html.includes('class="card in"')) await get("/api/acme/api/-/merge_requests/42/status", cookie);
    }
    expect(html).toContain("#42 · Return two");
    expect(html).toContain("Open in GitHub");
  });
});
