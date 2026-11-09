/**
 * How well name matching links calls in a repo (no compiler, no index).
 *
 *   npx vite-node scripts/measure-links.ts <repo folder> [.ext ...]
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

const [root, ...extArgs] = process.argv.slice(2);
if (!root) {
  console.error("usage: measure-links.ts <repo folder> [.ext ...]");
  process.exit(1);
}
const engine = await TreeSitterEngine.load();
const exts = extArgs.length ? extArgs : engine.extensions;
const files = listFiles(root, exts);
const { stats: s, meta } = new TreeSitterCallGraph(engine).link(files);

const inRepo = s.calls - s.external;
const pct = (n: number) => (inRepo ? ((100 * n) / inRepo).toFixed(1) + "%" : "-");
console.log(`${files.length} files, ${meta.size} symbols, ${s.calls} calls (${s.external} external)`);
console.log(`calls to repo code: ${inRepo}`);
console.log(`  one target    ${String(s.one).padStart(7)}  ${pct(s.one)}`);
console.log(`  2-5 targets   ${String(s.several).padStart(7)}  ${pct(s.several)}`);
console.log(`  too many      ${String(s.tooMany).padStart(7)}  ${pct(s.tooMany)}`);
console.log(`  unreachable   ${String(s.unreachable).padStart(7)}  ${pct(s.unreachable)}`);
console.log(`implements links: ${s.implementsLinks}`);
