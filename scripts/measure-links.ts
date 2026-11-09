/**
 * How well name matching links calls in a repo (no compiler, no index).
 *
 *   npx vite-node scripts/measure-links.ts <repo folder> [.ext ...] [--show <outcome> [N]]
 *
 * --show prints N (default 20) example calls with that outcome:
 * one, several, tooMany, unreachable, libraryType, external.
 *
 * Counts every call tree-sitter finds: linked to exactly one target, to several,
 * dropped (too many candidates, or none reachable), or external (no symbol of
 * that name in the repo, e.g. a library call). Run before and after a change to
 * the matching rules to see whether it helps.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { TreeSitterEngine } from "../src/infrastructure/parsers/tree-sitter/engine.js";
import { TreeSitterCallGraph } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-call-graph.js";

const SKIP = new Set([".git", "node_modules", "build", "dist", "target", ".build", "Pods", "vendor"]);

function listFiles(root: string, exts: string[]): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (exts.includes(extname(name).toLowerCase()) && st.size < 1_000_000) {
        out.push({ path: relative(root, full), source: readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

const args = process.argv.slice(2);
const showAt = args.indexOf("--show");
const show = showAt >= 0 ? args[showAt + 1] : null;
const showCount = showAt >= 0 && /^\d+$/.test(args[showAt + 2] ?? "") ? Number(args[showAt + 2]) : 20;
const [root, ...extArgs] = args.filter((a, i) => showAt < 0 || i < showAt);
if (!root) {
  console.error("usage: measure-links.ts <repo folder> [.ext ...]");
  process.exit(1);
}
const engine = await TreeSitterEngine.load();
const exts = extArgs.length ? extArgs : engine.extensions;
const files = listFiles(root, exts);
const examples: string[] = [];
const { stats: s, meta } = new TreeSitterCallGraph(engine).link(files, [], (c) => {
  if (c.outcome !== show) return;
  const text = files.find((f) => f.path === c.file)?.source.split("\n")[c.line - 1]?.trim() ?? "";
  examples.push(`${c.file}:${c.line}  ${c.receiver ? c.receiver + " . " : ""}${c.name}   ${text.slice(0, 100)}${c.targets.length ? "  -> " + c.targets.join(", ") : ""}`);
});

const inRepo = s.calls - s.external;
const pct = (n: number) => (inRepo ? ((100 * n) / inRepo).toFixed(1) + "%" : "-");
console.log(`${files.length} files, ${meta.size} symbols, ${s.calls} calls (${s.external} external)`);
console.log(`calls to repo code: ${inRepo}`);
console.log(`  one target    ${String(s.one).padStart(7)}  ${pct(s.one)}`);
console.log(`  2-5 targets   ${String(s.several).padStart(7)}  ${pct(s.several)}`);
console.log(`  too many      ${String(s.tooMany).padStart(7)}  ${pct(s.tooMany)}`);
console.log(`  unreachable   ${String(s.unreachable).padStart(7)}  ${pct(s.unreachable)}`);
console.log(`  library type  ${String(s.libraryType).padStart(7)}  ${pct(s.libraryType)}  (left out on purpose)`);
console.log(`implements links: ${s.implementsLinks}`);
if (show) {
  console.log(`\n${examples.length} calls "${show}", every ${Math.max(1, Math.floor(examples.length / showCount))}th:`);
  const step = Math.max(1, Math.floor(examples.length / showCount));
  for (let i = 0; i < examples.length && i / step < showCount; i += step) console.log("  " + examples[i]);
}
