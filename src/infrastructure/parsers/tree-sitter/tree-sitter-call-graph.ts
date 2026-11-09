import type { CallGraphInput, CallGraphPort, CallGraphResult } from "../../../application/ports/call-graph.port.js";
import { CallCollector, walkNeighbourhood } from "../../../application/call-graph-walk.js";
import type { GraphNode } from "../../../domain/graph.js";
import type { FoundCall, TreeSitterEngine, TypeParents } from "./engine.js";
import { Visibility, typeOfVariable } from "./visibility.js";

/** Above this many same-named targets a call is too ambiguous to draw (think `get`, `run`). */
const MAX_TARGETS = 5;

const simple = (name: string): string => name.split(".").pop()!;
const owner = (name: string): string => name.split(".").slice(0, -1).join(".");
const ownerSimple = (name: string): string => simple(owner(name) || "");

export type LinkOutcome = "external" | "libraryType" | "unreachable" | "one" | "several" | "tooMany";

/** One call and how it was linked (for measuring the matching rules). */
export interface LinkedCall extends FoundCall {
  file: string;
  outcome: LinkOutcome;
  targets: string[];
}

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
  link(files: CallGraphInput["files"], removed: CallGraphInput["removed"] = [], onCall?: (c: LinkedCall) => void) {
    const meta = new Map<string, GraphNode>();
    const linesOf = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const calls: (FoundCall & { file: string })[] = [];
    const typeParents: (TypeParents & { file: string })[] = [];
    const returns = new Map<string, string>(); // symbol id -> declared return type
    const params = new Map<string, [number, number]>(); // symbol id -> [min, max] arguments

    for (const f of files) {
      const { symbols, calls: found, parents, returns: rets, params: ps } = this.engine.outline(f.path, f.source);
      for (const [name, range] of Object.entries(ps)) params.set(`${f.path}#${name}`, range);
      for (const p of parents) typeParents.push({ file: f.path, ...p });
      for (const [name, type] of Object.entries(rets)) returns.set(`${f.path}#${name}`, type);
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
    const scope = new TypeScope(meta, linesOf, visibility, typeParents, returns);

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
      let targets = narrowed ?? [];
      // Several left: keep those that accept this many arguments (if any do).
      if (targets.length > 1 && c.args !== undefined) {
        const fits = targets.filter((id) => {
          const r = params.get(id);
          return !r || (r[0] <= c.args! && c.args! <= r[1]);
        });
        if (fits.length) targets = fits;
      }
      // Several left (two classes named Order): the one the file imports.
      targets = visibility.preferImported(c.file, targets, (id) => meta.get(id)!.file);
      const outcome: LinkOutcome =
        all.length === 0 ? "external"
        : narrowed === null ? "libraryType"
        : targets.length === 0 ? "unreachable"
        : targets.length === 1 ? "one"
        : targets.length <= MAX_TARGETS ? "several"
        : "tooMany";
      stats.calls++;
      stats[outcome]++;
      onCall?.({ ...c, outcome, targets });
      if (targets.length > 0 && targets.length <= MAX_TARGETS) {
        for (const to of targets) collector.add(from, to, "calls", c.line, text);
      } else if (all.length === 0) {
        // Nothing by that name exists any more: probably a call to removed code.
        for (const to of removedByName.get(c.name) ?? []) collector.add(from, to, "calls-removed", c.line, text);
      }
    }
    stats.implementsLinks = this.linkImplementations(typeParents, meta, linesOf, scope, visibility, collector);
    return { meta, linesOf, collector, stats };
  }

  /**
   * `class Jpa implements Repo` (or `: Repo`, `extends`, `impl Repo for`): each
   * method of Jpa implements the same-named method of Repo and of Repo's own
   * parents, when the file can see them. Returns how many links were added.
   */
  private linkImplementations(
    typeParents: (TypeParents & { file: string })[],
    meta: Map<string, GraphNode>,
    linesOf: Map<string, string[]>,
    scope: TypeScope,
    visibility: Visibility,
    collector: CallCollector,
  ): number {
    const methodsOf = new Map<string, GraphNode[]>(); // owner's simple name -> its methods
    for (const n of meta.values()) {
      const o = owner(n.name);
      if (o && !TYPE_KINDS.has(n.kind)) methodsOf.set(simple(o), [...(methodsOf.get(simple(o)) ?? []), n]);
    }
    let added = 0;
    const seen = new Set<string>();
    for (const t of typeParents) {
      const ancestors = scope.ancestorsOf(simple(t.type));
      // Methods of this type: in the declaring file, or (Swift extensions) files that see each other.
      const own = (methodsOf.get(simple(t.type)) ?? []).filter(
        (m) => owner(m.name) === t.type && (m.file === t.file || visibility.canSee(m.file, t.file) || visibility.canSee(t.file, m.file)),
      );
      for (const m of own) {
        const name = simple(m.name);
        if (CONSTRUCTORS.has(name) || name === simple(t.type)) continue;
        for (const a of ancestors) {
          const candidates = (methodsOf.get(a) ?? []).filter((p) => simple(p.name) === name && p.id !== m.id);
          const visible = candidates.filter((p) => visibility.canSee(m.file, p.file));
          for (const p of visible.length ? visible : candidates.length === 1 ? candidates : []) {
            const key = `${m.id}>${p.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            collector.add(m.id, p.id, "implements", m.line, linesOf.get(m.file)?.[m.line - 1] ?? "");
            added++;
          }
        }
      }
    }
    return added;
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
      const inherited = scope.inAncestors(all, simple(cls), c.file);
      if (inherited.length) return inherited;
      return all.filter((id) => owner(node(id).name) !== "" && visibility.canSee(c.file, node(id).file));
    }

    // Svc.x() or v.x() where v's type is written down: that class's x
    // ...also through calls and fields: repo.find(id).total() -> find's return type
    const typeName = receiver && caller ? scope.typeOfExpr(receiver, caller) : null;
    if (typeName) {
      // A type the repo doesn't define (String, List, a library class): not a call into repo code.
      if (!scope.isRepoType(typeName)) return null;
      const typed = all.filter((id) => ownerSimple(node(id).name) === typeName || simple(node(id).name) === typeName);
      if (typed.length) return typed;
      // Not declared on that type: a method it inherits.
      const inherited = scope.inAncestors(all, typeName, c.file);
      if (inherited.length) return inherited;
      // ...or one a subclass adds (`request.responseString()` on a Request, declared on DataRequest).
      const sub = all.filter((id) => scope.ancestorsOf(ownerSimple(node(id).name)).includes(typeName));
      if (sub.length) return sub;
      // ...or one it inherits from a library type (`interface OrderRepo extends JpaRepository`).
      if (scope.ancestorsOf(typeName).some((a) => !scope.isRepoType(a))) return null;
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
  /** Parent type names by type name (simple names; several declarations merge). */
  private readonly parents = new Map<string, string[]>();
  private readonly ancestorCache = new Map<string, string[]>();
  private readonly symbolsByName = new Map<string, GraphNode[]>();
  private readonly exprCache = new Map<string, string | null>();
  private globals: Map<string, { file: string; line: number; text: string }> | null = null;

  constructor(
    private readonly meta: Map<string, GraphNode>,
    private readonly linesOf: Map<string, string[]>,
    private readonly visibility: Visibility,
    typeParents: { type: string; parents: string[] }[] = [],
    private readonly returns = new Map<string, string>(),
  ) {
    for (const t of typeParents) {
      const key = simple(t.type);
      this.parents.set(key, [...new Set([...(this.parents.get(key) ?? []), ...t.parents])]);
    }
    for (const n of meta.values()) {
      if (TYPE_KINDS.has(n.kind)) {
        const key = simple(n.name);
        this.typesByName.set(key, [...(this.typesByName.get(key) ?? []), n]);
        this.repoTypes.add(key);
      }
      const cls = owner(n.name);
      if (cls) this.repoTypes.add(simple(cls));
      const key = simple(n.name);
      this.symbolsByName.set(key, [...(this.symbolsByName.get(key) ?? []), n]);
      // Constructors stay: Python, Ruby, JS and PHP set their fields there (`self.repo = Repo()`).
      if (cls && !CONSTRUCTORS.has(simple(n.name)) && simple(n.name) !== simple(cls)) {
        const key = `${n.file}#${cls}`;
        this.memberLines.set(key, [...(this.memberLines.get(key) ?? []), [n.line, n.endLine ?? n.line]]);
      }
    }
  }

  /** Parents, grandparents… of a type, nearest first (simple names, at most 8 levels). */
  ancestorsOf(type: string): string[] {
    const cached = this.ancestorCache.get(type);
    if (cached) return cached;
    const out: string[] = [];
    let level = this.parents.get(type) ?? [];
    for (let depth = 0; depth < 8 && level.length; depth++) {
      const next: string[] = [];
      for (const p of level) {
        if (p === type || out.includes(p)) continue;
        out.push(p);
        next.push(...(this.parents.get(p) ?? []));
      }
      level = next;
    }
    this.ancestorCache.set(type, out);
    return out;
  }

  /** The candidates declared on the nearest ancestor of `type` that has one (visible from `file` when possible). */
  inAncestors(all: string[], type: string, file: string): string[] {
    for (const a of this.ancestorsOf(type)) {
      const found = all.filter((id) => ownerSimple(this.meta.get(id)!.name) === a);
      if (!found.length) continue;
      const visible = found.filter((id) => this.visibility.canSee(file, this.meta.get(id)!.file));
      return visible.length ? visible : found;
    }
    return [];
  }

  isRepoType(name: string): boolean {
    return this.repoTypes.has(name);
  }

  /** Ruby's `@repo` -> "self.repo"; Go's `s` in `func (s *Svc)` -> "self" (`s.repo` -> "self.repo"). */
  plainReceiver(receiver: string, caller: GraphNode): string {
    let r = receiver.replace(/^@(?=\w)/, "self.");
    const head = /^(\w+)(?:\.|$)/.exec(r)?.[1];
    if (head && caller.kind === "method") {
      const first = this.linesOf.get(caller.file)?.[caller.line - 1] ?? "";
      if (new RegExp(`^\\s*func\\s*\\(\\s*${head}\\s+\\*?[A-Z]`).test(first)) r = "self" + r.slice(head.length);
    }
    return r;
  }

  /**
   * The type of an expression a call is made on, or null when unknown:
   * `repo` (a variable, field or parameter), `Svc` (a type), `Svc(x)` / `new Svc()`,
   * `repo.find(id)` (find's declared return type), `a.b` (field b of a's type),
   * at most a few steps deep. A type the repo doesn't define comes back as is
   * (or as LIBRARY), so the caller can tell a library call from an unknown one.
   */
  typeOfExpr(expr: string, caller: GraphNode, depth = 0): string | null {
    const e = expr
      .trim()
      .replace(/^(?:(?:try[?!]?|await)\s+)+/, "")
      .replace(/^new\s+/, "")
      .replace(/[!?]+$/, "");
    if (!e || depth > 3) return null;
    const key = `${caller.id}>${e}`;
    if (this.exprCache.has(key)) return this.exprCache.get(key)!;
    this.exprCache.set(key, null); // guards against `x = x.next()` loops
    const found = this.resolveExpr(e, caller, depth);
    this.exprCache.set(key, found);
    return found;
  }

  private resolveExpr(e: string, caller: GraphNode, depth: number): string | null {
    if (/^(this|self|\$this|Self)$/.test(e)) return owner(caller.name) ? simple(owner(caller.name)) : null;
    const part = lastAccess(e);
    if (!part) return null;
    const { recv, name, isCall } = part;
    if (!recv) {
      if (/^[A-Z]/.test(name)) {
        if (isCall || this.isRepoType(name)) return name; // Svc(x), or Svc.x()
        return this.globalType(name, caller, depth) ?? name; // AF.request(): a global, else a library type
      }
      if (isCall) return this.returnOfFunction(name, caller);
      return this.typeOf(name, caller, depth);
    }
    const t = this.typeOfExpr(recv, caller, depth + 1);
    // On a library type the result is unknown, not "library": items.get(0) may well be a repo type.
    if (!t || !this.isRepoType(t)) return null;
    if (isCall) return this.returnOfMethod(t, name);
    if (/^[A-Z]/.test(name)) return name; // Outer.Inner
    return this.fieldOfType(t, name);
  }

  /** Declared return type of `name` on a type or its parents; LIBRARY when only a library parent can have it. */
  private returnOfMethod(type: string, name: string): string | null {
    for (const t of [type, ...this.ancestorsOf(type)]) {
      const methods = (this.symbolsByName.get(name) ?? []).filter((m) => ownerSimple(m.name) === t);
      if (methods.length) {
        const r = methods.map((m) => this.returns.get(m.id)).find((x) => x) ?? null;
        return r === "Self" ? type : r; // Swift/Rust `-> Self`: the type it was called on
      }
    }
    return null;
  }

  /** `find(id)` without a receiver: the caller's own class (and parents), else a function it can see. */
  private returnOfFunction(name: string, caller: GraphNode): string | null {
    const cls = owner(caller.name);
    if (cls) {
      const own = [simple(cls), ...this.ancestorsOf(simple(cls))];
      const methods = (this.symbolsByName.get(name) ?? []).filter((m) => own.includes(ownerSimple(m.name)));
      if (methods.length) return methods.map((m) => this.returns.get(m.id)).find((r) => r) ?? null;
    }
    const all = this.symbolsByName.get(name) ?? [];
    if (!all.length) return LIBRARY; // expectation(...), make(...): not repo code
    const local = all.filter((f) => f.file === caller.file);
    const visible = local.length ? local : all.filter((f) => this.visibility.canSee(caller.file, f.file));
    return (visible.length ? visible : all).map((f) => this.returns.get(f.id)).find((r) => r) ?? null;
  }

  /** The type of field `name` declared on a type (or its parents). */
  private fieldOfType(type: string, name: string): string | null {
    for (const t of [type, ...this.ancestorsOf(type)]) {
      for (const decl of this.typesByName.get(t) ?? []) {
        const found = this.fieldType(name, decl);
        if (found) return found;
      }
    }
    return null;
  }

  /** A top-level `let AF = Session.default` / `val API: Api = ...` anywhere in the repo. */
  private globalType(name: string, caller: GraphNode, depth: number): string | null {
    if (!this.globals) {
      this.globals = new Map();
      const decl = /^(?:(?:public|internal|private|fileprivate|static|final|open|export|const)\s+)*(?:let|var|val|const)\s+([A-Z]\w*)\b/;
      for (const [file, lines] of this.linesOf) {
        lines.forEach((text, i) => {
          const m = decl.exec(text);
          if (m && !this.globals!.has(m[1])) this.globals!.set(m[1], { file, line: i + 1, text });
        });
      }
    }
    const g = this.globals.get(name);
    if (!g) return null;
    const declared = typeOfVariable(name, g.text);
    if (declared) return declared;
    const rhs = assignedExpr(name, g.text);
    const at: GraphNode = { id: `${g.file}#`, file: g.file, name: "", kind: "function", changed: false, line: g.line, endLine: g.line, labels: [] };
    return rhs ? this.typeOfExpr(rhs, at, depth + 1) : null;
  }

  typeOf(variable: string, caller: GraphNode, depth = 0): string | null {
    const key = `${caller.id}>${variable}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    this.cache.set(key, null);
    const code = this.code(caller);
    let found = typeOfVariable(variable, code);
    // var o = repo.find(id) / o, err := svc.Load() / let o = try await api.load()
    if (!found) {
      const rhs = assignedExpr(variable, code);
      if (rhs) found = this.typeOfExpr(rhs, caller, depth + 1);
    }
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

/** Stands for "a type the repo doesn't define"; never a repo type name. */
const LIBRARY = "<library>";

/**
 * The last step of an expression: `a.getB().run(x)` -> { recv: "a.getB()", name: "run", isCall: true },
 * `repo` -> { recv: "", name: "repo", isCall: false }. Null when it is not a plain name or call.
 */
export function lastAccess(expr: string): { recv: string; name: string; isCall: boolean } | null {
  let e = expr.trim();
  let isCall = false;
  if (e.endsWith(")")) {
    let depth = 0;
    let i = e.length - 1;
    for (; i >= 0; i--) {
      if (e[i] === ")") depth++;
      else if (e[i] === "(" && --depth === 0) break;
    }
    if (i <= 0) return null;
    e = e.slice(0, i).replace(/<[^<>()]*>$/, "").replace(/[!?]+$/, ""); // drop generic arguments: make<T>(…)
    isCall = true;
  }
  let depth = 0;
  for (let i = e.length - 1; i >= 0; i--) {
    const ch = e[i];
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "(" || ch === "[") depth--;
    else if (depth === 0 && (ch === "." || (ch === ">" && e[i - 1] === "-") || (ch === ":" && e[i - 1] === ":"))) {
      const name = e.slice(i + 1);
      const recv = e.slice(0, ch === "." ? (e[i - 1] === "?" ? i - 1 : i) : i - 1).replace(/[!?]+$/, "");
      return /^[$@]?\w+$/.test(name) ? { recv, name: name.replace(/^[$@]/, ""), isCall } : null;
    }
  }
  return /^[$@]?\w+$/.test(e) ? { recv: "", name: e.replace(/^@/, ""), isCall } : null;
}

/**
 * What a variable is set to: `var o = repo.find(id);` -> "repo.find(id)",
 * `o, err := svc.Load()` -> "svc.Load()", `let o = try await api.load()` -> "api.load()".
 * The first assignment in the code; the expression stops at the first space,
 * comma or brace outside brackets.
 */
export function assignedExpr(variable: string, code: string): string | null {
  const v = variable.replace(/^[$@]/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[^\\w.$>])[$@]?${v}\\s*(?:,\\s*[$\\w]+\\s*)*(?::=|=(?![=>]))\\s*(?:(?:try[?!]?|await)\\s+)*([^\\n;]+)`, "m").exec(code);
  if (!m) return null;
  const rhs = m[1];
  let depth = 0;
  for (let i = 0; i < rhs.length; i++) {
    const ch = rhs[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (/[\s,;{]/.test(ch))) return rhs.slice(0, i) || null;
  }
  return rhs.trim() || null;
}
