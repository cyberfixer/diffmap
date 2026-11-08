import { parentPort, workerData } from "node:worker_threads";
import { AnalyzeRangeUseCase } from "../../application/use-cases/analyze-range.js";
import { GitDiffReader } from "../git/git-diff-reader.js";
import { GitSourceReader } from "../git/git-source-reader.js";
import { loadLanguageSupport } from "../language-support.js";

/** Runs one analysis off the main thread, so the web server keeps answering. */
const { gitDir, base, head } = workerData as { gitDir: string; base: string; head: string };
try {
  const langs = await loadLanguageSupport();
  const result = new AnalyzeRangeUseCase(
    new GitDiffReader(gitDir),
    new GitSourceReader(gitDir),
    langs.parsers,
    langs.graphs,
  ).execute(base, head);
  parentPort!.postMessage({ ok: true, result });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
