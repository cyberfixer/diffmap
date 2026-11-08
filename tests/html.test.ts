import { describe, it, expect } from "vitest";
import { renderHtml } from "../src/interfaces/html/render-html.js";
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

const row = (type: DiffLine["type"], n: number, text: string): DiffLine => ({
  type,
  oldLine: type === "add" ? null : n,
  newLine: type === "del" ? null : n,
  text,
});

/** Pull the data object the page hands to its script. */
const pageData = (html: string) => JSON.parse(html.match(/var GITMAP = (.*?);<\/script>/)![1]);

describe("renderHtml", () => {
  // A 30-line file where only lines 4-5 changed; line 25 calls the changed method.
  const svcLines: DiffLine[] = [];
  for (let i = 1; i <= 30; i++) svcLines.push(row("ctx", i, `// line ${i}`));
  svcLines[3] = row("del", 4, "  return <em>old</em>;");
  svcLines.splice(4, 0, row("add", 4, "  return 2;"));
  svcLines[5] = row("add", 5, "  return 3;");

  const result: AnalysisResult = {
    base: sha("a"),
    head: sha("b"),
    range: { baseName: "main", headName: "feature/tasks", commits: 2, title: "Guard task updates" },
    symbols: [
      {
        id: "svc.ts#Svc.update",
        file: "svc.ts",
        name: "Svc.update",
        kind: "method",
        status: "modified",
        baseRange: { start: 4, end: 5 },
        headRange: { start: 4, end: 5 },
        diff: [row("del", 4, "  return <em>old</em>;"), row("add", 4, "  return 2;")],
      },
    ],
    files: [{ path: "svc.ts", status: "modified", lines: svcLines }],
    nodes: [
      node("svc.ts#Svc.update", { changed: true, status: "modified", kind: "method", line: 4 }),
      node("svc.ts#Svc.zap", { changed: true, status: "removed", kind: "method", line: 4 }),
      node("svc.ts#Svc.audit", { kind: "method", line: 25 }),
      node("ctl.ts#Ctl.update", {
        kind: "method",
        line: 7,
        endLine: 10,
        code: ['  @Patch(":id")', "  update(id: number) {", "    return this.svc.update(id);", "  }"],
      }),
    ],
    edges: [
      { from: "ctl.ts#Ctl.update", to: "svc.ts#Svc.update", kind: "calls", sites: [{ line: 9, text: "    return this.svc.update(id);" }] },
      { from: "svc.ts#Svc.audit", to: "svc.ts#Svc.update", kind: "calls", sites: [{ line: 25, text: "// line 25" }] },
      { from: "ctl.ts#Ctl.update", to: "svc.ts#Svc.zap", kind: "calls-removed", sites: [{ line: 9, text: "x" }] },
    ],
  };

  it("has the three panels: changed files, map and details", () => {
    const html = renderHtml(result);
    expect(html).toContain('<aside class="side">');
    expect(html).toContain('<main class="map">');
    expect(html).toContain('<aside class="detail" id="detail">');
  });

  it("shows branch names, commit count and title in the top bar, with no approve buttons", () => {
    const html = renderHtml(result);
    expect(html).toContain('<div class="t">Guard task updates</div>');
    expect(html).toContain("feature/tasks → main · 2 commits");
    expect(html).not.toMatch(/Approve|Request changes/);
  });

  it("lists each changed file with its changed symbols in the sidebar", () => {
    const html = renderHtml(result);
    expect(html.match(/class="sf-file/g)).toHaveLength(1);
    expect(html.match(/class="sf-sym"/g)).toHaveLength(2);
    expect(html).toContain("method · 2 usages"); // Svc.update: one call inside the diff, one outside
  });

  it("tracks 'viewed', not 'approved'", () => {
    const html = renderHtml(result);
    expect(html).toContain("of 2 symbols");
    expect(html).toContain("Mark as viewed");
    expect(pageData(html).key).toBe(`gitmap:viewed:${sha("a")}..${sha("b")}`);
  });

  it("shows one card per changed file, colour-coded with both line numbers", () => {
    const html = renderHtml(result);
    expect(html.match(/<section class="card in"/g)).toHaveLength(1);
    expect(html).toContain('class="dl add');
    expect(html).toContain('class="dl del');
    expect(html).toMatch(/<span class="lo">4<\/span><span class="ln"><\/span><span class="sg">−<\/span>/);
    expect(html).not.toContain('class="badge"');
  });

  it("folds far unchanged lines but keeps call sites in changed files visible", () => {
    const html = renderHtml(result);
    expect(html).toContain('class="gap"');
    expect(html).toMatch(/class="dl ctx far" id="L0-15"/);
    expect(html).toMatch(/class="dl ctx" id="L0-25"/); // a call site, kept open
    expect(html).toContain('class="cbtn expand"');
  });

  it("makes the line where a changed symbol starts clickable", () => {
    const html = renderHtml(result);
    expect(html).toMatch(/class="dl add def" id="L0-4" data-sel="0"/);
    expect(html).toMatch(/class="dl del def" data-sel="1"/); // removed symbol starts on its removed line
  });

  it("shows the whole caller outside the diff, hidden until a symbol is selected", () => {
    const html = renderHtml(result);
    expect(html.match(/<section class="card out"/g)).toHaveLength(1);
    expect(html).toContain('id="U0-9"');
    expect(html.match(/id="U0-\d+"/g)).toHaveLength(4); // every line of Ctl.update
    expect(html).toContain('data-for="0 1"'); // calls both changed symbols
    expect(html).toMatch(/\.card\.out \{[^}]*display:none/);
  });

  it("gives the script each symbol's before/after and where it is used", () => {
    const { syms } = pageData(renderHtml(result));
    const upd = syms[0];
    expect(upd.name).toBe("Svc.update");
    expect(upd.before).toEqual(["  return <em>old</em>;"]);
    expect(upd.after).toEqual(["  return 2;"]);
    expect(upd.refs).toEqual([
      { file: "svc.ts", line: 25, text: "// line 25", el: "L0-25", out: false, bad: false },
      { file: "ctl.ts", line: 9, text: "    return this.svc.update(id);", el: "U0-9", out: true, bad: false },
    ]);
    expect(syms[1].refs[0].bad).toBe(true);
  });

  it("warns about calls into removed code", () => {
    const html = renderHtml(result);
    expect(html).toContain("1 call still points at removed code");
  });

  it("escapes code, including inside the script data", () => {
    const html = renderHtml(result);
    expect(html).not.toContain("<em>old</em>");
    expect(html).toContain("&lt;em&gt;old&lt;/em&gt;");
    expect(html).toContain("\\u003cem>old\\u003c/em>");
  });

  it("renders an empty state", () => {
    const html = renderHtml({ base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [], files: [] });
    expect(html).toContain("No changed TypeScript files");
  });
});

describe("file card header", () => {
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
  });

  it("has a button that copies the full path", () => {
    const html = renderHtml(result);
    expect(html).toContain('class="cbtn copy" type="button" data-path="apps/api/src/tasks/tasks.service.ts"');
    expect(html).toContain("navigator.clipboard");
  });

  it("falls back to short SHAs when there is no range info", () => {
    expect(renderHtml(result)).toContain("aaaaaaa..bbbbbbb");
  });
});
