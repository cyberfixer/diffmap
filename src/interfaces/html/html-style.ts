/** Stylesheet for the HTML report: a three-panel review screen. */
export const STYLE = `
  :root {
    --bg:#F6F6F3; --panel:#FFFFFF; --side:#FBFBF9; --line:#E2E1DC; --line-strong:#C9C8C1;
    --fg:#1C1C1A; --fg2:#2B2A27; --muted:#5F5E58; --faint:#8A8880; --chip:#F2F1EC; --hover:#EAE9E4;
    --add-bg:#E6F4EA; --add-gut:#CFEBD8; --add-fg:#14532D; --add-edge:#8CC79E;
    --del-bg:#FDECEC; --del-gut:#F7D4D4; --del-fg:#8E1B12; --del-edge:#E7A9A3;
    --use-bg:#EEF3FC; --use-gut:#DCE6F8; --accent:#2457C5; --accent-bg:#E8F0FE; --use-edge:#9DB5E3;
    --edge:#5F5E58; --dots:#DEDDD7;
    --tk-keyword:#cf222e; --tk-string:#0a3069; --tk-comment:#6e7781; --tk-number:#0550ae;
    --tk-function:#8250df; --tk-type:#953800; --tk-decorator:#116329;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#141413; --panel:#1C1C1A; --side:#191917; --line:#2F2E2B; --line-strong:#45443F;
      --fg:#ECEBE6; --fg2:#DAD9D3; --muted:#A3A199; --faint:#7D7B74; --chip:#262522; --hover:#2A2926;
      --add-bg:#10291A; --add-gut:#173823; --add-fg:#6FD08C; --add-edge:#2F6B43;
      --del-bg:#33161A; --del-gut:#4A1E22; --del-fg:#F28B82; --del-edge:#7A3A3A;
      --use-bg:#15233D; --use-gut:#1D3157; --accent:#7AA2F7; --accent-bg:#1A2A4A; --use-edge:#3D5A94;
      --edge:#A3A199; --dots:#2A2926;
      --tk-keyword:#ff7b72; --tk-string:#a5d6ff; --tk-comment:#8b949e; --tk-number:#79c0ff;
      --tk-function:#d2a8ff; --tk-type:#ffa657; --tk-decorator:#7ee787;
    }
  }
  * { box-sizing:border-box; }
  html, body { margin:0; height:100%; }
  body { background:var(--bg); color:var(--fg); font:14px/1.4 'IBM Plex Sans', system-ui, sans-serif;
         display:flex; flex-direction:column; overflow:hidden; }
  button { font:inherit; color:inherit; }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .mono { font-family:'IBM Plex Mono', ui-monospace, monospace; }
  .add { color:var(--add-fg); } .del { color:var(--del-fg); }

  /* ── top bar ── */
  header.top { flex:none; display:flex; flex-wrap:wrap; align-items:center; gap:10px 24px; padding:10px 20px;
               background:var(--panel); border-bottom:1px solid var(--line); }
  .brand { display:flex; align-items:center; gap:8px; font-weight:600; font-size:15px; }
  .brand svg { stroke:var(--fg); }
  .title { flex:1 1 320px; min-width:0; display:flex; flex-direction:column; gap:2px; }
  .title .t { font-size:15px; font-weight:600; overflow-wrap:anywhere; }
  .title .s { font-size:12px; color:var(--muted); }
  .pills { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .pill { display:inline-flex; gap:8px; padding:5px 10px; border:1px solid var(--line); border-radius:999px;
          font-size:13px; color:var(--fg2); }
  .pill.warn { color:var(--del-fg); border-color:var(--del-edge); background:var(--del-bg); }

  /* ── three panels ── */
  .panes { flex:1; min-height:0; display:grid; grid-template-columns:minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 360px); }
  aside.side { background:var(--side); border-right:1px solid var(--line); display:flex; flex-direction:column; min-height:0; }
  .side-head { display:flex; justify-content:space-between; align-items:baseline; padding:16px 20px 8px; }
  .side-head h2 { margin:0; font-size:14px; font-weight:600; }
  .side-head span { font-size:12px; color:var(--muted); }
  .side-list { flex:1; overflow:auto; padding:4px 12px 12px; display:flex; flex-direction:column; gap:10px; }
  .sf-file { display:flex; align-items:center; gap:8px; width:100%; padding:6px 8px; border:0; border-radius:6px;
             background:transparent; cursor:pointer; text-align:left; font-size:12px; }
  .sf-file:hover { background:var(--hover); }
  .sf-file .p { flex:1; min-width:0; overflow-wrap:anywhere; }
  .sf-file .p b { font-weight:600; }
  .sf-file .p span { color:var(--muted); }
  .sf-file .n { flex:none; font-size:11px; }
  .sf-sym { display:flex; align-items:center; gap:8px; width:100%; min-height:44px; padding:4px 8px 4px 24px;
            border:0; border-radius:6px; background:transparent; cursor:pointer; text-align:left; }
  .sf-sym:hover { background:var(--hover); }
  .sf-sym.on { background:var(--hover); box-shadow:inset 3px 0 0 var(--fg); }
  .sf-sym .b { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
  .sf-sym .nm { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sf-sym .sub { font-size:11px; color:var(--muted); }
  .sf-sym .vw { width:14px; color:var(--accent); font-size:13px; }
  .st-added { color:var(--add-fg); } .st-removed { color:var(--del-fg); text-decoration:line-through; }
  .progress { padding:14px 20px 16px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:8px; }
  .progress .r { display:flex; justify-content:space-between; font-size:13px; }
  .progress .r span:last-child { color:var(--muted); }
  .bar { height:6px; border-radius:999px; background:var(--line); overflow:hidden; }
  .bar div { height:6px; width:0; background:var(--accent); transition:width .2s; }

  main.map { min-width:0; min-height:0; display:flex; flex-direction:column; }
  .map-head { flex:none; display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px 16px;
              padding:14px 20px 10px; }
  .map-head h1 { margin:0; font-size:18px; font-weight:600; }
  .map-head .sub { font-size:13px; color:var(--muted); display:flex; flex-wrap:wrap; gap:4px 14px; }
  .tools { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
  .switch { display:inline-flex; align-items:center; gap:10px; min-height:36px; padding:0 4px; border:0;
            background:transparent; font-size:13px; color:var(--fg2); cursor:pointer; }
  .switch .tr { position:relative; width:36px; height:20px; border-radius:999px; background:var(--line-strong); transition:background .15s; }
  .switch .kn { position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:999px; background:#fff; transition:left .15s; }
  .switch[aria-checked="true"] .tr { background:var(--fg); }
  .switch[aria-checked="true"] .kn { left:18px; }
  .switch[aria-checked="true"] .kn { background:var(--panel); }
  .zoom { display:inline-flex; align-items:center; border:1px solid var(--line-strong); border-radius:8px; overflow:hidden; font-size:13px; }
  .zoom button { min-width:36px; min-height:34px; border:0; background:var(--panel); cursor:pointer; font-size:15px; }
  .zoom button:hover { background:var(--hover); }
  .zoom span { min-width:52px; text-align:center; color:var(--fg2); line-height:34px;
               border-left:1px solid var(--line-strong); border-right:1px solid var(--line-strong); }
  .zoom .fit { font-size:13px; padding:0 10px; border-left:1px solid var(--line-strong); }

  #vp { flex:1; min-height:0; margin:0 20px; position:relative; overflow:hidden; cursor:grab; touch-action:none;
        border:1px solid var(--line); border-radius:12px; background-color:var(--panel);
        background-image:radial-gradient(var(--dots) 1px, transparent 1px); background-size:16px 16px; }
  #vp.drag { cursor:grabbing; }
  #cv { position:absolute; left:0; top:0; transform-origin:0 0; }
  #sv { position:absolute; left:0; top:0; overflow:visible; pointer-events:none; }
  .col-label { position:absolute; top:12px; font-size:13px; font-weight:500; color:var(--fg2); white-space:nowrap; }
  .col-label.r { display:none; }
  body.show-out .col-label.r { display:block; }

  .legend { flex:none; display:flex; flex-wrap:wrap; gap:6px 18px; padding:10px 20px 14px; font-size:12px; color:var(--fg2); }
  .legend > span { display:inline-flex; align-items:center; gap:6px; }
  .sw { width:14px; height:14px; border-radius:3px; }
  .sw.a { background:var(--add-bg); border:1px solid var(--add-edge); }
  .sw.d { background:var(--del-bg); border:1px solid var(--del-edge); }
  .sw.u { background:var(--use-bg); border:1px solid var(--use-edge); }
  .sw.o { background:var(--panel); border:1px dashed var(--faint); }
  .ln-s { width:22px; border-top:2px solid var(--edge); }
  .ln-r { width:22px; border-top:2px dashed var(--del-fg); }
  .ln-i { width:22px; border-top:2px dashed var(--edge); }

  /* ── code cards ── */
  .card { position:absolute; background:var(--panel); border:1px solid var(--line-strong); border-radius:10px; overflow:hidden; }
  .card.out { border-style:dashed; border-color:var(--faint); display:none; }
  .card.out.vis { display:block; }
  .ch { display:flex; align-items:center; gap:8px; min-height:34px; padding:5px 8px 5px 12px; border-bottom:1px solid var(--line);
        background:var(--side); font-size:12px; }
  .fpath { flex:1; min-width:0; font:12px/1.35 'IBM Plex Mono', ui-monospace, monospace; overflow-wrap:anywhere; }
  .fdir { color:var(--muted); } .fname { font-weight:600; }
  .cmeta { flex:none; font:12px 'IBM Plex Mono', ui-monospace, monospace; display:flex; gap:6px; }
  .cbtn { display:inline-flex; align-items:center; gap:4px; flex:none; border:1px solid var(--line); background:var(--panel);
          color:var(--muted); border-radius:6px; padding:2px 7px; font-size:11px; cursor:pointer; }
  .cbtn:hover { color:var(--fg); border-color:var(--line-strong); }
  .cbtn.done { color:var(--add-fg); border-color:var(--add-edge); }
  .cbtn[aria-pressed="true"] { color:var(--fg); background:var(--hover); }
  .code { padding:4px 0 8px; }
  .dl { display:flex; font:12px/20px 'IBM Plex Mono', ui-monospace, monospace; min-height:20px; color:var(--fg); }
  .dl .lo, .dl .ln { width:40px; flex:none; padding-right:6px; text-align:right; color:var(--faint); user-select:none; }
  .dl .sg { width:16px; flex:none; text-align:center; user-select:none; }
  .dl .tx { flex:1; min-width:0; padding-right:10px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .dl.add { background:var(--add-bg); } .dl.add .lo, .dl.add .ln { background:var(--add-gut); color:var(--add-fg); } .dl.add .sg { color:var(--add-fg); }
  .dl.del { background:var(--del-bg); } .dl.del .lo, .dl.del .ln { background:var(--del-gut); color:var(--del-fg); } .dl.del .sg { color:var(--del-fg); }
  .dl.def { cursor:pointer; }
  .dl.def:hover { box-shadow:inset 0 0 0 1px var(--line-strong); }
  .dl.sel, .dl.sel:hover { box-shadow:inset 0 0 0 2px var(--fg); }
  .dl.hit { box-shadow:inset 0 0 0 2px var(--accent); }
  .dl.ctx.hit { background:var(--use-bg); } .dl.ctx.hit .lo, .dl.ctx.hit .ln { background:var(--use-gut); }
  .dl.ctx.hit .sg::before { content:"\\2192"; color:var(--accent); }
  .dl.hit.bad { box-shadow:inset 0 0 0 2px var(--del-fg); }
  .dl.ctx.hit.bad .sg::before { color:var(--del-fg); }
  .dl.flash { animation:flash 1.2s ease-out; }
  @keyframes flash { 0% { background:var(--accent-bg); } 100% { } }
  .card:not(.whole) .dl.far { display:none; }
  .card.big .code, .card.big .expand { display:none; }
  .bigbar { display:block; width:100%; border:0; padding:10px 12px; text-align:left; background:var(--chip); color:var(--muted);
            font:13px 'IBM Plex Sans', system-ui, sans-serif; cursor:pointer; }
  .bigbar:hover { color:var(--fg); background:var(--hover); }
  .bigbar b { color:var(--accent); font-weight:500; }
  .card:not(.big) .bigbar { display:none; }
  .card.whole .gap { display:none; }
  .gap { display:block; width:100%; border:0; padding:2px 0 2px 96px; text-align:left; background:var(--chip);
         color:var(--muted); font:italic 12px/18px 'IBM Plex Sans', system-ui, sans-serif; cursor:pointer; }
  .gap:hover { color:var(--fg); background:var(--hover); }
  .caller { display:none; } .caller.vis { display:block; }
  .caller.vis ~ .caller.vis { border-top:1px dashed var(--line-strong); margin-top:4px; padding-top:4px; }
  .deco { color:var(--muted); font-size:11px; padding:2px 12px 0 96px; font-family:'IBM Plex Mono', ui-monospace, monospace; }
  .tk-keyword { color:var(--tk-keyword); } .tk-string { color:var(--tk-string); }
  .tk-comment { color:var(--tk-comment); font-style:italic; } .tk-number { color:var(--tk-number); }
  .tk-function { color:var(--tk-function); } .tk-type { color:var(--tk-type); } .tk-decorator { color:var(--tk-decorator); }

  #sv .edge { fill:none; stroke:var(--edge); stroke-width:1.5; opacity:.3; }
  #sv .edge.on { opacity:1; stroke-width:2; }
  #sv .edge.bad { stroke:var(--del-fg); stroke-dasharray:6 4; opacity:.8; }
  #sv .edge.bad.on { opacity:1; }
  #sv .edge.impl { stroke-dasharray:6 5; }
  #sv marker path { fill:var(--edge); } #sv #ah-bad path { fill:var(--del-fg); }

  /* ── details ── */
  aside.detail { background:var(--panel); border-left:1px solid var(--line); overflow:auto; padding:20px;
                 display:flex; flex-direction:column; gap:18px; }
  #dt { flex:1; display:flex; flex-direction:column; gap:18px; }
  #dt[hidden], #ov[hidden] { display:none; }
  .lbl { font-size:12px; color:var(--muted); }
  .dname { display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; }
  .dname h2 { margin:0; font:600 18px 'IBM Plex Mono', ui-monospace, monospace; overflow-wrap:anywhere; }
  .kind { padding:2px 8px; border-radius:999px; font-size:12px; background:var(--chip); color:var(--fg2); border:1px solid var(--line); }
  .loc { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
  .summary { margin:0; font-size:14px; line-height:1.5; color:var(--fg2); }
  .sec { display:flex; flex-direction:column; gap:8px; }
  .sec h3 { margin:0; font-size:13px; font-weight:600; }
  .snip { margin:0; padding:8px 10px; border-radius:6px; font:12px/1.5 'IBM Plex Mono', ui-monospace, monospace;
          white-space:pre-wrap; overflow-wrap:anywhere; }
  .snip.b { background:var(--del-bg); color:var(--del-fg); }
  .snip.a { background:var(--add-bg); color:var(--add-fg); }
  .snip.c { background:var(--bg); color:var(--fg2); }
  .more { font-size:11px; color:var(--muted); }
  .ref { display:flex; flex-direction:column; gap:6px; width:100%; padding:10px; border:1px solid var(--line); border-radius:10px;
         background:transparent; text-align:left; cursor:pointer; }
  .ref:hover { border-color:var(--line-strong); background:var(--side); }
  .ref.out { border-style:dashed; }
  .ref.bad { border-color:var(--del-edge); }
  .ref .rl { font:12px 'IBM Plex Mono', ui-monospace, monospace; color:var(--fg2); overflow-wrap:anywhere; }
  .actions { margin-top:auto; display:flex; flex-wrap:wrap; gap:8px; }
  .btn { flex:1 1 130px; min-height:44px; border-radius:8px; font-size:14px; cursor:pointer;
         border:1px solid var(--line-strong); background:var(--panel); color:var(--fg); }
  .btn:hover { background:var(--hover); }
  .btn.primary { background:var(--fg); color:var(--panel); border-color:var(--fg); font-weight:500; }
  .btn.primary:hover { opacity:.9; }
  .btn.viewed { background:var(--accent-bg); color:var(--accent); border-color:var(--accent); }
  .stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .stat { padding:10px 12px; border:1px solid var(--line); border-radius:10px; }
  .stat b { display:block; font-size:18px; font-weight:600; }
  .stat span { font-size:12px; color:var(--muted); }
  .warnbox { padding:10px 12px; border:1px solid var(--del-edge); background:var(--del-bg); color:var(--del-fg); border-radius:10px; font-size:13px; }
  .empty { margin:auto; color:var(--muted); }


  /* ── merge-request mode: header actions, comments ── */
  .hbtn { display:inline-flex; align-items:center; justify-content:center; min-height:36px; padding:0 14px;
          border:1px solid var(--line-strong); border-radius:8px; background:var(--panel); color:var(--fg);
          font-size:13px; text-decoration:none; cursor:pointer; }
  .hbtn:hover { background:var(--hover); }
  .hbtn.primary { background:var(--fg); color:var(--panel); border-color:var(--fg); font-weight:500; }
  .hbtn.primary:hover { opacity:.9; }
  .hbtn:disabled { opacity:.5; cursor:not-allowed; }
  .title a { color:inherit; text-decoration:none; } .title a:hover { text-decoration:underline; }
  .who { display:flex; align-items:center; gap:8px; margin:0; font-size:12px; color:var(--muted); }
  .link { border:0; background:none; padding:0; color:var(--accent); cursor:pointer; font-size:12px; }
  .link:hover { text-decoration:underline; }
  body.mr .card .dl .lo, body.mr .card .dl .ln { cursor:pointer; }
  body.mr .card .dl .lo:hover, body.mr .card .dl .ln:hover { background:var(--accent-bg); color:var(--accent); }
  .dl.has-c .lo { box-shadow:inset 3px 0 0 var(--accent); }
  .thread, .composer { margin:4px 10px 8px 96px; border:1px solid var(--line-strong); border-radius:8px; background:var(--panel);
                       font:13px/1.45 'IBM Plex Sans', system-ui, sans-serif; color:var(--fg); cursor:auto; }
  .thread.resolved { opacity:.65; }
  .note { padding:8px 10px; } .note + .note { border-top:1px solid var(--line); }
  .nh { font-size:12px; color:var(--muted); margin-bottom:2px; } .nh b { color:var(--fg); font-weight:600; }
  .nb { white-space:pre-wrap; overflow-wrap:anywhere; }
  .thread > .link { margin:0 10px 8px; }
  .composer { padding:8px; display:flex; flex-direction:column; gap:6px; }
  .composer textarea { width:100%; min-height:64px; resize:vertical; padding:6px 8px; border:1px solid var(--line-strong);
                       border-radius:6px; background:var(--bg); color:var(--fg); font:13px/1.4 'IBM Plex Sans', system-ui, sans-serif; }
  .composer .row { display:flex; gap:8px; align-items:center; justify-content:flex-end; }
  .composer .hint { font-size:12px; color:var(--muted); }
  .composer .err { font-size:12px; color:var(--del-fg); margin-right:auto; }
  #ov .thread, #ov .composer { margin:8px 0; }
  .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); max-width:90vw; padding:10px 14px; border-radius:8px;
           background:var(--fg); color:var(--panel); font-size:13px; z-index:20; }

  @media (max-width: 1100px) {
    body { overflow:auto; }
    .panes { grid-template-columns:minmax(0, 1fr); }
    aside.side { border-right:0; border-bottom:1px solid var(--line); max-height:40vh; }
    main.map { min-height:70vh; }
    aside.detail { border-left:0; border-top:1px solid var(--line); }
    #vp { margin:0 16px; }
  }
`;
