import type { ChangeStatus, SymbolKind } from "./symbol.js";

/** A symbol on the map: either changed by the diff, or an unchanged neighbour. */
export interface GraphNode {
  id: string;              // same id scheme as ChangedSymbol.id
  file: string;
  name: string;
  kind: SymbolKind;
  changed: boolean;
  status?: ChangeStatus;   // only set when changed
  line: number;            // first line of the symbol (head, or base if removed)
  endLine?: number;        // last line of the symbol, when known
  labels: string[];        // e.g. decorators such as "@Patch(':id')"
  /** Whole source of an unchanged symbol (head), so callers outside the diff can be shown in full. */
  code?: string[];
}

/** One place in the caller where the call is written. */
export interface CallSite {
  line: number;            // head line number in the caller's file
  text: string;            // that line's source text
}

export interface GraphEdge {
  from: string;            // caller id
  to: string;              // callee id
  /**
   * "calls": ordinary call resolved at head.
   * "calls-removed": a call at head to a symbol the diff removed (possible breakage).
   * "implements": `from` implements `to` (a class method implementing an interface method).
   */
  kind: "calls" | "calls-removed" | "implements";
  /** Where in the caller the call is made (head line numbers). */
  sites?: CallSite[];
}
