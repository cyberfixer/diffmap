import { parentPort, workerData } from "node:worker_threads";
import { AnalyzeRangeUseCase } from "../../application/use-cases/analyze-range.js";
import { GitDiffReader } from "../git/git-diff-reader.js";
import { GitSourceReader } from "../git/git-source-reader.js";
import { loadLanguageSupport, withIndex } from "../language-support.js";
import { decodeScip } from "../scip/scip-index.js";
import { join } from "node:path";
import { FileOutlineCache, OUTLINES_FILE } from "../parsers/tree-sitter/outline-cache.js";

/** Runs one analysis off the main thread, so the web server keeps answering. */
const { gitDir, base, head, index } = workerData as { gitDir: string; base: string; head: string; index?: Uint8Array };
try {
  const langs = withIndex(await loadLanguageSupport(), index ? decodeScip(index) : null);
  // What was read from each file is kept next to the project's code: a later
  // analysis of the same project only parses the files that changed.
  const outlines = new FileOutlineCache(join(gitDir, OUTLINES_FILE), langs.treeSitter.stamp);
  langs.treeSitter.cache = outlines;
  const result = new AnalyzeRangeUseCase(
    new GitDiffReader(gitDir),
    new GitSourceReader(gitDir),
    langs.parsers,
    langs.graphs,
  ).execute(base, head);
  outlines.save();
  parentPort!.postMessage({ ok: true, result });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
