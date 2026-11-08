import type { Person } from "../../application/ports/merge-request.port.js";
import type { PreparingStatus } from "../../application/use-cases/review-merge-request.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LOGO = `<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2.5"></circle><circle cx="19" cy="6" r="2.5"></circle><circle cx="12" cy="18" r="2.5"></circle><path d="M7.5 6h9M6.5 8.2l4.2 7.6M17.5 8.2l-4.2 7.6"></path></svg>`;

/** A small centred page in the same look as the report. */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap">
<style>
  :root { --bg:#F6F6F3; --panel:#FFFFFF; --line:#E2E1DC; --line-strong:#C9C8C1; --fg:#1C1C1A; --muted:#5F5E58; --accent:#2457C5; --err:#8E1B12; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141413; --panel:#1C1C1A; --line:#2F2E2B; --line-strong:#45443F; --fg:#ECEBE6; --muted:#A3A199; --accent:#7AA2F7; --err:#F28B82; }
  }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px 16px;
         background:var(--bg); color:var(--fg); font:15px/1.5 'IBM Plex Sans', system-ui, sans-serif; }
  main { width:100%; max-width:520px; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:32px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:600; font-size:18px; margin-bottom:20px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  label { display:block; font-size:13px; font-weight:500; margin-bottom:6px; }
  input { width:100%; min-height:44px; padding:0 12px; border:1px solid var(--line-strong); border-radius:8px;
          background:var(--bg); color:var(--fg); font:14px 'IBM Plex Mono', ui-monospace, monospace; }
  .btn { display:inline-flex; align-items:center; justify-content:center; min-height:44px; padding:0 18px; margin-top:14px;
         border:1px solid var(--fg); border-radius:8px; background:var(--fg); color:var(--panel); font:inherit; font-weight:500;
         text-decoration:none; cursor:pointer; }
  .foot { display:flex; justify-content:space-between; align-items:center; margin-top:24px; font-size:13px; color:var(--muted); }
  .foot button { border:0; background:none; color:var(--accent); font:inherit; cursor:pointer; padding:0; }
  code { font-family:'IBM Plex Mono', ui-monospace, monospace; font-size:13px; }
  .err { color:var(--err); }
  a { color:var(--accent); }
</style>
</head>
<body><main><div class="brand">${LOGO}<span>gitmap</span></div>${body}</main></body>
</html>`;
}

export function signInPage(gitlabUrl: string, returnTo: string): string {
  return shell(
    "Sign in · gitmap",
    `<h1>Review merge requests as a map</h1>
<p>Sign in with your GitLab account at <code>${esc(gitlabUrl)}</code>. gitmap only sees what you can see in GitLab.</p>
<a class="btn" href="/auth/login?returnTo=${encodeURIComponent(returnTo)}">Sign in with GitLab</a>`
  );
}

export function homePage(user: Person, gitlabUrl: string, error = ""): string {
  return shell(
    "gitmap",
    `<h1>Open a merge request</h1>
<p>Paste a merge request link from GitLab. Tip: you can also replace <code>${esc(gitlabUrl.replace(/^https?:\/\//, ""))}</code> with this site's address in any merge request URL.</p>
<form method="get" action="/go">
  <label for="u">Merge request link</label>
  <input id="u" name="url" required placeholder="${esc(gitlabUrl)}/group/project/-/merge_requests/42" autofocus>
  ${error ? `<p class="err" style="margin:10px 0 0">${esc(error)}</p>` : ""}
  <button class="btn" type="submit">Open map</button>
</form>
<div class="foot"><span>Signed in as <b>${esc(user.name)}</b> (@${esc(user.username)})</span>
<form method="post" action="/auth/logout"><button type="submit">Sign out</button></form></div>`
  );
}

export function errorPage(title: string, message: string, back = "/"): string {
  return shell(`${title} · gitmap`, `<h1>${esc(title)}</h1><p>${esc(message)}</p><a class="btn" href="${esc(back)}">Back</a>`);
}

/**
 * Shown while an MR's code downloads and is analysed. It asks the server for
 * progress about once a second and reloads into the map when it is ready.
 */
export function loadingPage(title: string, statusUrl: string, status: PreparingStatus): string {
  return shell(
    `${title} · gitmap`,
    `<style>
  .steps { list-style:none; padding:0; margin:20px 0 16px; display:flex; flex-direction:column; gap:10px; }
  .steps li { display:flex; align-items:center; gap:10px; color:var(--muted); }
  .steps li::before { content:""; width:12px; height:12px; border-radius:999px; border:2px solid var(--line-strong); flex:none; }
  .steps li.on { color:var(--fg); font-weight:500; }
  .steps li.on::before { border-color:var(--accent); background:var(--accent); animation:pulse 1.2s infinite; }
  .steps li.done::before { border-color:var(--accent); background:var(--accent); }
  @keyframes pulse { 50% { opacity:.4; } }
  .track { height:8px; border-radius:999px; background:var(--line); overflow:hidden; position:relative; }
  .fill { height:8px; width:0; background:var(--accent); transition:width .4s; }
  .fill.unknown { width:30%; position:absolute; animation:slide 1.4s ease-in-out infinite; }
  @keyframes slide { from { left:-30%; } to { left:100%; } }
  .detail { display:flex; justify-content:space-between; gap:12px; margin-top:8px; font-size:13px; color:var(--muted); }
  #err { display:none; }
</style>
<h1>${esc(title)}</h1>
<p>Getting this merge request ready. Big projects take longer the first time; after that only new commits are fetched.</p>
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
