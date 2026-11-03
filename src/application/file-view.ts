import type { FileChange } from "../domain/file-change.js";
import type { FileView } from "../domain/file-view.js";
import type { DiffLine } from "../domain/symbol.js";

const splitLines = (source: string): string[] => {
  const lines = source.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/**
 * Build the full-file view: every head line in order (marked added or
 * unchanged), with deleted lines inserted at the position they were removed.
 * Returns null when the needed source text is unavailable.
 */
export function buildFileView(
  fc: FileChange,
  baseSource: string | null,
  headSource: string | null
): FileView | null {
  if (fc.headPath === null) {
    if (baseSource === null) return null;
    return {
      path: fc.path,
      status: "deleted",
      lines: splitLines(baseSource).map((text, i) => ({
        type: "del" as const,
        oldLine: i + 1,
        newLine: null,
        text,
      })),
    };
  }
  if (headSource === null) return null;

  const head = splitLines(headSource);

  // Deleted lines belong just before the next line that exists at head.
  const delsBefore = new Map<number, DiffLine[]>();
  let pending: DiffLine[] = [];
  for (const l of fc.lines) {
    if (l.type === "del") {
      pending.push(l);
    } else if (pending.length > 0) {
      const at = l.newLine!;
      delsBefore.set(at, [...(delsBefore.get(at) ?? []), ...pending]);
      pending = [];
    }
  }
  const tail = pending;

  const lines: DiffLine[] = [];
  let added = 0;
  let deleted = 0;
  head.forEach((text, i) => {
    const n = i + 1;
    for (const d of delsBefore.get(n) ?? []) {
      lines.push(d);
      deleted++;
    }
    if (fc.addedLines.has(n)) {
      lines.push({ type: "add", oldLine: null, newLine: n, text });
      added++;
    } else {
      lines.push({ type: "ctx", oldLine: n - added + deleted, newLine: n, text });
    }
  });
  lines.push(...tail);

  return { path: fc.path, status: fc.basePath === null ? "added" : "modified", lines };
}
