/**
 * Abstracts reading file contents at a specific revision.
 */
export interface SourceReaderPort {
  /**
   * Return the full text of a file at the given revision, or null if the
   * file does not exist at that revision.
   */
  getSource(rev: string, filePath: string): string | null;

  /**
   * The same for many files at once, keyed by path. Optional: readers that
   * can fetch files in bulk implement it, since reading one by one is slow.
   */
  getSources?(rev: string, filePaths: string[]): Map<string, string | null>;

  /** List every tracked file path at the given revision. */
  listFiles(rev: string): string[];
}
