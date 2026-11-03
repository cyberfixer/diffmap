import { describe, it, expect } from "vitest";
import { TsHighlighter } from "../src/infrastructure/parsers/typescript/ts-highlighter.js";
import { renderHtml } from "../src/interfaces/html/render-html.js";
import type { HighlightToken } from "../src/application/ports/syntax-highlighter.port.js";
import type { AnalysisResult } from "../src/domain/analysis-result.js";

const hl = new TsHighlighter();
const kindsOf = (line: HighlightToken[]) =>
  Object.fromEntries(line.filter((t) => t.kind !== "plain").map((t) => [t.text.trim(), t.kind]));

describe("TsHighlighter", () => {
  it("returns exactly one token list per line", () => {
    const lines = ["const a = 1;", "", "/* x", "y */", "let b = `t", "u`;"];
    expect(hl.highlight("a.ts", lines)).toHaveLength(lines.length);
    expect(hl.highlight("a.ts", [])).toEqual([]);
  });

  it("colours keywords, strings, numbers, comments, calls and types", () => {
    const [line] = hl.highlight("a.ts", ["const x: number = foo(42, 'hi', Bar); // note"])!;
    expect(kindsOf(line)).toMatchObject({
      const: "keyword",
      number: "keyword",
      foo: "function",
      "42": "number",
      "'hi'": "string",
      Bar: "type",
      "// note": "comment",
    });
  });

  it("keeps the line text intact", () => {
    const src = ["  if (a < b) { return `x${a}y`; } // ok"];
    const [line] = hl.highlight("a.ts", src)!;
    expect(line.map((t) => t.text).join("")).toBe(src[0]);
  });

  it("handles multi-line comments, templates with substitutions, regex and decorators", () => {
    const out = hl.highlight("a.ts", [
      "@Patch(':id')",
      "/* start",
      "   end */ const r = /ab+c/g;",
      "const t = `a${ {x: 1}.x }b`;",
    ])!;
    expect(kindsOf(out[0])).toMatchObject({ "@": "decorator", Patch: "decorator" });
    expect(out[1][0].kind).toBe("comment");
    expect(out[2][0]).toMatchObject({ kind: "comment", text: "   end */" });
    expect(kindsOf(out[2])["/ab+c/g"]).toBe("string");
    // The template's tail after the substitution is still a string.
    expect(out[3].some((t) => t.kind === "string" && t.text.endsWith("b`"))).toBe(true);
  });

  it("treats contextual keywords used as names as plain", () => {
    const [line] = hl.highlight("a.ts", ["const o = { type: 1 }; o.type;"])!;
    expect(line.filter((t) => t.text === "type").every((t) => t.kind === "plain")).toBe(true);
  });
});

describe("renderHtml with a highlighter", () => {
  const result: AnalysisResult = {
    base: "a".repeat(40),
    head: "b".repeat(40),
    symbols: [],
    nodes: [],
    edges: [],
    files: [
      {
        path: "x.ts",
        status: "modified",
        lines: [
          { type: "ctx", oldLine: 1, newLine: 1, text: "/* open" },
          { type: "del", oldLine: 2, newLine: null, text: "   still old comment */ return a < b;" },
          { type: "add", oldLine: null, newLine: 2, text: "   still new comment */ return 'x';" },
        ],
      },
    ],
  };

  it("colours code and still escapes it", () => {
    const html = renderHtml(result, [hl]);

    expect(html).toContain('<span class="tk-keyword">return</span>');
    expect(html).toContain(`<span class="tk-string">'x'</span>`);
    expect(html).toContain("a &lt; b");
    expect(html).not.toContain("a < b");
  });

  it("tokenizes old and new versions separately, so a comment opened on an unchanged line spans both", () => {
    const html = renderHtml(result, [hl]);
    expect(html).toContain('<span class="tk-comment">   still old comment */</span>');
    expect(html).toContain('<span class="tk-comment">   still new comment */</span>');
  });

  it("falls back to plain text without a highlighter", () => {
    const html = renderHtml(result);
    expect(html).not.toContain('<span class="tk-');
  });
});
