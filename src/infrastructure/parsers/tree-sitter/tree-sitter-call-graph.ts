import type { CallGraphInput, CallGraphPort, CallGraphResult } from "../../../application/ports/call-graph.port.js";
import { CallCollector, walkNeighbourhood } from "../../../application/call-graph-walk.js";
import type { GraphNode } from "../../../domain/graph.js";
import type { FoundCall, TreeSitterEngine } from "./engine.js";
import { Visibility, typeOfVariable } from "./visibility.js";

/** Above this many same-named targets a call is too ambiguous to draw (think `get`, `run`). */
const MAX_TARGETS = 5;

const simple = (name: string): string => name.split(".").pop()!;
const owner = (name: string): string => name.split(".").slice(0, -1).join(".");
const ownerSimple = (name: string): string => simple(owner(name) || "");

/**
 * Call graph by name, narrowed to what the calling code can actually reach:
 * - `self.x()` / `this.x()` -> x in the same class;
 * - `Svc.x()` or a variable whose type is visible (`Svc s`, `s: Svc`, `s = Svc()`) -> Svc's x;
 * - otherwise x in the same file, then in files it imports or shares a folder with.
 * If nothing is reachable, a call is linked only when the name is unique in the repo.
 * No type checking, so it can still miss or over-link; a SCIP index makes it exact.
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
    const calls: (FoundCall & { file: string })[] = [];

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
    const visibility = new Visibility(input.files);

    const removedByName = new Map<string, string[]>();
    for (const r of input.removed) {
      const key = simple(r.name);
      removedByName.set(key, [...(removedByName.get(key) ?? []), r.id]);
    }

    const collector = new CallCollector();
    for (const c of calls) {
      const from = `${c.file}#${c.from}`;
      const text = linesOf.get(c.file)?.[c.line - 1] ?? "";
      const all = (byName.get(c.name) ?? []).filter((id) => id !== from);
      const targets = this.narrow(all, c, from, meta, linesOf, visibility);
      if (targets.length > 0 && targets.length <= MAX_TARGETS) {
        for (const to of targets) collector.add(from, to, "calls", c.line, text);
      } else if (all.length === 0) {
        // Nothing by that name exists any more: probably a call to removed code.
        for (const to of removedByName.get(c.name) ?? []) collector.add(from, to, "calls-removed", c.line, text);
      }
    }

    return walkNeighbourhood({ meta, linesOf, calls: collector.calls, changedIds: input.changedIds, depth: input.depth });
  }

  /** Keep only the targets the call can reach (see the class comment). */
  private narrow(
    all: string[],
    c: FoundCall & { file: string },
    from: string,
    meta: Map<string, GraphNode>,
    linesOf: Map<string, string[]>,
    visibility: Visibility,
  ): string[] {
    if (all.length === 0) return [];
    const node = (id: string) => meta.get(id)!;
    const caller = meta.get(from);

    // self.x() / this.x(): the caller's own class (or, if it isn't there, an inherited one it can see)
    if (c.receiver === "self" && caller) {
      const cls = owner(caller.name);
      const own = all.filter((id) => node(id).file === c.file && owner(node(id).name) === cls);
      if (own.length) return own;
      return all.filter((id) => owner(node(id).name) !== "" && visibility.canSee(c.file, node(id).file));
    }

    // Svc.x() or v.x() where v's type is written down: that class's x
    const lastPart = c.receiver.split(/\.|->|::/).pop() ?? "";
    let typeName: string | null = /^[A-Z]/.test(lastPart) ? lastPart : null;
    if (!typeName && /^\$?[A-Za-z_]\w*$/.test(c.receiver) && caller) {
      const code = (linesOf.get(c.file) ?? []).slice(caller.line - 1, caller.endLine ?? caller.line).join("\n");
      typeName = typeOfVariable(c.receiver, code);
    }
    if (typeName) {
      const typed = all.filter((id) => ownerSimple(node(id).name) === typeName || simple(node(id).name) === typeName);
      if (typed.length) return typed;
    }

    // Same file first, then files the caller imports or shares a folder with.
    const local = all.filter((id) => node(id).file === c.file);
    if (local.length) return local;
    const visible = all.filter((id) => visibility.canSee(c.file, node(id).file));
    if (visible.length) return visible;

    // Nothing reachable: only a name that exists once in the whole repo is trusted.
    return all.length === 1 ? all : [];
  }
}
