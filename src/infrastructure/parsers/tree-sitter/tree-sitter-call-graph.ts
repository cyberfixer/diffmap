import type { CallGraphInput, CallGraphPort, CallGraphResult } from "../../../application/ports/call-graph.port.js";
import { CallCollector, walkNeighbourhood } from "../../../application/call-graph-walk.js";
import type { GraphNode } from "../../../domain/graph.js";
import type { TreeSitterEngine } from "./engine.js";

/** Above this many same-named targets a call is too ambiguous to draw (think `get`, `run`). */
const MAX_TARGETS = 5;

const simple = (name: string): string => name.split(".").pop()!;

/**
 * Call graph by name matching: a call to `update(...)` links to the symbols
 * named `update`, preferring ones in the same file. No type checking, so it
 * can over-link when unrelated classes share a method name.
 */
export class TreeSitterCallGraph implements CallGraphPort {
  readonly supportedExtensions: readonly string[];

  constructor(private readonly engine: TreeSitterEngine) {
    this.supportedExtensions = engine.extensions;
  }

  build(input: CallGraphInput): CallGraphResult {
    const meta = new Map<string, GraphNode>();
    const linesOf = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const calls: { file: string; from: string; name: string; line: number }[] = [];

    for (const f of input.files) {
      const { symbols, calls: found } = this.engine.outline(f.path, f.source);
      linesOf.set(f.path, f.source.split("\n").map((l) => l.replace(/\r$/, "")));
      for (const s of symbols) {
        const id = `${f.path}#${s.name}`;
        if (meta.has(id)) continue; // overloads: keep the first
        meta.set(id, { id, file: f.path, name: s.name, kind: s.kind, changed: false, line: s.range.start, endLine: s.range.end, labels: [] });
        const key = simple(s.name);
        byName.set(key, [...(byName.get(key) ?? []), id]);
      }
      for (const c of found) calls.push({ file: f.path, ...c });
    }

    const removedByName = new Map<string, string[]>();
    for (const r of input.removed) {
      const key = simple(r.name);
      removedByName.set(key, [...(removedByName.get(key) ?? []), r.id]);
    }

    const collector = new CallCollector();
    for (const c of calls) {
      const from = `${c.file}#${c.from}`;
      const text = linesOf.get(c.file)?.[c.line - 1] ?? "";
      let targets = (byName.get(c.name) ?? []).filter((id) => id !== from);
      const local = targets.filter((id) => meta.get(id)!.file === c.file);
      if (local.length) targets = local;
      if (targets.length > 0 && targets.length <= MAX_TARGETS) {
        for (const to of targets) collector.add(from, to, "calls", c.line, text);
      } else if (targets.length === 0) {
        // Nothing by that name exists any more: probably a call to removed code.
        for (const to of removedByName.get(c.name) ?? []) collector.add(from, to, "calls-removed", c.line, text);
      }
    }

    return walkNeighbourhood({ meta, linesOf, calls: collector.calls, changedIds: input.changedIds, depth: input.depth });
  }
}
