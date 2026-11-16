import type { GraphEdge, GraphNode } from "../../domain/graph.js";

export interface CallGraphInput {
  /** Every source file of this language at the head revision. */
  files: { path: string; source: string }[];
  /** Ids of changed symbols that still exist at head. */
  changedIds: string[];
  /** Symbols the diff removed (they no longer exist at head), with the names Objective-C called them by (Swift). */
  removed: { id: string; name: string; objcNames?: string[] }[];
  /** How many hops of callers and callees to include around changed symbols. */
  depth: number;
  /** Other files the builder asked for (see CallGraphPort.wantsConfig), e.g. tsconfig.json. */
  configs?: { path: string; source: string }[];
}

export interface CallGraphResult {
  nodes: GraphNode[]; // changed symbols plus neighbours (removed symbols excluded)
  edges: GraphEdge[];
  /** Every name the repo defines a symbol under in these files, as code writes it (`load`, `Store`). */
  names?: string[];
}

/**
 * Builds the call graph around changed symbols. Only calls that resolve to
 * code inside the repo become edges; external packages are ignored.
 */
export interface CallGraphPort {
  readonly supportedExtensions: readonly string[];
  /** True when calls in this file are resolved by a compiler (not by matching names). */
  isExact?(path: string): boolean;
  /** Files besides its sources that tell it how to read them (TypeScript: tsconfig.json for import aliases). */
  wantsConfig?(path: string): boolean;
  build(input: CallGraphInput): CallGraphResult;
}
