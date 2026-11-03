import type { ChangedSymbol } from "./symbol.js";
import type { GraphEdge, GraphNode } from "./graph.js";

export interface AnalysisResult {
  base: string;              // resolved git SHA
  head: string;              // resolved git SHA
  symbols: ChangedSymbol[];
  nodes: GraphNode[];        // changed symbols plus their callers/callees
  edges: GraphEdge[];
}
