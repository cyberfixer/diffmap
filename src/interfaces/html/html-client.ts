/**
 * Browser script for the HTML report. Reads the DIFFMAP data object written by
 * renderHtml and wires up the editor-like screen: selection (go to definition /
 * usages), the usages panel, folding, collapsing files and "viewed" progress.
 * Kept free of template-literal syntax so it can live in a TS string.
 */
export const CLIENT_SCRIPT = `
(function () {
  var D = DIFFMAP, syms = D.syms;
  var ed = byId('ed'), dock = byId('dock'), prev = byId('prev'), ulist = byId('ulist'), outsrc = byId('outsrc');
  var files = qa('.fsec');
  var sel = null, refAt = -1, tab = 'u', hist = [], lent = null;
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
  function shortName(n) { var p = n.split(/[.#:]+/); return p[p.length - 1]; }
  function markName(row, k, def) {
    var name = shortName(syms[k].name), tx = row.querySelector('.tx');
    if (!name || !tx) return;
    var w = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) {
      if (n.parentNode.classList.contains('sym')) continue;
      var t = n.nodeValue, at = -1, from = 0;
      while ((at = t.indexOf(name, from)) >= 0) {
        var b = at ? t.charAt(at - 1) : '', a = t.charAt(at + name.length);
        if (!/[A-Za-z0-9_$]/.test(b) && !/[A-Za-z0-9_$]/.test(a)) break;
        from = at + 1;
      }
      if (at < 0) continue;
      var mid = n.splitText(at); mid.splitText(name.length);
      var s = h('span', 'sym');
      s.dataset.k = k;
      if (def) s.dataset.def = '1';
      mid.parentNode.replaceChild(s, mid); s.appendChild(mid);
      return;
    }
  }
  Object.keys(defRow).forEach(function (k) { markName(defRow[k], Number(k), true); });
  Object.keys(callsOn).forEach(function (id) {
    callsOn[id].forEach(function (k) { markName(byId(id), k, false); });
  });

  // ── moving around the code ──
  function setShut(sec, on) {
    sec.classList.toggle('shut', on);
    sec.querySelector('.fold').setAttribute('aria-expanded', String(!on));
  }
  /** Scroll a row (or a whole file) into view, a third of the way down, and flash it. */
  function reveal(el) {
    if (!el || !ed.contains(el)) return;
    var sec = el.closest('.fsec');
    if (sec && sec !== el) {
      sec.classList.remove('big'); setShut(sec, false);
      if (hiddenRow(el)) { el.classList.add('shown'); regap(sec); }
    }
    hist.push(ed.scrollTop);
    if (hist.length > 50) hist.shift();
    byId('back').disabled = false;
    var top = el.getBoundingClientRect().top - ed.getBoundingClientRect().top;
    ed.scrollTop += top - (sec === el ? 0 : ed.clientHeight / 3);
    if (el.classList.contains('dl')) {
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
  }
  /** Back to where the code was before the last jump. */
  function back() {
    if (!hist.length) return;
    ed.scrollTop = hist.pop();
    byId('back').disabled = !hist.length;
  }
  byId('back').onclick = back;

  // ── resizable explorer and usages panel (sizes kept in this browser) ──
  (function () {
    var work = byId('work'), main = byId('main'), KEY = 'diffmap:panes', w = {};
    try { w = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (err) { w = {}; }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch (err) { /* private mode */ } }
    function clamp(px, min, max) { return Math.round(Math.max(min, Math.min(Math.max(min, max), px))); }
    var parts = {
      l: { el: work, prop: '--lw', set: function (ev) { return clamp(ev.clientX - work.getBoundingClientRect().left, 160, work.clientWidth - 320); } },
      b: { el: dock, prop: '--dh', set: function (ev) { return clamp(dock.getBoundingClientRect().bottom - ev.clientY, 150, main.clientHeight - 120); } }
    };
    Object.keys(parts).forEach(function (side) {
      var p = parts[side], hd = byId('rz' + side);
      if (w[side]) p.el.style.setProperty(p.prop, w[side] + 'px');
      hd.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        hd.setPointerCapture(e.pointerId);
        hd.classList.add('on'); document.body.classList.add('resizing');
        function move(ev) { w[side] = p.set(ev); p.el.style.setProperty(p.prop, w[side] + 'px'); }
        function up() {
          hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up);
          hd.classList.remove('on'); document.body.classList.remove('resizing');
          save();
        }
        hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up);
      });
      hd.addEventListener('dblclick', function () { delete w[side]; p.el.style.removeProperty(p.prop); save(); });
    });
  })();

  // ── selection ──
  function select(k, toDef) {
    var next = k === null || k === undefined || isNaN(k) ? null : k;
    // refAt: -1 is the definition, 0.. are the usages. Going to the definition starts on it.
    if (next !== sel || toDef) refAt = -1;
    sel = next;
    qa('.sf-sym').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.sel) === sel); });
    qa('.dl.sel').forEach(function (r) { r.classList.remove('sel'); });
    qa('.dl.hit').forEach(function (r) { r.classList.remove('hit', 'bad'); });
    qa('.sym').forEach(function (s) { s.classList.toggle('cur', sel !== null && Number(s.dataset.k) === sel); });
    if (sel !== null) {
      tab = 'u';
      // A large file stays collapsed until something in it is selected.
      [defRow[sel]].concat(syms[sel].refs.map(function (r) { return byId(r.el); })).forEach(function (el) {
        var c = el && el.closest('.fsec.big');
        if (c) c.classList.remove('big');
      });
      if (defRow[sel]) defRow[sel].classList.add('sel');
      syms[sel].refs.forEach(function (r) {
        var el = byId(r.el);
        if (!el) return;
        el.classList.add('hit');
        if (r.bad) el.classList.add('bad');
      });
      if (!toDef && refAt < 0 && syms[sel].refs.length) refAt = 0;
    }
    renderDock();
    if (sel !== null && toDef) reveal(defRow[sel]);
  }
  function close() { tab = 'u'; select(null); }

  /** On a usage: select the symbol it calls and go to its definition. */
  function goToDef(row) {
    var ks = callsOn[row.id || row.dataset.src];
    if (!ks) return;
    // Several changed symbols called on one line: step through them on each click.
    var i = ks.indexOf(sel), k = ks[(i + 1) % ks.length];
    select(k, true);
  }
  /** On a definition: list its usages below; each further click goes to the next one. */
  function goToRefs(k) {
    if (sel !== k) select(k, false);
    else step(1);
  }
  /** Next (1) or previous (-1) stop: the definition, then each usage, then round again. */
  function step(d) {
    if (sel === null) return;
    var n = syms[sel].refs.length + 1;
    refAt = (refAt + 1 + d + n) % n - 1;
    showRef();
  }
  /** Show the current stop: in the panel, and in the code when it is part of the diff. */
  function showRef() {
    renderDock();
    var r = syms[sel].refs[refAt];
    if (refAt < 0) reveal(defRow[sel]);
    else if (r && !r.out) reveal(byId(r.el));
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
    if (e.altKey || !files.length) return;
    // With a symbol selected the arrows walk through its usages; otherwise they scroll as usual.
    if (sel !== null && (k === 'ArrowDown' || k === 'ArrowUp')) { e.preventDefault(); step(k === 'ArrowDown' ? 1 : -1); return; }
    if (sel !== null && k === 'ArrowRight') { e.preventDefault(); refAt = -1; showRef(); return; }
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
      if (tab === 'u') what.textContent = 'Click an underlined name in the code, or a symbol in the list, to see its definition and where it is used';
      return;
    }

    var sy = syms[sel];
    var n = sy.refs.length, nOut = sy.refs.filter(function (r) { return r.out; }).length;
    var nImpl = sy.refs.filter(function (r) { return r.impl; }).length;

    // Name, where it is, and one line of counts.
    what.appendChild(h('span', 'wn st-' + sy.status, sy.name));
    var go = btn('wl', sy.file + ':' + sy.line);
    go.title = sy.kind + ' · show the definition';
    go.addEventListener('click', function () { reveal(defRow[sel]); });
    what.appendChild(go);
    var facts = [];
    if (sy.status === 'removed') facts.push(n ? 'removed, still used in ' + plural(n, 'place', 'places') : 'removed, no longer used');
    else if (!n) facts.push(sy.status === 'added' ? 'new, not used yet' : 'no usages found');
    if (n && nOut) facts.push(nOut + ' outside the diff');
    if (nImpl) facts.push(plural(nImpl, 'implementation', 'implementations'));
    if (facts.length) what.appendChild(h('span', 'wf' + (sy.status === 'removed' && n ? ' bad' : ''), '· ' + facts.join(' · ')));

    // The definition first, then the usages grouped by file: one short line each.
    ulist.appendChild(h('div', 'rf', 'Definition'));
    var db = btn('ref' + (refAt < 0 ? ' on' : ''));
    var dtext = defRow[sel] ? defRow[sel].querySelector('.tx').textContent.trim() : sy.name;
    db.title = dtext;
    db.appendChild(h('span', 'rn', String(sy.line)));
    db.appendChild(h('span', 'rt', dtext));
    db.addEventListener('click', function () { refAt = -1; showRef(); });
    ulist.appendChild(db);
    if (!n) ulist.appendChild(h('div', 'none', 'Nothing calls this symbol.'));
    var last = null;
    sy.refs.forEach(function (r, i) {
      if (r.file !== last) { ulist.appendChild(h('div', 'rf mono' + (r.out ? ' out' : ''), r.file)); last = r.file; }
      var b = btn('ref' + (r.bad ? ' bad' : '') + (i === refAt ? ' on' : ''));
      b.title = r.text.trim();
      b.appendChild(h('span', 'rn', String(r.line)));
      b.appendChild(h('span', 'rt', r.text.trim()));
      if (r.impl) b.appendChild(h('span', 'tag', 'implements'));
      b.addEventListener('click', function () { refAt = i; showRef(); });
      ulist.appendChild(b);
    });
    var on = ulist.querySelector('.ref.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    if (refAt >= 0) preview(sy.refs[refAt]); else previewDef(sy);
  }

  function previewHead(where, note) {
    var hd = h('div', 'ph');
    hd.appendChild(h('span', 'pp mono', where));
    var cp = btn('cbtn copy');
    cp.dataset.path = where; cp.title = 'Copy location';
    cp.appendChild(h('span', 'copy-label', 'Copy'));
    hd.appendChild(cp);
    if (note) hd.appendChild(h('span', 'po', note));
    prev.appendChild(hd);
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
  /** The first lines of the definition; the rest of a long one stays hidden until asked for. */
  var DEF_LINES = 12;
  function previewDef(sy) {
    previewHead(sy.file + ':' + sy.line, 'definition');
    var el = defRow[sel];
    if (!el) return;
    var removed = sy.status === 'removed', rows = [];
    for (var n = el; n; n = n.nextElementSibling) {
      if (!n.classList.contains('dl')) continue;
      var del = n.classList.contains('del');
      if (removed ? !del || Number(n.querySelector('.lo').textContent) > sy.end
                  : !del && Number(n.querySelector('.ln').textContent) > sy.end) break;
      rows.push(n);
    }
    var box = copyRows(rows), extra = rows.length - DEF_LINES;
    if (extra <= 0) return;
    qa('.dl', box).slice(DEF_LINES).forEach(function (r) { r.classList.add('extra'); });
    box.classList.add('cut');
    var more = btn('more', 'Show ' + plural(extra, 'more line', 'more lines'));
    more.addEventListener('click', function () {
      var cut = box.classList.toggle('cut');
      more.textContent = cut ? 'Show ' + plural(extra, 'more line', 'more lines') : 'Show only the first ' + DEF_LINES + ' lines';
    });
    prev.appendChild(more);
  }

  /** The code around a usage. Outside the diff: the whole calling function. */
  function preview(r) {
    var el = byId(r.el);
    previewHead(r.file + ':' + r.line, r.out ? 'outside the diff' : '');
    if (!el) return;
    if (r.out) {
      lent = el.closest('.caller');
      prev.appendChild(lent);
      prev.scrollTop = Math.max(0, el.offsetTop - prev.clientHeight / 2);
      return;
    }
    // Part of the diff: the lines around it (the code above scrolls to the real one).
    var rows = [el], a = el.previousElementSibling, z = el.nextElementSibling, i;
    for (i = 0; i < 4 && a && !a.classList.contains('gap'); a = a.previousElementSibling) {
      if (a.classList.contains('dl') && !hiddenRow(a)) { rows.unshift(a); i++; }
    }
    for (i = 0; i < 4 && z && !z.classList.contains('gap'); z = z.nextElementSibling) {
      if (z.classList.contains('dl') && !hiddenRow(z)) { rows.push(z); i++; }
    }
    copyRows(rows);
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
        if (x.path !== last) { list.appendChild(h('div', 'rf mono', x.path)); last = x.path; }
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
  function updateViewed() {
    var n = 0;
    files.forEach(function (sec) {
      var on = isViewed(sec), stale = isStale(sec);
      if (on) n++;
      sec.classList.toggle('seen', on);
      sec.classList.toggle('stale', stale);
      sec.querySelector('.fv').checked = on;
      var b = document.querySelector('.sf-file[data-card="' + sec.id + '"]');
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
  window.diffmap = { reveal: reveal, showTab: showTab };

  // Files already viewed start collapsed.
  files.forEach(function (sec) { if (isViewed(sec)) setShut(sec, true); });
  updateViewed();
  renderDock();
})();
`;
