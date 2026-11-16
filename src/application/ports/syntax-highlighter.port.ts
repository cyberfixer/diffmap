export type HighlightKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "decorator"
  | "plain";

/**
 * What a token is more precisely, where an editor's colours tell it apart from the
 * rest of its kind (Xcode's do). Only the Xcode colours use it; diffmap's own go by
 * the kind alone, so a detail never changes how they look.
 * - "definition": the name a function, method or property is defined under (`func save`);
 *   "type-definition": the same for a type (`class Store`).
 * - "constructor": a type called to make a value (Swift `Store()`).
 * - "doc": a documentation comment (`///`, or `/**` and on); "mark": `// MARK:`, `// TODO:`, `#pragma mark`.
 * - "character": a character literal; "regex": a regular expression literal.
 * - "preprocessor": `#import`, `#include`, `#define`, `#if` in C and Objective-C.
 */
export type HighlightDetail =
  | "definition"
  | "type-definition"
  | "constructor"
  | "doc"
  | "mark"
  | "character"
  | "regex"
  | "preprocessor";

export interface HighlightToken {
  text: string;
  kind: HighlightKind;
  detail?: HighlightDetail;
}

/** Splits source code into coloured tokens, one token list per input line. */
export interface SyntaxHighlighterPort {
  /** File extensions this highlighter handles, e.g. [".ts", ".tsx"]. */
  readonly supportedExtensions: readonly string[];

  /**
   * Tokenize a whole document given as lines. Returns exactly one token list
   * per input line, or null if it cannot highlight this input.
   */
  highlight(path: string, lines: string[]): HighlightToken[][] | null;
}
