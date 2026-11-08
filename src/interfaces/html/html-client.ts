/**
 * Browser script for the HTML report. Reads the GITMAP data object written by
 * renderHtml and wires up selection, folding, arrows, "viewed" progress,
 * pan and zoom. Kept free of template-literal syntax so it can live in a TS string.
 */
export const CLIENT_SCRIPT = `
(function () {
  var D = GITMAP, syms = D.syms;
  var vp = byId('vp'), cv = byId('cv'), sv = byId('sv'), eg = byId('edges');
  var leftCards = qa('.card.in'), outCards = qa('.card.out');
  var GAP = 28, s = 1, tx = 0, ty = 0, W = 0, H = 0;
  var sel = null, showOut = true, rightShown = false;
  var viewed = loadViewed();

  function byId(i) { return document.getElementById(i); }
  function qa(q, root) { return [].slice.call((root || document).querySelectorAll(q)); }
  function has(list, k) { return (' ' + (list || '') + ' ').indexOf(' ' + k + ' ') >= 0; }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // The row where each changed symbol starts.
  var defRow = {};
  qa('[data-defs]').forEach(function (r) {
    r.dataset.defs.split(' ').forEach(function (k) { if (!defRow[k]) defRow[k] = r; });
  });

  // ── layout: stack each column from measured heights ──
  function outOn() { return showOut && sel !== null; }
  function stack() {
    var y = D.top;
    leftCards.forEach(function (c) { c.style.top = y + 'px'; y += c.offsetHeight + GAP; });
    var y2 = D.top, on = outOn();
    outCards.forEach(function (c) {
      var vis = on && has(c.dataset.for, sel);
      c.classList.toggle('vis', vis);
      if (!vis) return;
      qa('.caller', c).forEach(function (b) { b.classList.toggle('vis', has(b.dataset.for, sel)); });
      c.style.top = y2 + 'px';
      y2 += c.offsetHeight + GAP;
    });
    rightShown = y2 > D.top;
    document.body.classList.toggle('show-out', rightShown);
    W = (rightShown ? D.rightX + D.rightW : D.leftX + D.leftW + 120) + D.leftX;
    H = Math.max(y, y2) - GAP + D.leftX;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    sv.setAttribute('width', W); sv.setAttribute('height', H);
  }

  // Middle of a code row, in canvas coordinates (null if it is hidden).
  function rowY(el) {
    if (!el || !el.offsetParent) return null;
    var card = el.closest('.card');
    return card.offsetTop + el.offsetTop + el.offsetHeight / 2;
  }

  // ── arrows: from where a symbol is defined to each place it is used ──
  function draw() {
    var parts = [], nIn = 0, nOut = 0, x0 = D.leftX + D.leftW, on = outOn();
    syms.forEach(function (sy, k) {
      if (sel !== null && k !== sel) return;
      var a = rowY(defRow[k]);
      if (a === null) return;
      sy.refs.forEach(function (r) {
        if (r.out && !on) return;
        var b = rowY(byId(r.el));
        if (b === null) return;
        var d;
        if (!r.out) {
          var lane = x0 + 14 + (nIn++ % 8) * 9;
          d = 'M' + x0 + ',' + a + ' H' + lane + ' V' + b + ' H' + (x0 + 3);
        } else {
          var lane2 = x0 + 28 + (nOut++ % 12) * 12;
          d = 'M' + x0 + ',' + a + ' H' + lane2 + ' V' + b + ' H' + (D.rightX - 3);
        }
        var cls = 'edge' + (r.bad ? ' bad' : '') + (sel !== null ? ' on' : '');
        parts.push('<path class="' + cls + '" d="' + d + '" marker-end="url(#' + (r.bad ? 'ah-bad' : 'ah') + ')"/>');
      });
    });
    eg.innerHTML = parts.join('');
  }

  function relayout() { stack(); draw(); }

  // ── pan and zoom ──
  function apply() {
    cv.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    byId('zpct').textContent = Math.round(s * 100) + '%';
  }
  function fit() {
    s = Math.max(0.25, Math.min(1, (vp.clientWidth - 16) / W));
    tx = 0; ty = 0; apply();
  }
  function zoomAt(f, cx, cy) {
    var ns = Math.max(0.15, Math.min(2.5, s * f));
    tx = cx - (cx - tx) * (ns / s); ty = cy - (cy - ty) * (ns / s); s = ns; apply();
  }
  function centre(f) { zoomAt(f, vp.clientWidth / 2, vp.clientHeight / 2); }
  /** Pan so a row (or card) is in view, a third of the way down, and flash it. */
  function reveal(el) {
    if (!el || !el.offsetParent) return;
    var card = el.closest('.card') || el;
    var y = card === el ? card.offsetTop : card.offsetTop + el.offsetTop;
    var left = card.offsetLeft * s + tx, right = (card.offsetLeft + card.offsetWidth) * s + tx;
    if (left < 0 || right > vp.clientWidth) tx = Math.min(0, vp.clientWidth - 16 - (card.offsetLeft + card.offsetWidth) * s);
    if (card.offsetLeft * s + tx < 0) tx = 8 - card.offsetLeft * s;
    ty = vp.clientHeight / 3 - y * s;
    apply();
    if (el.classList.contains('dl')) {
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
  }

  vp.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {              // ctrl+scroll, or a trackpad pinch: zoom at the pointer
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    } else {                                   // plain scroll pans, like scrolling code in an editor
      tx -= e.shiftKey ? e.deltaY : e.deltaX;
      ty -= e.shiftKey ? 0 : e.deltaY;
      apply();
    }
  }, { passive: false });

  var drag = null, moved = false;
  vp.addEventListener('pointerdown', function (e) {
    moved = false;
    if (e.button !== 0 || e.target.closest('.tx, .fpath, button, a, textarea, .thread, .composer')) return; // keep code selectable, buttons clickable
    drag = { x: e.clientX - tx, y: e.clientY - ty, sx: e.clientX, sy: e.clientY };
    vp.classList.add('drag');
  });
  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) moved = true;
    tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply();
  });
  window.addEventListener('pointerup', function () { drag = null; vp.classList.remove('drag'); });
  byId('fit').onclick = fit;
  byId('zin').onclick = function () { centre(1.2); };
  byId('zout').onclick = function () { centre(1 / 1.2); };

  // ── selection ──
  function select(k, reveal_) {
    sel = k === null || k === undefined || isNaN(k) ? null : k;
    qa('.sf-sym').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.sel) === sel); });
    qa('.dl.sel').forEach(function (r) { r.classList.remove('sel'); });
    qa('.dl.hit').forEach(function (r) { r.classList.remove('hit', 'bad'); });
    if (sel !== null) {
      if (defRow[sel]) defRow[sel].classList.add('sel');
      syms[sel].refs.forEach(function (r) {
        var el = byId(r.el);
        if (!el) return;
        el.classList.add('hit');
        if (r.bad) el.classList.add('bad');
      });
    }
    var wasShown = rightShown;
    relayout();
    renderDetail();
    if (sel !== null && rightShown && !wasShown && W * s > vp.clientWidth) {
      s = Math.max(0.25, (vp.clientWidth - 16) / W); tx = 0; apply();
    }
    if (sel !== null && reveal_) reveal(defRow[sel]);
  }
  function toggle(k, reveal_) { select(sel === k ? null : k, reveal_); }

  cv.addEventListener('click', function (e) {
    if (moved) return;
    var gap = e.target.closest('.gap');
    if (gap) { expandGap(gap); return; }
    var ex = e.target.closest('.expand');
    if (ex) { wholeFile(ex); return; }
    var row = e.target.closest('.dl.def');
    if (row && !window.getSelection().toString()) toggle(Number(row.dataset.sel), false);
  });
  qa('.sf-sym').forEach(function (b) {
    b.addEventListener('click', function () { toggle(Number(b.dataset.sel), true); });
  });
  qa('.sf-file').forEach(function (b) {
    b.addEventListener('click', function () { reveal(byId(b.dataset.card)); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sel !== null) select(null);
  });
  var sw = byId('outsw');
  sw.addEventListener('click', function () {
    showOut = !showOut;
    sw.setAttribute('aria-checked', String(showOut));
    relayout();
  });

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
    relayout();
  }
  function wholeFile(btn) {
    var card = btn.closest('.card'), on = !card.classList.contains('whole');
    card.classList.toggle('whole', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'Changes only' : 'Whole file';
    btn.title = on ? 'Fold unchanged lines' : 'Show the whole file';
    relayout();
  }
  qa('.gap').forEach(function (g) {
    var n = Number(g.dataset.n);
    if (n > 20) g.textContent = g.textContent + ' · show more';
  });

  // ── viewed progress (kept in this browser only) ──
  // On the GitLab service the marks are saved on the server, per user; in a
  // standalone report they stay in this browser.
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
    var n = syms.filter(function (sy) { return viewed[sy.id]; }).length;
    byId('vcount').textContent = n;
    byId('vbar').style.width = (syms.length ? Math.round(n / syms.length * 100) : 0) + '%';
    qa('.sf-sym').forEach(function (b) {
      b.querySelector('.vw').textContent = viewed[syms[Number(b.dataset.sel)].id] ? '✓' : '';
    });
  }

  // ── details panel ──
  function snippet(lines, cls) {
    var MAX = 12, wrap = h('div', 'sec');
    wrap.style.gap = '4px';
    wrap.appendChild(h('pre', 'snip ' + cls, lines.slice(0, MAX).join('\\n')));
    if (lines.length > MAX) wrap.appendChild(h('span', 'more', '+ ' + plural(lines.length - MAX, 'more line', 'more lines')));
    return wrap;
  }
  function renderDetail() {
    var ov = byId('ov'), dt = byId('dt');
    dt.textContent = '';
    if (sel === null) { ov.hidden = false; dt.hidden = true; return; }
    ov.hidden = true; dt.hidden = false;
    var sy = syms[sel];
    var n = sy.refs.length, nOut = sy.refs.filter(function (r) { return r.out; }).length;

    var head = h('div', 'sec');
    head.style.gap = '6px';
    head.appendChild(h('div', 'lbl', 'Selected'));
    var name = h('div', 'dname');
    name.appendChild(h('h2', 'st-' + sy.status, sy.name));
    name.appendChild(h('span', 'kind', sy.kind));
    head.appendChild(name);
    var loc = h('div', 'loc mono');
    loc.appendChild(h('span', '', sy.file + ':' + sy.line));
    var cp = h('button', 'cbtn copy');
    cp.type = 'button'; cp.dataset.path = sy.file + ':' + sy.line; cp.title = 'Copy location';
    cp.appendChild(h('span', 'copy-label', 'Copy'));
    loc.appendChild(cp);
    head.appendChild(loc);
    dt.appendChild(head);

    var word = sy.status === 'added' ? 'Added' : sy.status === 'removed' ? 'Removed' : 'Changed';
    var text;
    if (n === 0) text = word + '. ' + (sy.status === 'added' ? 'Not called anywhere yet.' : 'No calls to it were found in the repo.');
    else if (sy.status === 'removed') text = 'Removed, but still called in ' + plural(n, 'place', 'places') + '.';
    else text = word + '. Called in ' + plural(n, 'place', 'places') +
      (nOut ? ': ' + (n - nOut) + ' inside this change, ' + nOut + ' outside it.' : ', all inside this change.');
    dt.appendChild(h('p', 'summary', text));

    if (sy.before.length || sy.after.length) {
      var ch = h('div', 'sec');
      ch.appendChild(h('h3', '', 'Change'));
      if (sy.before.length) { ch.appendChild(h('span', 'lbl', sy.after.length ? 'Before' : 'Removed lines')); ch.appendChild(snippet(sy.before, 'b')); }
      if (sy.after.length) { ch.appendChild(h('span', 'lbl', sy.before.length ? 'After' : 'Added lines')); ch.appendChild(snippet(sy.after, 'a')); }
      dt.appendChild(ch);
    }

    if (n) {
      var rs = h('div', 'sec');
      rs.appendChild(h('h3', '', (sy.status === 'removed' ? 'Still called in ' : 'Called in ') + plural(n, 'place', 'places')));
      sy.refs.forEach(function (r) {
        var b = h('button', 'ref' + (r.out ? ' out' : '') + (r.bad ? ' bad' : ''));
        b.type = 'button';
        b.title = r.out ? 'Outside the diff · show in map' : 'Show in map';
        b.appendChild(h('span', 'rl', r.file + ':' + r.line));
        b.appendChild(h('pre', 'snip c', r.text.trim()));
        b.addEventListener('click', function () {
          if (r.out && !showOut) sw.click();
          reveal(byId(r.el));
        });
        rs.appendChild(b);
      });
      dt.appendChild(rs);
    }

    var act = h('div', 'actions');
    var isV = !!viewed[sy.id];
    var vb = h('button', 'btn ' + (isV ? 'viewed' : 'primary'), isV ? 'Viewed ✓' : 'Mark as viewed');
    vb.type = 'button';
    vb.setAttribute('aria-pressed', String(isV));
    vb.addEventListener('click', function () {
      var on = !viewed[sy.id];
      if (on) viewed[sy.id] = true; else delete viewed[sy.id];
      updateViewed(); renderDetail();
      saveViewed(sy.id, on).catch(function () {
        // Put it back and say so if the server could not save it.
        if (on) delete viewed[sy.id]; else viewed[sy.id] = true;
        updateViewed(); renderDetail();
        var b = document.querySelector('#dt .btn');
        if (b) b.textContent = 'Could not save. Try again';
      });
    });
    var sm = h('button', 'btn', 'Show in map');
    sm.type = 'button';
    sm.addEventListener('click', function () { reveal(defRow[sel]); });
    act.appendChild(vb); act.appendChild(sm);
    dt.appendChild(act);
  }

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

  // Hooks for the merge-request script (comments change card heights).
  window.gitmap = { relayout: relayout, wasDrag: function () { return moved; } };

  updateViewed();
  relayout(); fit();
  window.addEventListener('load', relayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
  window.addEventListener('resize', draw);
})();
`;
