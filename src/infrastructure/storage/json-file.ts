import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A JSON value kept in one file. Writes go to a temp file first, so a crash never leaves half a file. */
export class JsonFile<T> {
  constructor(
    private readonly path: string,
    private readonly fallback: T,
  ) {}

  read(): T {
    try {
      const raw = readFileSync(this.path, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return this.fallback;
    }
  }

  write(value: T): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const text = JSON.stringify(value);
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
