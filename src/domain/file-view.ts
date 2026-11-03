import type { DiffLine } from "./symbol.js";

/**
 * A whole file as one stream of lines: unchanged lines, added lines, and the
 * deleted lines spliced in where they used to be. Language-neutral.
 */
export interface FileView {
  path: string; // repo-relative (head path, or base path for deleted files)
  status: "added" | "modified" | "deleted";
  lines: DiffLine[];
}
