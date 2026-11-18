export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "arrow"       // arrow function assigned to a variable/property
  | "interface"
  | "type"        // a type alias (TypeScript `type Status = ...`)
  | "struct"
  | "enum"
  | "trait"
  | "module"      // module, namespace, object (Ruby, Scala, Kotlin)
  | "template"    // an Angular component's template
  | "top-level";  // changed lines that fall outside any named symbol

export type ChangeStatus = "added" | "removed" | "modified";

export interface LineRange {
  start: number; // 1-based, inclusive
  end: number;   // 1-based, inclusive
  /**
   * Where the symbol's name is written, when the parser says: after `start` when attributes,
   * annotations or decorators come first (`@objc(save:)` on a line of its own).
   */
  name?: NamePosition;
}

/** A place in a file: line 1-based, column 0-based, in characters. */
export interface NamePosition {
  line: number;
  column: number;
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
  objcNames?: string[];        // Swift: the names Objective-C calls it by (see SymbolInfo)
}

/** A named symbol found in one version of a file. */
export interface SymbolInfo {
  name: string; // qualified, e.g. "MyClass.doThing"
  kind: SymbolKind;
  range: LineRange;
  /** Swift: the names Objective-C calls it by, as an Objective-C call reads them (`presentThread(_:)`). */
  objcNames?: string[];
}
