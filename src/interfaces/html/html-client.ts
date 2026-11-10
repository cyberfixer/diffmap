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
    if (sec && sec !== el) { sec.classList.remove('big'); setShut(sec, false); }
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
    if (next !== sel) refAt = -1;
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
      if (refAt < 0 && syms[sel].refs.length) refAt = 0;
    }
    renderDock();
    if (sel !== null && toDef) reveal(defRow[sel]);
  }
  function toggle(k) { select(sel === k ? null : k, true); }
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
  function step(d) {
    if (sel === null) return;
    var n = syms[sel].refs.length;
    if (!n) return;
    refAt = (refAt + d + n) % n;
    showRef();
  }
  /** Show the current usage: in the panel, and in the code when it is part of the diff. */
  function showRef() {
    renderDock();
    var r = syms[sel].refs[refAt];
    if (r && !r.out) reveal(byId(r.el));
  }

  document.addEventListener('click', function (e) {
    var t = e.target, x;
    if (!t.closest('#ed, #prev')) return;
    if ((x = t.closest('.gap'))) { expandGap(x); return; }
    if ((x = t.closest('.bigbar'))) { x.closest('.fsec').classList.remove('big'); return; }
    if ((x = t.closest('.expand'))) { wholeFile(x); return; }
    if ((x = t.closest('.fold'))) { x = x.closest('.fsec'); setShut(x, !x.classList.contains('shut')); return; }
    if (t.closest('button, a, input, label, textarea, .thread, .composer')) return;
    if (window.getSelection().toString()) return;
    if (D.mr && t.closest('.lo, .ln')) return; // in a merge request the line number starts a comment
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
    b.addEventListener('click', function () { toggle(Number(b.dataset.sel)); });
  });
  qa('.tf-dir').forEach(function (b) {
    b.addEventListener('click', function () { b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') === 'false')); });
  });
  qa('.sf-file').forEach(function (b) {
    b.addEventListener('click', function () { reveal(byId(b.dataset.card)); });
  });
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape' && !typing && dock.classList.contains('open')) close();
    if (e.key === 'F4' && sel !== null) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    if (e.key === 'ArrowLeft' && e.altKey && !typing) { e.preventDefault(); back(); }
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
  if (byId('tabc')) byId('tabc').onclick = function () { showTab(tab === 'c' ? 'u' : 'c'); };
  byId('closed').onclick = close;
  byId('nextu').onclick = function () { step(1); };
  byId('prevu').onclick = function () { step(-1); };

  function renderDock() {
    var cp = byId('cpane');
    if (!cp) tab = 'u';
    var open = sel !== null || tab === 'c', usages = tab === 'u' && sel !== null;
    dock.classList.toggle('open', open);
    byId('tabu').setAttribute('aria-selected', String(tab === 'u'));
    if (cp) { byId('tabc').setAttribute('aria-selected', String(tab === 'c')); cp.hidden = tab !== 'c'; }
    byId('upane').hidden = tab !== 'u';
    byId('ucount').textContent = sel === null ? 0 : syms[sel].refs.length;
    byId('closed').hidden = !open;
    byId('prevu').hidden = byId('nextu').hidden = !usages || syms[sel].refs.length < 2;

    var what = byId('what');
    what.textContent = '';
    // A caller shown in the preview goes back to where it is kept.
    if (lent) { outsrc.appendChild(lent); lent = null; }
    ulist.textContent = ''; prev.textContent = '';
    if (!usages) {
      if (tab === 'u') what.textContent = 'Click an underlined name in the code, or a symbol in the list, to see where it is used';
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

    if (!n) { ulist.appendChild(h('div', 'none', 'Nothing calls this symbol.')); return; }

    // Usages, grouped by file: one short line each.
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
    if (refAt >= 0) preview(sy.refs[refAt]);
  }

  /** The code around a usage. Outside the diff: the whole calling function. */
  function preview(r) {
    var el = byId(r.el);
    var hd = h('div', 'ph');
    hd.appendChild(h('span', 'pp mono', r.file + ':' + r.line));
    var cp = btn('cbtn copy');
    cp.dataset.path = r.file + ':' + r.line; cp.title = 'Copy location';
    cp.appendChild(h('span', 'copy-label', 'Copy'));
    hd.appendChild(cp);
    if (r.out) hd.appendChild(h('span', 'po', 'outside the diff'));
    prev.appendChild(hd);
    if (!el) return;
    if (r.out) {
      lent = el.closest('.caller');
      prev.appendChild(lent);
      prev.scrollTop = Math.max(0, el.offsetTop - prev.clientHeight / 2);
      return;
    }
    // Part of the diff: a read-only copy of the lines around it (the code above scrolls to the real one).
    var rows = [el], a = el.previousElementSibling, z = el.nextElementSibling, i;
    for (i = 0; i < 4 && a && !a.classList.contains('gap'); a = a.previousElementSibling) {
      if (a.classList.contains('dl') && !a.classList.contains('far')) { rows.unshift(a); i++; }
    }
    for (i = 0; i < 4 && z && !z.classList.contains('gap'); z = z.nextElementSibling) {
      if (z.classList.contains('dl') && !z.classList.contains('far')) { rows.push(z); i++; }
    }
    var box = h('div', 'code ro');
    rows.forEach(function (row) {
      var c = row.cloneNode(true);
      if (row.id) { c.dataset.src = row.id; c.removeAttribute('id'); }
      c.classList.remove('flash', 'has-c');
      box.appendChild(c);
    });
    prev.appendChild(box);
  }

  // ── folding: open part of a gap, or the whole file ──
  function expandGap(g) {
    var rows = [], n = g.nextElementSibling;
    while (n && n.classList.contains('far')) { rows.push(n); n = n.nextElementSibling; }
    if (rows.length <= 20) {
      rows.forEach(function (r) { r.classList.remove('far'); });
      g.parentNode.removeChild(g);
    } else {
      rows.slice(0, 10).concat(rows.slice(-10)).forEach(function (r) { r.classList.remove('far'); });
      g.parentNode.insertBefore(g, rows[10]);
      var left = rows.length - 20;
      g.textContent = '⋯ ' + plural(left, 'unchanged line', 'unchanged lines') + ' · show more';
      g.dataset.n = left;
    }
  }
  function wholeFile(b) {
    var sec = b.closest('.fsec'), on = !sec.classList.contains('whole');
    sec.classList.toggle('whole', on);
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? 'Changes only' : 'Whole file';
    b.title = on ? 'Fold unchanged lines' : 'Show the whole file';
  }
  qa('.gap').forEach(function (g) {
    var n = Number(g.dataset.n);
    if (n > 20) g.textContent = g.textContent + ' · show more';
  });

  // ── viewed files ──
  // On the service the marks are saved on the server, per user; in a standalone
  // report they stay in this browser. A viewed file is collapsed.
  function fileId(sec) { return 'file:' + sec.dataset.path; }
  function loadViewed() {
    if (D.mr) return D.mr.viewed.reduce(function (o, id) { o[id] = true; return o; }, {});
    try { return JSON.parse(localStorage.getItem(D.key) || '[]').reduce(function (o, id) { o[id] = true; return o; }, {}); }
    catch (err) { return {}; }
  }
  function saveViewed(id, on) {
    if (D.mr) {
      return fetch(D.mr.apiBase + '/viewed', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbolId: id, viewed: on })
      }).then(function (r) { if (!r.ok) throw new Error('save failed'); });
    }
    try { localStorage.setItem(D.key, JSON.stringify(Object.keys(viewed))); } catch (err) { /* private mode */ }
    return Promise.resolve();
  }
  function updateViewed() {
    var n = 0;
    files.forEach(function (sec) {
      var on = !!viewed[fileId(sec)];
      if (on) n++;
      sec.classList.toggle('seen', on);
      sec.querySelector('.fv').checked = on;
      var b = document.querySelector('.sf-file[data-card="' + sec.id + '"]');
      if (b) { b.classList.toggle('seen', on); b.querySelector('.vw').textContent = on ? '✓' : ''; }
    });
    byId('vcount').textContent = n;
    byId('vbar').style.width = (files.length ? Math.round(n / files.length * 100) : 0) + '%';
  }
  function setViewed(sec, on) {
    if (on) viewed[fileId(sec)] = true; else delete viewed[fileId(sec)];
    setShut(sec, on);
    updateViewed();
  }
  ed.addEventListener('change', function (e) {
    if (!e.target.classList.contains('fv')) return;
    var sec = e.target.closest('.fsec'), on = e.target.checked;
    setViewed(sec, on);
    saveViewed(fileId(sec), on).catch(function () {
      // Put it back and say so if the server could not save it.
      setViewed(sec, !on);
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
  files.forEach(function (sec) { if (viewed[fileId(sec)]) setShut(sec, true); });
  updateViewed();
  renderDock();
})();
`;
