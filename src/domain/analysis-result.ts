import type { ChangedSymbol } from "./symbol.js";
import type { GraphEdge, GraphNode } from "./graph.js";
import type { FileView } from "./file-view.js";

/** Human-friendly description of the compared range, like a merge request header. */
export interface RangeInfo {
  baseName: string;          // branch name of base (e.g. "main"), or a short SHA
  headName: string;          // branch name of head (e.g. "feature/x"), or a short SHA
  commits: number;           // commits on head since the merge base
  title: string | null;      // subject of the first commit on head, if any
}

export interface AnalysisResult {
  base: string;              // resolved git SHA
  head: string;              // resolved git SHA
  symbols: ChangedSymbol[];
  nodes: GraphNode[];        // changed symbols plus their callers/callees
  edges: GraphEdge[];
  files: FileView[];         // whole-file views of every changed, parsed file
  range?: RangeInfo;
  /** Of the changed files with symbols, how many have calls resolved by a compiler (TypeScript, or a CI index). */
  exactness?: { exact: number; total: number };
}
