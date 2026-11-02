import parseDiff from "parse-diff";
import type { FileChange } from "../../../domain/file-change.js";

/**
 * Parse a raw unified diff string into FileChange value objects.
 * All file types are returned — language filtering is the use case's job.
 */
export function parseDiffText(diffText: string): FileChange[] {
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
