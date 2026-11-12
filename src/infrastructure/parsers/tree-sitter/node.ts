/**
 * The part of a tree-sitter syntax node diffmap reads. web-tree-sitter types
 * child lists as possibly holding null; for a parsed tree they never do.
 */
export interface Node {
  readonly id: number;
  readonly type: string;
  readonly text: string;
  readonly isNamed: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly parent: Node | null;
  readonly children: Node[];
  readonly namedChildren: Node[];
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly nextNamedSibling: Node | null;
  childForFieldName(name: string): Node | null;
  descendantsOfType(type: string | string[]): Node[];
}
