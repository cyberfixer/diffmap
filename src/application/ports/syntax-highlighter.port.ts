export type HighlightKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "decorator"
  | "plain";

export interface HighlightToken {
  text: string;
  kind: HighlightKind;
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
