import type { GraphEdge, GraphNode } from "../../domain/graph.js";

export interface CallGraphInput {
  /** Every source file of this language at the head revision. */
  files: { path: string; source: string }[];
  /** Ids of changed symbols that still exist at head. */
  changedIds: string[];
  /** Symbols the diff removed (they no longer exist at head). */
  removed: { id: string; name: string }[];
  /** How many hops of callers and callees to include around changed symbols. */
  depth: number;
}

export interface CallGraphResult {
  nodes: GraphNode[]; // changed symbols plus neighbours (removed symbols excluded)
  edges: GraphEdge[];
}

/**
 * Builds the call graph around changed symbols. Only calls that resolve to
 * code inside the repo become edges; external packages are ignored.
 */
export interface CallGraphPort {
  readonly supportedExtensions: readonly string[];
  /** True when calls in this file are resolved by a compiler (not by matching names). */
  isExact?(path: string): boolean;
  build(input: CallGraphInput): CallGraphResult;
}
