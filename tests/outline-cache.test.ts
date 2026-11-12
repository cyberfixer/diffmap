import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLanguageSupport } from "../src/infrastructure/language-support.js";
import { FileOutlineCache, outlineKey } from "../src/infrastructure/parsers/tree-sitter/outline-cache.js";
import { TreeSitterCallGraph } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-call-graph.js";

let dir = "";
afterEach(async () => {
  (await loadLanguageSupport()).treeSitter.cache = null;
  rmSync(dir, { recursive: true, force: true });
});
const tmpFile = () => join((dir = mkdtempSync(join(tmpdir(), "diffmap-outlines-"))), "outlines.json");

const A = "class A:\n    def run(self, *args):\n        helper()\n\ndef helper():\n    pass\n";
const B = "def other():\n    helper()\n";

describe("what was read from a file is kept between runs", () => {
  it("gives the same outline from the file as from the text, without parsing again", async () => {
    const engine = (await loadLanguageSupport()).treeSitter;
    const file = tmpFile();
    const plain = engine.outline("a.py", A);

    const first = new FileOutlineCache(file, engine.stamp);
    engine.cache = first;
    expect(engine.outline("a.py", A)).toEqual(plain);
    expect(first.counts).toEqual({ reused: 0, parsed: 1 });
    first.save();

    // A new run: the same text, under any name with that extension, comes from the file.
    const second = new FileOutlineCache(file, engine.stamp);
    engine.cache = second;
    const again = engine.outline("moved/a.py", A);
    expect(again).toEqual(plain);
    expect(second.counts).toEqual({ reused: 1, parsed: 0 });
    // A function that takes any number of arguments (JSON has no Infinity).
    expect(Object.values(again.params).some(([, max]) => max === Infinity)).toBe(true);
    // Other text is parsed.
    engine.outline("b.py", B);
    expect(second.counts).toEqual({ reused: 1, parsed: 1 });
  });

  it("links a repo the same with and without it", async () => {
    const langs = await loadLanguageSupport();
    const graph = langs.graphs.find((g): g is TreeSitterCallGraph => g instanceof TreeSitterCallGraph)!;
    const files = [{ path: "a.py", source: A }, { path: "b.py", source: B }];
    const edges = () => [...graph.link(files).collector.calls.keys()].sort();
    const plain = edges();
    expect(plain).toContain("b.py#other>a.py#helper>calls");

    const file = tmpFile();
    for (let run = 0; run < 2; run++) {
      const cache = new FileOutlineCache(file, langs.treeSitter.stamp);
      langs.treeSitter.cache = cache;
      expect(edges()).toEqual(plain);
      expect(cache.counts).toEqual(run === 0 ? { reused: 0, parsed: 2 } : { reused: 2, parsed: 0 });
      cache.save();
    }
  });

  it("forgets files that are gone, and everything when the reading rules change", async () => {
    const engine = (await loadLanguageSupport()).treeSitter;
    const file = tmpFile();
    const first = new FileOutlineCache(file, engine.stamp);
    engine.cache = first;
    engine.outline("a.py", A);
    engine.outline("b.py", B);
    first.save();

    // The next run only meets a.py: b.py's outline is dropped from the file.
    const second = new FileOutlineCache(file, engine.stamp);
    engine.cache = second;
    engine.outline("a.py", A);
    second.save();
    const kept = JSON.parse(readFileSync(file, "utf-8")).outlines.map(([key]: [string]) => key);
    expect(kept).toEqual([outlineKey(".py", A)]);

    // Other rules (a new diffmap, a new grammar): nothing is reused.
    const other = new FileOutlineCache(file, "another-stamp");
    expect(other.get(outlineKey(".py", A))).toBeUndefined();
    // A broken file is the same as none.
    writeFileSync(file, "{ not json");
    expect(new FileOutlineCache(file, engine.stamp).get(outlineKey(".py", A))).toBeUndefined();
  });
});
