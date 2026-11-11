import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileViewedStore } from "../src/infrastructure/storage/file-viewed-store.js";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const tmp = () => (dir = mkdtempSync(join(tmpdir(), "diffmap-store-")));

describe("viewed marks", () => {
  it("are kept per user and merge request, across restarts", async () => {
    const d = tmp();
    const a = new FileViewedStore(join(d, "viewed.json"));
    await a.setViewed("ali", "team/api", 42, "file:a.ts", "v1");
    await a.setViewed("ali", "team/api", 42, "file:b.ts", "v1");
    await a.setViewed("ali", "team/api", 42, "file:b.ts", null);
    await a.setViewed("sara", "team/api", 42, "file:c.ts", "v1");

    const b = new FileViewedStore(join(d, "viewed.json"));
    expect(await b.getViewed("ali", "team/api", 42)).toEqual({ "file:a.ts": "v1" });
    expect(await b.getViewed("sara", "team/api", 42)).toEqual({ "file:c.ts": "v1" });
    expect(await b.getViewed("ali", "team/api", 7)).toEqual({});
  });

  it("keep the version that was viewed; viewing again replaces it", async () => {
    const store = new FileViewedStore(join(tmp(), "viewed.json"));
    await store.setViewed("ali", "team/api", 42, "file:a.ts", "v1");
    expect(await store.setViewed("ali", "team/api", 42, "file:a.ts", "v2")).toEqual({ "file:a.ts": "v2" });
  });

  it("read from a file saved before versions were kept match no version", async () => {
    const path = join(tmp(), "viewed.json");
    writeFileSync(path, JSON.stringify({ "ali|team/api!42": ["file:a.ts"] }));
    const store = new FileViewedStore(path);
    expect(await store.getViewed("ali", "team/api", 42)).toEqual({ "file:a.ts": "" });
    expect(await store.setViewed("ali", "team/api", 42, "file:b.ts", "v1")).toEqual({ "file:a.ts": "", "file:b.ts": "v1" });
  });
});
