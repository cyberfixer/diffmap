/**
 * How long it takes to analyse a change and make its review page, and where the time goes.
 *
 *   npx vite-node scripts/bench-analysis.ts <repo folder> <base>[..<head>] [--runs N] [--one-by-one] [--json]
 *
 * --runs N       timed runs (default 5); one extra run before them warms up and is not counted
 * --one-by-one   read each file with its own git process (how it was before bulk reading), to compare
 * --json         print the numbers as JSON
 *
 * Each run is a whole analysis, as the command line and the service do it. The
 * time is split by who did the work: git (the diff, listing and reading files),
 * finding symbols in the changed files, the call graph over the whole repo, and
 * drawing the page. "Other" is what is left: file views and putting the result
 * together. Loading the languages happens once per process and is shown apart.
 * Run it before and after a change to see whether the change helps.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { AnalyzeRangeUseCase } from "../src/application/use-cases/analyze-range.js";
import type { SourceReaderPort } from "../src/application/ports/source-reader.port.js";
import { GitDiffReader } from "../src/infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../src/infrastructure/git/git-source-reader.js";
import { loadLanguageSupport } from "../src/infrastructure/language-support.js";
import { renderHtml } from "../src/interfaces/html/render-html.js";

const PHASES = ["git", "symbols", "call graph", "page", "other"] as const;
type Phase = (typeof PHASES)[number];
type Timings = Record<Phase | "total", number>;

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 5;
const positional = args.filter((a, i) => !a.startsWith("--") && (runsAt < 0 || i !== runsAt + 1));
const [repoArg, range] = positional;
if (!repoArg || !range || !Number.isInteger(runs) || runs < 1) {
  console.error("Usage: npx vite-node scripts/bench-analysis.ts <repo folder> <base>[..<head>] [--runs N] [--one-by-one] [--json]");
  process.exit(1);
}
const repo = resolve(repoArg);
const [base, head = "HEAD"] = range.includes("..") ? [range.slice(0, range.indexOf("..")), range.slice(range.indexOf("..") + 2) || "HEAD"] : [range];

let spent: Record<string, number> = {};
/** The same object, with the time spent inside its methods added to a phase. */
function timed<T extends object>(target: T, phase: Phase): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop);
      if (typeof value !== "function") return value;
      return (...a: unknown[]) => {
        const start = performance.now();
        try {
          return value.apply(obj, a);
        } finally {
          spent[phase] = (spent[phase] ?? 0) + performance.now() - start;
        }
      };
    },
  });
}

const loadStart = performance.now();
const langs = await loadLanguageSupport();
const loadMs = performance.now() - loadStart;

const gitReader = new GitSourceReader(repo);
// Without getSources the analysis falls back to one git process per file.
const sourceReader: SourceReaderPort = flag("--one-by-one")
  ? { getSource: (rev, p) => gitReader.getSource(rev, p), listFiles: (rev) => gitReader.listFiles(rev) }
  : gitReader;
const useCase = new AnalyzeRangeUseCase(
  timed(new GitDiffReader(repo), "git"),
  timed(sourceReader, "git"),
  langs.parsers.map((p) => timed(p, "symbols")),
  langs.graphs.map((g) => timed(g, "call graph")),
);

let size = { changedFiles: 0, symbols: 0, nodes: 0, edges: 0, pageBytes: 0 };
function once(): Timings {
  spent = {};
  const start = performance.now();
  const result = useCase.execute(base, head);
  const analysed = performance.now();
  const html = renderHtml(result, langs.highlighters);
  const end = performance.now();
  size = {
    changedFiles: result.files.length,
    symbols: result.symbols.length,
    nodes: result.nodes.length,
    edges: result.edges.length,
    pageBytes: Buffer.byteLength(html),
  };
  const git = spent["git"] ?? 0;
  const symbols = spent["symbols"] ?? 0;
  const graph = spent["call graph"] ?? 0;
  return { git, symbols, "call graph": graph, page: end - analysed, other: analysed - start - git - symbols - graph, total: end - start };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

once(); // warm-up: the first run pays for compiling the code
const samples = Array.from({ length: runs }, once);
const of = (key: Phase | "total") => samples.map((s) => s[key]);
const repoFiles = gitReader.listFiles(head).length;
const peakMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
const gitVersion = spawnSync("git", ["--version"], { encoding: "utf-8" }).stdout.trim();

if (flag("--json")) {
  console.log(JSON.stringify({
    repo, base, head, runs, reading: flag("--one-by-one") ? "one by one" : "bulk",
    repoFiles, ...size, loadMs: Math.round(loadMs), memoryMb: peakMb,
    medianMs: Object.fromEntries([...PHASES, "total" as const].map((k) => [k, Math.round(median(of(k)))])),
    minMs: Math.round(Math.min(...of("total"))), maxMs: Math.round(Math.max(...of("total"))),
  }, null, 2));
} else {
  const ms = (n: number) => `${Math.round(n)} ms`.padStart(9);
  const total = median(of("total"));
  console.log(`${repo}  ${base}..${head}`);
  console.log(`${repoFiles} files in the repo, ${size.changedFiles} changed, ${size.symbols} changed symbols, ${size.nodes} on the map, ${size.edges} links, page ${(size.pageBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`${runs} runs after a warm-up, median; node ${process.version}, ${gitVersion}${flag("--one-by-one") ? "; files read one by one" : ""}\n`);
  for (const phase of PHASES) {
    const m = median(of(phase));
    console.log(`  ${phase.padEnd(11)}${ms(m)}  ${String(Math.round((m / total) * 100)).padStart(3)}%`);
  }
  console.log(`  ${"total".padEnd(11)}${ms(total)}        (fastest ${Math.round(Math.min(...of("total")))}, slowest ${Math.round(Math.max(...of("total")))})`);
  console.log(`\n  loading the languages, once per process: ${Math.round(loadMs)} ms; memory at the end: ${peakMb} MB`);
}
