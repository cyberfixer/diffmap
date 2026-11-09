import { createRequire } from "node:module";
import { extname } from "node:path";
import Parser from "web-tree-sitter";
import type { SymbolInfo, SymbolKind } from "../../../domain/symbol.js";
import { LANGUAGES, firstIdent, type LanguageSpec } from "./languages.js";

const require = createRequire(import.meta.url);
type Node = Parser.SyntaxNode;

/** A call found in a file: which symbol makes it, the called name, and its line. */
export interface FoundCall {
  from: string; // qualified name of the enclosing symbol
  name: string; // the called name, e.g. "update" for svc.update(...)
  line: number;
  /** What the call is made on: "svc" for svc.update(), "self" for this/self/$this, "" for a plain call. */
  receiver: string;
  /** How many arguments it passes; undefined when unknown (`f(*args)`, `this::f`). */
  args?: number;
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
    private readonly byExt: Map<string, { spec: LanguageSpec; language: Parser.Language }>,
  ) {}

  static async load(specs: LanguageSpec[] = LANGUAGES): Promise<TreeSitterEngine> {
    await Parser.init();
    const byExt = new Map<string, { spec: LanguageSpec; language: Parser.Language }>();
    for (const spec of specs) {
      const language = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${spec.id}.wasm`));
      for (const ext of spec.extensions) byExt.set(ext, { spec, language });
    }
    return new TreeSitterEngine(new Parser(), byExt);
  }

  get extensions(): string[] {
    return [...this.byExt.keys()];
  }

  /** Parse a file and hand the tree to `use`; returns null for an unknown extension. */
  with<T>(path: string, source: string, use: (root: Node, spec: LanguageSpec) => T): T | null {
    const lang = this.byExt.get(extname(path).toLowerCase());
    if (!lang) return null;
    this.parser.setLanguage(lang.language);
    const tree = this.parser.parse(source);
    try {
      return use(tree.rootNode, lang.spec);
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
        const found = listSymbols(root, spec, parents, returns, params);
        return { symbols: found.map((s) => s.info), calls: listCalls(root, spec, found), parents, returns, params };
      }) ?? { symbols: [], calls: [], parents: [], returns: {}, params: {} }
    );
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
          if (!CONTAINERS.has(kind)) {
            const range = paramRange(node);
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

function listCalls(root: Node, spec: LanguageSpec, symbols: Found[]): FoundCall[] {
  const out: FoundCall[] = [];
  const walk = (node: Node): void => {
    const rule = spec.calls[node.type];
    if (rule) {
      const name = rule(node);
      // Innermost symbol around the call; calls at the top level of a file are skipped.
      let best: Found | null = null;
      for (const s of symbols) {
        if (s.start <= node.startIndex && node.endIndex <= s.end && (!best || s.end - s.start < best.end - best.start)) best = s;
      }
      if (name && best) {
        out.push({ from: best.info.name, name, line: node.startPosition.row + 1, receiver: receiverOf(calleeText(node), name), args: argCount(node) });
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return out;
}
