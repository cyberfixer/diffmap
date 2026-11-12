import { AnalyzeRangeUseCase } from "../../application/use-cases/analyze-range.js";
import { GitDiffReader } from "../../infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../../infrastructure/git/git-source-reader.js";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FileOutlineCache, OUTLINES_FILE } from "../../infrastructure/parsers/tree-sitter/outline-cache.js";
import { loadLanguageSupport, withIndex } from "../../infrastructure/language-support.js";
import { decodeScip } from "../../infrastructure/scip/scip-index.js";
import { renderHtml } from "../html/render-html.js";

function usage(): void {
  console.error(
    "Usage: diffmap <base>[..<head>] [--format json|html] [--depth N] [--scip index.scip]... [--no-cache]\n\n" +
      "  --no-cache    parse every file again, ignoring what earlier runs kept in .git/diffmap-outlines.json\n" +
      "  --scip FILE   exact calls from a SCIP index (scip-typescript, scip-java, scip-clang, rust-analyzer); repeatable\n\n" +
      "Examples:\n  diffmap main\n  diffmap main..HEAD\n  diffmap main --format html > report.html\n  diffmap main --scip index.scip --format html > report.html"
  );
}

export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  let format = "json";
  let depth = 1;
  let noCache = false;
  const scipFiles: string[] = [];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format") {
      format = args[++i] ?? "";
    } else if (args[i].startsWith("--format=")) {
      format = args[i].slice("--format=".length);
    } else if (args[i] === "--scip") {
      scipFiles.push(args[++i] ?? "");
    } else if (args[i].startsWith("--scip=")) {
      scipFiles.push(args[i].slice("--scip=".length));
    } else if (args[i] === "--no-cache") {
      noCache = true;
    } else if (args[i] === "--depth") {
      depth = Number(args[++i]);
    } else if (args[i].startsWith("--depth=")) {
      depth = Number(args[i].slice("--depth=".length));
    } else {
      positional.push(args[i]);
    }
  }

  const arg = positional[0];

  if (!arg || arg === "--help" || arg === "-h") {
    usage();
    process.exit(arg ? 0 : 1);
  }

  if (format !== "json" && format !== "html") {
    console.error(`Error: unknown format "${format}" (expected json or html).`);
    process.exit(1);
  }

  if (!Number.isInteger(depth) || depth < 0) {
    console.error("Error: --depth must be a non-negative integer.");
    process.exit(1);
  }

  let base: string;
  let head: string;

  if (arg.includes("..")) {
    const idx = arg.indexOf("..");
    base = arg.slice(0, idx);
    head = arg.slice(idx + 2) || "HEAD";
  } else {
    base = arg;
    head = "HEAD";
  }

  if (!base) {
    console.error("Error: base ref must not be empty.");
    usage();
    process.exit(1);
  }

  try {
    // Several index files are simply joined: SCIP merges them.
    const index = scipFiles.length ? decodeScip(Buffer.concat(scipFiles.map((f) => readFileSync(f)))) : null;
    const langs = withIndex(await loadLanguageSupport(), index);
    // What was read from each file is kept in the repo's .git folder, so the next
    // run only parses the files that changed (--no-cache to read everything again).
    const gitDir = noCache ? "" : spawnSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf-8" }).stdout?.trim();
    const outlines = gitDir ? new FileOutlineCache(join(gitDir, OUTLINES_FILE), langs.treeSitter.stamp) : null;
    langs.treeSitter.cache = outlines;
    const useCase = new AnalyzeRangeUseCase(new GitDiffReader(), new GitSourceReader(), langs.parsers, langs.graphs);
    const result = useCase.execute(base, head, { depth });
    outlines?.save();
    process.stdout.write(
      format === "html" ? renderHtml(result, langs.highlighters) : JSON.stringify(result, null, 2) + "\n"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
