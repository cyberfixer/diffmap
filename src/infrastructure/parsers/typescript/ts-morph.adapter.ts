import { Project } from "ts-morph";
import type { SymbolParserPort, SymbolParserInput } from "../../../application/ports/symbol-parser.port.js";
import type { ChangedSymbol } from "../../../domain/symbol.js";
import { mapChangesToSymbols } from "../../../application/symbol-mapping.js";
import { listSymbolNodes } from "./symbols.js";

/** TypeScript symbols via the TypeScript compiler (ts-morph). */
export class TsMorphAdapter implements SymbolParserPort {
  readonly supportedExtensions = [".ts", ".tsx"] as const;

  parse(input: SymbolParserInput): ChangedSymbol[] {
    return mapChangesToSymbols(input, (source) => {
      const project = new Project({ useInMemoryFileSystem: true });
      const ext = input.filePath.endsWith(".tsx") ? "tsx" : "ts";
      return listSymbolNodes(project.createSourceFile(`__analysis__.${ext}`, source)).map((s) => s.info);
    });
  }
}
