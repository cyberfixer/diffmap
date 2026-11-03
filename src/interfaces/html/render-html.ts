import type { AnalysisResult } from "../../domain/analysis-result.js";
import type { GraphNode } from "../../domain/graph.js";
import type { DiffLine } from "../../domain/symbol.js";
import { MAX_DIFF_LINES, layoutGraph, type Box } from "./layout.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderDiff(lines: DiffLine[]): string {
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const rows = shown.map((l) => {
    const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
    const num = l.type === "del" ? l.oldLine : l.newLine;
    return `<div class="dl ${l.type}"><span class="ln">${num ?? ""}</span><span class="sg">${sign}</span><span class="tx">${esc(l.text)}</span></div>`;
  });
  if (lines.length > MAX_DIFF_LINES) {
    rows.push(`<div class="dl more">… ${lines.length - MAX_DIFF_LINES} more lines</div>`);
  }
  return `<div class="diff">${rows.join("")}</div>`;
}

function renderNode(n: GraphNode, box: Box, index: number, diff: DiffLine[]): string {
  const cls = ["node", n.changed ? `changed ${n.status}` : "context"].join(" ");
  const badge = n.changed ? `<span class="badge">${n.status}</span>` : "";
  const labels = n.labels.length
    ? `<div class="labels">${n.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join("")}</div>`
    : "";
  const body = n.changed && diff.length > 0 ? renderDiff(diff) : "";
  return `<div class="${cls}" id="n${index}" data-i="${index}" style="left:${box.x}px;top:${box.y}px;width:${box.w}px">
  <div class="head" style="height:${box.headH}px">
    <div class="row1">${badge}<span class="name" title="${esc(n.name)}">${esc(n.name)}</span></div>
    <div class="row2">${esc(n.kind)} · ${esc(n.file)}</div>
    ${labels}
  </div>${body}
</div>`;
}

function edgePath(from: Box, to: Box): string {
  const x1 = from.x + from.w;
  const y1 = from.y + from.headH / 2;
  const x2 = to.x;
  const y2 = to.y + to.headH / 2;
  const dx = Math.max(50, Math.abs(x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

/** Render an AnalysisResult as one self-contained, interactive HTML map. */
export function renderHtml(result: AnalysisResult): string {
  const diffs = new Map<string, DiffLine[]>(result.symbols.map((s) => [s.id, s.diff]));
  const layout = layoutGraph(result.nodes, result.edges, diffs);
  const index = new Map(result.nodes.map((n, i) => [n.id, i]));

  const nodesHtml = result.nodes
    .map((n, i) => renderNode(n, layout.boxes.get(n.id)!, i, diffs.get(n.id) ?? []))
    .join("\n");

  const edgesHtml = result.edges
    .filter((e) => layout.boxes.has(e.from) && layout.boxes.has(e.to))
    .map((e) => {
      const hot = result.nodes[index.get(e.from)!].changed || result.nodes[index.get(e.to)!].changed;
      const cls = e.kind === "calls-removed" ? "edge removed-call" : hot ? "edge hot" : "edge";
      const marker = e.kind === "calls-removed" ? "arrow-red" : "arrow";
      return `<path class="${cls}" data-from="${index.get(e.from)}" data-to="${index.get(e.to)}" d="${edgePath(layout.boxes.get(e.from)!, layout.boxes.get(e.to)!)}" marker-end="url(#${marker})"/>`;
    })
    .join("\n");

  const count = (s: string): number => result.nodes.filter((n) => n.status === s).length;
  const context = result.nodes.filter((n) => !n.changed).length;
  const brokenCalls = result.edges.filter((e) => e.kind === "calls-removed");

  const warning = brokenCalls.length
    ? `<div class="warn">⚠ ${brokenCalls.length === 1 ? "1 call still points" : brokenCalls.length + " calls still point"} at removed code (red dashed arrows)</div>`
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
          --add-bg:#dafbe1; --del-bg:#ffebe9; --ctx-bg:transparent; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --card:#161b22; --line:#30363d; --edge:#6e7681;
            --added:#3fb950; --removed:#f85149; --modified:#d29922;
            --add-bg:#12301a; --del-bg:#3d1518; --ctx-bg:transparent; }
  }
  * { box-sizing:border-box; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:14px/1.4 system-ui,sans-serif; }
  header { position:fixed; top:0; left:0; right:0; z-index:5; display:flex; flex-wrap:wrap; gap:8px 16px;
           align-items:center; padding:10px 16px; background:var(--bg); border-bottom:1px solid var(--line); }
  header h1 { font-size:15px; margin:0; }
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
  #cv { position:absolute; left:0; top:0; transform-origin:0 0; width:${layout.width}px; height:${layout.height}px; }
  svg { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; }
  .edge { fill:none; stroke:var(--edge); stroke-width:1.2; opacity:.5; }
  .edge.hot { opacity:.95; stroke-width:1.8; }
  .edge.removed-call { stroke:var(--removed); stroke-dasharray:6 4; stroke-width:2; opacity:1; }
  #arrow path { fill:var(--edge); } #arrow-red path { fill:var(--removed); }
  .node { position:absolute; background:var(--card); border:1px solid var(--line); border-radius:8px;
          overflow:hidden; transition:opacity .15s; }
  .node.changed { border-width:2px; border-color:var(--c); }
  .node.added { --c:var(--added); } .node.modified { --c:var(--modified); } .node.removed { --c:var(--removed); }
  .node.context { opacity:.8; }
  .head { padding:7px 12px; cursor:pointer; overflow:hidden; }
  .row1 { display:flex; gap:8px; align-items:baseline; }
  .name { font:600 13px ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { font-size:10px; text-transform:uppercase; font-weight:700; color:#fff; background:var(--c);
           padding:1px 6px; border-radius:4px; flex:none; }
  .row2 { color:var(--muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .labels { margin-top:3px; white-space:nowrap; overflow:hidden; }
  .chip { font:11px ui-monospace,monospace; background:var(--bg); border:1px solid var(--line);
          border-radius:4px; padding:0 5px; margin-right:4px; color:var(--muted); }
  .diff { border-top:1px solid var(--line); padding:8px 0; background:var(--bg); overflow-x:auto; }
  .node.collapsed .diff { display:none; }
  .dl { display:flex; font:12px/17px ui-monospace,monospace; white-space:pre; min-width:max-content; }
  .dl.add { background:var(--add-bg); } .dl.del { background:var(--del-bg); }
  .ln { width:40px; text-align:right; padding-right:8px; color:var(--muted); flex:none; user-select:none; }
  .sg { width:14px; flex:none; user-select:none; }
  .dl.add .sg { color:var(--added); } .dl.del .sg { color:var(--removed); }
  .dl.more { color:var(--muted); padding-left:62px; }
  .dim { opacity:.18 !important; }
  .empty { position:fixed; top:120px; left:0; right:0; text-align:center; color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>gitmap</h1>
  <span class="meta">${esc(result.base.slice(0, 10))} → ${esc(result.head.slice(0, 10))}</span>
  <span class="pill added"><b>${count("added")}</b> added</span>
  <span class="pill modified"><b>${count("modified")}</b> modified</span>
  <span class="pill removed"><b>${count("removed")}</b> removed</span>
  <span class="pill"><b>${context}</b> neighbours</span>
  <span class="tools"><button id="fit">Fit</button> <button id="zin">+</button> <button id="zout">−</button></span>
  <span class="hint">arrow = “calls” · drag to pan · scroll to zoom · click a header to fold its diff · hover to trace</span>
  ${warning}
</header>
<div id="vp">
  <div id="cv">
    <svg width="${layout.width}" height="${layout.height}">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>
        <marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker>
      </defs>
      ${edgesHtml}
    </svg>
    ${nodesHtml}
  </div>
</div>
${empty}
<script>
(function () {
  var vp = document.getElementById('vp'), cv = document.getElementById('cv');
  var W = ${layout.width}, s = 1, tx = 0, ty = 0;
  function apply() { cv.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')'; }
  function fit() {
    s = Math.max(0.25, Math.min(1, (vp.clientWidth - 40) / W));
    tx = 20; ty = 80; apply();
  }
  function zoom(f, cx, cy) {
    var ns = Math.max(0.15, Math.min(2.5, s * f));
    tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns; apply();
  }
  vp.addEventListener('wheel', function (e) {
    if (e.shiftKey && e.target.closest('.diff')) return;
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
  window.addEventListener('pointerup', function () { drag = null; vp.classList.remove('drag'); });
  document.getElementById('fit').onclick = fit;
  document.getElementById('zin').onclick = function () { zoom(1.2, vp.clientWidth / 2, vp.clientHeight / 2); };
  document.getElementById('zout').onclick = function () { zoom(1 / 1.2, vp.clientWidth / 2, vp.clientHeight / 2); };

  var nodes = [].slice.call(document.querySelectorAll('.node'));
  var edges = [].slice.call(document.querySelectorAll('.edge'));
  nodes.forEach(function (n) {
    n.querySelector('.head').addEventListener('click', function () {
      if (!drag || !drag.moved) n.classList.toggle('collapsed');
    });
    n.addEventListener('mouseenter', function () {
      var i = n.dataset.i, keep = {}; keep[i] = true;
      edges.forEach(function (e) {
        var hit = e.dataset.from === i || e.dataset.to === i;
        if (hit) { keep[e.dataset.from] = true; keep[e.dataset.to] = true; }
        e.classList.toggle('dim', !hit);
      });
      nodes.forEach(function (m) { m.classList.toggle('dim', !keep[m.dataset.i]); });
    });
    n.addEventListener('mouseleave', function () {
      edges.concat(nodes).forEach(function (x) { x.classList.remove('dim'); });
    });
  });
  fit();
})();
</script>
</body>
</html>
`;
}
