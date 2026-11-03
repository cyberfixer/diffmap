import { AnalyzeRangeUseCase } from "../../application/use-cases/analyze-range.js";
import { GitDiffReader } from "../../infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../../infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../../infrastructure/parsers/typescript/ts-morph.adapter.js";
import { TsMorphCallGraph } from "../../infrastructure/parsers/typescript/ts-morph-call-graph.js";
import { renderHtml } from "../html/render-html.js";

function usage(): void {
  console.error(
    "Usage: git-map <base>[..<head>] [--format json|html] [--depth N]\n\n" +
      "Examples:\n  git-map main\n  git-map main..HEAD\n  git-map main --format html > report.html"
  );
}

export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);

  let format = "json";
  let depth = 1;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format") {
      format = args[++i] ?? "";
    } else if (args[i].startsWith("--format=")) {
      format = args[i].slice("--format=".length);
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

  const useCase = new AnalyzeRangeUseCase(
    new GitDiffReader(),
    new GitSourceReader(),
    [new TsMorphAdapter()],
    [new TsMorphCallGraph()],
  );

  try {
    const result = useCase.execute(base, head, { depth });
    process.stdout.write(
      format === "html" ? renderHtml(result) : JSON.stringify(result, null, 2) + "\n"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
