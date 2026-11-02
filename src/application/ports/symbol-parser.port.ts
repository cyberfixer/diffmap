import type { ChangedSymbol } from "../../domain/symbol.js";

export interface SymbolParserInput {
  filePath: string;
  removedLines: Set<number>;
  addedLines: Set<number>;
  baseSource: string | null;
  headSource: string | null;
}

/**
 * Abstracts language-specific AST parsing.
 * Each language ships its own infrastructure adapter implementing this port.
 */
export interface SymbolParserPort {
  /** File extensions this parser handles, e.g. [".ts", ".tsx"]. */
  readonly supportedExtensions: readonly string[];

  /** Map changed lines to the symbols that contain them. */
  parse(input: SymbolParserInput): ChangedSymbol[];
}
