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
import { Project } from "ts-morph";
import { extname } from "node:path";
import { listSymbolNodes } from "./parsers/typescript/symbols.js";
import { ScipCallGraph, type ListedSymbol } from "./scip/scip-call-graph.js";
import { AngularGraph, AngularTemplateParser } from "./parsers/angular/angular-graph.js";
import type { ScipIndex } from "./scip/scip-index.js";

export interface LanguageSupport {
  parsers: SymbolParserPort[];
  graphs: CallGraphPort[];
  highlighters: SyntaxHighlighterPort[];
  /** diffmap's symbols in many files at once (same names as the parsers give). */
  listSymbols: (files: { path: string; source: string }[]) => Map<string, ListedSymbol[]>;
}

let loading: Promise<LanguageSupport> | null = null;

/**
 * Every supported language: TypeScript through the TypeScript compiler (exact),
 * the rest through tree-sitter (calls matched by name). Loaded once.
 */
export function loadLanguageSupport(): Promise<LanguageSupport> {
  loading ??= TreeSitterEngine.load().then((engine) => ({
    parsers: [new TsMorphAdapter(), new TreeSitterSymbolParser(engine), new AngularTemplateParser()],
    graphs: [new TsMorphCallGraph(), new TreeSitterCallGraph(engine), new AngularGraph()],
    highlighters: [new TsHighlighter(), new TreeSitterHighlighter(engine)],
    listSymbols: (files) => {
      const out = new Map<string, ListedSymbol[]>();
      const ts = files.filter((f) => /\.tsx?$/i.test(f.path));
      if (ts.length) {
        const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
        for (const f of ts) {
          const sf = project.createSourceFile("/" + f.path, f.source, { overwrite: true });
          out.set(f.path, listSymbolNodes(sf).map((s) => ({ ...s.info, labels: s.labels })));
        }
      }
      for (const f of files) {
        if (!out.has(f.path) && engine.extensions.includes(extname(f.path).toLowerCase())) out.set(f.path, engine.symbols(f.path, f.source));
      }
      return out;
    },
  }));
  return loading;
}

/** The same languages, with calls resolved from a SCIP index where it covers a file. */
export function withIndex(langs: LanguageSupport, index: ScipIndex | null): LanguageSupport {
  if (!index || index.documents.length === 0) return langs;
  // Graphs that add their own kind of links (Angular templates) keep running next to the index.
  const alongside = langs.graphs.filter((g) => (g as { alongsideIndex?: boolean }).alongsideIndex);
  const replaced = langs.graphs.filter((g) => !alongside.includes(g));
  return { ...langs, graphs: [new ScipCallGraph(index, replaced, langs.listSymbols), ...alongside] };
}
