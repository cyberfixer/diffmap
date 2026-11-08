import type { SymbolParserInput, SymbolParserPort } from "../../../application/ports/symbol-parser.port.js";
import type { ChangedSymbol } from "../../../domain/symbol.js";
import { mapChangesToSymbols } from "../../../application/symbol-mapping.js";
import type { TreeSitterEngine } from "./engine.js";

/** Changed symbols for every language tree-sitter knows (see languages.ts). */
export class TreeSitterSymbolParser implements SymbolParserPort {
  readonly supportedExtensions: readonly string[];

  constructor(private readonly engine: TreeSitterEngine) {
    this.supportedExtensions = engine.extensions;
  }

  parse(input: SymbolParserInput): ChangedSymbol[] {
    return mapChangesToSymbols(input, (source) => this.engine.symbols(input.filePath, source));
  }
}
