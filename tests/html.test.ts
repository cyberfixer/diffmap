import { describe, it, expect } from "vitest";
import { renderHtml } from "../src/interfaces/html/render-html.js";
import { layoutWindows } from "../src/interfaces/html/layout.js";
import type { AnalysisResult } from "../src/domain/analysis-result.js";
import type { GraphNode } from "../src/domain/graph.js";
import type { ChangedSymbol, DiffLine } from "../src/domain/symbol.js";

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

const line = (type: DiffLine["type"], n: number, text: string): DiffLine => ({
  type,
  oldLine: type === "add" ? null : n,
  newLine: type === "del" ? null : n,
  text,
});

const sym = (id: string, extra: Partial<ChangedSymbol>): ChangedSymbol => ({
  id,
  file: id.split("#")[0],
  name: id.split("#")[1],
  kind: "method",
  status: "modified",
  baseRange: { start: 1, end: 9 },
  headRange: { start: 1, end: 9 },
  diff: [],
  ...extra,
});

describe("renderHtml", () => {
  const longLine = "  const veryLongVariableName = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree);";

  const result: AnalysisResult = {
    base: sha("a"),
    head: sha("b"),
    symbols: [
      sym("svc.ts#Svc.update", {
        diff: [
          line("ctx", 3, "update() {"),
          line("del", 4, "  return 1;"),
          line("add", 4, "  return <em>2</em>;"),
          line("add", 5, longLine),
        ],
      }),
      sym("svc.ts#Svc.create", {
        diff: [line("add", 8, "  return 'new';")],
      }),
      // The class range contains both methods' lines plus its own decorator change.
      sym("svc.ts#Svc", {
        kind: "class",
        diff: [
          line("add", 1, "@Injectable()"),
          line("add", 4, "  return <em>2</em>;"),
          line("add", 8, "  return 'new';"),
        ],
      }),
    ],
    nodes: [
      node("svc.ts#Svc", { changed: true, status: "modified", kind: "class", line: 1 }),
      node("svc.ts#Svc.update", { changed: true, status: "modified", kind: "method", line: 3 }),
      node("svc.ts#Svc.create", { changed: true, status: "modified", kind: "method", line: 8 }),
      node("svc.ts#Svc.findOne", { kind: "method", line: 12 }),
      node("ctl.ts#Ctl.update", {
        kind: "method",
        labels: ['@Patch(":id")', "@HttpCode(204)"],
      }),
      node("svc.ts#Svc.count", { changed: true, status: "removed", kind: "method", line: 20 }),
    ],
    edges: [
      { from: "ctl.ts#Ctl.update", to: "svc.ts#Svc.update", kind: "calls" },
      { from: "svc.ts#Svc.update", to: "svc.ts#Svc.findOne", kind: "calls" }, // same file
      { from: "ctl.ts#Ctl.update", to: "svc.ts#Svc.count", kind: "calls-removed" },
    ],
  };

  it("renders each file exactly once, with all its symbols inside", () => {
    const html = renderHtml(result);

    expect(html.match(/<section class="win /g)).toHaveLength(2); // svc.ts + ctl.ts
    expect(html.match(/class="fname">svc\.ts</g)).toHaveLength(1);
    expect(html.match(/<div class="sym /g)).toHaveLength(6);
    expect(html).toContain("4 changed");
  });

  it("shows decorators as one inline hint, not chips", () => {
    const html = renderHtml(result);

    expect(html).not.toContain('class="chip"');
    expect(html).toContain('class="deco"');
    expect(html.match(/class="deco"/g)).toHaveLength(1);
    expect(html).toContain("@Patch(&quot;:id&quot;) @HttpCode(204)");
  });

  it("does not repeat a method's lines inside its class", () => {
    const html = renderHtml(result);

    // "return 'new'" is in Svc.create; the class must not show it a second time.
    expect(html.match(/return &#39;new&#39;|return 'new'/g)).toHaveLength(1);
    // The class's own change (the decorator) is still shown.
    expect(html).toContain("@Injectable()");
  });

  it("wraps long lines instead of scrolling and escapes code", () => {
    const html = renderHtml(result);

    expect(html).toContain("white-space:pre-wrap");
    expect(html).not.toContain("<em>2</em>");
    expect(html).toContain("&lt;em&gt;2&lt;/em&gt;");
  });

  it("sizes the window to fit its code, within limits", () => {
    const widths = [...renderHtml(result).matchAll(/class="win [^"]*"[^>]*width:(\d+)px/g)].map(
      (m) => Number(m[1])
    );

    expect(widths).toHaveLength(2);
    for (const w of widths) {
      expect(w).toBeGreaterThanOrEqual(360);
      expect(w).toBeLessThanOrEqual(760);
    }
    // svc.ts holds the long line, so it is wider than the context-only file.
    const svc = widths[0];
    const ctl = widths[1];
    expect(Math.max(svc, ctl)).toBeGreaterThan(Math.min(svc, ctl));
  });

  it("draws removed-code warnings and edges", () => {
    const html = renderHtml(result);

    expect(html.match(/<path class="edge/g)).toHaveLength(3);
    expect(html).toContain("edge removed-call");
    expect(html).toContain("1 call still points at removed code");
  });

  it("renders an empty state", () => {
    const html = renderHtml({ base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [] });
    expect(html).toContain("No changed TypeScript symbols");
  });
});
