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

/** How each call in the repo was linked (for measuring the matching rules). */
export interface LinkStats {
  calls: number;
  /** No symbol of that name in the repo: a library or built-in call. */
  external: number;
  one: number;
  several: number;
  /** More than MAX_TARGETS candidates left: not drawn. */
  tooMany: number;
  /** Symbols of that name exist, but none the caller can reach. */
  unreachable: number;
  /** Made on a variable whose type the repo doesn't define (String, List…): left out. */
  libraryType: number;
  implementsLinks: number;
}

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
    const { meta, linesOf, collector } = this.link(input.files, input.removed);
    return walkNeighbourhood({ meta, linesOf, calls: collector.calls, changedIds: input.changedIds, depth: input.depth });
  }

  /** Every symbol in the files and every call between them, plus how each call was linked. */
  link(files: CallGraphInput["files"], removed: CallGraphInput["removed"] = []) {
    const meta = new Map<string, GraphNode>();
    const linesOf = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const calls: (FoundCall & { file: string })[] = [];

    for (const f of files) {
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
    const visibility = new Visibility(files);
    const scope = new TypeScope(meta, linesOf, visibility);

    const removedByName = new Map<string, string[]>();
    for (const r of removed) {
      const key = simple(r.name);
      removedByName.set(key, [...(removedByName.get(key) ?? []), r.id]);
    }

    const stats: LinkStats = { calls: 0, external: 0, one: 0, several: 0, tooMany: 0, unreachable: 0, libraryType: 0, implementsLinks: 0 };
    const collector = new CallCollector();
    for (const c of calls) {
      const from = `${c.file}#${c.from}`;
      const text = linesOf.get(c.file)?.[c.line - 1] ?? "";
      const all = (byName.get(c.name) ?? []).filter((id) => id !== from);
      const narrowed = this.narrow(all, c, from, meta, scope, visibility);
      const targets = narrowed ?? [];
      stats.calls++;
      if (all.length === 0) stats.external++;
      else if (narrowed === null) stats.libraryType++;
      else if (targets.length === 0) stats.unreachable++;
      else if (targets.length === 1) stats.one++;
      else if (targets.length <= MAX_TARGETS) stats.several++;
      else stats.tooMany++;
      if (targets.length > 0 && targets.length <= MAX_TARGETS) {
        for (const to of targets) collector.add(from, to, "calls", c.line, text);
      } else if (all.length === 0) {
        // Nothing by that name exists any more: probably a call to removed code.
        for (const to of removedByName.get(c.name) ?? []) collector.add(from, to, "calls-removed", c.line, text);
      }
    }
    return { meta, linesOf, collector, stats };
  }

  /** Keep only the targets the call can reach (see the class comment); null for a call on a library type. */
  private narrow(
    all: string[],
    c: FoundCall & { file: string },
    from: string,
    meta: Map<string, GraphNode>,
    scope: TypeScope,
    visibility: Visibility,
  ): string[] | null {
    if (all.length === 0) return [];
    const node = (id: string) => meta.get(id)!;
    const caller = meta.get(from);
    const receiver = caller ? scope.plainReceiver(c.receiver, caller) : c.receiver;

    // self.x() / this.x(): the caller's own class (or, if it isn't there, an inherited one it can see)
    if (receiver === "self" && caller) {
      const cls = owner(caller.name);
      const own = all.filter((id) => node(id).file === c.file && owner(node(id).name) === cls);
      if (own.length) return own;
      return all.filter((id) => owner(node(id).name) !== "" && visibility.canSee(c.file, node(id).file));
    }

    // Svc.x() or v.x() where v's type is written down: that class's x
    const lastPart = receiver.split(/\.|->|::/).pop() ?? "";
    let typeName: string | null = /^[A-Z]/.test(lastPart) ? lastPart : null;
    if (!typeName && /^[$@]?[A-Za-z_]\w*$/.test(receiver) && caller) typeName = scope.typeOf(receiver, caller);
    if (typeName) {
      // A type the repo doesn't define (String, List, a library class): not a call into repo code.
      if (!scope.isRepoType(typeName)) return null;
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

const TYPE_KINDS = new Set(["class", "struct", "interface", "enum", "trait", "module"]);
const CONSTRUCTORS = new Set(["__init__", "initialize", "constructor", "__construct", "init"]);

/**
 * Where variable types are written down: the calling method, then its class
 * (fields, properties, constructor parameters), then classes of the same name
 * the caller can see (Swift extensions, Go structs declared in another file).
 */
class TypeScope {
  private readonly typesByName = new Map<string, GraphNode[]>();
  /** Types the repo defines or adds methods to (Swift `extension String { ... }`). */
  private readonly repoTypes = new Set<string>();
  /** Lines of each type's members, so their local variables don't count as fields. */
  private readonly memberLines = new Map<string, [number, number][]>();
  private readonly cache = new Map<string, string | null>();

  constructor(
    private readonly meta: Map<string, GraphNode>,
    private readonly linesOf: Map<string, string[]>,
    private readonly visibility: Visibility,
  ) {
    for (const n of meta.values()) {
      if (TYPE_KINDS.has(n.kind)) {
        const key = simple(n.name);
        this.typesByName.set(key, [...(this.typesByName.get(key) ?? []), n]);
        this.repoTypes.add(key);
      }
      const cls = owner(n.name);
      if (cls) this.repoTypes.add(simple(cls));
      // Constructors stay: Python, Ruby, JS and PHP set their fields there (`self.repo = Repo()`).
      if (cls && !CONSTRUCTORS.has(simple(n.name)) && simple(n.name) !== simple(cls)) {
        const key = `${n.file}#${cls}`;
        this.memberLines.set(key, [...(this.memberLines.get(key) ?? []), [n.line, n.endLine ?? n.line]]);
      }
    }
  }

  isRepoType(name: string): boolean {
    return this.repoTypes.has(name);
  }

  /** `this.repo` / `self.repo` / `$this->repo` / `@repo` -> "repo"; Go's `s` in `func (s *Svc)` -> "self". */
  plainReceiver(receiver: string, caller: GraphNode): string {
    let r = receiver.replace(/^(?:this|self|\$this)\s*(?:\.|->)\s*/, "").replace(/^@(?=\w)/, "");
    const head = /^(\w+)(?:\.|$)/.exec(r)?.[1];
    if (head && caller.kind === "method") {
      const first = this.linesOf.get(caller.file)?.[caller.line - 1] ?? "";
      if (new RegExp(`^\\s*func\\s*\\(\\s*${head}\\s+\\*?[A-Z]`).test(first)) r = r === head ? "self" : r.slice(head.length + 1);
    }
    return r;
  }

  typeOf(variable: string, caller: GraphNode): string | null {
    const key = `${caller.id}>${variable}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    let found = typeOfVariable(variable, this.code(caller));
    const cls = owner(caller.name);
    if (!found && cls) {
      const own = this.meta.get(`${caller.file}#${cls}`);
      const others = (this.typesByName.get(simple(cls)) ?? []).filter(
        (t) => t !== own && t.name === cls && this.visibility.canSee(caller.file, t.file),
      );
      for (const t of own ? [own, ...others] : others) {
        found = this.fieldType(variable, t);
        if (found) break;
      }
    }
    this.cache.set(key, found);
    return found;
  }

  private fieldType(variable: string, type: GraphNode): string | null {
    const key = `${type.id}>>${variable}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const lines = [...(this.linesOf.get(type.file) ?? []).slice(type.line - 1, type.endLine ?? type.line)];
    for (const [a, b] of this.memberLines.get(`${type.file}#${type.name}`) ?? []) {
      if (a === type.line) continue; // a member on the type's own first line (Kotlin `class A(val x: X)`)
      for (let i = a; i <= b; i++) if (i - type.line >= 0 && i - type.line < lines.length) lines[i - type.line] = "";
    }
    const found = typeOfVariable(variable, lines.join("\n"));
    this.cache.set(key, found);
    return found;
  }

  private code(n: GraphNode): string {
    return (this.linesOf.get(n.file) ?? []).slice(n.line - 1, n.endLine ?? n.line).join("\n");
  }
}
