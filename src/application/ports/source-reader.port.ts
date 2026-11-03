/**
 * Abstracts reading file contents at a specific revision.
 */
export interface SourceReaderPort {
  /**
   * Return the full text of a file at the given revision, or null if the
   * file does not exist at that revision.
   */
  getSource(rev: string, filePath: string): string | null;

  /** List every tracked file path at the given revision. */
  listFiles(rev: string): string[];
}
