import { AnalyzeRangeUseCase } from "../../application/use-cases/analyze-range.js";
import { GitDiffReader } from "../../infrastructure/git/git-diff-reader.js";
import { GitSourceReader } from "../../infrastructure/git/git-source-reader.js";
import { TsMorphAdapter } from "../../infrastructure/parsers/typescript/ts-morph.adapter.js";

function usage(): void {
  console.error(
    "Usage: git-map <base>[..<head>]\n\nExamples:\n  git-map main\n  git-map main..HEAD\n  git-map v1.0..v2.0"
  );
}

export async function runCli(): Promise<void> {
  const arg = process.argv[2];

  if (!arg || arg === "--help" || arg === "-h") {
    usage();
    process.exit(arg ? 0 : 1);
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
  );

  try {
    const result = useCase.execute(base, head);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
