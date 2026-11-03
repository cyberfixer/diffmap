import type { ChangeStatus, SymbolKind } from "./symbol.js";

/** A symbol on the map: either changed by the diff, or an unchanged neighbour. */
export interface GraphNode {
  id: string;              // same id scheme as ChangedSymbol.id
  file: string;
  name: string;
  kind: SymbolKind;
  changed: boolean;
  status?: ChangeStatus;   // only set when changed
  labels: string[];        // e.g. decorators such as "@Patch(':id')"
}

export interface GraphEdge {
  from: string;            // caller id
  to: string;              // callee id
  /**
   * "calls": ordinary call resolved at head.
   * "calls-removed": a call at head to a symbol the diff removed (possible breakage).
   */
  kind: "calls" | "calls-removed";
}
