import { extname } from "node:path";
import type { SyntaxHighlighterPort, HighlightToken } from "../../application/ports/syntax-highlighter.port.js";
import type { AnalysisResult } from "../../domain/analysis-result.js";
import type { FileView } from "../../domain/file-view.js";
import type { GraphNode } from "../../domain/graph.js";
import type { DiffLine } from "../../domain/symbol.js";
import { layoutWindows, MARGIN, type WindowSpec } from "./layout.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const expandTabs = (s: string): string => s.replace(/\t/g, "  ");

// Rough monospace character widths (px) used only to size windows to their code.
const CODE_CHAR = 7.4;
const NAME_CHAR = 7.8;
const CODE_GUTTER = 96; // line number, dot and sign columns plus padding
const MIN_W = 360;
const MAX_W = 760;
/** Unchanged lines within this distance of a change stay visible in "only changes" mode. */
const NEAR = 3;

function windowWidth(view: FileView | undefined, nodes: GraphNode[]): number {
  let w = 0;
  for (const n of nodes) w = Math.max(w, n.name.length * NAME_CHAR + 70);
  for (const l of view?.lines ?? []) {
    w = Math.max(w, expandTabs(l.text).length * CODE_CHAR + CODE_GUTTER);
  }
  return Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));
}

interface Row {
  line: DiffLine;
  anchors: number[]; // indexes of graph nodes that start on this row
  tokens?: HighlightToken[]; // syntax-coloured text, when a highlighter supports the file
}

/**
 * Colour a file view. Added lines come from the new file and removed lines from
 * the old one, so each version is tokenized as its own whole document (this keeps
 * multi-line comments and template strings right); unchanged lines are in both.
 */
function highlightRows(view: FileView, hl: SyntaxHighlighterPort): HighlightToken[][] | null {
  const headAt: number[] = [];
  const baseAt: number[] = [];
  view.lines.forEach((l, i) => {
    if (l.type !== "del") headAt.push(i);
    if (l.type !== "add") baseAt.push(i);
  });
  const head = hl.highlight(view.path, headAt.map((i) => view.lines[i].text));
  const base = hl.highlight(view.path, baseAt.map((i) => view.lines[i].text));
  if (!head || !base) return null;

  const out: HighlightToken[][] = new Array(view.lines.length);
  headAt.forEach((i, k) => (out[i] = head[k]));
  baseAt.forEach((i, k) => {
    if (view.lines[i].type === "del") out[i] = base[k];
  });
  return out;
}

const renderText = (r: Row): string =>
  r.tokens
    ? r.tokens
        .map((t) =>
          t.kind === "plain"
            ? esc(expandTabs(t.text))
            : `<span class="tk-${t.kind}">${esc(expandTabs(t.text))}</span>`
        )
        .join("")
    : esc(expandTabs(r.line.text));

/** Find the row where a symbol starts (deleted symbols start on a deleted row). */
function rowFor(rows: Row[], n: GraphNode): number {
  const want = n.status === "removed" ? "del" : null;
  const idx = rows.findIndex((r) =>
    want
      ? r.line.type === "del" && r.line.oldLine === n.line
      : r.line.type !== "del" && r.line.newLine === n.line
  );
  return idx >= 0 ? idx : 0;
}

function renderCode(rows: Row[], connected: Set<number>): string {
  // Mark which rows stay visible in "only changes" mode.
  const near = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    const keep = r.line.type !== "ctx" || r.anchors.some((a) => connected.has(a));
    if (!keep) return;
    for (let j = Math.max(0, i - NEAR); j <= Math.min(rows.length - 1, i + NEAR); j++) near[j] = true;
  });

  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    if (!near[i]) {
      let j = i;
      while (j < rows.length && !near[j]) j++;
      out.push(`<div class="dl gap">⋯ ${j - i} unchanged line${j - i === 1 ? "" : "s"}</div>`);
      for (; i < j; i++) out.push(renderRow(rows[i], connected, true));
      continue;
    }
    out.push(renderRow(rows[i], connected, false));
    i++;
  }
  return `<div class="code">${out.join("")}</div>`;
}

function renderRow(r: Row, connected: Set<number>, far: boolean): string {
  const l = r.line;
  const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
  const num = l.type === "del" ? l.oldLine : l.newLine;
  const live = r.anchors.filter((a) => connected.has(a));
  const cls = ["dl", l.type, far ? "far" : "", live.length ? "anchor" : ""].filter(Boolean).join(" ");
  const id = r.anchors.length ? ` id="s${r.anchors[0]}"` : "";
  const ss = live.length ? ` data-ss="${live.join(" ")}"` : "";
  const aliases = r.anchors
    .slice(1)
    .map((a) => `<span class="alias" id="s${a}"></span>`)
    .join("");
  return `<div class="${cls}"${id}${ss}><span class="ln">${num ?? ""}</span><span class="dot"></span><span class="sg">${sign}</span><span class="tx">${renderText(r)}${aliases}</span></div>`;
}

/** Context-only files (unchanged callers/callees) stay compact: names only. */
function renderCompact(nodes: GraphNode[], idx: Map<string, number>, connected: Set<number>): string {
  return nodes
    .map((n) => {
      const i = idx.get(n.id)!;
      const deco = n.labels.length
        ? `<span class="deco" title="${esc(n.labels.join(" "))}">${esc(n.labels.join(" "))}</span>`
        : "";
      const hover = connected.has(i) ? ` data-ss="${i}"` : "";
      return `<div class="sym${connected.has(i) ? " anchor" : ""}" id="s${i}"${hover}><div class="srow"><span class="name" title="${esc(n.name)}">${esc(n.name)}</span>${deco}</div></div>`;
    })
    .join("\n");
}

/** Render an AnalysisResult as one self-contained, interactive HTML map. */
export function renderHtml(
  result: AnalysisResult,
  highlighters: SyntaxHighlighterPort[] = []
): string {
  const symIndex = new Map(result.nodes.map((n, i) => [n.id, i]));
  const views = new Map<string, FileView>((result.files ?? []).map((f) => [f.path, f]));

  const connected = new Set<number>();
  for (const e of result.edges) {
    const a = symIndex.get(e.from);
    const b = symIndex.get(e.to);
    if (a !== undefined && b !== undefined) {
      connected.add(a);
      connected.add(b);
    }
  }

  const nodesByFile = new Map<string, GraphNode[]>();
  for (const n of result.nodes) {
    const list = nodesByFile.get(n.file) ?? [];
    list.push(n);
    nodesByFile.set(n.file, list);
  }
  const fileIds = [...new Set([...nodesByFile.keys(), ...views.keys()])].sort();
  const winIdx = new Map(fileIds.map((f, i) => [f, i]));

  const specs: WindowSpec[] = fileIds.map((f) => ({
    id: f,
    width: windowWidth(views.get(f), views.has(f) ? [] : nodesByFile.get(f) ?? []),
  }));
  const fileEdges = result.edges.flatMap((e) => {
    const a = result.nodes[symIndex.get(e.from) ?? -1];
    const b = result.nodes[symIndex.get(e.to) ?? -1];
    return a && b && a.file !== b.file ? [{ from: a.file, to: b.file }] : [];
  });
  const layout = layoutWindows(specs, fileEdges);

  let addedLines = 0;
  let removedLines = 0;

  const windowsHtml = fileIds
    .map((file) => {
      const view = views.get(file);
      const nodes = [...(nodesByFile.get(file) ?? [])].sort(
        (a, b) => a.line - b.line || a.name.localeCompare(b.name)
      );
      const p = layout.placed.get(file)!;
      const slash = file.lastIndexOf("/");
      const dir = slash >= 0 ? file.slice(0, slash + 1) : "";
      const base = file.slice(slash + 1);

      let meta = "context";
      let body: string;
      if (view) {
        const hl = highlighters.find((h) => h.supportedExtensions.includes(extname(file)));
        const tokens = hl ? highlightRows(view, hl) : null;
        const rows: Row[] = view.lines.map((line, i) => ({ line, anchors: [], tokens: tokens?.[i] }));
        for (const n of nodes) rows[rowFor(rows, n)]?.anchors.push(symIndex.get(n.id)!);
        const add = view.lines.filter((l) => l.type === "add").length;
        const del = view.lines.filter((l) => l.type === "del").length;
        addedLines += add;
        removedLines += del;
        meta = `<span class="m-add">+${add}</span> <span class="m-del">−${del}</span>`;
        body = renderCode(rows, connected);
      } else {
        body = renderCompact(nodes, symIndex, connected);
      }

      return `<section class="win ${view ? "has-change" : "ctx-only"}" id="w${winIdx.get(file)}" data-col="${p.col}" data-order="${p.order}" style="left:${p.x}px;width:${p.width}px">
  <header class="wh"><span class="fpath" title="${esc(file)}"><span class="fdir">${esc(dir)}</span><span class="fname">${esc(base)}</span></span><button class="copy" type="button" data-path="${esc(file)}" title="Copy path" aria-label="Copy path ${esc(file)}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.78.78 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .14.11.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Zm5-5C5 .78 5.78 0 6.75 0h7.5C15.22 0 16 .78 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .14.11.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg><span class="copy-label">Copy</span></button><span class="fmeta">${meta}</span></header>
  ${body}
</section>`;
    })
    .join("\n");

  const edgesHtml = result.edges
    .filter((e) => symIndex.has(e.from) && symIndex.has(e.to))
    .map((e) => {
      const hot = result.nodes[symIndex.get(e.from)!].changed || result.nodes[symIndex.get(e.to)!].changed;
      const cls = e.kind === "calls-removed" ? "edge removed-call" : hot ? "edge hot" : "edge";
      const marker = e.kind === "calls-removed" ? "arrow-red" : "arrow";
      return `<path class="${cls}" data-from="${symIndex.get(e.from)}" data-to="${symIndex.get(e.to)}" marker-end="url(#${marker})"/>`;
    })
    .join("\n");

  const changedSymbols = result.nodes.filter((n) => n.changed).length;
  const broken = result.edges.filter((e) => e.kind === "calls-removed").length;
  const warning = broken
    ? `<div class="warn">⚠ ${broken === 1 ? "1 call still points" : broken + " calls still point"} at removed code (red dashed arrows)</div>`
    : "";
  const empty =
    fileIds.length === 0 ? `<p class="empty">No changed TypeScript files in this range.</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gitmap ${esc(result.base.slice(0, 7))}..${esc(result.head.slice(0, 7))}</title>
<style>
  :root { --tk-keyword:#cf222e; --tk-string:#0a3069; --tk-comment:#6e7781; --tk-number:#0550ae;
          --tk-function:#8250df; --tk-type:#953800; --tk-decorator:#116329;
          --bg:#ffffff; --fg:#1f2328; --muted:#656d76; --card:#f6f8fa; --line:#d0d7de; --edge:#8c959f;
          --added:#1a7f37; --removed:#cf222e;
          --add-bg:#dafbe1; --add-ln:#aceebb; --del-bg:#ffebe9; --del-ln:#ffcecb; }
  @media (prefers-color-scheme: dark) {
    :root { --tk-keyword:#ff7b72; --tk-string:#a5d6ff; --tk-comment:#8b949e; --tk-number:#79c0ff;
            --tk-function:#d2a8ff; --tk-type:#ffa657; --tk-decorator:#7ee787;
            --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --card:#161b22; --line:#30363d; --edge:#6e7681;
            --added:#3fb950; --removed:#f85149;
            --add-bg:#12301a; --add-ln:#1b4a28; --del-bg:#3d1518; --del-ln:#5c1f24; }
  }
  * { box-sizing:border-box; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:14px/1.4 system-ui,sans-serif; }
  header.top { position:fixed; top:0; left:0; right:0; z-index:5; display:flex; flex-wrap:wrap; gap:8px 16px;
               align-items:center; padding:10px 16px; background:var(--bg); border-bottom:1px solid var(--line); }
  header.top h1 { font-size:15px; margin:0; }
  .meta { color:var(--muted); font:12px ui-monospace,monospace; }
  .legend { display:flex; gap:12px; font-size:12px; color:var(--muted); align-items:center; }
  .sw { display:inline-block; width:12px; height:12px; border-radius:3px; vertical-align:-2px; margin-right:4px; }
  .sw.add { background:var(--add-bg); border:1px solid var(--added); }
  .sw.del { background:var(--del-bg); border:1px solid var(--removed); }
  .hint { color:var(--muted); font-size:12px; margin-left:auto; }
  .warn { width:100%; color:var(--removed); font-weight:600; font-size:13px; }
  .tools button { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px;
                  padding:2px 10px; cursor:pointer; font-size:13px; }
  .tools button.on { background:var(--fg); color:var(--bg); }
  #vp { position:fixed; inset:0; overflow:hidden; cursor:grab; touch-action:none; }
  #vp.drag { cursor:grabbing; }
  #cv { position:absolute; left:0; top:0; transform-origin:0 0; width:${layout.width}px; }
  svg { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; }
  .edge { fill:none; stroke:var(--edge); stroke-width:1.2; opacity:.5; }
  .edge.hot { opacity:.95; stroke-width:1.8; }
  .edge.removed-call { stroke:var(--removed); stroke-dasharray:6 4; stroke-width:2; opacity:1; }
  #arrow path { fill:var(--edge); } #arrow-red path { fill:var(--removed); }
  .win { position:absolute; top:${MARGIN}px; background:var(--card); border:1px solid var(--line);
         border-radius:8px; overflow:hidden; transition:opacity .15s; }
  .win.ctx-only { opacity:.85; }
  .wh { display:flex; align-items:center; gap:8px; padding:7px 10px 7px 12px; border-bottom:1px solid var(--line);
        background:var(--bg); min-width:0; }
  /* The full path is always shown; long paths wrap rather than being cut off. */
  .fpath { font:12px/1.35 ui-monospace,monospace; overflow-wrap:anywhere; min-width:0; flex:1; }
  .fdir { color:var(--muted); }
  .fname { font-weight:700; color:var(--fg); }
  .copy { display:inline-flex; align-items:center; gap:4px; flex:none; border:1px solid var(--line);
          background:var(--card); color:var(--muted); border-radius:6px; padding:2px 7px; font-size:11px;
          cursor:pointer; }
  .copy:hover { color:var(--fg); border-color:var(--edge); }
  .copy.done { color:var(--added); border-color:var(--added); }
  .fmeta { color:var(--muted); font-size:11px; flex:none; }
  .m-add { color:var(--added); font-weight:600; } .m-del { color:var(--removed); font-weight:600; }
  .code { padding:4px 0; background:var(--bg); }
  .dl { display:flex; font:12px/17px ui-monospace,monospace; min-height:17px; }
  .dl.add { background:var(--add-bg); } .dl.del { background:var(--del-bg); }
  .ln { width:44px; text-align:right; padding-right:6px; color:var(--muted); flex:none; user-select:none; }
  .dl.add .ln { background:var(--add-ln); } .dl.del .ln { background:var(--del-ln); }
  .dot { width:12px; flex:none; text-align:center; font-size:8px; line-height:17px; color:var(--edge); user-select:none; }
  .dl.anchor .dot::before { content:"●"; }
  .dl.anchor { cursor:default; }
  .sg { width:12px; flex:none; user-select:none; }
  .dl.add .sg { color:var(--added); } .dl.del .sg { color:var(--removed); }
  .tx { white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; flex:1; padding-right:10px; }
  .tk-keyword { color:var(--tk-keyword); } .tk-string { color:var(--tk-string); }
  .tk-comment { color:var(--tk-comment); font-style:italic; } .tk-number { color:var(--tk-number); }
  .tk-function { color:var(--tk-function); } .tk-type { color:var(--tk-type); } .tk-decorator { color:var(--tk-decorator); }
  .alias { display:inline-block; width:0; height:0; }
  .dl.gap { display:none; color:var(--muted); padding-left:62px; font-style:italic; background:var(--card); }
  body.only .dl.gap { display:flex; }
  body.only .dl.far { display:none; }
  .sym { border-top:1px solid var(--line); }
  .wh + .sym { border-top:0; }
  .srow { display:flex; align-items:baseline; gap:8px; padding:6px 12px 6px 16px; min-width:0; color:var(--muted); }
  .name { font:500 13px ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:none; max-width:100%; }
  .deco { opacity:.75; font:11px ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .dim { opacity:.18 !important; }
  .empty { position:fixed; top:120px; left:0; right:0; text-align:center; color:var(--muted); }
</style>
</head>
<body>
<header class="top">
  <h1>gitmap</h1>
  <span class="meta">${esc(result.base.slice(0, 10))} → ${esc(result.head.slice(0, 10))}</span>
  <span class="legend">
    <span><span class="sw add"></span>added · <b>${addedLines}</b> lines</span>
    <span><span class="sw del"></span>removed · <b>${removedLines}</b> lines</span>
    <span>${[...views.keys()].length} files · ${changedSymbols} symbols changed</span>
  </span>
  <span class="tools"><button id="only">Only changes</button> <button id="fit">Fit</button> <button id="zin">+</button> <button id="zout">−</button></span>
  <span class="hint">whole files · ● = linked symbol, hover to trace · drag to pan · scroll to zoom</span>
  ${warning}
</header>
<div id="vp">
  <div id="cv">
    <svg id="sv" width="${layout.width}" height="400">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>
        <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>
      </defs>
      ${edgesHtml}
    </svg>
    ${windowsHtml}
  </div>
</div>
${empty}
<script>
(function () {
  var vp = document.getElementById('vp'), cv = document.getElementById('cv'), sv = document.getElementById('sv');
  var W = ${layout.width}, M = ${MARGIN}, GAP = 28, s = 1, tx = 0, ty = 0, H = 400;
  var wins = [].slice.call(document.querySelectorAll('.win'));
  var edges = [].slice.call(document.querySelectorAll('.edge'));

  function apply() { cv.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')'; }

  // Heights depend on wrapped text, so stack each column from measured sizes.
  function stack() {
    var cols = {};
    wins.forEach(function (w) { (cols[w.dataset.col] = cols[w.dataset.col] || []).push(w); });
    H = 0;
    Object.keys(cols).forEach(function (c) {
      cols[c].sort(function (a, b) { return a.dataset.order - b.dataset.order; });
      var y = M;
      cols[c].forEach(function (w) { w.style.top = y + 'px'; y += w.offsetHeight + GAP; });
      H = Math.max(H, y);
    });
    H += M - GAP;
    cv.style.height = H + 'px'; sv.setAttribute('height', H);
  }

  // Edge end point: first line of the row (code rows) or middle of the name row (compact).
  function anchor(idx, right) {
    var el = document.getElementById('s' + idx), r = el.closest('.dl, .sym'), win = el.closest('.win');
    var h = r.classList.contains('dl') ? 9 : r.querySelector('.srow').offsetHeight / 2;
    return { x: win.offsetLeft + (right ? win.offsetWidth : 0), y: win.offsetTop + r.offsetTop + h, win: win };
  }

  function draw() {
    edges.forEach(function (e) {
      var a = anchor(e.dataset.from, true), b = anchor(e.dataset.to, false), d;
      if (a.win === b.win) {            // call inside the same file: loop on the right edge
        var x = a.x + 46;
        d = 'M' + a.x + ',' + a.y + ' C' + x + ',' + a.y + ' ' + x + ',' + b.y + ' ' + a.x + ',' + b.y;
      } else {
        var dx = Math.max(50, Math.abs(b.x - a.x) / 2);
        d = 'M' + a.x + ',' + a.y + ' C' + (a.x + dx) + ',' + a.y + ' ' + (b.x - dx) + ',' + b.y + ' ' + b.x + ',' + b.y;
      }
      e.setAttribute('d', d);
    });
  }

  function relayout() { stack(); draw(); }

  function fit() {
    s = Math.max(0.25, Math.min(1, (vp.clientWidth - 40) / W));
    tx = 20; ty = 80; apply();
  }
  function zoom(f, cx, cy) {
    var ns = Math.max(0.15, Math.min(2.5, s * f));
    tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns; apply();
  }
  vp.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
  }, { passive: false });
  var drag = null;
  vp.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.tx, .fpath, button')) return;   // let people select code and paths, and click buttons
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    vp.classList.add('drag');
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply();
  });
  window.addEventListener('pointerup', function () { drag = null; vp.classList.remove('drag'); });
  document.getElementById('fit').onclick = fit;
  document.getElementById('zin').onclick = function () { zoom(1.2, vp.clientWidth / 2, vp.clientHeight / 2); };
  document.getElementById('zout').onclick = function () { zoom(1 / 1.2, vp.clientWidth / 2, vp.clientHeight / 2); };
  var only = document.getElementById('only');
  only.onclick = function () { document.body.classList.toggle('only'); only.classList.toggle('on'); relayout(); };

  // Copy a file's path. The Clipboard API can be unavailable (e.g. some file:// pages),
  // so fall back to selecting a hidden textarea.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  [].slice.call(document.querySelectorAll('.copy')).forEach(function (b) {
    var label = b.querySelector('.copy-label'), timer = null;
    b.addEventListener('click', function () {
      copyText(b.dataset.path).then(function (ok) {
        label.textContent = ok ? 'Copied' : 'Copy failed';
        b.classList.toggle('done', ok);
        clearTimeout(timer);
        timer = setTimeout(function () { label.textContent = 'Copy'; b.classList.remove('done'); }, 1400);
      });
    });
  });

  [].slice.call(document.querySelectorAll('[data-ss]')).forEach(function (n) {
    n.addEventListener('mouseenter', function () {
      var ids = n.dataset.ss.split(' '), keep = {};
      ids.forEach(function (i) { keep[i] = true; });
      edges.forEach(function (e) {
        var hit = ids.indexOf(e.dataset.from) >= 0 || ids.indexOf(e.dataset.to) >= 0;
        if (hit) { keep[e.dataset.from] = true; keep[e.dataset.to] = true; }
        e.classList.toggle('dim', !hit);
      });
      var live = {};
      Object.keys(keep).forEach(function (k) { live[document.getElementById('s' + k).closest('.win').id] = true; });
      wins.forEach(function (w) { w.classList.toggle('dim', !live[w.id]); });
    });
    n.addEventListener('mouseleave', function () {
      edges.concat(wins).forEach(function (x) { x.classList.remove('dim'); });
    });
  });

  relayout(); fit();
  window.addEventListener('load', relayout);
})();
</script>
</body>
</html>
`;
}
