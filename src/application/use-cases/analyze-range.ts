import { extname } from "node:path";
import type { DiffReaderPort } from "../ports/diff-reader.port.js";
import type { SourceReaderPort } from "../ports/source-reader.port.js";
import type { SymbolParserPort } from "../ports/symbol-parser.port.js";
import type { CallGraphPort } from "../ports/call-graph.port.js";
import type { AnalysisResult } from "../../domain/analysis-result.js";
import type { GraphEdge, GraphNode } from "../../domain/graph.js";
import type { ChangedSymbol } from "../../domain/symbol.js";
import type { FileView } from "../../domain/file-view.js";
import { buildFileView } from "../file-view.js";

export interface AnalyzeOptions {
  /** Hops of callers/callees to include around changed symbols (default 1). */
  depth?: number;
}

export class AnalyzeRangeUseCase {
  constructor(
    private readonly diffReader: DiffReaderPort,
    private readonly sourceReader: SourceReaderPort,
    private readonly parsers: SymbolParserPort[],
    private readonly graphBuilders: CallGraphPort[] = [],
  ) {}

  execute(base: string, head: string, options: AnalyzeOptions = {}): AnalysisResult {
    const resolvedBase = this.diffReader.resolveRef(base);
    const resolvedHead = this.diffReader.resolveRef(head);
    const mergeBase = this.diffReader.getMergeBase(resolvedBase, resolvedHead);

    const fileChanges = this.diffReader.getFileChanges(base, head);

    const baseSources = this.readSources(mergeBase, fileChanges.flatMap((fc) => (fc.basePath ? [fc.basePath] : [])));
    const headSources = this.readSources(resolvedHead, fileChanges.flatMap((fc) => (fc.headPath ? [fc.headPath] : [])));

    const files: FileView[] = [];
    const symbols = fileChanges.flatMap((fc) => {
      const parser = this.parsers.find((p) => p.supportedExtensions.includes(extname(fc.path).toLowerCase()));

      const baseSource = fc.basePath ? (baseSources.get(fc.basePath) ?? null) : null;
      const headSource = fc.headPath ? (headSources.get(fc.headPath) ?? null) : null;
      // Binary files (images, archives...) have no lines to show.
      if ((baseSource ?? "").includes("\0") || (headSource ?? "").includes("\0")) return [];

      // Every changed text file is shown; only supported languages get symbols.
      const view = buildFileView(fc, baseSource, headSource);
      if (view) files.push(view);
      if (!parser) return [];

      return parser.parse({
        filePath: fc.path,
        removedLines: fc.removedLines,
        addedLines: fc.addedLines,
        diffLines: fc.lines,
        baseSource,
        headSource,
      });
    });

    const { nodes, edges } = this.buildGraph(symbols, resolvedHead, options.depth ?? 1);

    const range = this.diffReader.describeRange?.(base, head, mergeBase);
    const parsedFiles = [...new Set(symbols.map((s) => s.file))];
    const exactFiles = parsedFiles.filter((p) =>
      this.graphBuilders.some((g) => g.supportedExtensions.includes(extname(p).toLowerCase()) && g.isExact?.(p) === true)
    );
    const exactness = { exact: exactFiles.length, total: parsedFiles.length };

    return { base: resolvedBase, head: resolvedHead, symbols, nodes, edges, files, exactness, ...(range ? { range } : {}) };
  }

  /** Many files of one revision, in bulk when the reader can. */
  private readSources(rev: string, paths: string[]): Map<string, string | null> {
    const unique = [...new Set(paths)];
    return (
      this.sourceReader.getSources?.(rev, unique) ??
      new Map(unique.map((p) => [p, this.sourceReader.getSource(rev, p)]))
    );
  }

  private buildGraph(
    symbols: ChangedSymbol[],
    headRev: string,
    depth: number,
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const named = symbols.filter((s) => s.kind !== "top-level");
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();

    if (named.length > 0) {
      const changedIds = named.filter((s) => s.status !== "removed").map((s) => s.id);
      const removed = named
        .filter((s) => s.status === "removed")
        .map((s) => ({ id: s.id, name: s.name }));
      const allFiles = this.sourceReader.listFiles(headRev);

      for (const builder of this.graphBuilders) {
        const sources = this.readSources(
          headRev,
          allFiles.filter((p) => builder.supportedExtensions.includes(extname(p).toLowerCase())),
        );
        const files = [...sources].flatMap(([path, source]) => (source === null ? [] : [{ path, source }]));

        const result = builder.build({ files, changedIds, removed, depth });
        for (const n of result.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
        for (const e of result.edges) edges.set(`${e.from}>${e.to}>${e.kind}`, e);
      }
    }

    // Overlay the diff status, and add removed symbols (absent at head).
    for (const s of named) {
      const existing = nodes.get(s.id);
      nodes.set(s.id, {
        id: s.id,
        file: s.file,
        name: s.name,
        kind: s.kind,
        changed: true,
        status: s.status,
        line: s.headRange?.start ?? s.baseRange?.start ?? 0,
        endLine: s.headRange?.end ?? s.baseRange?.end,
        labels: existing?.labels ?? [],
      });
    }

    // Drop edges whose endpoints are not on the map.
    const kept = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));

    return { nodes: [...nodes.values()], edges: kept };
  }
}
