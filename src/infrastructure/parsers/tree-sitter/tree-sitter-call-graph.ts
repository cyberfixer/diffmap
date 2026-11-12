import type { CallGraphInput, CallGraphPort, CallGraphResult } from "../../../application/ports/call-graph.port.js";
import { CallCollector, walkNeighbourhood } from "../../../application/call-graph-walk.js";
import type { GraphNode } from "../../../domain/graph.js";
import type { FoundCall, TreeSitterEngine, TypeParents } from "./engine.js";
import type { LanguageSpec, Param } from "./languages.js";
import { posix } from "node:path";
import { Visibility, typeOfVariable } from "./visibility.js";

/** Above this many same-named targets a call is too ambiguous to draw (think `get`, `run`). */
const MAX_TARGETS = 5;
/**
 * ...unless they are all methods of one type: overloads that differ by what only a compiler
 * sees (Swift's `request(_: URL)` and `request(_: URLRequest)`, each its own symbol). The type is
 * not in doubt then, so a few more are drawn.
 */
const MAX_OVERLOADS = 8;

/** Swift's argument labels at the end of a name: "(_:cache:)". Nothing else in parentheses (C++ `operator()`). */
const LABELS = /\(((?:[^\s():]+:)+)\)$/;
/** Last part of a qualified name, as written: "Svc.load(_:cache:)" -> "load(_:cache:)". */
const member = (name: string): string => name.split(".").pop()!;
/** The same without Swift's argument labels, which is what a call writes: "Svc.load(_:cache:)" -> "load". */
const simple = (name: string): string => member(name).replace(LABELS, "");
const owner = (name: string): string => name.split(".").slice(0, -1).join(".");
const ownerSimple = (name: string): string => simple(owner(name) || "");

/** Swift: the argument labels in a name: "load(_:cache:)" -> ["_", "cache"]; [] for a plain name. */
const labelsOf = (name: string): string[] => LABELS.exec(member(name))?.[1].split(":").filter(Boolean) ?? [];

/**
 * Swift: can a function with these parameters take a call's arguments?
 * Each argument goes to the next parameter with its label; only parameters with a
 * default (or variadic ones) may be passed over. Trailing closures then fill
 * parameters that can take a closure, first those without a default; any other
 * parameter left must have one.
 */
export function acceptsLabels(params: Param[], labels: string[], closures = 0): boolean {
  const skippable = (p: Param) => p.optional || p.variadic;
  let at = 0;
  for (const label of labels) {
    if (params[at - 1]?.variadic && label === "_") continue; // one more value for f(_ xs: Int...), isAny(of: a, b)
    while (at < params.length && params[at].label !== label) {
      if (!skippable(params[at])) return false;
      at++;
    }
    if (at === params.length) return false;
    at++;
  }
  const rest = params.slice(at);
  const required = rest.filter((p) => !skippable(p));
  if (required.length > closures || required.some((p) => !p.closure)) return false;
  return closures - required.length <= rest.filter((p) => skippable(p) && p.closure).length;
}

export type LinkOutcome = "external" | "libraryType" | "unreachable" | "one" | "several" | "tooMany";

/** One call (or, with `use`, a property read or a function passed by name) and how it was linked (for measuring the matching rules). */
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
  /** Uses that are not calls and were linked: property reads, functions passed by name (Swift). */
  uses: number;
}

/**
 * Call graph by name, narrowed to what the calling code can actually reach:
 * - `self.x()` / `this.x()` -> x in the same class;
 * - `Svc.x()` or a variable whose type is visible (`Svc s`, `s: Svc`, `s = Svc()`) -> Svc's x;
 * - otherwise x in the same file, then in files it imports or shares a folder with.
 * If nothing is reachable, a call is linked only when the name is unique in the repo.
 * No type checking, so it can still miss or over-link; a SCIP index makes it exact.
 *
 * Swift (see its rules in languages.ts): a plain `x()` in a type is the type's own
 * `x` first; `super.x()` is a parent's; `Svc(a: 1)` also links to `Svc.init(a:)`;
 * same-named methods are told apart by their argument labels; `#selector(x)`,
 * `action: x` and reads of properties with code count as uses.
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

    const properties = new Set<string>(); // ids of properties with code
    const statics = new Set<string>(); // ids of static functions
    const signatures = new Map<string, Param[]>(); // symbol id -> its parameters one by one (Swift)
    for (const f of files) {
      const { symbols, calls: found, parents, returns: rets, params: ps, properties: props, statics: sts, signatures: sigs } = this.engine.outline(f.path, f.source);
      for (const name of sts) statics.add(`${f.path}#${name}`);
      for (const [name, sig] of Object.entries(sigs)) signatures.set(`${f.path}#${name}`, sig);
      for (const [name, range] of Object.entries(ps)) params.set(`${f.path}#${name}`, range);
      for (const p of parents) typeParents.push({ file: f.path, ...p });
      for (const [name, type] of Object.entries(rets)) returns.set(`${f.path}#${name}`, type);
      for (const name of props) properties.add(`${f.path}#${name}`);
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
    // A second look (Swift): reads of properties with code, and functions passed by name.
    const names = { properties: new Set<string>(), functions: new Set<string>() };
    for (const n of meta.values()) {
      if (properties.has(n.id)) names.properties.add(simple(n.name));
      else if (!TYPE_KINDS.has(n.kind)) names.functions.add(simple(n.name));
    }
    const visibility = new Visibility(files, (path) => !!this.engine.spec(path)?.moduleScope);
    const scope = new TypeScope(meta, linesOf, visibility, typeParents, returns, properties, this.engine.knownParents, (file) => this.engine.spec(file));

    const removedByName = new Map<string, string[]>();
    for (const r of removed) {
      const key = simple(r.name);
      removedByName.set(key, [...(removedByName.get(key) ?? []), r.id]);
    }

    const stats: LinkStats = { calls: 0, external: 0, one: 0, several: 0, tooMany: 0, unreachable: 0, libraryType: 0, implementsLinks: 0, uses: 0 };
    const collector = new CallCollector();
    const node = (id: string) => meta.get(id)!;
    const linkOne = (c: FoundCall & { file: string }): void => {
      const from = `${c.file}#${c.from}`;
      const text = linesOf.get(c.file)?.[c.line - 1] ?? "";
      const spec = this.engine.spec(c.file);
      const named = (byName.get(c.name) ?? []).filter((id) => id !== from);

      // Not a call: a property read, or a function passed by name. Linked only when it is clear whose.
      if (c.use) {
        const all = named.filter((id) => (c.use === "read" ? properties.has(id) : !TYPE_KINDS.has(node(id).kind) && !properties.has(id)));
        let targets = this.narrowUse(all, c, from, meta, scope, visibility);
        if (c.labels) targets = targets.filter((id) => labelsOf(node(id).name).join(":") === c.labels!.join(":"));
        if (targets.length > MAX_TARGETS) targets = [];
        if (targets.length) stats.uses++;
        onCall?.({ ...c, outcome: targets.length === 0 ? "unreachable" : targets.length === 1 ? "one" : "several", targets });
        for (const to of targets) collector.add(from, to, "calls", c.line, text);
        return;
      }

      const all = named;
      // Swift: the argument labels are part of a function's name, so load(_:) is no candidate for
      // load(1, cache: true); and a property is called only as a closure, which takes no labels.
      const labelled = c.labels?.some((x) => x !== "_");
      const fitting = !c.labels
        ? all
        : all.filter((id) => (signatures.has(id) ? acceptsLabels(signatures.get(id)!, c.labels!, c.closures) : !(labelled && properties.has(id))));
      const narrowed = this.narrow(fitting, c, from, meta, scope, visibility, statics, spec);
      let targets = narrowed?.ids ?? [];
      // A property is not called on a guess by name.
      if (narrowed?.unsure) targets = targets.filter((id) => !properties.has(id));
      // Several left: keep those that accept this many arguments (if any do).
      if (targets.length > 1 && c.args !== undefined) {
        const fits = targets.filter((id) => {
          const r = params.get(id);
          return !r || (r[0] <= c.args! && c.args! <= r[1]);
        });
        if (fits.length) targets = fits;
      }
      // Several left (two classes named Order): the one the file imports. In a module (Swift), of
      // top-level names the nearest; methods of one type in several files are overloads, all kept.
      targets = visibility.preferImported(c.file, targets, (id) => node(id).file, targets.every((id) => scope.ownerOf(id) === ""));
      // Found by name alone among everything the module can see: trusted only when one is left.
      if (narrowed?.unsure && targets.length > 1) targets = [];
      const oneType = targets.length > MAX_TARGETS && scope.ownerOf(targets[0]) !== "" && targets.every((id) => scope.ownerOf(id) === scope.ownerOf(targets[0]));
      const limit = oneType ? MAX_OVERLOADS : MAX_TARGETS;
      const outcome: LinkOutcome =
        all.length === 0 ? "external"
        : narrowed === null ? "libraryType"
        : targets.length === 0 ? "unreachable"
        : targets.length === 1 ? "one"
        : targets.length <= limit ? "several"
        : "tooMany";
      stats.calls++;
      stats[outcome]++;
      onCall?.({ ...c, outcome, targets });
      if (targets.length > 0 && targets.length <= limit) {
        for (const to of targets) collector.add(from, to, "calls", c.line, text);
        // Swift: `Svc(a: 1)` runs `Svc.init(a:)` when the type writes one out.
        for (const to of this.constructorsOf(targets, c, from, spec?.constructorName, scope, meta, signatures, visibility)) {
          collector.add(from, to, "calls", c.line, text);
        }
      } else if (all.length === 0) {
        // Nothing by that name exists any more: probably a call to removed code.
        for (const to of removedByName.get(c.name) ?? []) collector.add(from, to, "calls-removed", c.line, text);
      }
    };
    for (const c of calls) linkOne(c);
    // The second look, one file at a time: a big repo has many more uses than calls, too many to keep.
    if (names.properties.size || names.functions.size) {
      for (const f of files) for (const u of this.engine.uses(f.path, f.source, names)) linkOne({ file: f.path, ...u });
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
        const name = member(m.name); // with Swift's labels: save(_:) implements save(_:), not save(_:force:)
        if (CONSTRUCTORS.has(simple(m.name)) || simple(m.name) === simple(t.type)) continue;
        for (const a of ancestors) {
          const candidates = (methodsOf.get(a) ?? []).filter((p) => member(p.name) === name && p.id !== m.id);
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

  /**
   * A property read or a function passed by name: whose is it? Only clear cases
   * are linked, because a name alone says little (`title`, `count`):
   * - `header`, `self.header`: the calling type's own member, or one it inherits;
   *   then a global the file can see. Not when the code declares a local of that name.
   * - `viewModel.title`: title of viewModel's type, when that type is written down.
   */
  private narrowUse(
    all: string[],
    c: FoundCall & { file: string },
    from: string,
    meta: Map<string, GraphNode>,
    scope: TypeScope,
    visibility: Visibility,
  ): string[] {
    const caller = meta.get(from);
    if (all.length === 0 || !caller) return [];
    const node = (id: string) => meta.get(id)!;
    const cls = TYPE_KINDS.has(caller.kind) ? caller.name : owner(caller.name);
    const own = () => all.filter((id) => scope.ownerOf(id) === cls && (node(id).file === c.file || visibility.canSee(c.file, node(id).file)));

    if (c.receiver === "super") return cls ? scope.inAncestors(all, simple(cls), c.file) : [];
    if (c.receiver === "" || c.receiver === "self") {
      if (c.receiver === "" && scope.declaresLocal(caller, c.name)) return [];
      if (cls) {
        const mine = own();
        if (mine.length) return mine;
        // The type's own plain stored property of that name is what is meant.
        if (scope.declaresField(caller.file, cls, c.name)) return [];
        const inherited = scope.inAncestors(all, simple(cls), c.file);
        if (inherited.length) return inherited;
      }
      if (c.receiver === "self") return [];
      // A global: `let formatter: DateFormatter = { ... }()`, or a free function passed by name.
      const globals = all.filter((id) => scope.ownerOf(id) === "");
      const local = globals.filter((id) => node(id).file === c.file);
      return local.length ? local : globals.filter((id) => visibility.canSee(c.file, node(id).file));
    }
    const type = scope.typeOfExpr(c.receiver, caller);
    if (!type || !scope.isRepoType(type)) return [];
    const typed = scope.ofExactType(all.filter((id) => scope.ownerSimpleOf(id) === type), type);
    // Several types of that name nested in different places (generated models): no telling which.
    if (new Set(typed.map((id) => scope.ownerOf(id))).size > 1) return [];
    return typed.length ? typed : scope.inAncestors(all, type, c.file);
  }

  /**
   * Swift: when a call was linked to a type (`Svc(a: 1)`), the constructors that
   * type writes out and that take these argument labels (`Svc.init(a:)`), also from extensions.
   */
  private constructorsOf(
    targets: string[],
    c: FoundCall & { file: string },
    from: string,
    constructorName: string | undefined,
    scope: TypeScope,
    meta: Map<string, GraphNode>,
    signatures: Map<string, Param[]>,
    visibility: Visibility,
  ): string[] {
    if (!constructorName || !c.labels || !targets.every((id) => TYPE_KINDS.has(meta.get(id)!.kind))) return [];
    const out: string[] = [];
    for (const type of targets.map((id) => meta.get(id)!)) {
      for (const id of scope.membersOf(type.name, constructorName)) {
        const init = meta.get(id)!;
        if (id === from) continue;
        if (init.file !== type.file && !visibility.canSee(type.file, init.file) && !visibility.canSee(init.file, type.file)) continue;
        if (acceptsLabels(signatures.get(id) ?? [], c.labels, c.closures)) out.push(id);
      }
    }
    return out.length <= MAX_CONSTRUCTORS ? out : [];
  }

  /**
   * Keep only the targets the call can reach (see the class comment); null for a call on a library type.
   * `unsure`: found by name alone, to be trusted only when exactly one target is left.
   */
  private narrow(
    candidates: string[],
    c: FoundCall & { file: string },
    from: string,
    meta: Map<string, GraphNode>,
    scope: TypeScope,
    visibility: Visibility,
    statics: ReadonlySet<string>,
    spec?: LanguageSpec,
  ): { ids: string[]; unsure?: boolean } | null {
    if (candidates.length === 0) return { ids: [] };
    let all = candidates;
    const node = (id: string) => meta.get(id)!;
    const caller = meta.get(from);
    const receiver = caller ? scope.plainReceiver(c.receiver, caller) : c.receiver;
    // The type the calling code is in: the owner of a method, or the type itself (a property's initial value).
    const cls = !caller ? "" : TYPE_KINDS.has(caller.kind) && spec?.implicitSelf ? caller.name : owner(caller.name);
    // Members of that type, also from its extensions in other files of the module.
    const ownMembers = () =>
      all.filter((id) => scope.ownerOf(id) === cls && (node(id).file === c.file || visibility.canSee(c.file, node(id).file)));

    // super.x(): a parent's x, never the type's own or a sibling's. No parent in the repo has it: a library class.
    if (receiver === "super") {
      const inherited = cls ? scope.inAncestors(all, simple(cls), c.file) : [];
      return inherited.length ? { ids: inherited } : null;
    }

    // .make(1): a static member of a type only the compiler knows; `.init(x)` could be any type's.
    if (receiver === ".") {
      // ...unless the type is written nearby: let tab: Tab = .init(1), tab = .next(), -> Tab { .init(1) }
      const base = c.context && caller ? scope.typeOfExpr(c.context, caller) : null;
      if (base) {
        if (!scope.isRepoType(base)) return null;
        const typed = scope.ofExactType(all.filter((id) => scope.ownerSimpleOf(id) === base), base);
        return { ids: typed.length ? typed : scope.inAncestors(all, base, c.file) };
      }
      return { ids: c.name === spec?.constructorName ? [] : all.filter((id) => statics.has(id)), unsure: true };
    }

    // self.x() / this.x(): the caller's own class (or, if it isn't there, an inherited one it can see)
    if (receiver === "self" && caller) {
      const own = spec?.implicitSelf ? ownMembers() : all.filter((id) => node(id).file === c.file && scope.ownerOf(id) === cls);
      if (own.length) return { ids: own };
      const inherited = scope.inAncestors(all, simple(cls), c.file);
      if (inherited.length) return { ids: inherited };
      // self.init(...) with no init written out is the type's own (memberwise) one, not another type's.
      if (c.name === spec?.constructorName) return { ids: [] };
      const others = all.filter((id) => scope.ownerOf(id) !== "" && visibility.canSee(c.file, node(id).file));
      return { ids: others, unsure: spec?.moduleScope };
    }

    // Swift: a plain x() inside a type is the type's own x, or one it inherits, before anything else.
    if (spec?.implicitSelf && receiver === "" && caller) {
      // A closure the code holds itself: completion(result), onDone().
      if (scope.declaresLocal(caller, c.name, true)) return { ids: [] };
      if (cls) {
        const own = ownMembers();
        if (own.length) return { ids: own };
        if (scope.declaresField(caller.file, cls, c.name)) return { ids: [] };
        const inherited = scope.inAncestors(all, simple(cls), c.file);
        if (inherited.length) return { ids: inherited };
      }
      // What is left: a free function, a type (Svc(x)), or something nested where the call is.
      // Not another type's method, nor a type nested in another type (Reward.Image is not Image).
      all = all.filter((id) => {
        const o = scope.ownerOf(id);
        return o === "" || caller.name === o || caller.name.startsWith(o + ".");
      });
      if (all.length === 0) return { ids: [] };
    }

    // Svc.x() or v.x() where v's type is written down: that class's x
    // ...also through calls and fields: repo.find(id).total() -> find's return type
    const typeName = receiver && caller ? scope.typeOfExpr(receiver, caller) : null;
    if (typeName) {
      // A type the repo doesn't define or add to (String, List, a library class): not a call into repo code...
      if (!scope.isRepoType(typeName) && !scope.ancestorsOf(typeName).some((t) => scope.isRepoType(t))) {
        // ...unless the repo adds the method to a library protocol that type adopts, which only the
        // compiler knows: Text("a").card() with `extension View { func card() }`. Trusted when one fits.
        const added = spec?.moduleScope ? all.filter((id) => scope.isExtendedOnly(scope.ownerSimpleOf(id))) : [];
        return added.length ? { ids: added, unsure: true } : null;
      }
      let typed = all.filter((id) => scope.ownerSimpleOf(id) === typeName || simple(node(id).name) === typeName);
      if (spec?.moduleScope) typed = scope.ofExactType(typed, typeName);
      if (typed.length) return { ids: typed };
      // Not declared on that type: a method it inherits.
      const inherited = scope.inAncestors(all, typeName, c.file);
      if (inherited.length) return { ids: inherited };
      // ...or one a subclass adds (`request.responseString()` on a Request, declared on DataRequest).
      const sub = all.filter((id) => scope.ancestorsOf(scope.ownerSimpleOf(id)).includes(typeName));
      if (sub.length) return { ids: sub };
      // ...or one it inherits from a library type (`interface OrderRepo extends JpaRepository`).
      if (scope.ancestorsOf(typeName).some((t) => !scope.isRepoType(t))) return null;
    }

    // Same file first, then files the caller imports or shares a folder with.
    const local = all.filter((id) => node(id).file === c.file);
    if (local.length) return { ids: local };
    const visible = all.filter((id) => visibility.canSee(c.file, node(id).file));
    if (spec?.moduleScope && visible.length) {
      // The whole module is visible. A method of something nobody typed (`items.map { }`) is
      // trusted only when one fits; a free function or a type in the same folder comes first.
      if (receiver !== "") return { ids: visible, unsure: true };
      const near = visible.filter((id) => posix.dirname(node(id).file) === posix.dirname(c.file));
      return { ids: near.length ? near : visible };
    }
    if (visible.length) return { ids: visible };

    // Nothing reachable: only a name that exists once in the whole repo is trusted.
    return { ids: all.length === 1 ? all : [] };
  }
}

const TYPE_KINDS = new Set(["class", "struct", "interface", "enum", "trait", "module"]);
/** At most this many constructors are drawn for one `Svc(...)`. */
const MAX_CONSTRUCTORS = 3;
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
  /** Answers of declaresLocal and declaresField. */
  private readonly declared = new Map<string, boolean>();
  /** Each symbol's owner ("Svc" for "Svc.load(_:)"), and the symbols by owner and name: both are asked for every call. */
  private readonly owners = new Map<string, string>();
  private readonly members = new Map<string, string[]>();
  private globals: Map<string, { file: string; line: number; text: string }> | null = null;

  constructor(
    private readonly meta: Map<string, GraphNode>,
    private readonly linesOf: Map<string, string[]>,
    private readonly visibility: Visibility,
    typeParents: { type: string; parents: string[] }[] = [],
    private readonly returns = new Map<string, string>(),
    properties: ReadonlySet<string> = new Set(),
    knownParents: Record<string, string> = {},
    /** The language rules of a file. */
    private readonly specOf: (file: string) => LanguageSpec | undefined = () => undefined,
  ) {
    for (const t of typeParents) {
      const key = simple(t.type);
      this.parents.set(key, [...new Set([...(this.parents.get(key) ?? []), ...t.parents])]);
    }
    // Library classes the repo builds on: their own parents (UITableViewCell -> UIView).
    for (const [type, parent] of Object.entries(knownParents)) {
      if (!this.parents.has(type)) this.parents.set(type, [parent]);
    }
    for (const n of meta.values()) {
      if (TYPE_KINDS.has(n.kind)) {
        const key = simple(n.name);
        this.typesByName.set(key, [...(this.typesByName.get(key) ?? []), n]);
        this.repoTypes.add(key);
      }
      const cls = owner(n.name);
      this.owners.set(n.id, cls);
      const member = `${cls}\n${simple(n.name)}`;
      this.members.set(member, [...(this.members.get(member) ?? []), n.id]);
      if (cls) this.repoTypes.add(simple(cls));
      const key = simple(n.name);
      this.symbolsByName.set(key, [...(this.symbolsByName.get(key) ?? []), n]);
      // Constructors stay: Python, Ruby, JS and PHP set their fields there (`self.repo = Repo()`).
      if (cls && !CONSTRUCTORS.has(simple(n.name)) && simple(n.name) !== simple(cls)) {
        const key = `${n.file}#${cls}`;
        // A property's declaration (`lazy var table: UITableView = {`) stays a field; it may come after
        // lines of attributes (`@objc`).
        let first = n.line;
        if (properties.has(n.id)) {
          const lines = this.linesOf.get(n.file) ?? [];
          while (first < (n.endLine ?? n.line) && !/\b(var|let)\b/.test(lines[first - 1] ?? "")) first++;
          first++;
        }
        this.memberLines.set(key, [...(this.memberLines.get(key) ?? []), [first, n.endLine ?? n.line]]);
      }
    }
  }

  /** The qualified name of the type or function a symbol is in; "" at the top level. */
  ownerOf(id: string): string {
    return this.owners.get(id) ?? "";
  }

  /** The same, last part only: "Inner" for "Outer.Inner.run". */
  ownerSimpleOf(id: string): string {
    return simple(this.ownerOf(id));
  }

  /** The symbols called `name` (without labels) in the type with this qualified name. */
  membersOf(type: string, name: string): string[] {
    return this.members.get(`${type}\n${name}`) ?? [];
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
      const found = all.filter((id) => this.ownerSimpleOf(id) === a);
      if (!found.length) continue;
      const visible = found.filter((id) => this.visibility.canSee(file, this.meta.get(id)!.file));
      return visible.length ? visible : found;
    }
    return [];
  }

  isRepoType(name: string): boolean {
    return this.repoTypes.has(name);
  }

  /** A library type the repo only adds members to (`extension View { ... }`). */
  isExtendedOnly(name: string): boolean {
    return this.repoTypes.has(name) && !this.typesByName.has(name);
  }

  /**
   * Of members whose type is called `type`: those of the top-level type by that
   * name. When that type exists but has none of them, the others belong to
   * same-named types nested elsewhere (`Reward` vs `BackingFragment.Reward`): none.
   */
  ofExactType(ids: string[], type: string): string[] {
    const exact = ids.filter((id) => {
      const name = this.meta.get(id)!.name;
      return owner(name) === type || name === type;
    });
    if (exact.length) return exact;
    return (this.typesByName.get(type) ?? []).some((t) => t.name === type) ? [] : ids;
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
    const field = this.fieldOfType(t, name);
    if (field || !this.specOf(caller.file)?.enumCases) return field;
    // Status.active: a case of the enum Status is a Status.
    return recv === t && (this.typesByName.get(t) ?? []).some((n) => n.kind === "enum") ? t : null;
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
    let found = typeOfVariable(variable, code, this.specOf(caller.file)?.typeCalls);
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
      // ...or a field a parent class declares (where a bare name can be one).
      if (!found && this.specOf(caller.file)?.implicitSelf) {
        for (const a of this.ancestorsOf(simple(cls))) {
          for (const decl of this.typesByName.get(a) ?? []) found ??= this.fieldType(variable, decl);
          if (found) break;
        }
      }
    }
    this.cache.set(key, found);
    return found;
  }

  private fieldType(variable: string, type: GraphNode): string | null {
    const key = `${type.id}>>${variable}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const found = typeOfVariable(variable, this.fieldsText(type), this.specOf(type.file)?.typeCalls);
    this.cache.set(key, found);
    return found;
  }

  private readonly fieldsTexts = new Map<string, string>();

  /** A type's own code without its members' bodies: where its fields are declared. */
  private fieldsText(type: GraphNode): string {
    const known = this.fieldsTexts.get(type.id);
    if (known !== undefined) return known;
    const lines = [...(this.linesOf.get(type.file) ?? []).slice(type.line - 1, type.endLine ?? type.line)];
    for (const [a, b] of this.memberLines.get(`${type.file}#${type.name}`) ?? []) {
      if (a === type.line) continue; // a member on the type's own first line (Kotlin `class A(val x: X)`)
      for (let i = a; i <= b; i++) if (i - type.line >= 0 && i - type.line < lines.length) lines[i - type.line] = "";
    }
    const text = lines.join("\n");
    this.fieldsTexts.set(type.id, text);
    return text;
  }

  private code(n: GraphNode): string {
    return (this.linesOf.get(n.file) ?? []).slice(n.line - 1, n.endLine ?? n.line).join("\n");
  }

  /** True when a symbol's code declares `name` itself: a parameter, a `let`/`var`, a loop or closure variable. */
  declaresLocal(n: GraphNode, name: string, called = false): boolean {
    const key = `${n.id}>${name}>${called}`;
    const known = this.declared.get(key);
    if (known !== undefined) return known;
    const found = this.findsLocal(n, name, called);
    this.declared.set(key, found);
    return found;
  }

  private findsLocal(n: GraphNode, name: string, called: boolean): boolean {
    const v = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let code = this.code(n);
    // `let image = image(named: "x")` calls the function image, it does not make image a closure.
    if (called) code = code.replace(new RegExp(`\\b(?:let|var)\\s+${v}\\s*(?::[^=\\n]+)?=\\s*(?:try[?!]?\\s+|await\\s+)*${v}\\s*\\(`, "g"), "");
    const open = code.indexOf("{");
    const signature = open < 0 ? code : code.slice(0, open);
    return (
      new RegExp(`[(,]\\s*(?:\\w+\\s+)?${v}\\s*:`).test(signature) || // func f(_ name: T)
      new RegExp(`\\b(?:let|var|for)\\s+${v}\\b`).test(code) || // let name = / if let name { / for name in
      new RegExp(`\\b(?:let|var)\\s*\\([^)\\n]*\\b${v}\\b[^)\\n]*\\)\\s*=`).test(code) || // let (a, name) =
      new RegExp(`[{,(]\\s*${v}\\s*(?:,[\\w\\s,]*)?\\)?\\s+in\\b`).test(code) // { name in / { a, name in
    );
  }

  /** True when a type declares a plain stored property `name` (which hides a global of that name). */
  declaresField(file: string, type: string, name: string): boolean {
    const key = `${file}#${type}>>${name}`;
    const known = this.declared.get(key);
    if (known !== undefined) return known;
    const found = this.findsField(file, type, name);
    this.declared.set(key, found);
    return found;
  }

  private findsField(file: string, type: string, name: string): boolean {
    const v = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const own = this.meta.get(`${file}#${type}`);
    const all = (this.typesByName.get(simple(type)) ?? []).filter((t) => t === own || (t.name === type && this.visibility.canSee(file, t.file)));
    return all.some((t) => {
      const lines = [...(this.linesOf.get(t.file) ?? []).slice(t.line - 1, t.endLine ?? t.line)];
      for (const [a, b] of this.memberLines.get(`${t.file}#${t.name}`) ?? []) {
        if (a === t.line) continue;
        for (let i = a; i <= b; i++) if (i - t.line >= 0 && i - t.line < lines.length) lines[i - t.line] = "";
      }
      return new RegExp(`\\b(?:let|var)\\s+${v}\\b`).test(lines.join("\n"));
    });
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
