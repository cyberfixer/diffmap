import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";

let repo: FixtureRepo;
afterEach(() => repo?.cleanup());

describe("reading many files at once", () => {
  it("gives the same text as reading each file on its own", () => {
    repo = createFixtureRepo();
    repo.write("a.ts", "export const a = 1;\n");
    repo.write("src/no-newline.txt", "last line without a line break");
    repo.write("src/empty.txt", "");
    repo.write("src/arabic.md", "مرحبا بالعالم\nline two\n");
    repo.write("src/crlf.txt", "one\r\ntwo\r\n");
    repo.commit("first");
    repo.write("a.ts", "export const a = 2;\n");
    repo.commit("second");

    const reader = new GitSourceReader(repo.dir);
    const paths = ["a.ts", "src/no-newline.txt", "missing.ts", "src/empty.txt", "src", "src/arabic.md", "src/crlf.txt"];
    for (const rev of ["HEAD", "HEAD~1"]) {
      const sources = reader.getSources(rev, paths);
      expect([...sources.keys()]).toEqual(paths);
      for (const p of paths.filter((p) => p !== "src")) {
        expect(sources.get(p), `${rev}:${p}`).toBe(reader.getSource(rev, p));
      }
    }
    expect(reader.getSources("HEAD", paths).get("a.ts")).toBe("export const a = 2;\n");
    expect(reader.getSources("HEAD", paths).get("missing.ts")).toBeNull();
    // A folder is not a file.
    expect(reader.getSources("HEAD", paths).get("src")).toBeNull();
  });

  it("reads more files than fit in one batch, and none", () => {
    repo = createFixtureRepo();
    const paths = Array.from({ length: 1205 }, (_, i) => `f/${i}.txt`);
    mkdirSync(join(repo.dir, "f"));
    for (const p of paths) writeFileSync(join(repo.dir, p), `content of ${p}\n`);
    repo.git("add", ".");
    repo.commit("many");

    const reader = new GitSourceReader(repo.dir);
    const sources = reader.getSources("HEAD", paths);
    expect(sources.size).toBe(paths.length);
    expect(paths.every((p) => sources.get(p) === `content of ${p}\n`)).toBe(true);
    expect(reader.getSources("HEAD", []).size).toBe(0);
  });
});
