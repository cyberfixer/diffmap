/**
 * How right name matching is, checked against a compiler: the links diffmap makes by
 * name are compared with the links a SCIP index gives for the same files.
 *
 *   npx vite-node scripts/measure-accuracy.ts <repo folder> --scip index.scip [--scip more.scip]
 *       [--show wrong|missed|unconfirmed [N]] [--json]
 *
 * The index comes from a compiler-based indexer run on the same checkout
 * (scip-java, scip-clang, rust-analyzer scip, scip-python, scip-typescript for
 * JavaScript, ...). Its paths must be relative to <repo folder>.
 *
 * Per language (TypeScript is left out: it already uses the compiler):
 *   right        links name matching made that the compiler also has
 *   wrong        links it made where the compiler says the name on that line is something else
 *   unconfirmed  links it made where the compiler has nothing for that name on that line
 *                (it could not work out the type: common in Python, JavaScript, Ruby, PHP)
 *   missed       links the compiler has that name matching did not make
 *   precision = right / (right + wrong): of the links the compiler can judge, how many are true
 *   recall    = right / (right + missed): of the true links, how many are shown
 *
 * A link is "this function uses that function": one per caller and target, however
 * many times it calls. Only links to functions and methods are scored, from files
 * the index covers. Links to classes are left out, because an index counts every
 * mention of a class (a parameter's type) and name matching only counts creating one.
 * Also left out: links from code outside every function, and "implements" links.
 *
 * --show prints N (default 20) examples, spread over the list.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { loadLanguageSupport } from "../src/infrastructure/language-support.js";
import { TreeSitterCallGraph } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-call-graph.js";
import { ScipCallGraph } from "../src/infrastructure/scip/scip-call-graph.js";
import { ROLE_DEFINITION, ROLE_IMPORT, decodeScip, isLocal, symbolName } from "../src/infrastructure/scip/scip-index.js";

const SKIP = new Set([".git", "node_modules", "build", "dist", "target", ".build", "Pods", "vendor"]);
const TS = /\.(ts|tsx|mts|cts)$/i;
const CALLABLE = new Set(["function", "method", "arrow"]);
const LANGUAGE: Record<string, string> = {
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".swift": "Swift", ".cs": "C#", ".scala": "Scala", ".sc": "Scala",
  ".go": "Go", ".rs": "Rust", ".py": "Python", ".php": "PHP", ".rb": "Ruby",
  ".c": "C", ".h": "C/C++ header", ".cpp": "C++", ".cc": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++", ".hxx": "C++",
};

const args = process.argv.slice(2);
const scipFiles: string[] = [];
let show: string | null = null;
let showCount = 20;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--scip") scipFiles.push(args[++i] ?? "");
  else if (args[i] === "--show") {
    show = args[++i] ?? "";
    if (/^\d+$/.test(args[i + 1] ?? "")) showCount = Number(args[++i]);
  } else if (!args[i].startsWith("--")) positional.push(args[i]);
}
const json = args.includes("--json");
if (!positional[0] || scipFiles.length === 0 || (show !== null && !["wrong", "missed", "unconfirmed"].includes(show))) {
  console.error("Usage: npx vite-node scripts/measure-accuracy.ts <repo folder> --scip index.scip [--show wrong|missed|unconfirmed [N]] [--json]");
  process.exit(1);
}
const root = resolve(positional[0]);

const langs = await loadLanguageSupport();
const matcher = langs.graphs.find((g): g is TreeSitterCallGraph => g instanceof TreeSitterCallGraph)!;
const index = decodeScip(Buffer.concat(scipFiles.map((f) => readFileSync(f))));
const indexed = new Set(index.documents.map((d) => d.path));

// Every file name matching reads: it needs the whole repo to know what a caller can reach.
const files: { path: string; source: string }[] = [];
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (matcher.supportedExtensions.includes(extname(name).toLowerCase()) && !TS.test(name) && st.size < 1_000_000) {
      files.push({ path: relative(root, full).split("\\").join("/"), source: readFileSync(full, "utf8") });
    }
  }
};
walk(root);
const covered = files.filter((f) => indexed.has(f.path));
if (covered.length === 0) {
  console.error(`The index covers none of the ${files.length} files found. Are its paths relative to ${root}? It starts with: ${[...indexed].slice(0, 3).join(", ")}`);
  process.exit(1);
}

// What the compiler says: every link between symbols of the files the index covers.
const listed = langs.listSymbols(covered);
const kindOf = new Map<string, string>();
for (const [path, symbols] of listed) for (const s of symbols) if (!kindOf.has(`${path}#${s.name}`)) kindOf.set(`${path}#${s.name}`, s.kind);
const exactEdges = new ScipCallGraph(index, [], langs.listSymbols).build({ files: covered, changedIds: [...kindOf.keys()], removed: [], depth: 1 }).edges;

// What name matching says, for the same callers.
const { collector } = matcher.link(files, []);

const fileOf = (id: string): string => id.slice(0, id.indexOf("#"));
/** The name as a call writes it: no owner, no Swift argument labels. */
const written = (id: string): string => id.slice(id.indexOf("#") + 1).split(".").pop()!.replace(/\((?:[^\s():]+:)+\)$/, "");
type Edge = { from: string; to: string; kind: string; sites?: { line: number }[] };
const scored = (e: Edge): boolean =>
  e.kind === "calls" && indexed.has(fileOf(e.from)) && indexed.has(fileOf(e.to)) && CALLABLE.has(kindOf.get(e.to) ?? "");
const pair = (e: Edge): string => `${e.from} -> ${e.to}`;
const exact = new Set(exactEdges.filter(scored).map(pair));

// What the compiler has on each line, by the name written there: its targets in the repo,
// and whether it knows the name at all (it may point at a library, or at a class).
const at = (file: string, line: number, name: string): string => `${file}:${line}:${name}`;
const targetsAt = new Map<string, Set<string>>();
for (const e of exactEdges as Edge[]) {
  if (e.kind !== "calls") continue;
  for (const s of e.sites ?? []) {
    const key = at(fileOf(e.from), s.line, written(e.to));
    (targetsAt.get(key) ?? targetsAt.set(key, new Set()).get(key)!).add(e.to);
  }
}
const knownAt = new Set<string>();
for (const d of index.documents) {
  for (const o of d.occurrences) if (!(o.roles & (ROLE_DEFINITION | ROLE_IMPORT)) && !isLocal(o.symbol)) knownAt.add(at(d.path, o.line + 1, symbolName(o.symbol)));
}

interface Score { files: number; right: number; wrong: number; unconfirmed: number; missed: number }
const scores = new Map<string, Score>();
/** The score of a file's language; a link counts for the language of its caller. */
const scoreOf = (pathOrLink: string): Score => {
  const ext = extname(pathOrLink.includes("#") ? fileOf(pathOrLink) : pathOrLink).toLowerCase();
  const language = LANGUAGE[ext] ?? ext;
  return scores.get(language) ?? scores.set(language, { files: 0, right: 0, wrong: 0, unconfirmed: 0, missed: 0 }).get(language)!;
};
for (const f of covered) scoreOf(f.path).files++;
const wrong: string[] = [];
const unconfirmed: string[] = [];
const missed: string[] = [];
const matched = new Set<string>();
for (const e of collector.calls.values() as Iterable<Edge>) {
  if (!scored(e)) continue;
  const p = pair(e);
  matched.add(p);
  if (exact.has(p)) {
    scoreOf(p).right++;
    continue;
  }
  // Not a link the compiler has. Does it say something else about that name on those lines, or nothing?
  const keys = (e.sites ?? []).map((s) => at(fileOf(e.from), s.line, written(e.to)));
  if (keys.some((k) => targetsAt.has(k) || knownAt.has(k))) {
    scoreOf(p).wrong++;
    wrong.push(p);
  } else {
    scoreOf(p).unconfirmed++;
    unconfirmed.push(p);
  }
}
for (const p of exact) {
  if (!matched.has(p)) {
    scoreOf(p).missed++;
    missed.push(p);
  }
}

const pct = (n: number, of: number): string => (of ? `${((n / of) * 100).toFixed(1)}%` : "-");
const rows = [...scores].sort((a, b) => b[1].right + b[1].missed - (a[1].right + a[1].missed));
if (json) {
  console.log(JSON.stringify({
    repo: root, files: files.length, covered: covered.length,
    languages: Object.fromEntries(rows.map(([language, s]) => [language, {
      ...s,
      precision: s.right + s.wrong ? s.right / (s.right + s.wrong) : null,
      recall: s.right + s.missed ? s.right / (s.right + s.missed) : null,
    }])),
  }, null, 2));
} else {
  console.log(`${root}\n${covered.length} of ${files.length} files are in the index\n`);
  console.log(`${"language".padEnd(14)}${"files".padStart(7)}${"right".padStart(9)}${"wrong".padStart(9)}${"unconfirmed".padStart(13)}${"missed".padStart(9)}${"precision".padStart(11)}${"recall".padStart(9)}`);
  for (const [language, s] of rows) {
    console.log(
      `${language.padEnd(14)}${String(s.files).padStart(7)}${String(s.right).padStart(9)}${String(s.wrong).padStart(9)}${String(s.unconfirmed).padStart(13)}${String(s.missed).padStart(9)}` +
        `${pct(s.right, s.right + s.wrong).padStart(11)}${pct(s.right, s.right + s.missed).padStart(9)}`,
    );
  }
  if (show) {
    const list = (show === "wrong" ? wrong : show === "missed" ? missed : unconfirmed).sort();
    const step = Math.max(1, Math.floor(list.length / showCount));
    console.log(`\n${list.length} ${show} links, every ${step}th:`);
    for (let i = 0; i < list.length && i / step < showCount; i += step) console.log(`  ${list[i]}`);
  }
}
