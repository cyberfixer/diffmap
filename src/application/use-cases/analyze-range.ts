import { extname } from "node:path";
import type { DiffReaderPort } from "../ports/diff-reader.port.js";
import type { SourceReaderPort } from "../ports/source-reader.port.js";
import type { SymbolParserPort } from "../ports/symbol-parser.port.js";
import type { AnalysisResult } from "../../domain/analysis-result.js";

export class AnalyzeRangeUseCase {
  constructor(
    private readonly diffReader: DiffReaderPort,
    private readonly sourceReader: SourceReaderPort,
    private readonly parsers: SymbolParserPort[],
  ) {}

  execute(base: string, head: string): AnalysisResult {
    const resolvedBase = this.diffReader.resolveRef(base);
    const resolvedHead = this.diffReader.resolveRef(head);
    const mergeBase = this.diffReader.getMergeBase(resolvedBase, resolvedHead);

    const fileChanges = this.diffReader.getFileChanges(base, head);

    const symbols = fileChanges.flatMap((fc) => {
      const ext = extname(fc.path);
      const parser = this.parsers.find((p) =>
        p.supportedExtensions.includes(ext)
      );
      if (!parser) return [];

      const baseSource = fc.basePath
        ? this.sourceReader.getSource(mergeBase, fc.basePath)
        : null;
      const headSource = fc.headPath
        ? this.sourceReader.getSource(resolvedHead, fc.headPath)
        : null;

      return parser.parse({
        filePath: fc.path,
        removedLines: fc.removedLines,
        addedLines: fc.addedLines,
        baseSource,
        headSource,
      });
    });

    return { base: resolvedBase, head: resolvedHead, symbols };
  }
}
