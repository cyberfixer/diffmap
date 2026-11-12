import { createRequire } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import type { SymbolInfo, SymbolKind } from "../../../domain/symbol.js";
import { LANGUAGES, firstIdent, type CallShape, type LanguageSpec, type Param, type UseNames } from "./languages.js";
import type { Node } from "./node.js";

const require = createRequire(import.meta.url);

/** A call found in a file: which symbol makes it, the called name, and its line. */
export interface FoundCall {
  from: string; // qualified name of the enclosing symbol
  name: string; // the called name, e.g. "update" for svc.update(...)
  line: number;
  /**
   * What the call is made on: "svc" for svc.update(), "self" for this/self/$this, "" for a plain call.
   * Swift also tells "super" (the parent class) and "." (`.make()`, a member of a type only the compiler knows).
   */
  receiver: string;
  /** How many arguments it passes; undefined when unknown (`f(*args)`, `this::f`). */
  args?: number;
  /** Swift, for receiver ".": a type or an expression of the type the member belongs to, when written nearby. */
  context?: string;
  /** Swift: the argument labels as written, "_" for none (`load(1, cache: true)` -> ["_", "cache"]). */
  labels?: string[];
  /** Swift: trailing closures after the arguments. */
  closures?: number;
  /** Not a call: "ref" names a function without calling it (`#selector(save)`), "read" reads a property with code. */
  use?: "ref" | "read";
}

/** A type and the types it extends or implements: `class Jpa implements Repo` -> { type: "Jpa", parents: ["Repo"] }. */
export interface TypeParents {
  type: string; // qualified name, also for containers that are not symbols (Swift extensions, Rust impls)
  parents: string[];
}

export interface Outline {
  symbols: SymbolInfo[];
  calls: FoundCall[];
  parents: TypeParents[];
  /** Declared return types by qualified symbol name (`Repo.find` -> "Order"). */
  returns: Record<string, string>;
  /** How many arguments each function accepts, [min, max] (max Infinity for varargs); overloads merge. */
  params: Record<string, [number, number]>;
  /** Qualified names of the symbols that are properties with code (reading one is a use). */
  properties: string[];
  /** Qualified names of the functions that belong to the type itself (`static func`). */
  statics: string[];
  /** Swift: each function's parameters one by one (label, default, closure), by qualified name. */
  signatures: Record<string, Param[]>;
}

const SELF = /^(this|self|\$this|@|Self|super)$/;

/**
 * The text before the called name: `self.repo.find(x)` -> "self.repo", `new Svc()` -> "",
 * `a.getB().run(x)` -> "a.getB()". Pass the call without its own arguments when
 * possible (see calleeText); spaces and line breaks in chains are dropped.
 */
export function receiverOf(callText: string, name: string): string {
  const head = callText.replace(/\s*\n\s*/g, "").replace(/\s*(\?\.|\.|->|::)\s*/g, "$1");
  const at = head.lastIndexOf(name);
  if (at < 0) return "";
  const r = head
    .slice(0, at)
    .replace(/(\?\.|\.|->|::|&)\s*$/, "")
    .replace(/^\s*new\s+/, "")
    .trim();
  return SELF.test(r) ? "self" : r;
}

const CONTAINERS = new Set<SymbolKind>(["class", "struct", "interface", "enum", "trait", "module"]);

/**
 * Loads tree-sitter grammars once (asynchronously), then parses synchronously.
 * Trees live in WebAssembly memory, so each one is deleted right after use.
 */
export class TreeSitterEngine {
  private constructor(
    private readonly parser: Parser,
    private readonly byExt: Map<string, { spec: LanguageSpec; language: Language }>,
  ) {}

  static async load(specs: LanguageSpec[] = LANGUAGES): Promise<TreeSitterEngine> {
    await Parser.init();
    const byExt = new Map<string, { spec: LanguageSpec; language: Language }>();
    for (const spec of specs) {
      // A grammar diffmap ships itself (grammars/), else the one from tree-sitter-wasms.
      const file = spec.wasm
        ? fileURLToPath(new URL(`../../../../grammars/${spec.wasm}`, import.meta.url))
        : require.resolve(`tree-sitter-wasms/out/tree-sitter-${spec.id}.wasm`);
      const language = await Language.load(file);
      for (const ext of spec.extensions) byExt.set(ext, { spec, language });
    }
    return new TreeSitterEngine(new Parser(), byExt);
  }

  get extensions(): string[] {
    return [...this.byExt.keys()];
  }

  /** Parents of well-known library classes, from every loaded language (see LanguageSpec.knownParents). */
  get knownParents(): Record<string, string> {
    return Object.assign({}, ...[...this.byExt.values()].map((l) => l.spec.knownParents ?? {}));
  }

  /** The language rules for a file, or undefined for an unknown extension. */
  spec(path: string): LanguageSpec | undefined {
    return this.byExt.get(extname(path).toLowerCase())?.spec;
  }

  /**
   * Parse a file and hand the tree to `use`; returns null for an unknown extension.
   * `asWritten`: parse the text exactly as it is (for colours), without the language's `prepare`.
   */
  with<T>(path: string, source: string, use: (root: Node, spec: LanguageSpec) => T, asWritten = false): T | null {
    const lang = this.byExt.get(extname(path).toLowerCase());
    if (!lang) return null;
    this.parser.setLanguage(lang.language);
    const tree = this.parser.parse(asWritten || !lang.spec.prepare ? source : lang.spec.prepare(source));
    if (!tree) return null;
    try {
      return use(tree.rootNode as unknown as Node, lang.spec);
    } finally {
      tree.delete();
    }
  }

  symbols(path: string, source: string): SymbolInfo[] {
    return this.with(path, source, (root, spec) => listSymbols(root, spec).map((s) => s.info)) ?? [];
  }

  /** Symbols, the calls made inside them, and each type's parent types, from one parse. */
  outline(path: string, source: string): Outline {
    return (
      this.with(path, source, (root, spec) => {
        const parents: TypeParents[] = [];
        const returns: Record<string, string> = {};
        const params: Record<string, [number, number]> = {};
        const properties: string[] = [];
        const statics: string[] = [];
        const signatures: Record<string, Param[]> = {};
        const found = listSymbols(root, spec, parents, returns, params, properties, statics, signatures);
        return { symbols: found.map((s) => s.info), calls: listCalls(root, spec, found), parents, returns, params, properties, statics, signatures };
      }) ?? { symbols: [], calls: [], parents: [], returns: {}, params: {}, properties: [], statics: [], signatures: {} }
    );
  }

  /**
   * Uses that are not calls: reads of the named properties and the named
   * functions passed without being called (Swift). It needs the names from every
   * file first, so it is a second look at the file; other languages answer [] at once.
   */
  uses(path: string, source: string, names: UseNames): FoundCall[] {
    if (!this.spec(path)?.uses) return [];
    return this.with(path, source, (root, spec) => listCalls(root, spec, listSymbols(root, spec), names)) ?? [];
  }
}

interface Found {
  info: SymbolInfo;
  start: number; // character offsets, to find the innermost symbol around a call
  end: number;
}

const endLine = (n: Node): number =>
  n.endPosition.column === 0 && n.endPosition.row > n.startPosition.row ? n.endPosition.row : n.endPosition.row + 1;

function listSymbols(
  root: Node,
  spec: LanguageSpec,
  parents: TypeParents[] = [],
  returns: Record<string, string> = {},
  params: Record<string, [number, number]> = {},
  properties: string[] = [],
  statics: string[] = [],
  signatures: Record<string, Param[]> = {},
): Found[] {
  const out: Found[] = [];
  const walk = (node: Node, prefix: string[], inType: boolean): void => {
    let nextPrefix = prefix;
    let nextInType = inType;
    const rule = spec.defs[node.type];
    if (rule && (!rule.when || rule.when(node))) {
      const raw = rule.name ? rule.name(node) : node.childForFieldName("name")?.text ?? firstIdent(node);
      const name = raw?.replace(/\s+/g, "");
      if (name) {
        let kind = rule.kindOf?.(node) ?? rule.kind;
        if (kind === "function" && inType) kind = "method";
        const qualified = [...prefix, name].join(".");
        const containerOnly = typeof rule.containerOnly === "function" ? rule.containerOnly(node) : !!rule.containerOnly;
        if (!containerOnly) {
          const returned = rule.returns?.(node);
          if (returned && !(qualified in returns)) returns[qualified] = returned;
          if (rule.property && !properties.includes(qualified)) properties.push(qualified);
          if (rule.isStatic?.(node) && !statics.includes(qualified)) statics.push(qualified);
          if (!CONTAINERS.has(kind)) {
            const signature = rule.signature?.(node);
            if (signature) signatures[qualified] = mergeSignatures(signatures[qualified], signature);
            const range = signature ? rangeOf(signature) : paramRange(node);
            if (range) {
              const had = params[qualified];
              params[qualified] = had ? [Math.min(had[0], range[0]), Math.max(had[1], range[1])] : range;
            }
          }
          const last = rule.extendTo?.(node) ?? node;
          out.push({
            info: { name: qualified, kind, range: { start: node.startPosition.row + 1, end: endLine(last) } },
            start: node.startIndex,
            end: last.endIndex,
          });
        }
        const supers = rule.supers?.(node) ?? [];
        if (supers.length) parents.push({ type: qualified, parents: supers });
        nextPrefix = [...prefix, name];
        nextInType = containerOnly || CONTAINERS.has(kind);
      }
    }
    for (const child of node.namedChildren) walk(child, nextPrefix, nextInType);
  };
  walk(root, [], false);
  return out;
}

const ARGUMENTS = /^(argument_list|arguments|call_suffix|value_arguments)$/;

/** A call's text without its own argument list: `a.getB().run(x)` -> "a.getB().run". */
function calleeText(call: Node): string {
  const kids = call.children;
  for (let i = kids.length - 1; i >= 0; i--) {
    if (ARGUMENTS.test(kids[i].type)) return call.text.slice(0, kids[i].startIndex - call.startIndex);
  }
  return call.text;
}

const PARAM_LIST = /^(parameters|formal_parameters|parameter_list|function_value_parameters|method_parameters|parameter_clause)$/;
const RECEIVER_PARAM = /^(self|cls|&self|&mut self|mut self|self_parameter)$/;

/**
 * One name declared twice with the same labels (a protocol's method and its default
 * implementation in an extension): a call fits if it fits either, so the looser of each parameter.
 */
function mergeSignatures(had: Param[] | undefined, now: Param[]): Param[] {
  if (!had || had.length !== now.length) return had ?? now;
  return had.map((p, i) => ({
    label: p.label,
    optional: p.optional || now[i].optional,
    variadic: p.variadic || now[i].variadic,
    closure: p.closure || now[i].closure,
  }));
}

/** [min, max] arguments for parameters read one by one. */
const rangeOf = (signature: Param[]): [number, number] => [
  signature.filter((p) => !p.optional && !p.variadic).length,
  signature.some((p) => p.variadic) ? Infinity : signature.length,
];

/** [min, max] arguments a function accepts, from its parameter list; null when it has none we can read. */
export function paramRange(def: Node): [number, number] | null {
  let tokens: Node[] | null = null;
  const list = def.childForFieldName("parameters") ?? findParamList(def, 0);
  if (list) tokens = list.children;
  else if (def.children.some((c) => c.type === "parameter")) {
    // Swift: parameters sit in the declaration itself, between ( and ).
    const kids = def.children;
    const open = kids.findIndex((c) => c.type === "(");
    const close = kids.findIndex((c, i) => i > open && c.type === ")");
    if (open >= 0 && close > open) tokens = kids.slice(open, close + 1);
  }
  if (!tokens) return null;
  const groups: Node[][] = [[]];
  for (const t of tokens) {
    if (t.type === "(" || t.type === ")" || t.type === "comment") continue;
    if (t.type === ",") groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  let min = 0;
  let max = 0;
  let variadic = false;
  groups.forEach((g, i) => {
    if (!g.length) return;
    const text = g.map((n) => n.text).join(" ").trim();
    if (RECEIVER_PARAM.test(text) || g.some((n) => n.type === "self_parameter") || (i === 0 && /^(self|cls)$/.test(text))) return;
    if (g.some((n) => /splat|variadic|spread|params|vararg/.test(n.type) || /\bvararg\b/.test(n.text)) || /\.\.\.|^\*/.test(text)) {
      variadic = true;
      return;
    }
    max++;
    const optional = g.some((n) => n.type === "=" || /default|optional/.test(n.type)) || /=/.test(text);
    if (!optional) min++;
  });
  return [min, variadic ? Infinity : max];
}

function findParamList(n: Node, depth: number): Node | null {
  for (const c of n.namedChildren) {
    if (PARAM_LIST.test(c.type) && c !== n.childForFieldName("receiver")) return c;
    if (depth < 2 && !/body|block|statement/.test(c.type)) {
      const found = findParamList(c, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** How many arguments a call passes (a trailing closure counts); undefined when a spread hides it. */
function argCount(call: Node): number | undefined {
  // Kotlin `f(1, 2) { x -> x }` is a call wrapped in a call: the inner one counts the lambda too.
  if (call.namedChildren[0]?.type === call.type) return undefined;
  const parent = call.parent;
  const wrapped = parent?.type === call.type && parent.namedChildren[0]?.id === call.id ? lambdasIn(parent) : 0;
  const n = ownArgs(call);
  return n === undefined ? undefined : n + wrapped;
}

function lambdasIn(call: Node): number {
  const suffix = call.children.find((c) => c.type === "call_suffix");
  return suffix?.namedChildren.filter((c) => /lambda/.test(c.type)).length ?? 0;
}

function ownArgs(call: Node): number | undefined {
  const args = [...call.children].reverse().find((c) => ARGUMENTS.test(c.type));
  if (!args) return call.type === "method_reference" ? undefined : 0;
  let list: Node[] = args.namedChildren;
  if (args.type === "call_suffix") {
    const values = args.namedChildren.find((c) => c.type === "value_arguments");
    const lambdas = args.namedChildren.filter((c) => /lambda/.test(c.type));
    list = [...(values?.namedChildren ?? []), ...lambdas];
  }
  list = list.filter((c) => c.type !== "comment");
  if (list.some((c) => /splat|spread|unpack/.test(c.type) || /^(\.\.\.|\*)/.test(c.text))) return undefined;
  return list.length;
}

/** The line the called name is written on (a chain over several lines starts on its first one). */
function nameLine(call: Node, head: string, name: string): number {
  let line = call.startPosition.row + 1;
  const at = head.lastIndexOf(name);
  for (let i = 0; i < at; i++) if (head.charCodeAt(i) === 10) line++;
  return line;
}

/** Calls in a file; with `names`, the uses that are not calls instead (see TreeSitterEngine.uses). */
function listCalls(root: Node, spec: LanguageSpec, symbols: Found[], names?: UseNames): FoundCall[] {
  const out: FoundCall[] = [];
  const walk = (node: Node): void => {
    const rule = names ? spec.uses?.[node.type] : spec.calls[node.type];
    const answer = rule ? (rule as (n: Node, names?: UseNames) => string | CallShape | null)(node, names) : null;
    if (answer) {
      const shape: CallShape = typeof answer === "string" ? { name: answer } : answer;
      // Innermost symbol around the call; calls at the top level of a file are skipped.
      let best: Found | null = null;
      for (const s of symbols) {
        if (s.start <= node.startIndex && node.endIndex <= s.end && (!best || s.end - s.start < best.end - best.start)) best = s;
      }
      if (best) {
        const head = shape.receiver === undefined || !shape.at ? calleeText(node) : "";
        out.push({
          from: best.info.name,
          name: shape.name,
          line: shape.at ? shape.at.startPosition.row + 1 : nameLine(node, head, shape.name),
          receiver: shape.receiver ?? receiverOf(head, shape.name),
          args: shape.use ? undefined : shape.labels ? shape.labels.length + (shape.closures ?? 0) : argCount(node),
          ...(shape.context ? { context: shape.context } : {}),
          ...(shape.labels ? { labels: shape.labels } : {}),
          ...(shape.closures ? { closures: shape.closures } : {}),
          ...(shape.use ? { use: shape.use } : {}),
        });
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return out;
}
