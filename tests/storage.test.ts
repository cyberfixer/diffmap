import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
    await a.setViewed("ali", "team/api", 42, "a.ts#f", true);
    await a.setViewed("ali", "team/api", 42, "a.ts#g", true);
    await a.setViewed("ali", "team/api", 42, "a.ts#g", false);
    await a.setViewed("sara", "team/api", 42, "a.ts#h", true);

    const b = new FileViewedStore(join(d, "viewed.json"));
    expect(await b.getViewed("ali", "team/api", 42)).toEqual(["a.ts#f"]);
    expect(await b.getViewed("sara", "team/api", 42)).toEqual(["a.ts#h"]);
    expect(await b.getViewed("ali", "team/api", 7)).toEqual([]);
  });
});
