import { describe, it, expect } from "vitest";
import { renderHtml } from "../src/interfaces/html/render-html.js";
import { layoutWindows } from "../src/interfaces/html/layout.js";
import type { AnalysisResult } from "../src/domain/analysis-result.js";
import type { GraphNode } from "../src/domain/graph.js";
import type { DiffLine } from "../src/domain/symbol.js";

const sha = (c: string) => c.repeat(40);

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  file: id.split("#")[0],
  name: id.split("#")[1],
  kind: "function",
  changed: false,
  line: 1,
  labels: [],
  ...extra,
});

describe("layoutWindows", () => {
  it("places callers left of callees and survives cycles", () => {
    const layout = layoutWindows(
      [
        { id: "a.ts", width: 300 },
        { id: "b.ts", width: 300 },
        { id: "c.ts", width: 300 },
      ],
      [
        { from: "a.ts", to: "b.ts" },
        { from: "b.ts", to: "c.ts" },
        { from: "c.ts", to: "a.ts" }, // cycle
      ]
    );
    const x = (id: string) => layout.placed.get(id)!.x;

    expect(x("a.ts")).toBeLessThan(x("b.ts"));
    expect(x("b.ts")).toBeLessThan(x("c.ts"));
  });

  it("stacks unrelated windows in one column with distinct orders", () => {
    const layout = layoutWindows(
      [
        { id: "a.ts", width: 300 },
        { id: "b.ts", width: 300 },
      ],
      []
    );
    expect(layout.columns).toHaveLength(1);
    const orders = [...layout.placed.values()].map((p) => p.order).sort();
    expect(orders).toEqual([0, 1]);
  });
});

const row = (type: DiffLine["type"], n: number, text: string): DiffLine => ({
  type,
  oldLine: type === "add" ? null : n,
  newLine: type === "del" ? null : n,
  text,
});

describe("renderHtml", () => {
  const longLine = "  const veryLongVariableName = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree);";

  // A 30-line file where only lines 4-5 changed.
  const svcLines: DiffLine[] = [];
  for (let i = 1; i <= 30; i++) svcLines.push(row("ctx", i, `// line ${i}`));
  svcLines[3] = row("del", 4, "  return <em>old</em>;");
  svcLines.splice(4, 0, row("add", 4, "  return 2;"));
  svcLines[5] = row("add", 5, longLine);

  const result: AnalysisResult = {
    base: sha("a"),
    head: sha("b"),
    symbols: [],
    files: [{ path: "svc.ts", status: "modified", lines: svcLines }],
    nodes: [
      node("svc.ts#Svc.update", { changed: true, status: "modified", kind: "method", line: 4 }),
      node("svc.ts#Svc.findOne", { kind: "method", line: 20 }),
      node("ctl.ts#Ctl.update", { kind: "method", labels: ['@Patch(":id")', "@HttpCode(204)"] }),
      node("svc.ts#Svc.count", { changed: true, status: "removed", kind: "method", line: 4 }),
    ],
    edges: [
      { from: "ctl.ts#Ctl.update", to: "svc.ts#Svc.update", kind: "calls" },
      { from: "svc.ts#Svc.update", to: "svc.ts#Svc.findOne", kind: "calls" }, // same file
      { from: "ctl.ts#Ctl.update", to: "svc.ts#Svc.count", kind: "calls-removed" },
    ],
  };

  it("shows the whole file once, every line", () => {
    const html = renderHtml(result);

    expect(html.match(/<section class="win /g)).toHaveLength(2); // svc.ts + ctl.ts
    expect(html.match(/class="fname">svc\.ts</g)).toHaveLength(1);
    expect(html.match(/<span class="tx">\/\/ line /g)).toHaveLength(28); // every untouched line
  });

  it("colour-codes changed lines and has no status tags", () => {
    const html = renderHtml(result);

    expect(html).toContain('class="dl add');
    expect(html).toContain('class="dl del');
    expect(html).toContain("+2");
    expect(html).not.toContain('class="badge"');
    expect(html).not.toContain(">modified<");
    expect(html).not.toContain(">added<");
  });

  it("shows decorators as one inline hint, not chips", () => {
    const html = renderHtml(result);

    expect(html).not.toContain('class="chip"');
    expect(html.match(/class="deco"/g)).toHaveLength(1);
    expect(html).toContain("@Patch(&quot;:id&quot;) @HttpCode(204)");
  });

  it("marks far-away unchanged lines so 'only changes' can fold them", () => {
    const html = renderHtml(result);

    expect(html).toContain('class="dl gap"');
    expect(html).toMatch(/class="dl ctx far"/);
    // Lines next to the change stay visible in that mode.
    expect(html).not.toMatch(/class="dl ctx far"[^>]*><span class="ln">3</);
  });

  it("anchors arrows on the symbol's own line and wraps long lines", () => {
    const html = renderHtml(result);

    expect(html).toMatch(/<div class="dl [^"]*anchor[^"]*" id="s0"/);
    expect(html).toContain("white-space:pre-wrap");
  });

  it("escapes code", () => {
    const html = renderHtml(result);

    expect(html).not.toContain("<em>old</em>");
    expect(html).toContain("&lt;em&gt;old&lt;/em&gt;");
  });

  it("sizes windows to fit their code, within limits", () => {
    const widths = [...renderHtml(result).matchAll(/class="win [^"]*"[^>]*width:(\d+)px/g)].map(
      (m) => Number(m[1])
    );

    expect(widths).toHaveLength(2);
    for (const w of widths) {
      expect(w).toBeGreaterThanOrEqual(360);
      expect(w).toBeLessThanOrEqual(760);
    }
  });

  it("draws removed-code warnings and edges", () => {
    const html = renderHtml(result);

    expect(html.match(/<path class="edge/g)).toHaveLength(3);
    expect(html).toContain("edge removed-call");
    expect(html).toContain("1 call still points at removed code");
  });

  it("renders an empty state", () => {
    const html = renderHtml({ base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [], files: [] });
    expect(html).toContain("No changed TypeScript files");
  });
});

describe("file window header", () => {
  const result: AnalysisResult = {
    base: sha("a"),
    head: sha("b"),
    symbols: [],
    nodes: [],
    edges: [],
    files: [
      {
        path: "apps/api/src/tasks/tasks.service.ts",
        status: "modified",
        lines: [{ type: "add", oldLine: null, newLine: 1, text: "x" }],
      },
    ],
  };

  it("shows the full repo path, not just the file name", () => {
    const html = renderHtml(result);
    expect(html).toContain(
      '<span class="fdir">apps/api/src/tasks/</span><span class="fname">tasks.service.ts</span>'
    );
    expect(html).not.toContain("text-overflow:ellipsis; white-space:nowrap; direction:rtl");
  });

  it("has a button that copies the full path", () => {
    const html = renderHtml(result);
    expect(html).toContain('class="copy" type="button" data-path="apps/api/src/tasks/tasks.service.ts"');
    expect(html).toContain("navigator.clipboard");
  });
});
