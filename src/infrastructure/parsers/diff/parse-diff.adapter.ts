import parseDiff from "parse-diff";
import type { FileChange } from "../../../domain/file-change.js";
import type { DiffLine } from "../../../domain/symbol.js";

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

    const lines: DiffLine[] = [];

    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        // content keeps the leading "+", "-" or " " marker; drop it.
        const text = change.content.slice(1);
        if (change.content.startsWith("\\")) continue; // "\ No newline at end of file"

        if (change.type === "add") {
          addedLines.add(change.ln);
          lines.push({ type: "add", oldLine: null, newLine: change.ln, text });
        } else if (change.type === "del") {
          removedLines.add(change.ln);
          lines.push({ type: "del", oldLine: change.ln, newLine: null, text });
        } else {
          lines.push({ type: "ctx", oldLine: change.ln1, newLine: change.ln2, text });
        }
      }
    }

    if (addedLines.size === 0 && removedLines.size === 0) continue;

    result.push({ path, basePath, headPath, addedLines, removedLines, lines });
  }

  return result;
}
