/**
 * Represents a single file touched by a diff, with the sets of line numbers
 * that were added or removed. Language-neutral — no parsing logic here.
 */
export interface FileChange {
  /** Canonical repo-relative path (headPath when available, else basePath). */
  path: string;
  basePath: string | null; // null for new files
  headPath: string | null; // null for deleted files
  /** Line numbers in the base revision that were removed. */
  removedLines: Set<number>;
  /** Line numbers in the head revision that were added. */
  addedLines: Set<number>;
}
