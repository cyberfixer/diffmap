import parseDiff from "parse-diff";

const TS_EXTENSIONS = /\.(tsx?)$/;

export interface FileChange {
  /** Repo-relative path (use headPath when available, else basePath). */
  path: string;
  basePath: string | null; // null for new files
  headPath: string | null; // null for deleted files
  /** Line numbers in the base revision that were removed. */
  removedLines: Set<number>;
  /** Line numbers in the head revision that were added. */
  addedLines: Set<number>;
}

/** Parse a unified diff string and return only TypeScript file changes. */
export function parseTsDiff(diffText: string): FileChange[] {
  const files = parseDiff(diffText);
  const result: FileChange[] = [];

  for (const file of files) {
    const from = file.from ?? "";
    const to = file.to ?? "";

    const isNew = from === "/dev/null" || from === "";
    const isDeleted = to === "/dev/null" || to === "";

    const basePath = isNew ? null : from;
    const headPath = isDeleted ? null : to;
    const path = headPath ?? basePath ?? "";

    if (!TS_EXTENSIONS.test(path)) continue;

    const addedLines = new Set<number>();
    const removedLines = new Set<number>();

    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === "add") {
          addedLines.add(change.ln);
        } else if (change.type === "del") {
          removedLines.add(change.ln);
        }
      }
    }

    if (addedLines.size === 0 && removedLines.size === 0) continue;

    result.push({ path, basePath, headPath, addedLines, removedLines });
  }

  return result;
}
