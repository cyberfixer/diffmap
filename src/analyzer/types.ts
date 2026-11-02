/** Language-neutral diff analysis output. */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "arrow" // arrow function assigned to a variable/property
  | "top-level"; // changed lines that fall outside any named symbol

export type ChangeStatus = "added" | "removed" | "modified";

export interface LineRange {
  start: number; // 1-based, inclusive
  end: number; // 1-based, inclusive
}

export interface ChangedSymbol {
  file: string; // repo-relative path
  name: string; // qualified name, e.g. "MyClass.doThing" or "processItems"
  kind: SymbolKind;
  status: ChangeStatus;
  baseRange: LineRange | null; // line range in base rev (null if added)
  headRange: LineRange | null; // line range in head rev (null if removed)
}

export interface AnalysisResult {
  base: string; // resolved git ref
  head: string; // resolved git ref
  symbols: ChangedSymbol[];
}
