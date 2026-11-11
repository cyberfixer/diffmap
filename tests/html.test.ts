import { describe, it, expect } from "vitest";
import { changeVersion, folderTree, renderHtml } from "../src/interfaces/html/render-html.js";
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
const pageData = (html: string) => JSON.parse(html.match(/var DIFFMAP = (.*?);<\/script>/)![1]);

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

  it("is laid out like an editor: file tree, code, usages panel below, status bar", () => {
    const html = renderHtml(result);
    expect(html).toContain('<aside class="side">');
    expect(html).toContain('<div class="ed" id="ed">');
    expect(html).toContain('<section class="dock" id="dock"');
    expect(html).toContain('<footer class="status">');
    expect(html).not.toContain('id="cv"'); // no pan/zoom canvas
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
    expect(html.match(/class="sf-sym mono"/g)).toHaveLength(2);
    expect(html).toContain("Svc.update · method · 2 usages"); // Svc.update: one call inside the diff, one outside
  });

  it("groups files by folder in the sidebar, joining single-child folders", () => {
    const t = folderTree([
      "app/src/main/kotlin/ui/add/AddRepo.kt",
      "app/src/main/kotlin/ui/add/AddRepoIntro.kt",
      "app/src/main/kotlin/ui/list/List.kt",
      "README.md",
    ]);
    expect(t.files).toEqual([3]);
    expect(t.folders.map((f) => f.name)).toEqual(["app/src/main/kotlin/ui"]);
    expect(t.folders[0].folders.map((f) => [f.name, f.files])).toEqual([["add", [0, 1]], ["list", [2]]]);
    // Everything in one folder: the tree starts at that folder.
    expect(folderTree(["a/b/x.ts", "a/b/y.ts"]).folders.map((f) => [f.name, f.files])).toEqual([["a/b", [0, 1]]]);
  });

  it("colours file names by what happened to them", () => {
    const html = renderHtml(result);
    expect(html).toMatch(/class="sf-file mono fs-modified"/);
  });

  it("tracks 'viewed' per file, not 'approved'", () => {
    const html = renderHtml(result);
    expect(html).toContain("of 1 file<");
    expect(html.match(/<input type="checkbox" class="fv">/g)).toHaveLength(1);
    expect(html).toContain("'file:' + sec.dataset.path");
    expect(pageData(html).key).toBe(`diffmap:viewed:${sha("a")}..${sha("b")}`);
  });

  it("gives each file's change a version, so 'viewed' can reset when it changes again", () => {
    const file = result.files[0];
    const rev = changeVersion(file);
    expect(renderHtml(result)).toContain(`data-path="svc.ts" data-rev="${rev}"`);

    // The same change after a rebase (other lines and line numbers moved): same version.
    const moved = file.lines.map((l) => ({
      ...l,
      oldLine: l.oldLine && l.oldLine + 7,
      newLine: l.newLine && l.newLine + 7,
      text: l.type === "ctx" ? `${l.text} (rebased)` : l.text,
    }));
    expect(changeVersion({ ...file, lines: moved })).toBe(rev);

    // A later push that changes the file again: a new version.
    const again = file.lines.map((l) => (l.text === "  return 3;" ? { ...l, text: "  return 4;" } : l));
    expect(changeVersion({ ...file, lines: again })).not.toBe(rev);
    expect(changeVersion({ ...file, lines: [...file.lines, row("add", 31, "// more")] })).not.toBe(rev);
  });

  it("shows each changed file once, colour-coded with both line numbers, with a way to collapse it", () => {
    const html = renderHtml(result);
    expect(html.match(/<section class="fsec" id="c0" data-path="svc.ts"/g)).toHaveLength(1);
    expect(html.match(/<button class="fold"/g)).toHaveLength(1);
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

  it("can open folded lines from the top or the bottom, and fold them all again", () => {
    const html = renderHtml(result);
    expect(html).toContain("gapButton('top'");
    expect(html).toContain("gapButton('bottom'");
    expect(html).toContain("Changes only");
    expect(html).toMatch(/\.dl\.far:not\(\.shown\) \{ display:none/);
  });

  it("has a search box for the text of the changed files", () => {
    const html = renderHtml(result);
    expect(html).toContain('<button class="dtab" id="tabs"');
    expect(html).toContain('placeholder="Search in the changed files"');
    expect(html).toContain("<kbd>/</kbd> search");
  });

  it("tells the script where each definition ends, and lists the keyboard shortcuts", () => {
    const html = renderHtml(result);
    expect(pageData(html).syms[0]).toMatchObject({ line: 4, end: 5 });
    expect(html).toContain("<kbd>↑</kbd><kbd>↓</kbd> usages");
    expect(html).toContain("<kbd>N</kbd><kbd>P</kbd> next / previous file");
  });

  it("makes the line where a changed symbol starts clickable", () => {
    const html = renderHtml(result);
    expect(html).toMatch(/class="dl add def" id="L0-4" data-sel="0"/);
    expect(html).toMatch(/class="dl del def" data-sel="1"/); // removed symbol starts on its removed line
  });

  it("keeps the whole caller outside the diff, for the usages panel to show when picked", () => {
    const html = renderHtml(result);
    const kept = html.slice(html.indexOf('<div id="outsrc" hidden>'));
    expect(kept.match(/<div class="caller code" data-path="ctl.ts">/g)).toHaveLength(1);
    expect(kept).toContain('id="U0-9"');
    expect(kept.match(/id="U0-\d+"/g)).toHaveLength(4); // every line of Ctl.update
    expect(html).toContain("2 usages in 1 file outside the diff");
  });

  it("gives the script each symbol's before/after and where it is used", () => {
    const { syms } = pageData(renderHtml(result));
    const upd = syms[0];
    expect(upd.name).toBe("Svc.update");
    expect(upd.before).toEqual(["  return <em>old</em>;"]);
    expect(upd.after).toEqual(["  return 2;"]);
    expect(upd.refs).toEqual([
      { file: "svc.ts", line: 25, text: "// line 25", el: "L0-25", out: false, bad: false, impl: false },
      { file: "ctl.ts", line: 9, text: "    return this.svc.update(id);", el: "U0-9", out: true, bad: false, impl: false },
    ]);
    expect(syms[1].refs[0].bad).toBe(true);
  });

  it("warns about calls into removed code, with a list of them", () => {
    const html = renderHtml(result);
    expect(html).toContain("1 call still points at removed code");
    // The count is a button that opens the list; the list has its own tab.
    expect(html).toMatch(/<button class="pill warn" id="brokenpill"/);
    expect(html).toMatch(/id="tabb"[^>]*>Removed code<em>1<\/em>/);
    expect(html).toContain('id="blist"');

    const clean = renderHtml({ ...result, edges: result.edges.filter((e) => e.kind !== "calls-removed") });
    expect(clean).not.toContain('id="tabb"');
    expect(clean).not.toContain('id="brokenpill"');
  });

  it("has back and forward, and keeps the definition apart from the usages", () => {
    const html = renderHtml(result);
    expect(html).toMatch(/id="back"[^>]*disabled/);
    expect(html).toMatch(/id="fwd"[^>]*disabled/);
    expect(html).toContain("<kbd>←</kbd><kbd>→</kbd> back / forward");
    expect(html).toContain("if (k === 'ArrowRight') { e.preventDefault(); forward(); return; }");
    // Stepping through usages only redraws the panel; it does not scroll the code.
    expect(html).toMatch(/function step\(d\) \{[^}]*renderDock\(\);\s*\}/);
    expect(html).toContain("Show in the code above");
  });

  it("stays quick on big changes: files off screen are not laid out, panel sizes are not inherited", () => {
    const html = renderHtml(result);
    expect(html).toContain(".fsec { content-visibility:auto;");
    expect(html).toContain(".sf { content-visibility:auto;");
    expect(html).toContain('@property --lw { syntax:"<length>"; inherits:false;');
    expect(html).toContain("requestAnimationFrame(apply)");
  });

  it("escapes code, including inside the script data", () => {
    const html = renderHtml(result);
    expect(html).not.toContain("<em>old</em>");
    expect(html).toContain("&lt;em&gt;old&lt;/em&gt;");
    expect(html).toContain("\\u003cem>old\\u003c/em>");
  });

  it("renders an empty state", () => {
    const html = renderHtml({ base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [], files: [] });
    expect(html).toContain("No changed files");
  });
});

describe("large files", () => {
  const file = (path: string, n: number) => ({
    path,
    status: "modified" as const,
    lines: Array.from({ length: n }, (_, i) => row(i === 0 ? "add" : "ctx", i + 1, `line ${i + 1}`)),
  });
  const page = (files: ReturnType<typeof file>[]) =>
    renderHtml({ base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [], files });

  it("start collapsed above 500 lines, with a button to show them", () => {
    const html = page([file("big.py", 501), file("small.py", 500)]);
    expect(html).toMatch(/<section class="fsec big" id="c0"/);
    expect(html).toContain("501 lines · hidden because the file is large · <b>Show</b>");
    expect(html).toMatch(/<section class="fsec" id="c1"/);
  });

  it("use a lower limit of 300 lines for HTML files", () => {
    const html = page([file("page.html", 301), file("ok.html", 300)]);
    expect(html).toMatch(/<section class="fsec big" id="c1"/); // sorted: ok.html is c0, page.html is c1
    expect(html).toMatch(/<section class="fsec" id="c0"/);
  });

  it("can use other limits", () => {
    const html = renderHtml(
      { base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [], files: [file("a.py", 50)] },
      [],
      { maxLines: 40 },
    );
    expect(html).toContain('class="fsec big"');
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

describe("light / dark toggle", () => {
  const page = renderHtml({ base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [], files: [] });

  it("has a theme button and applies a saved choice before the page paints", () => {
    expect(page).toContain('id="theme"');
    expect(page.indexOf('localStorage.getItem("diffmap:theme")')).toBeLessThan(page.indexOf("<body"));
  });

  it("has colours for the system setting and for an explicit light or dark choice", () => {
    expect(page).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
    expect(page).toContain(':root[data-theme="dark"] {');
  });
});
