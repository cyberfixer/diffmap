export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "arrow"       // arrow function assigned to a variable/property
  | "top-level";  // changed lines that fall outside any named symbol

export type ChangeStatus = "added" | "removed" | "modified";

export interface LineRange {
  start: number; // 1-based, inclusive
  end: number;   // 1-based, inclusive
}

/** One line of a unified diff, with its line number on each side. */
export interface DiffLine {
  type: "add" | "del" | "ctx";
  oldLine: number | null; // null for added lines
  newLine: number | null; // null for deleted lines
  text: string;
}

export interface ChangedSymbol {
  id: string;                  // stable id: "<file>#<name>"
  file: string;                // repo-relative path
  name: string;                // qualified name, e.g. "MyClass.doThing" or "processItems"
  kind: SymbolKind;
  status: ChangeStatus;
  baseRange: LineRange | null; // line range in base rev (null if added)
  headRange: LineRange | null; // line range in head rev (null if removed)
  diff: DiffLine[];            // the diff lines that belong to this symbol
}
