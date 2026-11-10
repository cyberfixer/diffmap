/**
 * Browser script for the HTML report. Reads the DIFFMAP data object written by
 * renderHtml and wires up selection (highlights, go to definition / usages), folding, "viewed" progress,
 * pan and zoom. Kept free of template-literal syntax so it can live in a TS string.
 */
export const CLIENT_SCRIPT = `
(function () {
  var D = DIFFMAP, syms = D.syms;
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

  // ── layout: stack each column from measured heights ──
  function outOn() { return showOut && sel !== null; }
  function stack() {
    var y = D.top;
    leftCards.forEach(function (c) { c.style.top = y + 'px'; y += c.offsetHeight + GAP; });
    // Usages outside the diff sit next to the selected symbol, not at the top of the map.
    var y2 = D.top, on = outOn();
    if (on && defRow[sel] && defRow[sel].offsetParent) {
      var dc = defRow[sel].closest('.card');
      y2 = Math.max(D.top, dc.offsetTop + defRow[sel].offsetTop - 40);
    }
    var outTop = y2;
    outCards.forEach(function (c) {
      var vis = on && has(c.dataset.for, sel);
      c.classList.toggle('vis', vis);
      if (!vis) return;
      qa('.caller', c).forEach(function (b) { b.classList.toggle('vis', has(b.dataset.for, sel)); });
      c.style.top = y2 + 'px';
      y2 += c.offsetHeight + GAP;
    });
    rightShown = y2 > outTop;
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

  // No arrows: the selected symbol's definition and every place it is used are highlighted
  // instead, and clicking moves between them (see "selection").
  function draw() { eg.textContent = ''; }

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
  function endDrag() { drag = null; vp.classList.remove('drag'); }
  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    // Released outside the window (no pointerup reached the page): stop here.
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { endDrag(); return; }
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) moved = true;
    tx = e.clientX - drag.x; ty = e.clientY - drag.y; apply();
  });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);
  vp.addEventListener('dragstart', function (e) { if (drag) e.preventDefault(); }); // no native drag of selected text

  // ── middle-button autoscroll, like a browser page ──
  // Hold the middle button and move away from where you pressed: the map scrolls
  // that way, faster the further you go. A middle click without moving keeps it
  // on until the next click, a scroll, or Escape.
  var auto = null, DEAD = 10;
  vp.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); }); // no native autoscroll or paste
  vp.addEventListener('pointerdown', function (e) {
    if (auto) { stopAuto(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.button !== 1 || e.target.closest('textarea')) return;
    e.preventDefault();
    var r = vp.getBoundingClientRect();
    var mark = h('div', 'auto-mark');
    mark.style.left = (e.clientX - r.left) + 'px'; mark.style.top = (e.clientY - r.top) + 'px';
    vp.appendChild(mark);
    vp.classList.add('autoscroll');
    auto = { ox: e.clientX, oy: e.clientY, cx: e.clientX, cy: e.clientY, moved: false, mark: mark, t: performance.now() };
    requestAnimationFrame(autoStep);
  }, true);
  window.addEventListener('pointermove', function (e) {
    if (!auto) return;
    auto.cx = e.clientX; auto.cy = e.clientY;
    if (Math.abs(auto.cx - auto.ox) + Math.abs(auto.cy - auto.oy) > DEAD) auto.moved = true;
  });
  window.addEventListener('pointerup', function (e) { if (auto && e.button === 1 && auto.moved) stopAuto(); });
  vp.addEventListener('wheel', function () { if (auto) stopAuto(); }, true);
  window.addEventListener('keydown', function (e) { if (auto && e.key === 'Escape') stopAuto(); });
  window.addEventListener('blur', function () { if (auto) stopAuto(); });
  function speed(d) { var a = Math.abs(d) - DEAD; return a <= 0 ? 0 : (d < 0 ? -1 : 1) * a * 8; } // px per second
  function autoStep(now) {
    if (!auto) return;
    var dt = Math.min(0.05, (now - auto.t) / 1000); auto.t = now;
    var vx = speed(auto.cx - auto.ox), vy = speed(auto.cy - auto.oy);
    if (vx || vy) { tx -= vx * dt; ty -= vy * dt; apply(); }
    requestAnimationFrame(autoStep);
  }
  function stopAuto() {
    auto.mark.remove(); auto = null;
    vp.classList.remove('autoscroll');
    moved = true; // the click that ends autoscroll is not a selection
  }

  // ── resizable side panels (widths kept in this browser) ──
  (function () {
    var panes = byId('panes'), KEY = 'diffmap:panes';
    if (!panes) return;
    var w = {};
    try { w = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (err) { w = {}; }
    function set(side, px) {
      var other = side === 'l' ? w.r || 360 : w.l || 280;
      var max = Math.max(200, panes.clientWidth - other - 320); // leave the map at least 320px
      px = Math.round(Math.max(side === 'l' ? 160 : 240, Math.min(max, px)));
      w[side] = px;
      panes.style.setProperty(side === 'l' ? '--lw' : '--rw', px + 'px');
    }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch (err) { /* private mode */ } }
    if (w.l) set('l', w.l);
    if (w.r) set('r', w.r);
    ['l', 'r'].forEach(function (side) {
      var hd = byId('rz' + side);
      hd.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        hd.setPointerCapture(e.pointerId);
        hd.classList.add('on'); document.body.classList.add('resizing');
        var box = panes.getBoundingClientRect();
        function move(ev) { set(side, side === 'l' ? ev.clientX - box.left : box.right - ev.clientX); draw(); }
        function up() {
          hd.removeEventListener('pointermove', move); hd.removeEventListener('pointerup', up);
          hd.classList.remove('on'); document.body.classList.remove('resizing');
          save(); draw();
        }
        hd.addEventListener('pointermove', move); hd.addEventListener('pointerup', up);
      });
      hd.addEventListener('dblclick', function () {
        delete w[side]; panes.style.removeProperty(side === 'l' ? '--lw' : '--rw'); save(); draw();
      });
    });
  })();

  byId('fit').onclick = fit;
  byId('zin').onclick = function () { centre(1.2); };
  byId('zout').onclick = function () { centre(1 / 1.2); };

  // ── selection ──
  function select(k, reveal_) {
    var next = k === null || k === undefined || isNaN(k) ? null : k;
    if (next !== sel) refAt = -1;
    sel = next;
    qa('.sf-sym').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.sel) === sel); });
    qa('.dl.sel').forEach(function (r) { r.classList.remove('sel'); });
    qa('.dl.hit').forEach(function (r) { r.classList.remove('hit', 'bad'); });
    if (sel !== null) {
      // A large file stays collapsed until something in it is selected.
      [defRow[sel]].concat(syms[sel].refs.map(function (r) { return byId(r.el); })).forEach(function (el) {
        var c = el && el.closest('.card.big');
        if (c) c.classList.remove('big');
      });
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
    var big = e.target.closest('.bigbar');
    if (big) { big.closest('.card').classList.remove('big'); relayout(); return; }
    var ex = e.target.closest('.expand');
    if (ex) { wholeFile(ex); return; }
    if (window.getSelection().toString()) return;
    if (D.mr && e.target.closest('.lo, .ln')) return; // in a merge request the line number starts a comment
    // Like an editor: on a usage, go to the definition; on a definition, go to its usages.
    var call = e.target.closest('.dl.call');
    if (call) { goToDef(call); return; }
    var row = e.target.closest('.dl.def');
    if (row) goToRefs(Number(row.dataset.sel));
  });
  /** Clicking a line that calls a changed symbol selects that symbol and jumps to its definition. */
  function goToDef(row) {
    var ks = callsOn[row.id];
    // Several changed symbols called on one line: step through them on each click.
    var i = ks.indexOf(sel), k = ks[(i + 1) % ks.length];
    select(k, true);
  }
  /** Clicking a definition selects it and jumps to its first usage; each further click, the next one. */
  var refAt = -1;
  function goToRefs(k) {
    if (sel !== k) { select(k, false); refAt = -1; }
    var refs = syms[k].refs;
    if (!refs.length) { reveal(defRow[k]); return; }
    refAt = (refAt + 1) % refs.length;
    showRef(refs[refAt]);
    renderDetail();
  }
  function showRef(r) {
    if (r.out && !showOut) sw.click();
    reveal(byId(r.el));
  }
  qa('.sf-sym').forEach(function (b) {
    b.addEventListener('click', function () { toggle(Number(b.dataset.sel), true); });
  });
  qa('.tf-dir').forEach(function (b) {
    b.addEventListener('click', function () { b.setAttribute('aria-expanded', String(b.getAttribute('aria-expanded') === 'false')); });
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
  function renderDetail() {
    var ov = byId('ov'), dt = byId('dt');
    dt.textContent = '';
    if (sel === null) { ov.hidden = false; dt.hidden = true; return; }
    ov.hidden = true; dt.hidden = false;
    var sy = syms[sel];
    var n = sy.refs.length, nOut = sy.refs.filter(function (r) { return r.out; }).length;
    var nImpl = sy.refs.filter(function (r) { return r.impl; }).length;

    // Name, kind and where it is, in one block.
    var head = h('div', 'sec dhead');
    var name = h('div', 'dname');
    name.appendChild(h('h2', 'st-' + sy.status, sy.name));
    name.appendChild(h('span', 'kind', sy.kind));
    head.appendChild(name);
    var loc = h('div', 'loc mono');
    var go = h('button', 'link', sy.file + ':' + sy.line);
    go.type = 'button'; go.title = 'Show in map';
    go.addEventListener('click', function () { reveal(defRow[sel]); });
    loc.appendChild(go);
    var cp = h('button', 'cbtn copy');
    cp.type = 'button'; cp.dataset.path = sy.file + ':' + sy.line; cp.title = 'Copy location';
    cp.appendChild(h('span', 'copy-label', 'Copy'));
    loc.appendChild(cp);
    head.appendChild(loc);
    dt.appendChild(head);

    // One line of counts.
    var facts = [];
    if (sy.status === 'removed') facts.push(n ? 'removed, still used in ' + plural(n, 'place', 'places') : 'removed, no longer used');
    else if (!n) facts.push(sy.status === 'added' ? 'new, not used yet' : 'no usages found');
    else facts.push('used in ' + plural(n, 'place', 'places'));
    if (n && nOut) facts.push(nOut + ' outside the change');
    if (nImpl) facts.push(plural(nImpl, 'implementation', 'implementations'));
    var sum = h('p', 'summary' + (sy.status === 'removed' && n ? ' bad' : ''), facts.join(' · '));
    dt.appendChild(sum);

    // Usages, grouped by file: one short line each, the full line on hover.
    if (n) {
      var groups = [], byFile = {};
      sy.refs.forEach(function (r, i) {
        if (!byFile[r.file]) { byFile[r.file] = { file: r.file, out: r.out, refs: [] }; groups.push(byFile[r.file]); }
        byFile[r.file].refs.push({ r: r, i: i });
      });
      var rs = h('div', 'sec refs');
      groups.forEach(function (g) {
        rs.appendChild(h('div', 'rf mono' + (g.out ? ' out' : ''), g.file));
        g.refs.forEach(function (x) {
          var r = x.r;
          var b = h('button', 'ref' + (r.bad ? ' bad' : '') + (x.i === refAt ? ' on' : ''));
          b.type = 'button';
          b.title = r.text.trim();
          b.appendChild(h('span', 'rn mono', String(r.line)));
          b.appendChild(h('span', 'rt mono', r.text.trim()));
          if (r.impl) b.appendChild(h('span', 'tag', 'implements'));
          b.addEventListener('click', function () { refAt = x.i; showRef(r); renderDetail(); });
          rs.appendChild(b);
        });
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
    act.appendChild(vb);
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
  window.diffmap = { relayout: relayout, wasDrag: function () { return moved; } };

  updateViewed();
  relayout(); fit();
  window.addEventListener('load', relayout);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
  window.addEventListener('resize', draw);
})();
`;
