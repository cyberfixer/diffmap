import { describe, it, expect, beforeAll } from "vitest";
import { changeVersion, folderTree, renderHtml, startsRtl } from "../src/interfaces/html/render-html.js";
import { STYLE } from "../src/interfaces/html/html-style.js";
import { XCODE_DARK, XCODE_LIGHT, XCODE_STYLE } from "../src/interfaces/html/xcode-style.js";
import { TreeSitterEngine } from "../src/infrastructure/parsers/tree-sitter/engine.js";
import { TreeSitterHighlighter } from "../src/infrastructure/parsers/tree-sitter/tree-sitter-highlighter.js";
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
    expect(html).toContain('<div class="t"><bdi>Guard task updates</bdi></div>');
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

  it("has no file comment button in a report file (comments need the service)", () => {
    expect(renderHtml(result)).not.toContain('class="cbtn fcomment"');
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

  it("keeps right-to-left text readable: isolated in code, whole lines in plain text", () => {
    const line = (text: string, n: number) => row("add", n, text);
    const files = [
      { path: "docs/عربي/دليل.md", status: "added" as const, lines: [line("# مرحبا بالعالم", 1), line("Mixed: كلمة عربية here", 2), line("plain", 3)] },
      { path: "a.ts", status: "added" as const, lines: [line('const m = "مرحبا" + 5; // تعليق عربي', 1)] },
    ];
    const ts = {
      supportedExtensions: [".ts"],
      highlight: (_f: string, lines: string[]) => lines.map((t) => [{ kind: "plain" as const, text: t }]),
    };
    const html = renderHtml({ ...result, symbols: [], nodes: [], edges: [], files }, [ts as never]);
    // Plain text: a line that starts with Arabic is laid out right to left as a whole.
    expect(html).toContain('<span class="tx" dir="rtl"># مرحبا بالعالم</span>');
    expect(html).toContain('<span class="tx">Mixed: <bdi>كلمة عربية</bdi> here</span>');
    expect(html).toContain('<span class="tx">plain</span>');
    // Code stays left to right; each Arabic run is isolated so "+ 5" stays where it is.
    expect(html).toContain('const m = &quot;<bdi>مرحبا</bdi>&quot; + 5; // <bdi>تعليق عربي</bdi>');
    // Folder names keep their order in the path.
    expect(html).toContain('<span class="fdir">docs/&lrm;عربي/&lrm;</span><span class="fname"><bdi>دليل</bdi>.md</span>');
    expect(startsRtl("- البند الأول")).toBe(true);
    expect(startsRtl("key: قيمة")).toBe(false);
    expect(startsRtl("123 + 4")).toBe(false);
  });

  it("shades the letters that changed on an edited line", () => {
    const files = [{
      path: "a.txt",
      status: "modified" as const,
      lines: [row("del", 1, "\tlimit = 10 # مرحبا"), row("add", 1, "\tlimit = 100 # مرحبا"), row("add", 2, "something else entirely")],
    }];
    const html = renderHtml({ ...result, symbols: [], nodes: [], edges: [], files });
    expect(html).toContain('<span class="tx">  limit = 10 # <bdi>مرحبا</bdi></span>');
    expect(html).toContain('<span class="tx">  limit = 10<span class="chg">0</span> # <bdi>مرحبا</bdi></span>');
    expect(html).toContain('<span class="tx">something else entirely</span>');
    expect(html).toContain(".dl.add .chg { background:var(--add-hl);");
    expect(html).toContain(".dl.del .chg { background:var(--del-hl);");
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

describe("where a symbol is shown to be defined", () => {
  // An attribute on a line of its own comes before the name: the name's line is the definition.
  const lines: DiffLine[] = [
    row("ctx", 1, "class Cache {"),
    row("ctx", 2, "  @objc"),
    row("ctx", 3, "  func storeItem(_ item: Item, forKey key: String) {"),
    row("del", 4, "    print(key)"),
    row("add", 4, "    print(key, item)"),
    row("ctx", 5, "  }"),
    row("ctx", 6, "  - (instancetype)initWithName:(NSString *)name {"),
    row("add", 7, "    return self;"),
    row("ctx", 8, "  }"),
    row("ctx", 9, "}"),
  ];
  const result: AnalysisResult = {
    base: sha("a"),
    head: sha("b"),
    symbols: [],
    files: [{ path: "Cache.swift", status: "modified", lines }],
    nodes: [
      node("Cache.swift#Cache.storeItem(_:forKey:)", { changed: true, status: "modified", kind: "method", line: 2, endLine: 5 }),
      // Objective-C's initWithName: is shown as init(name:); "init" starts the word that is written.
      node("Cache.swift#Cache.init(name:)", { changed: true, status: "modified", kind: "method", line: 6, endLine: 8 }),
    ],
    edges: [],
  };
  const html = renderHtml(result);
  const defRow = (k: number) => html.match(new RegExp(`<[^>]*data-defs="${k}"[^>]*>[\\s\\S]{0,600}`))![0];

  it("is the line that writes its name, not an attribute before it", () => {
    const syms = pageData(html).syms as { name: string; line: number }[];
    expect(syms.map((s) => [s.name, s.line])).toEqual([
      ["Cache.storeItem(_:forKey:)", 3],
      ["Cache.init(name:)", 6],
    ]);
    expect(defRow(0)).toContain("storeItem");
    expect(defRow(0).split("storeItem")[0]).not.toContain("@objc");
    expect(defRow(1)).toContain("initWithName");
  });

  it("is the line the parser says has the name, also when an attribute before it holds the name (roadmap 38)", () => {
    const lines: DiffLine[] = [
      row("ctx", 1, "class Cache {"),
      row("ctx", 2, "  @objc(storeItem:)"),
      row("ctx", 3, "  @MainActor"),
      row("ctx", 4, "  func storeItem(_ item: Item) {"),
      row("add", 5, "    print(item)"),
      row("ctx", 6, "  }"),
      row("ctx", 7, "\t@objc(load:) func load(_ x: Int) {}"),
      row("del", 8, "  @objc(drop:)"),
      row("del", 9, "  func drop(_ x: Int) {}"),
      { type: "ctx", oldLine: 10, newLine: 8, text: "}" },
    ];
    const page = renderHtml({
      base: sha("a"),
      head: sha("b"),
      symbols: [],
      files: [{ path: "Cache.swift", status: "modified", lines }],
      nodes: [
        node("Cache.swift#Cache.storeItem(_:)", { changed: true, status: "modified", kind: "method", line: 2, endLine: 6, nameAt: { line: 4, column: 7 } }),
        node("Cache.swift#Cache.load(_:)", { changed: true, status: "modified", kind: "method", line: 7, endLine: 7, nameAt: { line: 7, column: 19 } }),
        node("Cache.swift#Cache.drop(_:)", { changed: true, status: "removed", kind: "method", line: 8, endLine: 9, nameAt: { line: 9, column: 7 } }),
      ],
      edges: [],
    });
    const syms = pageData(page).syms as { name: string; line: number; col?: number }[];
    // The column is in the text as shown, where a tab is two spaces.
    expect(syms.map((s) => [s.name, s.line, s.col])).toEqual([
      ["Cache.storeItem(_:)", 4, 7],
      ["Cache.load(_:)", 7, 20],
      ["Cache.drop(_:)", 9, 7],
    ]);
    const defRowOf = (k: number) => page.match(new RegExp(`<div class="([^"]*)"[^>]*data-defs="${k}"[^>]*>[\\s\\S]{0,400}?</div>`))!;
    expect(defRowOf(0)[0]).toContain("func storeItem");
    expect(defRowOf(2)[1]).toContain("del");
    expect(defRowOf(2)[0]).toContain("func drop");
  });
});


describe("Xcode colours (roadmap 37)", () => {
  const empty = renderHtml({ base: sha("a"), head: sha("b"), symbols: [], nodes: [], edges: [], files: [] });

  it("have a button, and a saved choice is applied before the page paints", () => {
    expect(empty).toContain('id="codestyle"');
    expect(empty).toContain('aria-pressed="false"');
    const boot = empty.indexOf('localStorage.getItem("diffmap:style")');
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(empty.indexOf("<body"));
    expect(empty).toContain('setAttribute("data-style","xcode")');
    // Next to the light / dark button, which keeps working as before.
    expect(empty.indexOf('id="codestyle"')).toBeLessThan(empty.indexOf('id="theme"'));
  });

  it("are Xcode's Default (Light) and Default (Dark), picked by the Auto / Light / Dark choice", () => {
    expect(empty).toMatch(/:root\[data-style="xcode"\] \{[^}]*--xc-bg:#FFFFFF;[^}]*--xc-keyword:#9B2393;/);
    expect(empty).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root\[data-style="xcode"\]:not\(\[data-theme="light"\]\) \{[^}]*--xc-bg:#1F1F24;[^}]*--xc-keyword:#FC5FA3;/);
    expect(empty).toMatch(/:root\[data-style="xcode"\]\[data-theme="dark"\] \{[^}]*--xc-bg:#1F1F24;/);
    // SF Mono 12 where the reader has it (it is never downloaded), Medium in dark and Regular in light.
    expect(empty).toContain('--xc-mono:ui-monospace, "SF Mono", SFMono-Regular, Menlo');
    expect(empty).toContain("font:var(--xc-weight) 12px/16px var(--xc-mono)");
    expect([XCODE_LIGHT.weight, XCODE_LIGHT.keywordWeight, XCODE_DARK.weight, XCODE_DARK.keywordWeight]).toEqual([400, 600, 500, 700]);
    expect(empty).not.toMatch(/\.(woff2?|ttf|otf)\b/);
  });

  it("leave diffmap's own colours as they were", () => {
    const own = STYLE.replace(XCODE_STYLE, "");
    expect(own).not.toMatch(/tk-(definition|type-definition|constructor|doc|mark|character|regex|preprocessor|url)|\.own\b/);
  });

  it("change the code only: not the page's fonts, the pills or the inputs", () => {
    // Every rule is about the code (.code, .ed, .prev, its rows and tokens), or sets the palette's own --xc-* properties.
    for (const [, selectors, body] of XCODE_STYLE.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of selectors.split(",").map((s) => s.trim())) {
        if (/^:root\[data-style="xcode"\](\[data-theme="dark"\]|:not\(\[data-theme="light"\]\))?$/.test(selector)) {
          expect(body.match(/--[\w-]+(?=:)/g)!.filter((p) => !p.startsWith("--xc-")), selector).toEqual([]);
        } else {
          expect(selector, selector).toMatch(/^\[data-style="xcode"\] (\.code|\.ed|\.prev|\.dl|\.tk-)/);
        }
      }
    }
  });

  describe("token by token, in Swift and Objective-C", () => {
    /** The colour Xcode's CSS gives an element with these classes: the rule with the most classes, then the last. */
    const colourOf = (classes: string[], palette: "light" | "dark"): string => {
      let best: { n: number; at: number; value: string } | null = null;
      for (const m of XCODE_STYLE.matchAll(/\n\s*((?:\[data-style="xcode"\] \.[^{]+?))\s*\{([^}]*)\}/g)) {
        const colour = /(?:^|;|\s)color:var\(--([\w-]+)\)/.exec(m[2]);
        if (!colour) continue;
        for (const selector of m[1].split(",")) {
          const need = selector.replace('[data-style="xcode"]', "").trim().split(".").filter(Boolean);
          if (need.length === 0 || need.some((c) => !classes.includes(c))) continue;
          if (!best || need.length > best.n || (need.length === best.n && m.index > best.at)) best = { n: need.length, at: m.index, value: colour[1] };
        }
      }
      const block = palette === "dark" ? /\[data-theme="dark"\] \{([^}]*)\}/.exec(XCODE_STYLE)![1] : /:root\[data-style="xcode"\] \{([^}]*)\}/.exec(XCODE_STYLE)![1];
      return best ? new RegExp(`--${best.value}:([^;]+);`).exec(block)![1] : "plain";
    };
    /** The classes of the first coloured piece of code whose text is `word`. */
    const classesOf = (html: string, word: string): string[] => {
      const found = new RegExp(`<span class="(tk-[^"]*)">${word.replace(/"/g, "&quot;").replace(/[.*+?^$()|[\]\\]/g, "\\$&")}</span>`).exec(html);
      expect(found, word).not.toBeNull();
      return found![1].split(" ");
    };

    const SWIFT = [
      "import UIKit",
      "",
      "// MARK: - Inbox",
      "/// Opens a thread. See https://example.com/help.",
      "final class InboxViewController: UIViewController {",
      "    #if DEBUG",
      "    let limit = 3",
      "    #endif",
      "    @objc(presentThread:)",
      "    func presentView(_ thread: Thread) {",
      '        let detail = DetailViewController(title: "x")',
      "        print(detail)",
      "        reload()",
      "    }",
      "    func reload() {}",
      "}",
    ];
    const OBJC = [
      '#import "Inbox.h"',
      "@implementation Inbox",
      "- (void)openThread:(NSString *)name {",
      "    char c = 'a';",
      "    if (self.ready == YES) { [self show:name]; }",
      "}",
      "@end",
    ];
    const view = (path: string, text: string[]) => ({
      path,
      status: "modified" as const,
      lines: text.map((t, i) => row(i === 2 ? "add" : "ctx", i + 1, t)),
    });
    let html = "";
    beforeAll(async () => {
      const result: AnalysisResult = {
        base: sha("a"),
        head: sha("b"),
        symbols: [],
        nodes: [],
        edges: [],
        files: [view("App/Inbox.swift", SWIFT), view("App/Inbox.m", OBJC)],
        // What the analysis found the repo defines (see AnalyzeRangeUseCase): the rest is a library's.
        names: ["DetailViewController", "InboxViewController", "presentView", "reload"],
      };
      html = renderHtml(result, [new TreeSitterHighlighter(await TreeSitterEngine.load())]);
    });

    const SWIFT_WORDS: [string, keyof typeof XCODE_DARK][] = [
      ["import", "keyword"],
      ["func", "keyword"],
      ["// MARK: - Inbox", "mark"],
      ["https://example.com/help", "url"],
      ["InboxViewController", "typeDeclaration"],
      ["UIViewController", "otherType"],
      ["#if", "preprocessor"],
      ["3", "number"],
      ["@objc(presentThread:)", "attribute"],
      ["presentView", "otherDeclaration"],
      ["Thread", "otherType"],
      ["DetailViewController", "projectType"],
      ['"x"', "string"],
      ["print", "otherFunction"],
      ["reload", "projectFunction"],
    ];
    const OBJC_WORDS: [string, keyof typeof XCODE_DARK][] = [
      ["#import", "preprocessor"],
      ['"Inbox.h"', "string"],
      ["@implementation", "keyword"],
      ["Inbox", "typeDeclaration"],
      ["void", "keyword"],
      ["openThread", "otherDeclaration"],
      ["NSString", "otherType"],
      ["'a'", "character"],
      ["self", "keyword"],
      ["YES", "keyword"],
      ["show", "otherFunction"],
      ["@end", "keyword"],
    ];

    for (const palette of ["light", "dark"] as const) {
      const colours = palette === "dark" ? XCODE_DARK : XCODE_LIGHT;
      it(`Swift, ${palette}`, () => {
        for (const [word, key] of SWIFT_WORDS) expect([word, colourOf(classesOf(html, word), palette)]).toEqual([word, colours[key]]);
        // The documentation comment around the address, in Helvetica like Xcode's.
        expect(html).toMatch(/<span class="tk-comment tk-doc">\/\/\/ Opens a thread\. See <span class="tk-url">/);
      });
      it(`Objective-C, ${palette}`, () => {
        for (const [word, key] of OBJC_WORDS) expect([word, colourOf(classesOf(html, word), palette)]).toEqual([word, colours[key]]);
      });
    }
  });
});

describe("a usage written with the name Objective-C sees (roadmap 39)", () => {
  // Objective-C calls `@objc(presentThread:) func presentView` as presentThread: that is the word to underline there.
  const result: AnalysisResult = {
    base: sha("a"),
    head: sha("b"),
    symbols: [],
    files: [
      {
        path: "App/List.swift",
        status: "modified",
        lines: [row("ctx", 1, "class List {"), row("ctx", 2, "  @objc(presentThread:)"), row("ctx", 3, "  func presentView(_ thread: Thread) {"), row("add", 4, "    print(thread)"), row("ctx", 5, "  }"), row("ctx", 6, "  func close() {}"), row("ctx", 7, "}")],
      },
      { path: "App/Inbox.m", status: "modified", lines: [row("ctx", 1, "- (void)open:(List *)list {"), row("add", 2, "    [list presentThread:nil];"), row("ctx", 3, "}")] },
    ],
    nodes: [
      node("App/List.swift#List.presentView(_:)", { changed: true, status: "modified", kind: "method", line: 2, endLine: 5, objcNames: ["presentThread"] }),
      node("App/List.swift#List.close", { changed: true, status: "modified", kind: "method", line: 6, endLine: 6 }),
      node("App/Inbox.m#Inbox.open(_:)", { kind: "method", line: 1, endLine: 3 }),
    ],
    edges: [{ from: "App/Inbox.m#Inbox.open(_:)", to: "App/List.swift#List.presentView(_:)", kind: "calls", sites: [{ line: 2, text: "    [list presentThread:nil];" }] }],
  };
  const page = renderHtml(result);

  it("tells the page those words, and the page tries them after the symbol's own name", () => {
    const syms = pageData(page).syms as { name: string; written?: string[] }[];
    expect(syms.map((s) => [s.name, s.written])).toEqual([
      ["List.presentView(_:)", ["presentThread"]],
      ["List.close", undefined],
    ]);
    expect(page).toContain("syms[k].written");
  });
});
