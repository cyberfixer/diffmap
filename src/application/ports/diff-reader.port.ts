import type { FileChange } from "../../domain/file-change.js";
import type { RangeInfo } from "../../domain/analysis-result.js";

/**
 * Abstracts reading diffs from a version-control system.
 * The application layer depends on this interface; git lives in infrastructure.
 */
export interface DiffReaderPort {
  /** Return all files touched by the diff between base and head. */
  getFileChanges(base: string, head: string): FileChange[];

  /** Return the merge-base commit of two refs. */
  getMergeBase(a: string, b: string): string;

  /** Resolve a symbolic ref (branch name, tag, HEAD…) to a full SHA. */
  resolveRef(ref: string): string;

  /** Branch names, commit count and title of the range (like a merge request header). */
  describeRange?(base: string, head: string, mergeBase: string): RangeInfo;
}
