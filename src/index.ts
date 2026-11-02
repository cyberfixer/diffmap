import { analyzeRange } from "./analyzer/index.js";

function usage(): void {
  console.error(
    "Usage: git-map <base>[..<head>]\n\nExamples:\n  git-map main\n  git-map main..HEAD\n  git-map v1.0..v2.0"
  );
}

async function main(): Promise<void> {
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

  try {
    const result = await analyzeRange(base, head);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
