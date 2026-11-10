import type { Person } from "../../application/ports/merge-request.port.js";
import type { PreparingStatus } from "../../application/use-cases/review-merge-request.js";
import { THEME_BOOT, THEME_BUTTON } from "../html/theme.js";
import type { HostProfile } from "./host-profile.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const DARK = "--bg:#141413; --panel:#1B1B19; --side:#171715; --line:#2C2B28; --line-strong:#45443F; --fg:#ECEBE6; --muted:#A3A199; --hover:#282724; --accent:#7AA2F7; --err:#F28B82;";

const LOGO = `<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"></circle><circle cx="19" cy="6" r="2.5"></circle><circle cx="12" cy="18" r="2.5"></circle><path d="M7.5 6h9M6.5 8.2l4.2 7.6M17.5 8.2l-4.2 7.6"></path></svg>`;

/** A small centred page in the same look as the report. */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>${THEME_BOOT}</script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap">
<style>
  :root { --bg:#F6F6F3; --panel:#FFFFFF; --side:#FAFAF7; --line:#E4E3DD; --line-strong:#C9C8C1; --fg:#1C1C1A; --muted:#66655F; --hover:#EDECE7; --accent:#2457C5; --err:#8E1B12; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { ${DARK} }
  }
  :root[data-theme="dark"] { ${DARK} }
  :root { color-scheme: light dark; }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px;
         background:var(--bg); color:var(--fg); font:14px/1.5 'IBM Plex Sans', system-ui, sans-serif; }
  /* The same window look as the review page: a title bar on top of a plain panel. */
  main { width:100%; max-width:520px; background:var(--panel); border:1px solid var(--line-strong); border-radius:8px; overflow:hidden; }
  .brand { display:flex; align-items:center; gap:8px; min-height:44px; padding:6px 10px 6px 16px; font-weight:600; font-size:14px;
           background:var(--side); border-bottom:1px solid var(--line); }
  .brand svg { width:20px; height:20px; }
  .brand .theme { margin-left:auto; display:inline-flex; align-items:center; gap:6px; min-height:30px; padding:0 9px;
                  border:1px solid var(--line-strong); border-radius:6px; background:var(--panel); color:var(--muted);
                  font:13px 'IBM Plex Sans', system-ui, sans-serif; font-weight:400; cursor:pointer; }
  .brand .theme:hover { background:var(--hover); }
  .brand .theme svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .body { padding:24px 24px 28px; }
  h1 { font-size:18px; line-height:1.3; margin:0 0 8px; text-wrap:balance; }
  p { margin:0 0 16px; color:var(--muted); }
  label { display:block; font-size:12px; font-weight:600; margin-bottom:6px; }
  input { width:100%; min-height:38px; padding:0 10px; border:1px solid var(--line-strong); border-radius:6px;
          background:var(--bg); color:var(--fg); font:13px 'IBM Plex Mono', ui-monospace, monospace; }
  .btn { display:inline-flex; align-items:center; justify-content:center; min-height:38px; padding:0 16px; margin-top:14px;
         border:1px solid var(--fg); border-radius:6px; background:var(--fg); color:var(--panel); font:inherit; font-weight:500;
         text-decoration:none; cursor:pointer; }
  .btn:hover { opacity:.9; }
  .btn:focus-visible, input:focus-visible, .theme:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .foot { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:6px 16px; margin:24px -24px -28px; padding:8px 24px;
          background:var(--side); border-top:1px solid var(--line); font-size:12px; color:var(--muted); }
  .foot form { margin:0; }
  .foot button { border:0; background:none; color:var(--accent); font:inherit; cursor:pointer; padding:0; }
  code { font-family:'IBM Plex Mono', ui-monospace, monospace; font-size:12.5px; overflow-wrap:anywhere; }
  .err { color:var(--err); }
  a { color:var(--accent); }
</style>
</head>
<body><main><div class="brand">${LOGO}<span>diffmap</span>${THEME_BUTTON}</div><div class="body">${body}</div></main></body>
</html>`;
}

export function signInPage(host: HostProfile, returnTo: string, mode: "full" | "view" = "full", error = ""): string {
  if (mode === "full") {
    return shell(
      "Sign in · diffmap",
      `<h1>Review ${host.reviewName}s as a map</h1>
<p>Sign in with your ${host.name} account at <code>${esc(host.url)}</code>. diffmap only sees what you can see in ${host.name}.</p>
<a class="btn" href="/auth/login?returnTo=${encodeURIComponent(returnTo)}">Sign in with ${host.name}</a>`
    );
  }
  // View mode: no OAuth application; each person uses their own read-only token.
  return shell(
    "Sign in · diffmap",
    `<h1>Review ${host.reviewName}s as a map</h1>
<p>This diffmap is <b>view-only</b>. Sign in with a ${host.name} access token of your own; diffmap only sees what you can see in ${host.name}.</p>
<ol style="margin:0 0 16px; padding-left:20px; color:var(--muted)">
  <li><a href="${esc(host.token.createUrl)}" target="_blank" rel="noopener">Create a token in ${host.name}</a> (${esc(host.token.howTo)}).</li>
  <li>Paste it here. It stays in diffmap's memory only and is forgotten when you sign out.</li>
</ol>
<form method="post" action="/auth/token">
  <input type="hidden" name="returnTo" value="${esc(returnTo)}">
  <label for="t">${host.name} access token</label>
  <input id="t" name="token" type="password" required autocomplete="off" spellcheck="false" autofocus>
  ${error ? `<p class="err" style="margin:10px 0 0">${esc(error)}</p>` : ""}
  <button class="btn" type="submit">Sign in</button>
</form>`
  );
}

export function homePage(user: Person, host: HostProfile, error = ""): string {
  return shell(
    "diffmap",
    `<h1>Open a ${host.reviewName}</h1>
<p>Paste a ${host.reviewName} link from ${host.name}. Tip: you can also replace <code>${esc(host.url.replace(/^https?:\/\//, ""))}</code> with this site's address in any ${host.reviewName} URL.</p>
<form method="get" action="/go">
  <label for="u">${host.name} ${host.reviewName} link</label>
  <input id="u" name="url" required placeholder="${esc(host.example)}" autofocus>
  ${error ? `<p class="err" style="margin:10px 0 0">${esc(error)}</p>` : ""}
  <button class="btn" type="submit">Open map</button>
</form>
<div class="foot"><span>Signed in as <b>${esc(user.name)}</b> (@${esc(user.username)})</span>
<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></div>`
  );
}

export function errorPage(title: string, message: string, back = "/"): string {
  return shell(`${title} · diffmap`, `<h1>${esc(title)}</h1><p>${esc(message)}</p><a class="btn" href="${esc(back)}">Back</a>`);
}

/**
 * Shown while an MR's code downloads and is analysed. It asks the server for
 * progress about once a second and reloads into the map when it is ready.
 */
export function loadingPage(title: string, statusUrl: string, status: PreparingStatus): string {
  return shell(
    `${title} · diffmap`,
    `<style>
  .steps { list-style:none; padding:0; margin:20px 0 16px; display:flex; flex-direction:column; gap:10px; }
  .steps li { display:flex; align-items:center; gap:10px; color:var(--muted); }
  .steps li::before { content:""; width:12px; height:12px; border-radius:999px; border:2px solid var(--line-strong); flex:none; }
  .steps li.on { color:var(--fg); font-weight:500; }
  .steps li.on::before { border-color:var(--accent); background:var(--accent); animation:pulse 1.2s infinite; }
  @media (prefers-reduced-motion: reduce) { .steps li.on::before, .fill.unknown { animation:none; } }
  .steps li.done::before { border-color:var(--accent); background:var(--accent); }
  @keyframes pulse { 50% { opacity:.4; } }
  .track { height:4px; border-radius:2px; background:var(--line); overflow:hidden; position:relative; }
  .fill { height:4px; width:0; background:var(--accent); transition:width .4s; }
  .fill.unknown { width:30%; position:absolute; animation:slide 1.4s ease-in-out infinite; }
  @keyframes slide { from { left:-30%; } to { left:100%; } }
  .detail { display:flex; justify-content:space-between; gap:12px; margin-top:8px; font-size:13px; color:var(--muted); }
  #err { display:none; }
</style>
<h1>${esc(title)}</h1>
<p>Getting this review ready. Big projects take longer the first time; after that only new commits are fetched.</p>
<ol class="steps">
  <li id="s1">Download the code</li>
  <li id="s2">Analyse the changes</li>
  <li id="s3">Open the map</li>
</ol>
<div class="track" role="progressbar" aria-label="Progress" id="bar"><div class="fill unknown" id="fill"></div></div>
<div class="detail"><span id="step" aria-live="polite">${esc(status.step)}</span><span id="time"></span></div>
<div class="detail"><span id="more">${esc(status.detail)}</span></div>
<div id="err"><p class="err" id="errmsg" style="margin:16px 0 0"></p><button class="btn" type="button" onclick="location.reload()">Try again</button></div>
<script>
(function () {
  var url = ${JSON.stringify(statusUrl).replace(/</g, "\\u003c")};
  var started = ${status.startedAt};
  function $(id) { return document.getElementById(id); }
  function show(s) {
    var at = s.state === 'downloading' ? 1 : s.state === 'analysing' ? 2 : 3;
    [1, 2, 3].forEach(function (i) {
      $('s' + i).className = i < at ? 'done' : i === at ? 'on' : '';
    });
    $('step').textContent = s.step;
    $('more').textContent = s.detail || '';
    var f = $('fill');
    if (typeof s.percent === 'number') {
      f.className = 'fill'; f.style.width = s.percent + '%';
      $('bar').setAttribute('aria-valuenow', s.percent);
    } else {
      f.className = 'fill unknown'; f.style.width = '';
      $('bar').removeAttribute('aria-valuenow');
    }
    if (s.startedAt) started = s.startedAt;
  }
  function tick() {
    var sec = Math.max(0, Math.round((Date.now() - started) / 1000));
    $('time').textContent = sec < 60 ? sec + ' s' : Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s';
  }
  function poll() {
    fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.reload(); return null; }
      return r.json();
    }).then(function (s) {
      if (!s) return;
      if (s.error && !s.state) throw new Error(s.error);
      show(s);
      if (s.state === 'ready') { location.reload(); return; }
      if (s.state === 'error') throw new Error(s.error || 'Something went wrong.');
      setTimeout(poll, 900);
    }).catch(function (e) {
      $('errmsg').textContent = 'Could not get the merge request ready: ' + e.message;
      $('err').style.display = 'block';
    });
  }
  show(${JSON.stringify(status).replace(/</g, "\\u003c")});
  setInterval(tick, 1000); tick();
  setTimeout(poll, 600);
})();
</script>`
  );
}
