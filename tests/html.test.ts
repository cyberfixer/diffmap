import { describe, it, expect } from "vitest";
import { renderHtml } from "../src/interfaces/html/render-html.js";
import { layoutGraph } from "../src/interfaces/html/layout.js";
import type { AnalysisResult } from "../src/domain/analysis-result.js";
import type { GraphNode } from "../src/domain/graph.js";

const sha = (c: string) => c.repeat(40);

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  file: id.split("#")[0],
  name: id.split("#")[1],
  kind: "function",
  changed: false,
  labels: [],
  ...extra,
});

describe("layoutGraph", () => {
  it("places callers left of callees and survives cycles", () => {
    const nodes = [node("a.ts#caller"), node("a.ts#mid"), node("b.ts#leaf")];
    const layout = layoutGraph(
      nodes,
      [
        { from: "a.ts#caller", to: "a.ts#mid", kind: "calls" },
        { from: "a.ts#mid", to: "b.ts#leaf", kind: "calls" },
        { from: "b.ts#leaf", to: "a.ts#caller", kind: "calls" }, // cycle
      ],
      new Map()
    );
    const x = (id: string) => layout.boxes.get(id)!.x;

    expect(x("a.ts#caller")).toBeLessThan(x("a.ts#mid"));
    expect(x("a.ts#mid")).toBeLessThan(x("b.ts#leaf"));
  });

  it("does not overlap boxes in the same column", () => {
    const nodes = [node("a.ts#x"), node("a.ts#y"), node("a.ts#z")];
    const layout = layoutGraph(nodes, [], new Map());
    const boxes = [...layout.boxes.values()].sort((p, q) => p.y - q.y);

    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].h);
    }
  });
});

describe("renderHtml", () => {
  const result: AnalysisResult = {
    base: sha("a"),
    head: sha("b"),
    symbols: [
      {
        id: "svc.ts#Svc.update",
        file: "svc.ts",
        name: "Svc.update",
        kind: "method",
        status: "modified",
        baseRange: { start: 1, end: 3 },
        headRange: { start: 1, end: 4 },
        diff: [
          { type: "ctx", oldLine: 1, newLine: 1, text: "update() {" },
          { type: "del", oldLine: 2, newLine: null, text: "  return 1;" },
          { type: "add", oldLine: null, newLine: 2, text: "  return <b>2</b>;" },
        ],
      },
    ],
    nodes: [
      node("svc.ts#Svc.update", { changed: true, status: "modified", kind: "method" }),
      node("ctl.ts#Ctl.update", { kind: "method", labels: ['@Patch(":id")'] }),
      node("svc.ts#Svc.count", { changed: true, status: "removed", kind: "method" }),
    ],
    edges: [
      { from: "ctl.ts#Ctl.update", to: "svc.ts#Svc.update", kind: "calls" },
      { from: "ctl.ts#Ctl.update", to: "svc.ts#Svc.count", kind: "calls-removed" },
    ],
  };

  it("draws nodes, diff lines, edges and decorator labels", () => {
    const html = renderHtml(result);

    expect(html).toContain("<!doctype html>");
    expect(html.match(/class="node /g)).toHaveLength(3);
    expect(html.match(/<path class="edge/g)).toHaveLength(2);
    expect(html).toContain('class="dl add"');
    expect(html).toContain('class="dl del"');
    expect(html).toContain("&quot;:id&quot;");
    expect(html).toContain("edge removed-call");
    expect(html).toContain("1 call still points at removed code");
  });

  it("escapes code from the diff", () => {
    const html = renderHtml(result);
    expect(html).not.toContain("<b>2</b>");
    expect(html).toContain("&lt;b&gt;2&lt;/b&gt;");
  });

  it("renders an empty state", () => {
    const html = renderHtml({ base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [] });
    expect(html).toContain("No changed TypeScript symbols");
  });
});
