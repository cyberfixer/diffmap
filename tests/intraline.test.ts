import { describe, it, expect } from "vitest";
import { diffLine, intralineMarks } from "../src/application/intraline.js";
import type { DiffLine } from "../src/domain/symbol.js";

/** The changed parts of each side, as text. */
const parts = (a: string, b: string) => {
  const d = diffLine(a, b);
  return d && [d.old.map(([s, e]) => a.slice(s, e)), d.new.map(([s, e]) => b.slice(s, e))];
};

describe("what changed inside a line", () => {
  it("points at the word that changed", () => {
    expect(parts("  return a + b;", "  return a - b;")).toEqual([["+"], ["-"]]);
    expect(parts("const x = load(id);", "const x = await load(id, true);")).toEqual([[], ["await ", ", true"]]);
  });

  it("points at the letters when one word became another", () => {
    expect(parts("function userName() {", "function userNames() {")).toEqual([[], ["s"]]);
    expect(parts("let count = 10;", "let count = 100;")).toEqual([[], ["0"]]);
    expect(parts("getUserById(id)", "getUserByName(id)")).toEqual([["Id"], ["Name"]]);
  });

  it("joins changed words that only have spaces between them", () => {
    expect(parts("call(first second, x)", "call(third fourth, x)")).toEqual([["first second"], ["third fourth"]]);
  });

  it("keeps Arabic words whole, so their letters stay joined", () => {
    expect(parts('title: "مرحبا بالعالم"', 'title: "مرحبا بالجميع"')).toEqual([["بالعالم"], ["بالجميع"]]);
  });

  it("says nothing when the line was rewritten, is unchanged, or one side is empty", () => {
    expect(diffLine("const total = sum(items);", "if (!user) throw new Error();")).toBeNull();
    expect(diffLine("same", "same")).toBeNull();
    expect(diffLine("", "x = 1")).toBeNull();
  });

  it("compares very long lines by their two ends", () => {
    const long = (mid: string) => `start ${Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ")} ${mid} end`;
    expect(parts(long("old"), long("new"))).toEqual([["old"], ["new"]]);
  });

  it("pairs removed lines with the added lines that follow them, in order", () => {
    const l = (type: DiffLine["type"], text: string): DiffLine => ({ type, oldLine: 1, newLine: 1, text });
    const lines = [
      l("ctx", "keep"),
      l("del", "const a = 1;"),
      l("del", "const b = 2;"),
      l("add", "const a = 10;"),
      l("add", "const b = 2;"),
      l("add", "brand new line here"),
      l("ctx", "keep"),
      l("add", "alone = true"),
    ];
    const marks = intralineMarks(lines);
    expect([...marks.keys()]).toEqual([3]); // only "const a = 10;" has changed letters
    expect(marks.get(3)).toEqual([[11, 12]]);
  });
});
