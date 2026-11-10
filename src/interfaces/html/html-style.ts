/** Dark-mode colour tokens, used for the system setting and for an explicit "dark" choice. */
const DARK_TOKENS = `
--bg:#141413; --panel:#1B1B19; --side:#171715; --line:#2C2B28; --line-strong:#45443F;
--fg:#ECEBE6; --fg2:#D3D2CC; --muted:#A3A199; --faint:#7D7B74; --chip:#232220; --hover:#282724;
--mod-fg:#E5C07B; --add-bg:#10291A; --add-gut:#173823; --add-fg:#6FD08C; --add-edge:#2F6B43;
--del-bg:#33161A; --del-gut:#4A1E22; --del-fg:#F28B82; --del-edge:#7A3A3A;
--use-bg:#15233D; --use-gut:#1D3157; --accent:#7AA2F7; --accent-bg:#1A2A4A;
--tk-keyword:#ff7b72; --tk-string:#a5d6ff; --tk-comment:#8b949e; --tk-number:#79c0ff;
--tk-function:#d2a8ff; --tk-type:#ffa657; --tk-decorator:#7ee787;
`;

/**
 * Stylesheet for the HTML report, laid out like a code editor: a title bar, the
 * changed files as a tree on the left, every changed file in one scrolling code
 * column, a usages panel docked under the code, and a status bar.
 */
export const STYLE = `
  :root {
    --bg:#F6F6F3; --panel:#FFFFFF; --side:#FAFAF7; --line:#E4E3DD; --line-strong:#C9C8C1;
    --fg:#1C1C1A; --fg2:#3A3935; --muted:#66655F; --faint:#8F8D85; --chip:#F2F1EC; --hover:#EDECE7;
    --mod-fg:#8A5A00; --add-bg:#E6F4EA; --add-gut:#D3ECDB; --add-fg:#14532D; --add-edge:#8CC79E;
    --del-bg:#FDECEC; --del-gut:#F8D8D8; --del-fg:#8E1B12; --del-edge:#E7A9A3;
    --use-bg:#EAF0FC; --use-gut:#D9E4F8; --accent:#2457C5; --accent-bg:#E8F0FE;
    --tk-keyword:#cf222e; --tk-string:#0a3069; --tk-comment:#6e7781; --tk-number:#0550ae;
    --tk-function:#8250df; --tk-type:#953800; --tk-decorator:#116329;
    --sans:'IBM Plex Sans', system-ui, sans-serif; --mono:'IBM Plex Mono', ui-monospace, monospace;
  }
  /* Dark colours: from the system setting, unless the reader picked light or dark (data-theme). */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { ${DARK_TOKENS} }
  }
  :root[data-theme="dark"] { ${DARK_TOKENS} }
  :root { color-scheme: light dark; }
  :root[data-theme="light"] { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  html, body { margin:0; height:100%; }
  body { background:var(--bg); color:var(--fg); font:13px/1.4 var(--sans); display:flex; flex-direction:column; overflow:hidden; }
  button { font:inherit; color:inherit; }
  button:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  .mono { font-family:var(--mono); }
  .add { color:var(--add-fg); } .del { color:var(--del-fg); }

  /* ── title bar ── */
  header.top { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:6px 16px; min-height:44px; padding:6px 16px;
               background:var(--panel); border-bottom:1px solid var(--line); }
  .brand { display:flex; align-items:center; gap:7px; font-weight:600; font-size:14px; }
  .brand svg { stroke:var(--fg); }
  .title { flex:1 1 280px; min-width:0; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 12px; }
  .title .t { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
  .title .s { font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
  .title a { color:inherit; text-decoration:none; } .title a:hover { text-decoration:underline; }
  .acts { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .pill { display:inline-flex; gap:6px; padding:3px 9px; border:1px solid var(--line); border-radius:999px; font-size:12px; color:var(--fg2); }
  .pill.warn { color:var(--del-fg); border-color:var(--del-edge); background:var(--del-bg); }
  .hbtn, .theme { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:30px; padding:0 12px;
          border:1px solid var(--line-strong); border-radius:6px; background:var(--panel); color:var(--fg);
          font-size:13px; text-decoration:none; cursor:pointer; }
  .hbtn:hover, .theme:hover { background:var(--hover); }
  .hbtn.primary { background:var(--fg); color:var(--panel); border-color:var(--fg); font-weight:500; }
  .hbtn.primary:hover { opacity:.9; }
  .hbtn:disabled { opacity:.5; cursor:not-allowed; }
  .theme { padding:0 9px; color:var(--fg2); }
  .theme svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .who { display:flex; align-items:center; gap:8px; margin:0; font-size:12px; color:var(--muted); }
  .link { border:0; background:none; padding:0; color:var(--accent); cursor:pointer; font-size:12px; }
  .link:hover { text-decoration:underline; }

  /* ── explorer and editor ── */
  .work { --lw:270px; position:relative; flex:1; min-height:0; display:grid; grid-template-columns:var(--lw) minmax(0, 1fr); }
  .rz { position:absolute; z-index:6; touch-action:none; }
  .rz.l { top:0; bottom:0; left:calc(var(--lw) - 4px); width:8px; cursor:col-resize; }
  .rz.b { left:0; right:0; top:-4px; height:8px; cursor:row-resize; }
  .rz.l:hover, .rz.l.on { background:linear-gradient(var(--accent), var(--accent)) center / 2px 100% no-repeat; }
  .rz.b:hover, .rz.b.on { background:linear-gradient(var(--accent), var(--accent)) center / 100% 2px no-repeat; }
  body.resizing, body.resizing * { user-select:none; }
  aside.side { background:var(--side); border-right:1px solid var(--line); display:flex; flex-direction:column; min-height:0; }
  .side-head { display:flex; flex-direction:column; gap:8px; padding:12px 12px 8px 16px; }
  .cap { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
  #filter { width:100%; height:28px; padding:0 8px; border:1px solid var(--line); border-radius:5px; background:var(--panel);
            color:var(--fg); font:12px var(--sans); }
  .side-list { flex:1; overflow:auto; padding:0 6px 12px; font-size:12.5px; }
  .tf-dir, .sf-file, .sf-sym { display:flex; align-items:center; gap:6px; width:100%; min-height:26px; padding:0 8px; border:0;
            border-radius:4px; background:transparent; cursor:pointer; text-align:left; white-space:nowrap; }
  .tf-dir:hover, .sf-file:hover, .sf-sym:hover { background:var(--hover); }
  .tf-dir { color:var(--muted); }
  .tf-dir .dn { overflow:hidden; text-overflow:ellipsis; }
  .tf-dir .chev, .fold .chev { flex:none; width:0; height:0; border:4px solid transparent; border-top:5px solid currentColor; margin-top:4px; transition:transform .1s; }
  .tf-dir[aria-expanded="false"] .chev, .fold[aria-expanded="false"] .chev { transform:rotate(-90deg); }
  .tf-dir[aria-expanded="false"] + .tf-kids { display:none; }
  .tf-kids { margin-left:13px; padding-left:5px; border-left:1px solid var(--line); }
  .sf-file .p { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
  .sf-file.fs-added .p { color:var(--add-fg); }
  .sf-file.fs-modified .p { color:var(--mod-fg); }
  .sf-file.fs-deleted .p { color:var(--del-fg); text-decoration:line-through; }
  .sf-file .n { flex:none; font-size:11px; }
  .sf-file .vw { flex:none; width:12px; color:var(--accent); font-family:var(--sans); }
  .sf-file.seen .p, .sf-file.seen .n { opacity:.55; }
  .sf-sym { padding-left:22px; color:var(--fg2); }
  .sf-sym .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .sf-sym .ct { flex:none; color:var(--faint); font:11px var(--sans); }
  .sf-sym.on { background:var(--accent-bg); color:var(--accent); }
  .glyph { flex:none; width:14px; height:14px; border-radius:3px; font:600 9px/14px var(--sans); text-align:center;
           color:var(--panel); background:var(--mod-fg); }
  .glyph.st-added { background:var(--add-fg); } .glyph.st-removed { background:var(--del-fg); }
  .nm.st-removed, .wn.st-removed { color:var(--del-fg); text-decoration:line-through; }
  .wn.st-added { color:var(--add-fg); }

  main.main { position:relative; min-width:0; min-height:0; display:flex; flex-direction:column; background:var(--panel); }
  .ed { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; }
  .empty { padding:40px; text-align:center; color:var(--muted); }

  /* ── one changed file ── */
  .fh { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:10px; min-height:34px; padding:3px 12px 3px 8px;
        background:var(--side); border-bottom:1px solid var(--line); font-size:12px; }
  .fsec + .fsec .fh { border-top:1px solid var(--line); }
  .fold { flex:none; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border:0; border-radius:4px;
          background:transparent; color:var(--muted); cursor:pointer; }
  .fold:hover { background:var(--hover); color:var(--fg); }
  .fpath { flex:1; min-width:0; font:12px/1.35 var(--mono); overflow-wrap:anywhere; }
  .fdir { color:var(--muted); } .fname { font-weight:600; }
  .fsec.seen .fpath { opacity:.6; }
  .cmeta { flex:none; font:12px var(--mono); display:flex; gap:6px; }
  .cbtn { display:inline-flex; align-items:center; gap:4px; flex:none; border:0; background:transparent;
          color:var(--muted); border-radius:4px; padding:3px 6px; font-size:12px; cursor:pointer; }
  .cbtn:hover { color:var(--fg); background:var(--hover); }
  .cbtn.done { color:var(--add-fg); }
  .cbtn[aria-pressed="true"] { color:var(--fg); background:var(--hover); }
  .vf { flex:none; display:inline-flex; align-items:center; gap:5px; padding:3px 8px; border:1px solid var(--line-strong); border-radius:5px;
        background:var(--panel); color:var(--fg2); cursor:pointer; user-select:none; }
  .vf input { margin:0; accent-color:var(--accent); }
  .fsec.seen .vf { border-color:var(--accent); color:var(--accent); background:var(--accent-bg); }
  .fsec.shut .code, .fsec.shut .bigbar, .fsec.shut .expand { display:none; }
  .fsec.big .code, .fsec.big .expand { display:none; }
  .fsec:not(.big) .bigbar { display:none; }
  .bigbar { display:block; width:100%; border:0; padding:10px 16px; text-align:left; background:var(--chip); color:var(--muted);
            font:13px var(--sans); cursor:pointer; }
  .bigbar:hover { color:var(--fg); background:var(--hover); }
  .bigbar b { color:var(--accent); font-weight:500; }

  /* ── code rows ── */
  .code { padding:4px 0 8px; }
  .dl { display:flex; font:12px/20px var(--mono); min-height:20px; color:var(--fg); }
  .dl .lo, .dl .ln { width:40px; flex:none; padding-right:6px; text-align:right; color:var(--faint); user-select:none; }
  .dl .sg { width:16px; flex:none; text-align:center; user-select:none; }
  .dl .tx { flex:1; min-width:0; padding-right:16px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .dl.add { background:var(--add-bg); } .dl.add .lo, .dl.add .ln { background:var(--add-gut); color:var(--add-fg); } .dl.add .sg { color:var(--add-fg); }
  .dl.del { background:var(--del-bg); } .dl.del .lo, .dl.del .ln { background:var(--del-gut); color:var(--del-fg); } .dl.del .sg { color:var(--del-fg); }
  .dl.def, .dl.call { cursor:pointer; }
  .dl.sel { box-shadow:inset 3px 0 0 var(--fg); }
  .dl.hit { box-shadow:inset 3px 0 0 var(--accent); }
  .dl.ctx.hit { background:var(--use-bg); } .dl.ctx.hit .lo, .dl.ctx.hit .ln { background:var(--use-gut); color:var(--accent); }
  .dl.hit.bad { box-shadow:inset 3px 0 0 var(--del-fg); }
  .dl.ctx.hit.bad { background:var(--del-bg); } .dl.ctx.hit.bad .lo, .dl.ctx.hit.bad .ln { background:var(--del-gut); color:var(--del-fg); }
  .dl.flash .tx { animation:flash 1.2s ease-out; }
  @keyframes flash { 0% { background:var(--accent-bg); } 100% { } }
  @media (prefers-reduced-motion: reduce) { .dl.flash .tx { animation:none; } }
  /* The name of a changed symbol: click it like in an editor (definition <-> usages). */
  .sym { border-radius:3px; text-decoration:underline; text-decoration-color:var(--line-strong); text-underline-offset:3px; }
  .dl:hover .sym { text-decoration-color:var(--accent); }
  .sym:hover { background:var(--accent-bg); }
  .sym.cur { background:var(--accent-bg); text-decoration-color:var(--accent); font-weight:600; }
  .fsec:not(.whole) .dl.far:not(.shown) { display:none; }
  .fsec.whole .gap { display:none; }
  /* Folded unchanged lines: open some from the top, some from the bottom, or all. */
  .gap { display:flex; flex-wrap:wrap; align-items:center; gap:2px 6px; padding:1px 12px 1px 90px; background:var(--side);
         color:var(--muted); font:12px/20px var(--sans); }
  .gap button { border:0; border-radius:4px; padding:0 6px; background:transparent; color:var(--muted); font:inherit; cursor:pointer; }
  .gap button:hover { color:var(--fg); background:var(--hover); }
  .gap .ga { color:var(--accent); }
  .more { display:block; width:100%; border:0; padding:3px 12px 3px 96px; text-align:left; background:var(--side); color:var(--accent);
          font:12px/20px var(--sans); cursor:pointer; }
  .more:hover { background:var(--hover); }
  .ro.cut .dl.extra { display:none; }
  .deco { color:var(--muted); font:11px var(--mono); padding:2px 12px 0 96px; }
  .tk-keyword { color:var(--tk-keyword); } .tk-string { color:var(--tk-string); }
  .tk-comment { color:var(--tk-comment); font-style:italic; } .tk-number { color:var(--tk-number); }
  .tk-function { color:var(--tk-function); } .tk-type { color:var(--tk-type); } .tk-decorator { color:var(--tk-decorator); }

  /* ── usages panel, docked under the code ── */
  .dock { position:relative; flex:none; display:flex; flex-direction:column; border-top:1px solid var(--line-strong); background:var(--panel); }
  .dock.open { height:var(--dh, 40%); min-height:150px; max-height:80%; }
  .dock:not(.open) .rz, .dock:not(.open) .dpane, .dock:not(.open) .cpane { display:none; }
  .dtabs { flex:none; display:flex; align-items:center; gap:4px; min-height:34px; padding:0 8px; }
  .dock.open .dtabs { border-bottom:1px solid var(--line); }
  .dtab { height:34px; padding:0 8px; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--muted); cursor:pointer; }
  .dtab:hover { color:var(--fg); }
  .dtab[aria-selected="true"] { color:var(--fg); border-bottom-color:var(--accent); }
  .dtab em { font-style:normal; margin-left:5px; padding:0 6px; border-radius:999px; background:var(--hover); font-size:11px; }
  .what { flex:1; min-width:0; display:flex; align-items:center; gap:8px; margin-left:10px; overflow:hidden; white-space:nowrap; font-size:12px; color:var(--muted); }
  .what .wn { flex:none; font:600 13px var(--mono); color:var(--fg); }
  .what .wl { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; border:0; background:none; padding:0; color:inherit;
              font:12px var(--mono); cursor:pointer; }
  .what .wl:hover { color:var(--fg); text-decoration:underline; }
  .what .wf { flex:none; } .what .wf.bad { color:var(--del-fg); }
  .mini { flex:none; border:0; background:transparent; color:var(--muted); border-radius:4px; padding:3px 7px; font-size:12px; cursor:pointer; white-space:nowrap; }
  .mini:hover { color:var(--fg); background:var(--hover); }
  .mini:disabled { opacity:.4; cursor:default; background:transparent; color:var(--muted); }
  .dpane { flex:1; min-height:0; display:grid; grid-template-columns:minmax(220px, 36%) minmax(0, 1fr); }
  .ulist { min-width:0; overflow:auto; padding:6px; border-right:1px solid var(--line); }
  .rf { padding:6px 8px 2px; font-size:11px; color:var(--muted); overflow-wrap:anywhere; }
  .rf.out::after, .ph .po { content:"outside the diff"; margin-left:6px; padding:0 5px; border:1px dashed var(--faint); border-radius:3px;
                   font:11px var(--sans); color:var(--muted); white-space:nowrap; }
  .ref { display:flex; align-items:baseline; gap:8px; width:100%; padding:3px 8px; border:0; border-radius:4px;
         background:transparent; cursor:pointer; text-align:left; color:var(--fg2); font:12px/18px var(--mono); }
  .ref:hover { background:var(--hover); }
  .ref.on { background:var(--accent-bg); }
  .ref .rn { flex:none; min-width:3ch; text-align:right; color:var(--faint); }
  .ref .rt { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ref .tag { flex:none; font:11px var(--sans); color:var(--muted); }
  .ref.bad .rt { color:var(--del-fg); }
  .ref.resolved { opacity:.6; }
  .none { padding:10px 8px; color:var(--muted); }
  .prev { position:relative; min-width:0; overflow:auto; }
  .ph { position:sticky; top:0; z-index:1; display:flex; align-items:center; gap:8px; min-height:30px; padding:2px 12px;
        background:var(--side); border-bottom:1px solid var(--line); font-size:12px; color:var(--muted); }
  .ph .pp { min-width:0; overflow-wrap:anywhere; }
  .cpane { flex:1; min-height:0; overflow:auto; padding:10px 16px 16px; display:flex; flex-direction:column; gap:14px; }
  .cpane h3 { margin:0 0 4px; font-size:12px; font-weight:600; color:var(--muted); }
  .cpane .thread, .cpane .composer { margin:6px 0; max-width:720px; }
  .cpane .ref { font-family:var(--sans); }
  .cpane .ref .rn { font-family:var(--mono); min-width:0; }

  /* ── status bar ── */
  footer.status { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:2px 18px; padding:4px 16px; background:var(--side);
                  border-top:1px solid var(--line); font-size:12px; color:var(--muted); }
  .keys { display:inline-flex; flex-wrap:wrap; gap:2px 12px; }
  .keys span { white-space:nowrap; }
  kbd { display:inline-block; min-width:18px; margin-right:3px; padding:0 4px; border:1px solid var(--line-strong); border-bottom-width:2px;
        border-radius:4px; background:var(--panel); color:var(--fg2); font:11px/15px var(--sans); text-align:center; }
  .vprog { margin-left:auto; display:inline-flex; align-items:center; gap:8px; }
  .bar { display:block; width:64px; height:4px; border-radius:2px; background:var(--line-strong); overflow:hidden; }
  .bar span { display:block; height:4px; width:0; background:var(--accent); transition:width .2s; }

  /* ── merge-request mode: comments on lines ── */
  body.mr-write .dl .lo, body.mr-write .dl .ln { cursor:pointer; }
  body.mr-write .dl .lo:hover, body.mr-write .dl .ln:hover { background:var(--accent-bg); color:var(--accent); }
  body.mr-write .ro .dl .lo, body.mr-write .ro .dl .ln { cursor:default; background:none; color:var(--faint); }
  .dl.has-c .lo { box-shadow:inset 3px 0 0 var(--accent); }
  .thread, .composer { margin:4px 16px 8px 96px; max-width:720px; border:1px solid var(--line-strong); border-radius:6px; background:var(--panel);
                       font:13px/1.45 var(--sans); color:var(--fg); cursor:auto; }
  .thread.resolved { opacity:.65; }
  .note { padding:8px 10px; } .note + .note { border-top:1px solid var(--line); }
  .nh { font-size:12px; color:var(--muted); margin-bottom:2px; } .nh b { color:var(--fg); font-weight:600; }
  .nb { white-space:pre-wrap; overflow-wrap:anywhere; }
  .thread > .link { margin:0 10px 8px; }
  .composer { padding:8px; display:flex; flex-direction:column; gap:6px; }
  .composer textarea { width:100%; min-height:64px; resize:vertical; padding:6px 8px; border:1px solid var(--line-strong);
                       border-radius:6px; background:var(--bg); color:var(--fg); font:13px/1.4 var(--sans); }
  .composer .row { display:flex; gap:8px; align-items:center; justify-content:flex-end; }
  .composer .hint { font-size:12px; color:var(--muted); }
  .composer .err { font-size:12px; color:var(--del-fg); margin-right:auto; }
  .toast { position:fixed; bottom:40px; left:50%; transform:translateX(-50%); max-width:90vw; padding:10px 14px; border-radius:8px;
           background:var(--fg); color:var(--panel); font-size:13px; z-index:20; }

  @media (max-width: 800px) {
    .work { grid-template-columns:minmax(0, 1fr); grid-template-rows:auto minmax(0, 1fr); }
    .rz.l { display:none; }
    aside.side { border-right:0; border-bottom:1px solid var(--line); max-height:28vh; }
    .dpane { grid-template-columns:minmax(0, 1fr); grid-template-rows:minmax(60px, 40%) minmax(0, 1fr); }
    .ulist { border-right:0; border-bottom:1px solid var(--line); }
    .what .wl, .what .wf { display:none; }
    .thread, .composer { margin-left:16px; }
    .gap, .more { padding-left:16px; }
    .keys { display:none; }
  }
`;
