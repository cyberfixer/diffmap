import type { ReviewActivity } from "../../application/use-cases/review-merge-request.js";
import type { RepoCacheUsage } from "../../infrastructure/git/git-repo-cache.js";
import { shell } from "./pages.js";

/** Everything the dashboard shows; also what GET /api/dashboard answers. */
export interface DashboardData {
  now: number;
  startedAt: number;
  hostName: string;
  hostUrl: string;
  mode: "full" | "view";
  node: string;
  memory: { rssBytes: number; heapBytes: number };
  signedIn: number;
  /** Analyses running and waiting for a worker; null when the service does not say. */
  workers: { running: number; waiting: number; max: number; memoryMb: number } | null;
  review: ReviewActivity;
  /** Room the projects' code takes on disk; null when the service does not say. */
  storage: RepoCacheUsage | null;
  counters: { mapsOpened: number; signIns: number };
  /** The newest lines of the service log, oldest first. */
  log: { at: number; text: string }[];
}

/**
 * What the service is doing: analyses running and waiting, the latest ones with
 * their times, memory, code on disk and the log. For the people in ADMIN_USERS
 * only, since it names projects and review titles. It asks for fresh numbers
 * every five seconds. Everything is put on the page as text, never as HTML:
 * titles and project names are written by other people.
 */
export function dashboardPage(data: DashboardData, refPrefix = "#"): string {
  return shell(
    "Dashboard · diffmap",
    `<style>
  body { align-items:flex-start; }
  .top { display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:4px 16px; margin-bottom:16px; }
  .top h1 { margin:0; }
  .top span { font-size:12px; color:var(--muted); }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; margin-bottom:24px; }
  .tile { border:1px solid var(--line); border-radius:6px; padding:10px 12px; background:var(--side); min-width:0; }
  .tile b { display:block; font-size:20px; line-height:1.25; font-weight:600; font-variant-numeric:tabular-nums; }
  .tile span { display:block; font-size:12px; color:var(--muted); }
  .tile small { display:block; font-size:12px; color:var(--muted); margin-top:2px; }
  h2 { font-size:13px; margin:24px 0 8px; }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:6px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  tr:last-child td { border-bottom:0; }
  th { font-size:12px; font-weight:600; color:var(--muted); background:var(--side); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.wrap { white-space:normal; min-width:180px; overflow-wrap:anywhere; }
  td .sub { display:block; font-size:12px; color:var(--muted); }
  .ok { color:var(--muted); }
  .bad { color:var(--err); font-weight:500; }
  .empty { padding:12px; color:var(--muted); font-size:13px; }
  .bar { height:4px; border-radius:2px; background:var(--line); overflow:hidden; margin-top:6px; }
  .bar i { display:block; height:4px; background:var(--accent); }
  pre { margin:0; padding:10px 12px; max-height:260px; overflow:auto; border:1px solid var(--line); border-radius:6px; background:var(--side);
        font:12px/1.5 'IBM Plex Mono', ui-monospace, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
  .foot a { color:var(--accent); }
</style>
<div class="top"><h1>Dashboard</h1><span id="fresh" aria-live="polite"></span></div>
<div class="tiles" id="tiles"></div>
<h2>Now</h2><div id="now"></div>
<h2>Latest analyses</h2><div id="recent"></div>
<h2>Code on disk</h2><div id="disk"></div>
<h2>Log</h2><pre id="log" tabindex="0" aria-label="Service log"></pre>
<div class="foot"><span id="about"></span><a href="/">Start page</a></div>
<script>
(function () {
  var data = ${JSON.stringify(data).replace(/</g, "\\u003c")};
  var refPrefix = ${JSON.stringify(refPrefix).replace(/</g, "\\u003c")};
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function dur(ms) {
    if (ms < 1000) return Math.round(ms) + ' ms';
    var s = ms / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ' + Math.round(s % 60) + ' s';
    var h = Math.floor(m / 60);
    return h < 48 ? h + ' h ' + (m % 60) + ' min' : Math.floor(h / 24) + ' days';
  }
  function ago(at, now) { return at ? dur(Math.max(0, now - at)) + ' ago' : 'never'; }
  function size(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  }
  function clock(at) { return new Date(at).toLocaleTimeString(); }
  function tile(value, label, note) {
    var t = el('div', 'tile');
    t.appendChild(el('b', '', value));
    t.appendChild(el('span', '', label));
    if (note) t.appendChild(el('small', '', note));
    return t;
  }
  function table(into, heads, rows, empty) {
    into.textContent = '';
    if (!rows.length) { into.appendChild(el('div', 'empty scroll', empty)); return; }
    var wrap = el('div', 'scroll'), t = el('table'), tr = el('tr');
    heads.forEach(function (h) { tr.appendChild(el('th', h[1] || '', h[0])); });
    t.appendChild(tr);
    rows.forEach(function (cells) {
      var r = el('tr');
      cells.forEach(function (c, i) {
        var td = el('td', heads[i][1] || '');
        if (c && c.nodeType) td.appendChild(c); else if (Array.isArray(c)) { td.appendChild(document.createTextNode(c[0])); var sub = el('span', 'sub', c[1]); sub.dir = 'auto'; td.appendChild(sub); } else td.textContent = c;
        r.appendChild(td);
      });
      t.appendChild(r);
    });
    wrap.appendChild(t); into.appendChild(wrap);
  }
  function review(a) { return [a.projectPath + ' ' + refPrefix + a.iid, a.title]; }
  function median(list) {
    if (!list.length) return null;
    var s = list.slice().sort(function (x, y) { return x - y; });
    return s[Math.floor(s.length / 2)];
  }

  function render(d) {
    var r = d.review, w = d.workers, tiles = $('tiles');
    tiles.textContent = '';
    var busy = w ? w.running : r.running.length;
    tiles.appendChild(tile(w ? busy + ' of ' + w.max : String(busy), 'analysing now', w && w.waiting ? w.waiting + ' waiting for a free slot' : 'none waiting'));
    tiles.appendChild(tile(String(r.totals.analysed), 'analyses since start', r.totals.failed ? r.totals.failed + ' failed' : 'none failed'));
    var times = r.recent.filter(function (a) { return a.ok; }).map(function (a) { return a.totalMs; });
    var mid = median(times);
    tiles.appendChild(tile(mid === null ? '–' : dur(mid), 'typical time to a map', times.length ? 'slowest ' + dur(Math.max.apply(null, times)) : 'no analysis yet'));
    tiles.appendChild(tile(String(d.counters.mapsOpened), 'maps opened', r.totals.servedFromMemory + ' without analysing again'));
    tiles.appendChild(tile(size(d.memory.rssBytes), 'memory in use', w ? 'each analysis up to ' + size(w.memoryMb * 1024 * 1024) : ''));
    tiles.appendChild(tile(String(d.signedIn), d.signedIn === 1 ? 'person signed in' : 'people signed in', d.counters.signIns + (d.counters.signIns === 1 ? ' sign-in' : ' sign-ins') + ' since start'));
    if (d.storage) {
      var s = d.storage, t = tile(size(s.totalBytes), 'code on disk', s.maxBytes ? 'limit ' + size(s.maxBytes) : 'no limit');
      if (s.maxBytes) { var bar = el('div', 'bar'), fill = el('i'); fill.style.width = Math.min(100, (s.totalBytes / s.maxBytes) * 100) + '%'; bar.appendChild(fill); t.appendChild(bar); }
      tiles.appendChild(t);
    }

    table($('now'), [['Review'], ['Step'], ['Progress', 'num'], ['Running for', 'num']], r.running.map(function (j) {
      return [review(j), [j.status.step, j.status.detail || ''], typeof j.status.percent === 'number' ? j.status.percent + '%' : '–', dur(d.now - j.status.startedAt)];
    }), 'Nothing is being analysed right now.');

    table($('recent'), [['Review'], ['Finished', 'num'], ['Total', 'num'], ['Getting the code', 'num'], ['Analysing', 'num'], ['Changed files', 'num'], ['Calls'], ['Result']], r.recent.map(function (a) {
      var result = el('span', a.ok ? 'ok' : 'bad', a.ok ? 'Ready' : 'Failed: ' + (a.error || 'unknown error'));
      return [review(a), ago(a.finishedAt, d.now), dur(a.totalMs), dur(a.downloadMs), a.ok ? dur(a.analysisMs) : '–',
        a.ok ? String(a.changedFiles) : '–', a.indexState === 'found' ? 'exact (index)' : a.ok ? 'by name' : '–', result];
    }), 'No analysis has finished since the service started.');
    var cells = $('recent').querySelectorAll('td:last-child');
    for (var i = 0; i < cells.length; i++) cells[i].className = 'wrap';

    table($('disk'), [['Project'], ['Size', 'num'], ['Last used', 'num']], d.storage ? d.storage.projects.map(function (p) {
      return [p.name, size(p.bytes), ago(p.lastUsed, d.now)];
    }) : [], d.storage ? 'No project has been downloaded yet.' : 'This service does not report its disk use.');

    var log = $('log'), atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    log.textContent = d.log.length ? d.log.map(function (l) { return clock(l.at) + '  ' + l.text; }).join('\\n') : 'Nothing logged yet.';
    if (atEnd) log.scrollTop = log.scrollHeight;

    $('about').textContent = d.hostName + ' ' + d.hostUrl + ' · ' + (d.mode === 'full' ? 'full mode' : 'view-only mode') + ' · up ' + dur(d.now - d.startedAt) +
      ' · ' + r.cached + ' of ' + r.maxCached + ' analyses kept in memory · Node ' + d.node;
    $('fresh').textContent = 'Updated ' + clock(Date.now());
  }

  function poll() {
    fetch('/api/dashboard', { credentials: 'same-origin' }).then(function (res) {
      if (res.status === 401 || res.status === 403) { location.reload(); return null; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (d) { if (d) render(d); }).catch(function () {
      $('fresh').textContent = 'Could not refresh; trying again';
    }).then(function () { setTimeout(poll, 5000); });
  }
  render(data);
  setTimeout(poll, 5000);
})();
</script>`,
    1080,
  );
}
