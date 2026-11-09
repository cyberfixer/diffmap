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
        const found = listSymbols(root, spec, parents, returns);
        return { symbols: found.map((s) => s.info), calls: listCalls(root, spec, found), parents, returns };
      }) ?? { symbols: [], calls: [], parents: [], returns: {} }
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

function listSymbols(root: Node, spec: LanguageSpec, parents: TypeParents[] = [], returns: Record<string, string> = {}): Found[] {
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
        out.push({ from: best.info.name, name, line: node.startPosition.row + 1, receiver: receiverOf(calleeText(node), name) });
      }
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(root);
  return out;
}
