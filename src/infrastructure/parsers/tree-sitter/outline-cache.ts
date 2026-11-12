import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Outline } from "./engine.js";

/** Remembers what was read from a file's text (see TreeSitterEngine.outline), by the text itself. */
export interface OutlineCache {
  get(key: string): Outline | undefined;
  set(key: string, outline: Outline): void;
}

/** The same text of the same kind of file always reads the same. */
export const outlineKey = (ext: string, source: string): string => `${ext}:${createHash("sha1").update(source).digest("base64")}`;

/** The cache's file name inside a project's git folder. */
export const OUTLINES_FILE = "diffmap-outlines.json";

// JSON has no Infinity (a function that takes any number of arguments accepts up to Infinity).
const INFINITY = "__Infinity__";

/**
 * Outlines kept in one file between runs, so that only files whose text changed
 * are parsed again: most of a repo is the same from one analysis to the next.
 *
 * `stamp` names the reading rules (diffmap's code and grammars); a file written
 * under another stamp is ignored. `save` writes the outlines this run used, so
 * the file follows the repo instead of growing for ever.
 */
export class FileOutlineCache implements OutlineCache {
  private stored: Map<string, Outline> | null = null;
  private readonly used = new Map<string, Outline>();
  private added = 0;
  /** How many outlines came from the file, and how many had to be read from the text. */
  readonly counts = { reused: 0, parsed: 0 };

  constructor(
    private readonly file: string,
    private readonly stamp: string,
  ) {}

  get(key: string): Outline | undefined {
    const hit = this.used.get(key) ?? this.load().get(key);
    if (hit) {
      this.used.set(key, hit);
      this.counts.reused++;
    }
    return hit;
  }

  set(key: string, outline: Outline): void {
    this.used.set(key, outline);
    this.added++;
    this.counts.parsed++;
  }

  /** Write the file if this run read anything new or left something behind. Never throws: the cache is only a shortcut. */
  save(): void {
    if (this.added === 0 && this.used.size === this.load().size) return;
    try {
      const text = JSON.stringify({ stamp: this.stamp, outlines: [...this.used] }, (_, v) => (v === Infinity ? INFINITY : v));
      // Another analysis of the same project may be writing too: swap the whole file in at once.
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.file);
      this.added = 0;
    } catch {
      // A read-only folder, a full disk: the next run parses again.
    }
  }

  private load(): Map<string, Outline> {
    if (this.stored) return this.stored;
    this.stored = new Map();
    try {
      const data = JSON.parse(readFileSync(this.file, "utf-8"), (_, v) => (v === INFINITY ? Infinity : v)) as {
        stamp?: string;
        outlines?: [string, Outline][];
      };
      if (data.stamp === this.stamp && Array.isArray(data.outlines)) this.stored = new Map(data.outlines);
    } catch {
      // No file yet, or one that cannot be read: start empty.
    }
    return this.stored;
  }
}
