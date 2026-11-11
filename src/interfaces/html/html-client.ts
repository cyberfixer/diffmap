/**
 * Browser script for the HTML report. Reads the DIFFMAP data object written by
 * renderHtml and wires up the editor-like screen: selection (the code goes to the
 * definition, the panel below shows the usages), back / forward, the list of calls
 * into removed code, folding, collapsing files and "viewed" progress.
 * Kept free of template-literal syntax so it can live in a TS string.
 */
export const CLIENT_SCRIPT = `
(function () {
  var D = DIFFMAP, syms = D.syms;
  var ed = byId('ed'), dock = byId('dock'), prev = byId('prev'), ulist = byId('ulist'), outsrc = byId('outsrc');
  var files = qa('.fsec');
  // sel: the selected symbol. refAt: which of its usages the panel shows (-1 when it has none).
  var sel = null, refAt = -1, tab = 'u', hist = [], fwd = [], lent = null;
  var viewed = loadViewed();

  function byId(i) { return document.getElementById(i); }
  function qa(q, root) { return [].slice.call((root || document).querySelectorAll(q)); }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function btn(cls, text) { var b = h('button', cls, text); b.type = 'button'; return b; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // The rows that call a changed symbol, and which symbols they call.
  var callsOn = {};
  syms.forEach(function (sy, k) {
    sy.refs.forEach(function (r) {
      var el = byId(r.el);
      if (!el || el.classList.contains('def')) return;
      (callsOn[r.el] = callsOn[r.el] || []).indexOf(k) < 0 && callsOn[r.el].push(k);
      el.classList.add('call');
      el.title = 'Go to ' + (callsOn[r.el].map(function (j) { return syms[j].name; }).join(', '));
    });
  });

  // The row where each changed symbol starts.
  var defRow = {};
  qa('[data-defs]').forEach(function (r) {
    r.dataset.defs.split(' ').forEach(function (k) { if (!defRow[k]) defRow[k] = r; });
  });

  // ── underline the symbol's name on its definition and on each usage, like a link in an editor ──
  var symSpans = {};
  function shortName(n) { var p = n.split(/[.#:]+/); return p[p.length - 1]; }
  function markName(row, k, def) {
    var name = shortName(syms[k].name), tx = row.querySelector('.tx');
    if (!name || !tx) return;
    // The name can run over several pieces of the line (syntax colours, changed letters),
    // so look for it in the whole line and then find the pieces it covers.
    var parts = [], text = '', w = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) { parts.push({ n: n, at: text.length }); text += n.nodeValue; }
    function part(pos, end) {
      for (var i = parts.length - 1; i >= 0; i--) {
        if (parts[i].at < pos || (!end && parts[i].at === pos)) return parts[i];
      }
      return parts[0];
    }
    var at = -1, from = 0;
    while ((at = text.indexOf(name, from)) >= 0) {
      var b = at ? text.charAt(at - 1) : '', a = text.charAt(at + name.length);
      var taken = part(at, false).n.parentNode.closest('.sym'); // already another symbol's name
      if (!/[A-Za-z0-9_$]/.test(b) && !/[A-Za-z0-9_$]/.test(a) && !taken) break;
      from = at + 1;
    }
    if (at < 0) return;
    var p0 = part(at, false), p1 = part(at + name.length, true);
    var s = h('span', 'sym');
    s.dataset.k = k;
    if (def) s.dataset.def = '1';
    if (p0.n === p1.n) {
      // The usual case, and the quick one: the name is inside one piece.
      var mid = p0.n.splitText(at - p0.at); mid.splitText(name.length);
      mid.parentNode.replaceChild(s, mid); s.appendChild(mid);
    } else {
      var r = document.createRange();
      r.setStart(p0.n, at - p0.at);
      r.setEnd(p1.n, at + name.length - p1.at);
      s.appendChild(r.extractContents());
      r.insertNode(s);
    }
    (symSpans[k] = symSpans[k] || []).push(s);
  }
  Object.keys(defRow).forEach(function (k) { markName(defRow[k], Number(k), true); });
  Object.keys(callsOn).forEach(function (id) {
    callsOn[id].forEach(function (k) { markName(byId(id), k, false); });
  });

  // ── moving around the code ──
  function setShut(sec, on) {
    // Collapsing a file from somewhere inside it removes everything between its header and
    // the screen, which would pull many later files past the reader. Stay on its header.
    var inside = on && !sec.classList.contains('shut') && sec.getBoundingClientRect().top < ed.getBoundingClientRect().top;
    sec.classList.toggle('shut', on);
    sec.querySelector('.fold').setAttribute('aria-expanded', String(!on));
    if (inside) ed.scrollTop += sec.getBoundingClientRect().top - ed.getBoundingClientRect().top;
  }
  // A path with right-to-left names (Arabic, Hebrew) keeps its folders in order, left to right.
  function lp(path) { return /[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFC]/.test(path) ? path.split('/').join('/\\u200E') : path; }
  /**
   * Scroll a row (or a whole file) into view, a third of the way down, and flash it.
   * "from" is where the reader was (see here()), for Back; left out, it is taken now.
   */
  function reveal(el, from) {
    if (!el || !ed.contains(el)) return;
    var sec = el.closest('.fsec');
    if (sec && sec !== el) {
      sec.classList.remove('big'); setShut(sec, false);
      if (hiddenRow(el)) { el.classList.add('shown'); regap(sec); }
    }
    hist.push(from || here());
    if (hist.length > 50) hist.shift();
    fwd = [];
    navButtons();
    function place() {
      var top = el.getBoundingClientRect().top - ed.getBoundingClientRect().top;
      ed.scrollTop += top - (sec === el ? 0 : ed.clientHeight / 3);
    }
    place();
    // Files off screen are not laid out until they are near (content-visibility), so
    // the first jump lands by estimate. Once they are measured, land exactly.
    requestAnimationFrame(place);
    if (el.classList.contains('dl')) {
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
  }

  // ── back and forward, like a browser: where the code was and what was selected ──
  function here() { return { top: ed.scrollTop, sel: sel, at: refAt }; }
  function navButtons() { byId('back').disabled = !hist.length; byId('fwd').disabled = !fwd.length; }
  function travel(from, to) {
    if (!from.length) return;
    to.push(here());
    var s = from.pop();
    paint(s.sel, s.at);
    ed.scrollTop = s.top;
    navButtons();
  }
  function back() { travel(hist, fwd); }
  function forward() { travel(fwd, hist); }
  byId('back').onclick = back;
  byId('fwd').onclick = forward;

  // ── resizable explorer and usages panel (sizes kept in this browser) ──
  (function () {
    var work = byId('work'), main = byId('main'), KEY = 'diffmap:panes', w = {};
    try { w = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (err) { w = {}; }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch (err) { /* private mode */ } }
    function clamp(px, min, max) { return Math.round(Math.max(min, Math.min(Math.max(min, max), px))); }
    // measure(): read the layout once, when the drag starts. set(): the new size for a pointer position.
    var parts = {
      l: { el: work, prop: '--lw',
           measure: function () { return { edge: work.getBoundingClientRect().left, room: work.clientWidth - 320 }; },
           set: function (ev, m) { return clamp(ev.clientX - m.edge, 160, m.room); } },
      b: { el: dock, prop: '--dh',
           measure: function () { return { edge: dock.getBoundingClientRect().bottom, room: main.clientHeight - 120 }; },
           set: function (ev, m) { return clamp(m.edge - ev.clientY, 150, m.room); } }
    };
    Object.keys(parts).forEach(function (side) {
      var p = parts[side], hd = byId('rz' + side);
      if (w[side]) p.el.style.setProperty(p.prop, w[side] + 'px');
      hd.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        hd.setPointerCapture(e.pointerId);
        hd.classList.add('on'); document.body.classList.add('resizing');
        var m = p.measure(), frame = 0;
        // The pointer can move many times between two frames: lay the page out once per frame.
        function apply() { frame = 0; p.el.style.setProperty(p.prop, w[side] + 'px'); }
        function move(ev) { w[side] = p.set(ev, m); if (!frame) frame = requestAnimationFrame(apply); }
        function up() {
          hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up);
          hd.removeEventListener('pointercancel', up);
          if (frame) { cancelAnimationFrame(frame); apply(); }
          hd.classList.remove('on'); document.body.classList.remove('resizing');
          save();
        }
        hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up);
        hd.addEventListener('pointercancel', up);
      });
      hd.addEventListener('dblclick', function () { delete w[side]; p.el.style.removeProperty(p.prop); save(); });
    });
  })();

  // ── selection ──
  // The code column goes to the definition and stays there; the panel below shows the usages.
  var symBtn = {};
  qa('.sf-sym').forEach(function (b) { symBtn[b.dataset.sel] = b; });
  var marked = []; // what the selection has highlighted, so clearing it doesn't search the whole page
  function mark(el, cls) { if (el) { el.classList.add(cls); marked.push(el); } }
  /** Highlight symbol k (or nothing) and show its usage number "at" in the panel. Does not scroll. */
  function paint(k, at) {
    marked.forEach(function (el) { el.classList.remove('sel', 'hit', 'bad', 'cur', 'on'); });
    marked = [];
    sel = k === null || k === undefined || isNaN(k) ? null : k;
    refAt = -1;
    if (sel !== null) {
      var refs = syms[sel].refs;
      if (refs.length) refAt = Math.max(0, Math.min(refs.length - 1, at || 0));
      tab = 'u';
      mark(symBtn[sel], 'on');
      (symSpans[sel] || []).forEach(function (s) { mark(s, 'cur'); });
      mark(defRow[sel], 'sel');
      refs.forEach(function (r) {
        var el = byId(r.el);
        mark(el, 'hit');
        if (el && r.bad) el.classList.add('bad');
      });
      // A large file stays collapsed until something in it is selected.
      [defRow[sel]].concat(refs.map(function (r) { return byId(r.el); })).forEach(function (el) {
        var c = el && el.closest('.fsec.big');
        if (c) c.classList.remove('big');
      });
    }
    renderDock();
  }
  /** Select a symbol; with toDef the code goes to its definition. "at" picks the usage shown below. */
  function select(k, toDef, at) {
    var from = here();
    paint(k, at !== undefined ? at : k === sel ? refAt : 0);
    if (sel !== null && toDef) reveal(defRow[sel], from);
  }
  function close() { tab = 'u'; paint(null); }

  /** On a usage: select the symbol it calls, go to its definition, and show this usage below. */
  function goToDef(row) {
    var id = row.id || row.dataset.src, ks = callsOn[id];
    if (!ks) return;
    // Several changed symbols called on one line: step through them on each click.
    var i = ks.indexOf(sel), k = ks[(i + 1) % ks.length], at = 0;
    syms[k].refs.forEach(function (r, j) { if (r.el === id) at = j; });
    select(k, true, at);
  }
  /** On a definition: list its usages below; each further click shows the next one. */
  function goToRefs(k) {
    if (sel !== k) select(k, false);
    else step(1);
  }
  /** Next (1) or previous (-1) usage in the panel, round again at the ends. The code stays where it is. */
  function step(d) {
    if (sel === null) return;
    var n = syms[sel].refs.length;
    if (!n) return;
    refAt = (refAt + d + n) % n;
    renderDock();
  }

  document.addEventListener('click', function (e) {
    var t = e.target, x;
    if (!t.closest('#ed, #prev')) return;
    if ((x = t.closest('.gap button'))) { openGap(x); return; }
    if ((x = t.closest('.bigbar'))) { x.closest('.fsec').classList.remove('big'); return; }
    if ((x = t.closest('.expand'))) { wholeFile(x); return; }
    if ((x = t.closest('.fold'))) { x = x.closest('.fsec'); setShut(x, !x.classList.contains('shut')); return; }
    if (t.closest('button, a, input, label, textarea, .thread, .composer')) return;
    if (window.getSelection().toString()) return;
    if (D.mr && t.closest('.lo, .ln, .sg')) return; // in a merge request the line number (and the "+" beside it) starts a comment
    // Like an editor: on a usage, go to the definition; on a definition, show its usages.
    var name = t.closest('.sym');
    if (name) {
      var k = Number(name.dataset.k);
      if (name.dataset.def) goToRefs(k); else select(k, true);
      return;
    }
    var call = t.closest('.dl.call');
    if (call) { goToDef(call); return; }
    var row = t.closest('.dl.def');
    if (row) goToRefs(Number(row.dataset.sel));
  });
  qa('.sf-sym').forEach(function (b) {
    // Always goes to the definition, opening its file first when that is collapsed (Esc clears).
    b.addEventListener('click', function () { select(Number(b.dataset.sel), true); });
  });
  qa('.tf-dir').forEach(function (b) {
    b.addEventListener('click', function () { b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') === 'false')); });
  });
  qa('.sf-file').forEach(function (b) {
    b.addEventListener('click', function () {
      var sec = byId(b.dataset.card);
      setShut(sec, false); // a collapsed file opens when picked in the list
      reveal(sec);
    });
  });

  // ── keyboard (the status bar lists these) ──
  /** The file at the top of the code area. */
  function curFile() {
    var top = ed.getBoundingClientRect().top + 1, cur = files[0];
    files.forEach(function (sec) { if (sec.getBoundingClientRect().top <= top) cur = sec; });
    return cur;
  }
  function fileStep(d) {
    var i = files.indexOf(curFile()) + d;
    if (i >= 0 && i < files.length) reveal(files[i]);
  }
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'F4' && sel !== null) { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey) return;
    if (k === 'Escape') { if (dock.classList.contains('open')) close(); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); back(); return; }
    if (k === 'ArrowRight') { e.preventDefault(); forward(); return; }
    if (e.altKey || !files.length) return;
    // With a symbol selected the up and down arrows walk through its usages; otherwise they scroll as usual.
    if (sel !== null && (k === 'ArrowDown' || k === 'ArrowUp')) { e.preventDefault(); step(k === 'ArrowDown' ? 1 : -1); return; }
    k = k.toLowerCase();
    if (k === '/') { e.preventDefault(); showTab('s'); byId('q').focus(); byId('q').select(); }
    else if (k === 'n') fileStep(1);
    else if (k === 'p') fileStep(-1);
    else if (k === 'v') curFile().querySelector('.fv').click();
    else if (k === 'c') { var sec = curFile(); setShut(sec, !sec.classList.contains('shut')); }
  });

  // ── filter the explorer ──
  byId('filter').addEventListener('input', function () {
    var q = this.value.trim().toLowerCase();
    qa('.sf').forEach(function (sf) {
      var f = sf.querySelector('.sf-file'), all = !q || f.title.toLowerCase().indexOf(q) >= 0, any = all;
      qa('.sf-sym', sf).forEach(function (b) {
        var on = all || b.querySelector('.nm').textContent.toLowerCase().indexOf(q) >= 0;
        b.hidden = !on;
        if (on) any = true;
      });
      sf.hidden = !any;
    });
    qa('.tf').reverse().forEach(function (tf) { tf.hidden = !tf.querySelector('.sf:not([hidden])'); });
  });

  // ── the panel under the code: usages of the selected symbol, and (merge requests) comments ──
  function showTab(t) { tab = t; renderDock(); }
  byId('tabu').onclick = function () { showTab('u'); };
  byId('tabs').onclick = function () { showTab(tab === 's' ? 'u' : 's'); if (tab === 's') byId('q').focus(); };
  if (byId('tabc')) byId('tabc').onclick = function () { showTab(tab === 'c' ? 'u' : 'c'); };
  if (byId('tabb')) byId('tabb').onclick = function () { showTab(tab === 'b' ? 'u' : 'b'); };
  if (byId('brokenpill')) byId('brokenpill').onclick = function () { showTab('b'); };

  // ── calls that still point at code this change removes: one list of all of them ──
  (function () {
    var list = byId('blist');
    if (!list) return;
    syms.forEach(function (sy, k) {
      var head = false;
      sy.refs.forEach(function (r, i) {
        if (!r.bad) return;
        if (!head) {
          var hd = h('div', 'rf mono');
          hd.appendChild(h('span', 'gone', sy.name));
          hd.appendChild(document.createTextNode(' · removed from ' + lp(sy.file)));
          list.appendChild(hd);
          head = true;
        }
        var b = btn('ref bad');
        b.title = 'Show this call, and the removed code it points at';
        b.appendChild(h('span', 'rp', lp(r.file) + ':' + r.line));
        b.appendChild(h('span', 'rt', r.text.trim()));
        if (r.out) b.appendChild(h('span', 'tag', 'outside the diff'));
        // The code goes to what was removed; the Usages tab shows this call.
        b.addEventListener('click', function () { select(k, true, i); });
        list.appendChild(b);
      });
    });
  })();
  byId('closed').onclick = close;
  byId('nextu').onclick = function () { step(1); };
  byId('prevu').onclick = function () { step(-1); };

  function renderDock() {
    var cp = byId('cpane');
    if (!cp && tab === 'c') tab = 'u';
    var open = sel !== null || tab !== 'u', usages = tab === 'u' && sel !== null;
    dock.classList.toggle('open', open);
    byId('tabu').setAttribute('aria-selected', String(tab === 'u'));
    if (cp) { byId('tabc').setAttribute('aria-selected', String(tab === 'c')); cp.hidden = tab !== 'c'; }
    byId('tabs').setAttribute('aria-selected', String(tab === 's'));
    byId('spane').hidden = tab !== 's';
    if (byId('tabb')) { byId('tabb').setAttribute('aria-selected', String(tab === 'b')); byId('bpane').hidden = tab !== 'b'; }
    byId('upane').hidden = tab !== 'u';
    byId('ucount').textContent = sel === null ? 0 : syms[sel].refs.length;
    byId('closed').hidden = !open;
    byId('prevu').hidden = byId('nextu').hidden = !usages || !syms[sel].refs.length;

    var what = byId('what');
    what.textContent = '';
    // A caller shown in the preview goes back to where it is kept.
    if (lent) { outsrc.appendChild(lent); lent = null; }
    ulist.textContent = ''; prev.textContent = '';
    if (!usages) {
      if (tab === 'u') what.textContent = 'Click an underlined name in the code, or a symbol in the list: the code goes to its definition and its usages are listed here';
      if (tab === 'b') what.textContent = 'Calls that still point at code this change removes. Click one to see it and what was removed';
      return;
    }

    var sy = syms[sel];
    var n = sy.refs.length, nOut = sy.refs.filter(function (r) { return r.out; }).length;
    var nImpl = sy.refs.filter(function (r) { return r.impl; }).length;

    // Name, where it is, and one line of counts.
    what.appendChild(h('span', 'wn st-' + sy.status, sy.name));
    var go = btn('wl', lp(sy.file) + ':' + sy.line);
    go.title = sy.kind + ' · go to the definition in the code above';
    go.addEventListener('click', function () { reveal(defRow[sel]); });
    what.appendChild(go);
    var facts = [];
    if (sy.status === 'removed') facts.push(n ? 'removed, still used in ' + plural(n, 'place', 'places') : 'removed, no longer used');
    else if (!n) facts.push(sy.status === 'added' ? 'new, not used yet' : 'no usages found');
    if (n && nOut) facts.push(nOut + ' outside the diff');
    if (nImpl) facts.push(plural(nImpl, 'implementation', 'implementations'));
    if (facts.length) what.appendChild(h('span', 'wf' + (sy.status === 'removed' && n ? ' bad' : ''), '· ' + facts.join(' · ')));

    // The usages grouped by file: one short line each. (The definition is in the code above.)
    if (!n) ulist.appendChild(h('div', 'none', 'Nothing calls this symbol.'));
    var last = null;
    sy.refs.forEach(function (r, i) {
      if (r.file !== last) { ulist.appendChild(h('div', 'rf mono' + (r.out ? ' out' : ''), lp(r.file))); last = r.file; }
      var b = btn('ref' + (r.bad ? ' bad' : '') + (i === refAt ? ' on' : ''));
      b.title = r.text.trim();
      b.appendChild(h('span', 'rn', String(r.line)));
      b.appendChild(h('span', 'rt', r.text.trim()));
      if (r.impl) b.appendChild(h('span', 'tag', 'implements'));
      b.addEventListener('click', function () { refAt = i; renderDock(); });
      ulist.appendChild(b);
    });
    var on = ulist.querySelector('.ref.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    if (refAt >= 0) preview(sy.refs[refAt]);
  }

  function previewHead(where, note) {
    var hd = h('div', 'ph');
    hd.appendChild(h('span', 'pp mono', lp(where)));
    var cp = btn('cbtn copy');
    cp.dataset.path = where; cp.title = 'Copy location';
    cp.appendChild(h('span', 'copy-label', 'Copy'));
    hd.appendChild(cp);
    if (note) hd.appendChild(h('span', 'po', note));
    prev.appendChild(hd);
    return hd;
  }
  /** A read-only copy of code rows for the panel (the code above keeps the real ones). */
  function copyRows(rows) {
    var box = h('div', 'code ro');
    rows.forEach(function (row) {
      var c = row.cloneNode(true);
      if (row.id) { c.dataset.src = row.id; c.removeAttribute('id'); }
      c.classList.remove('flash', 'has-c', 'far', 'shown');
      box.appendChild(c);
    });
    prev.appendChild(box);
    return box;
  }
  /** The code around a usage. Outside the diff: the whole calling function. */
  var AROUND = 10;
  function preview(r) {
    var el = byId(r.el);
    var hd = previewHead(r.file + ':' + r.line, r.out ? 'outside the diff' : '');
    if (!el) return;
    if (!r.out) {
      // The code above stays on the definition; this takes it to the usage when asked.
      var open = btn('cbtn', 'Show in the code above');
      open.title = 'Scroll the code to this line (← comes back)';
      open.addEventListener('click', function () { reveal(el); });
      hd.appendChild(open);
    }
    if (r.out) {
      lent = el.closest('.caller');
      prev.appendChild(lent);
      prev.scrollTop = Math.max(0, el.offsetTop - prev.clientHeight / 2);
      return;
    }
    // Part of the diff: a copy of the lines around it, folded ones too.
    var rows = [el], a = el.previousElementSibling, z = el.nextElementSibling, i;
    for (i = 0; i < AROUND && a; a = a.previousElementSibling) {
      if (a.classList.contains('dl')) { rows.unshift(a); i++; }
    }
    for (i = 0; i < AROUND && z; z = z.nextElementSibling) {
      if (z.classList.contains('dl')) { rows.push(z); i++; }
    }
    var at = copyRows(rows).children[rows.indexOf(el)];
    prev.scrollTop = Math.max(0, at.offsetTop - prev.clientHeight / 2);
  }

  // ── search: the text of the files in the diff only (every line of them, folded ones too) ──
  (function () {
    var q = byId('q'), list = byId('slist'), count = byId('qn'), MAX = 300, hits = [], at = -1, timer = null, index = null;
    function build() {
      index = [];
      files.forEach(function (sec) {
        qa('.dl', sec).forEach(function (row) {
          index.push({ row: row, path: sec.dataset.path, text: row.querySelector('.tx').textContent });
        });
      });
    }
    function go(i) {
      if (!hits.length) return;
      at = (i + hits.length) % hits.length;
      hits.forEach(function (x, j) { x.b.classList.toggle('on', j === at); });
      if (hits[at].b.scrollIntoView) hits[at].b.scrollIntoView({ block: 'nearest' });
      reveal(hits[at].row);
    }
    function run() {
      var term = q.value.toLowerCase(), last = null, total = 0;
      list.textContent = ''; hits = []; at = -1;
      if (!term.trim()) { count.textContent = ''; return; }
      if (!index) build();
      index.forEach(function (x) {
        var p = x.text.toLowerCase().indexOf(term);
        if (p < 0) return;
        total++;
        if (hits.length >= MAX) return;
        if (x.path !== last) { list.appendChild(h('div', 'rf mono', lp(x.path))); last = x.path; }
        var del = x.row.classList.contains('del');
        var b = btn('ref' + (del ? ' del' : x.row.classList.contains('add') ? ' add' : ''));
        b.title = del ? 'A removed line' : '';
        b.appendChild(h('span', 'rn', x.row.querySelector(del ? '.lo' : '.ln').textContent));
        var t = h('span', 'rt', (p > 40 ? '…' : '') + x.text.slice(Math.max(0, p - 40), p).replace(/^\\s+/, ''));
        t.appendChild(h('mark', '', x.text.slice(p, p + term.length)));
        t.appendChild(document.createTextNode(x.text.slice(p + term.length)));
        b.appendChild(t);
        var n = hits.length;
        b.addEventListener('click', function () { go(n); });
        list.appendChild(b);
        hits.push({ b: b, row: x.row });
      });
      count.textContent = !total ? 'No lines match in the changed files'
        : plural(total, 'line', 'lines') + (total > MAX ? ' · showing the first ' + MAX : '') + ' · Enter for the next one';
    }
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(run, 150); });
    q.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); if (at < 0 && !hits.length) run(); go(at + (e.shiftKey ? -1 : 1)); }
      if (e.key === 'Escape') { q.blur(); close(); }
    });
  })();

  // ── folding ──
  // Unchanged lines far from a change are folded (class "far"). The bar in their place opens
  // some from its top, some from its bottom, or all of them (class "shown");
  // "Changes only" folds them all again.
  var STEP = 20;
  function hiddenRow(r) { return r.classList.contains('far') && !r.classList.contains('shown'); }
  function gapButton(act, text, title) {
    var b = btn(act === 'all' ? '' : 'ga', text);
    b.dataset.act = act; b.title = title;
    return b;
  }
  /** Put a bar wherever a file has a run of folded lines, and set its Whole file / Changes only button. */
  function regap(sec) {
    qa('.gap', sec).forEach(function (g) { g.remove(); });
    var code = sec.querySelector('.code'), n = code.firstElementChild;
    while (n) {
      if (!hiddenRow(n)) { n = n.nextElementSibling; continue; }
      var first = n, count = 0;
      while (n && hiddenRow(n)) { count++; n = n.nextElementSibling; }
      var g = h('div', 'gap');
      if (count > STEP) g.appendChild(gapButton('top', '↓ Show ' + STEP + ' from the top', 'Show the first ' + STEP + ' of these lines'));
      g.appendChild(gapButton('all', '⋯ ' + plural(count, 'unchanged line', 'unchanged lines') + (count > STEP ? ' · show all' : ''), 'Show all of these lines'));
      if (count > STEP) g.appendChild(gapButton('bottom', '↑ Show ' + STEP + ' from the bottom', 'Show the last ' + STEP + ' of these lines'));
      code.insertBefore(g, first);
    }
    var b = sec.querySelector('.expand');
    if (!b) return;
    var open = sec.classList.contains('whole') || !!sec.querySelector('.dl.shown');
    b.setAttribute('aria-pressed', String(open));
    b.textContent = open ? 'Changes only' : 'Whole file';
    b.title = open ? 'Fold all unchanged lines again' : 'Show the whole file';
  }
  function openGap(b) {
    var g = b.closest('.gap'), rows = [], n = g.nextElementSibling;
    while (n && hiddenRow(n)) { rows.push(n); n = n.nextElementSibling; }
    var act = b.dataset.act;
    (act === 'top' ? rows.slice(0, STEP) : act === 'bottom' ? rows.slice(-STEP) : rows).forEach(function (r) { r.classList.add('shown'); });
    regap(g.closest('.fsec'));
  }
  /** Whole file, or back to the changes only (which also folds lines opened by hand). */
  function wholeFile(b) {
    var sec = b.closest('.fsec');
    if (sec.classList.contains('whole') || sec.querySelector('.dl.shown')) {
      sec.classList.remove('whole');
      qa('.dl.shown', sec).forEach(function (r) { r.classList.remove('shown'); });
    } else sec.classList.add('whole');
    regap(sec);
  }
  files.forEach(regap);

  // ── viewed files ──
  // On the service the marks are saved on the server, per user; in a standalone
  // report they stay in this browser. A viewed file is collapsed.
  // A mark is saved with the version of the file's change (data-rev) and only
  // counts while the change still has that version: a later push that changes
  // the file again clears it.
  function fileId(sec) { return 'file:' + sec.dataset.path; }
  function loadViewed() {
    if (D.mr) return D.mr.viewed;
    // A report file is one fixed change, so its marks need no version.
    try { return JSON.parse(localStorage.getItem(D.key) || '[]').reduce(function (o, id) { o[id] = true; return o; }, {}); }
    catch (err) { return {}; }
  }
  function isViewed(sec) { var v = viewed[fileId(sec)]; return v === true || v === sec.dataset.rev; }
  // Marked as viewed before, but the file has changed since.
  function isStale(sec) { var v = viewed[fileId(sec)]; return typeof v === 'string' && v !== '' && v !== sec.dataset.rev; }
  function saveViewed(sec, on) {
    if (D.mr) {
      return fetch(D.mr.apiBase + '/viewed', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: fileId(sec), rev: sec.dataset.rev, viewed: on })
      }).then(function (r) { if (!r.ok) throw new Error('save failed'); });
    }
    try { localStorage.setItem(D.key, JSON.stringify(Object.keys(viewed))); } catch (err) { /* private mode */ }
    return Promise.resolve();
  }
  var fileBtn = {};
  qa('.sf-file').forEach(function (b) { fileBtn[b.dataset.card] = b; });
  function updateViewed() {
    var n = 0;
    files.forEach(function (sec) {
      var on = isViewed(sec), stale = isStale(sec);
      if (on) n++;
      sec.classList.toggle('seen', on);
      sec.classList.toggle('stale', stale);
      sec.querySelector('.fv').checked = on;
      var b = fileBtn[sec.id];
      if (b) {
        b.classList.toggle('seen', on);
        b.classList.toggle('stale', stale);
        b.querySelector('.vw').textContent = on ? '✓' : stale ? '●' : '';
        b.querySelector('.vw').title = stale ? 'Changed since you viewed it' : '';
      }
    });
    byId('vcount').textContent = n;
    byId('vbar').style.width = (files.length ? Math.round(n / files.length * 100) : 0) + '%';
  }
  function setViewed(sec, on) {
    if (on) viewed[fileId(sec)] = D.mr ? sec.dataset.rev : true; else delete viewed[fileId(sec)];
    setShut(sec, on);
    updateViewed();
  }
  ed.addEventListener('change', function (e) {
    if (!e.target.classList.contains('fv')) return;
    var sec = e.target.closest('.fsec'), on = e.target.checked, before = viewed[fileId(sec)];
    setViewed(sec, on);
    saveViewed(sec, on).catch(function () {
      // Put it back and say so if the server could not save it.
      if (before === undefined) delete viewed[fileId(sec)]; else viewed[fileId(sec)] = before;
      setShut(sec, isViewed(sec));
      updateViewed();
      var t = h('div', 'toast', 'Could not save "viewed" for ' + sec.dataset.path + '. Try again.');
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
      setTimeout(function () { t.remove(); }, 5000);
    });
  });

  // ── copy a path. The Clipboard API can be missing on file:// pages, so fall back. ──
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
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.copy');
    if (!b) return;
    var label = b.querySelector('.copy-label');
    copyText(b.dataset.path).then(function (ok) {
      label.textContent = ok ? 'Copied' : 'Copy failed';
      b.classList.toggle('done', ok);
      clearTimeout(b._t);
      b._t = setTimeout(function () { label.textContent = 'Copy'; b.classList.remove('done'); }, 1400);
    });
  });

  // Hooks for the merge-request script.
  window.diffmap = { reveal: reveal, showTab: showTab, setShut: setShut, lp: lp };

  // Files already viewed start collapsed.
  files.forEach(function (sec) { if (isViewed(sec)) setShut(sec, true); });
  updateViewed();
  renderDock();
})();
`;
