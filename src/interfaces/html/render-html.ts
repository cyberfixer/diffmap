import type { AnalysisResult } from "../../domain/analysis-result.js";
import type { GraphNode } from "../../domain/graph.js";
import type { DiffLine } from "../../domain/symbol.js";
import { layoutWindows, MARGIN, type WindowSpec } from "./layout.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const expandTabs = (s: string): string => s.replace(/\t/g, "  ");

// Rough monospace character widths (px) used only to size windows to their code.
const CODE_CHAR = 7.4;
const NAME_CHAR = 7.8;
const CODE_GUTTER = 80; // line-number column, sign column and padding
const MIN_W = 360;
const MAX_W = 760;

const dedupeKey = (l: DiffLine): string => `${l.type}:${l.oldLine}:${l.newLine}`;

/**
 * A class's own diff range contains the diffs of its methods. Show only the
 * lines that belong to no other changed symbol in the same file, so code
 * appears once.
 */
function ownDiff(node: GraphNode, diff: DiffLine[], siblings: GraphNode[], diffs: Map<string, DiffLine[]>): DiffLine[] {
  if (node.kind !== "class") return diff;
  const claimed = new Set<string>();
  for (const sib of siblings) {
    if (sib.id === node.id || !sib.changed || sib.kind === "class") continue;
    for (const l of diffs.get(sib.id) ?? []) claimed.add(dedupeKey(l));
  }
  const rest = diff.filter((l) => !claimed.has(dedupeKey(l)));
  return rest.some((l) => l.type !== "ctx") ? rest : [];
}

function renderDiff(lines: DiffLine[]): string {
  const rows = lines.map((l) => {
    const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
    const num = l.type === "del" ? l.oldLine : l.newLine;
    return `<div class="dl ${l.type}"><span class="ln">${num ?? ""}</span><span class="sg">${sign}</span><span class="tx">${esc(expandTabs(l.text))}</span></div>`;
  });
  return `<div class="diff">${rows.join("")}</div>`;
}

function renderSymbol(n: GraphNode, idx: number, diff: DiffLine[]): string {
  const badge = n.changed ? `<span class="badge">${n.status}</span>` : "";
  // Decorators collapse into one faint inline hint instead of their own row of chips.
  const deco = n.labels.length
    ? `<span class="deco" title="${esc(n.labels.join(" "))}">${esc(n.labels.join(" "))}</span>`
    : "";
  const cls = n.changed ? `sym changed ${n.status}` : "sym context";
  const body = n.changed && diff.length > 0 ? renderDiff(diff) : "";
  return `<div class="${cls}" id="s${idx}" data-s="${idx}">
    <div class="srow">${badge}<span class="name" title="${esc(n.name)}">${esc(n.name)}</span>${deco}</div>${body}
  </div>`;
}

function windowWidth(nodes: GraphNode[], diffs: Map<string, DiffLine[]>): number {
  let w = 0;
  for (const n of nodes) {
    const nameW = n.name.length * NAME_CHAR + (n.changed ? 110 : 40);
    w = Math.max(w, nameW);
    if (n.changed) {
      for (const l of diffs.get(n.id) ?? []) {
        w = Math.max(w, expandTabs(l.text).length * CODE_CHAR + CODE_GUTTER);
      }
    }
  }
  return Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));
}

function edgeClass(kind: string, hot: boolean): string {
  return kind === "calls-removed" ? "edge removed-call" : hot ? "edge hot" : "edge";
}

/** Render an AnalysisResult as one self-contained, interactive HTML map. */
export function renderHtml(result: AnalysisResult): string {
  const diffs = new Map<string, DiffLine[]>(result.symbols.map((s) => [s.id, s.diff]));
  const symIndex = new Map(result.nodes.map((n, i) => [n.id, i]));

  // One window per file.
  const files = new Map<string, GraphNode[]>();
  for (const n of result.nodes) {
    const list = files.get(n.file) ?? [];
    list.push(n);
    files.set(n.file, list);
  }
  const fileIds = [...files.keys()].sort();
  const winIdx = new Map(fileIds.map((f, i) => [f, i]));

  const shown = new Map<string, DiffLine[]>();
  for (const n of result.nodes) {
    shown.set(n.id, ownDiff(n, diffs.get(n.id) ?? [], files.get(n.file)!, diffs));
  }

  const specs: WindowSpec[] = fileIds.map((f) => ({
    id: f,
    width: windowWidth(files.get(f)!, shown),
  }));
  const fileEdges = result.edges.flatMap((e) => {
    const a = result.nodes[symIndex.get(e.from) ?? -1];
    const b = result.nodes[symIndex.get(e.to) ?? -1];
    return a && b && a.file !== b.file ? [{ from: a.file, to: b.file }] : [];
  });
  const layout = layoutWindows(specs, fileEdges);

  const windowsHtml = fileIds
    .map((file) => {
      const nodes = [...files.get(file)!].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
      const p = layout.placed.get(file)!;
      const slash = file.lastIndexOf("/");
      const dir = slash >= 0 ? file.slice(0, slash + 1) : "";
      const base = file.slice(slash + 1);
      const changedCount = nodes.filter((n) => n.changed).length;
      const meta = changedCount ? `${changedCount} changed` : "context";
      const body = nodes
        .map((n) => renderSymbol(n, symIndex.get(n.id)!, shown.get(n.id) ?? []))
        .join("\n");
      return `<section class="win ${changedCount ? "has-change" : "ctx-only"}" id="w${winIdx.get(file)}" data-col="${p.col}" data-order="${p.order}" style="left:${p.x}px;width:${p.width}px">
  <header class="wh"><span class="fname">${esc(base)}</span><span class="fdir">${esc(dir)}</span><span class="fmeta">${meta}</span></header>
  ${body}
</section>`;
    })
    .join("\n");

  const edgesHtml = result.edges
    .filter((e) => symIndex.has(e.from) && symIndex.has(e.to))
    .map((e) => {
      const hot = result.nodes[symIndex.get(e.from)!].changed || result.nodes[symIndex.get(e.to)!].changed;
      const marker = e.kind === "calls-removed" ? "arrow-red" : "arrow";
      return `<path class="${edgeClass(e.kind, hot)}" data-from="${symIndex.get(e.from)}" data-to="${symIndex.get(e.to)}" marker-end="url(#${marker})"/>`;
    })
    .join("\n");

  const count = (s: string): number => result.nodes.filter((n) => n.status === s).length;
  const neighbours = result.nodes.filter((n) => !n.changed).length;
  const broken = result.edges.filter((e) => e.kind === "calls-removed").length;
  const warning = broken
    ? `<div class="warn">⚠ ${broken === 1 ? "1 call still points" : broken + " calls still point"} at removed code (red dashed arrows)</div>`
    : "";
  const empty =
    result.nodes.length === 0
      ? `<p class="empty">No changed TypeScript symbols in this range.</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gitmap ${esc(result.base.slice(0, 7))}..${esc(result.head.slice(0, 7))}</title>
<style>
  :root { --bg:#ffffff; --fg:#1f2328; --muted:#656d76; --card:#f6f8fa; --line:#d0d7de; --edge:#8c959f;
          --added:#1a7f37; --removed:#cf222e; --modified:#9a6700;
          --add-bg:#dafbe1; --del-bg:#ffebe9; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --card:#161b22; --line:#30363d; --edge:#6e7681;
            --added:#3fb950; --removed:#f85149; --modified:#d29922;
            --add-bg:#12301a; --del-bg:#3d1518; }
  }
  * { box-sizing:border-box; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:14px/1.4 system-ui,sans-serif; }
  header.top { position:fixed; top:0; left:0; right:0; z-index:5; display:flex; flex-wrap:wrap; gap:8px 16px;
               align-items:center; padding:10px 16px; background:var(--bg); border-bottom:1px solid var(--line); }
  header.top h1 { font-size:15px; margin:0; }
  .meta { color:var(--muted); font:12px ui-monospace,monospace; }
  .pill { padding:2px 10px; border:1px solid var(--line); border-radius:999px; font-size:12px; }
  .pill b { color:var(--c, var(--fg)); }
  .pill.added { --c:var(--added); } .pill.modified { --c:var(--modified); } .pill.removed { --c:var(--removed); }
  .hint { color:var(--muted); font-size:12px; margin-left:auto; }
  .warn { width:100%; color:var(--removed); font-weight:600; font-size:13px; }
  .tools button { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:6px;
                  padding:2px 10px; cursor:pointer; font-size:13px; }
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
  .wh { display:flex; align-items:baseline; gap:8px; padding:7px 12px; border-bottom:1px solid var(--line);
        background:var(--bg); min-width:0; }
  .fname { font:700 13px ui-monospace,monospace; flex:none; }
  .fdir { color:var(--muted); font:11px ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; min-width:0; }
  .fmeta { margin-left:auto; color:var(--muted); font-size:11px; flex:none; }
  .sym { border-top:1px solid var(--line); }
  .wh + .sym { border-top:0; }
  .srow { display:flex; align-items:baseline; gap:8px; padding:6px 12px; cursor:default; min-width:0; }
  .sym.changed > .srow { cursor:pointer; border-left:4px solid var(--c); }
  .sym.changed.added { --c:var(--added); } .sym.changed.modified { --c:var(--modified); } .sym.changed.removed { --c:var(--removed); }
  .sym.context > .srow { padding-left:16px; color:var(--muted); }
  .name { font:600 13px ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:none; max-width:100%; }
  .sym.context .name { font-weight:500; }
  .badge { font-size:10px; text-transform:uppercase; font-weight:700; color:#fff; background:var(--c);
           padding:1px 6px; border-radius:4px; flex:none; }
  .deco { color:var(--muted); opacity:.75; font:11px ui-monospace,monospace; overflow:hidden;
          text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .diff { padding:6px 0; background:var(--bg); border-top:1px solid var(--line); }
  .sym.collapsed .diff { display:none; }
  .dl { display:flex; font:12px/17px ui-monospace,monospace; }
  .dl.add { background:var(--add-bg); } .dl.del { background:var(--del-bg); }
  .ln { width:40px; text-align:right; padding-right:8px; color:var(--muted); flex:none; user-select:none; }
  .sg { width:14px; flex:none; user-select:none; }
  .dl.add .sg { color:var(--added); } .dl.del .sg { color:var(--removed); }
  .tx { white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; flex:1; padding-right:10px; }
  .dim { opacity:.18 !important; }
  .empty { position:fixed; top:120px; left:0; right:0; text-align:center; color:var(--muted); }
</style>
</head>
<body>
<header class="top">
  <h1>gitmap</h1>
  <span class="meta">${esc(result.base.slice(0, 10))} → ${esc(result.head.slice(0, 10))}</span>
  <span class="pill added"><b>${count("added")}</b> added</span>
  <span class="pill modified"><b>${count("modified")}</b> modified</span>
  <span class="pill removed"><b>${count("removed")}</b> removed</span>
  <span class="pill"><b>${neighbours}</b> neighbours</span>
  <span class="tools"><button id="fit">Fit</button> <button id="zin">+</button> <button id="zout">−</button></span>
  <span class="hint">one window per file · arrow = “calls” · drag to pan · scroll to zoom · click a changed symbol to fold its diff · hover to trace</span>
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

  function anchor(idx, right) {
    var el = document.getElementById('s' + idx), win = el.closest('.win'), row = el.querySelector('.srow');
    return { x: win.offsetLeft + (right ? win.offsetWidth : 0), y: win.offsetTop + el.offsetTop + row.offsetHeight / 2,
             win: win };
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
    if (e.target.closest('.diff')) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty, moved: false };
    vp.classList.add('drag');
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    drag.moved = true; tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply();
  });
  window.addEventListener('pointerup', function () { vp.classList.remove('drag'); setTimeout(function () { drag = null; }, 0); });
  document.getElementById('fit').onclick = fit;
  document.getElementById('zin').onclick = function () { zoom(1.2, vp.clientWidth / 2, vp.clientHeight / 2); };
  document.getElementById('zout').onclick = function () { zoom(1 / 1.2, vp.clientWidth / 2, vp.clientHeight / 2); };

  var syms = [].slice.call(document.querySelectorAll('.sym'));
  syms.forEach(function (n) {
    var row = n.querySelector('.srow');
    if (n.classList.contains('changed') && n.querySelector('.diff')) {
      row.addEventListener('click', function () {
        if (drag && drag.moved) return;
        n.classList.toggle('collapsed'); relayout();
      });
    }
    n.addEventListener('mouseenter', function () {
      var i = n.dataset.s, keep = {}; keep[i] = true;
      edges.forEach(function (e) {
        var hit = e.dataset.from === i || e.dataset.to === i;
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
