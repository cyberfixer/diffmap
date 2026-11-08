import type { CallSite, GraphEdge, GraphNode } from "../domain/graph.js";
import type { CallGraphResult } from "./ports/call-graph.port.js";

export type ResolvedCall = GraphEdge & { sites: CallSite[] };

/**
 * Collects resolved calls (with the lines they are written on), one edge per
 * caller -> callee pair. Language adapters feed it; the walk below is shared.
 */
export class CallCollector {
  readonly calls = new Map<string, ResolvedCall>();

  add(from: string, to: string, kind: GraphEdge["kind"], line: number, text: string): void {
    if (from === to) return;
    const key = `${from}>${to}>${kind}`;
    const edge = this.calls.get(key) ?? this.calls.set(key, { from, to, kind, sites: [] }).get(key)!;
    if (!edge.sites.some((s) => s.line === line)) edge.sites.push({ line, text });
  }
}

/**
 * From every call in the repo, keep the neighbourhood of the changed symbols:
 * `depth` hops of callers and callees, plus every call into removed code.
 * Unchanged neighbours carry their whole source so the report can show them.
 */
export function walkNeighbourhood(input: {
  meta: Map<string, GraphNode>; // every symbol in the repo
  linesOf: Map<string, string[]>; // source lines per file
  calls: Map<string, ResolvedCall>;
  changedIds: string[];
  depth: number;
}): CallGraphResult {
  const { meta, linesOf, calls, depth } = input;
  // Calls and "implements" links both count as neighbours; each pair keeps its edges.
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const between = new Map<string, ResolvedCall[]>();
  for (const e of calls.values()) {
    if (e.kind === "calls-removed") continue;
    (out.get(e.from) ?? out.set(e.from, new Set()).get(e.from)!).add(e.to);
    (inn.get(e.to) ?? inn.set(e.to, new Set()).get(e.to)!).add(e.from);
    const pair = `${e.from}>${e.to}`;
    between.set(pair, [...(between.get(pair) ?? []), e]);
  }

  const changed = new Set(input.changedIds.filter((id) => meta.has(id)));
  const included = new Set(changed);
  const edges = new Map<string, GraphEdge>();
  const keep = (from: string, to: string): void => {
    for (const e of between.get(`${from}>${to}`) ?? []) edges.set(`${from}>${to}>${e.kind}`, e);
  };

  for (const direction of ["callees", "callers"] as const) {
    let frontier = new Set(changed);
    for (let hop = 0; hop < depth; hop++) {
      const next = new Set<string>();
      for (const id of frontier) {
        for (const n of (direction === "callees" ? out : inn).get(id) ?? []) {
          if (direction === "callees") keep(id, n);
          else keep(n, id);
          if (!included.has(n)) next.add(n);
          included.add(n);
        }
      }
      frontier = next;
    }
  }

  // Calls into removed symbols always show, with their callers.
  for (const e of calls.values()) {
    if (e.kind !== "calls-removed") continue;
    edges.set(`${e.from}>${e.to}>${e.kind}`, e);
    included.add(e.from);
  }

  const nodes: GraphNode[] = [];
  for (const id of included) {
    const n = meta.get(id);
    if (!n) continue;
    const isChanged = changed.has(id);
    const code = isChanged ? undefined : linesOf.get(n.file)?.slice(n.line - 1, n.endLine ?? n.line);
    nodes.push({ ...n, changed: isChanged, ...(code ? { code } : {}) });
  }
  return { nodes, edges: [...edges.values()] };
}
