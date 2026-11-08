import type { CallGraphPort } from "../application/ports/call-graph.port.js";
import type { SymbolParserPort } from "../application/ports/symbol-parser.port.js";
import type { SyntaxHighlighterPort } from "../application/ports/syntax-highlighter.port.js";
import { TsHighlighter } from "./parsers/typescript/ts-highlighter.js";
import { TsMorphAdapter } from "./parsers/typescript/ts-morph.adapter.js";
import { TsMorphCallGraph } from "./parsers/typescript/ts-morph-call-graph.js";
import { TreeSitterEngine } from "./parsers/tree-sitter/engine.js";
import { TreeSitterSymbolParser } from "./parsers/tree-sitter/tree-sitter.adapter.js";
import { TreeSitterCallGraph } from "./parsers/tree-sitter/tree-sitter-call-graph.js";
import { TreeSitterHighlighter } from "./parsers/tree-sitter/tree-sitter-highlighter.js";

export interface LanguageSupport {
  parsers: SymbolParserPort[];
  graphs: CallGraphPort[];
  highlighters: SyntaxHighlighterPort[];
}

let loading: Promise<LanguageSupport> | null = null;

/**
 * Every supported language: TypeScript through the TypeScript compiler (exact),
 * the rest through tree-sitter (calls matched by name). Loaded once.
 */
export function loadLanguageSupport(): Promise<LanguageSupport> {
  loading ??= TreeSitterEngine.load().then((engine) => ({
    parsers: [new TsMorphAdapter(), new TreeSitterSymbolParser(engine)],
    graphs: [new TsMorphCallGraph(), new TreeSitterCallGraph(engine)],
    highlighters: [new TsHighlighter(), new TreeSitterHighlighter(engine)],
  }));
  return loading;
}
