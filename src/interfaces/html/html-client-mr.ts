/**
 * Browser script added only when the page shows a GitLab merge request:
 * shows existing comment threads on their lines, lets the reviewer comment on
 * any line (click its line number) or reply, and approve. Talks to the gitmap
 * server, which calls GitLab as the signed-in user.
 * Kept free of template-literal syntax so it can live in a TS string.
 */
export const MR_CLIENT_SCRIPT = `
(function () {
  var M = GITMAP.mr, G = window.gitmap;
  if (!M || !G) return;

  function byId(i) { return document.getElementById(i); }
  function qa(q, root) { return [].slice.call((root || document).querySelectorAll(q)); }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function toast(msg) {
    var t = h('div', 'toast', msg);
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 5000);
  }

  function post(path, body) {
    return fetch(M.apiBase + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) throw new Error('Your sign-in has expired. Reload the page to sign in again.');
        if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')'));
        return j;
      });
    });
  }

  // ── find code rows ──
  var cardByPath = {};
  qa('.card.in').forEach(function (c) {
    var b = c.querySelector('.copy');
    if (b) cardByPath[b.dataset.path] = c;
  });
  function rowFor(p) {
    var card = cardByPath[p.path];
    if (!card) return null;
    var rows = qa('.dl', card);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], o = r.querySelector('.lo').textContent, n = r.querySelector('.ln').textContent;
      if (p.newLine !== null ? n === String(p.newLine) : (o === String(p.oldLine) && r.classList.contains('del'))) return r;
    }
    return null;
  }
  function lineInfo(row) {
    var card = row.closest('.card');
    var o = row.querySelector('.lo').textContent, n = row.querySelector('.ln').textContent;
    var out = card.classList.contains('out');
    return {
      path: card.querySelector('.copy').dataset.path,
      oldLine: out || row.classList.contains('add') || !o ? null : Number(o),
      newLine: row.classList.contains('del') || !n ? null : Number(n),
      code: row.querySelector('.tx').textContent,
      outside: out
    };
  }
  function insertAfterRow(row, el) {
    var at = row, n = row.nextElementSibling;
    while (n && (n.classList.contains('thread') || n.classList.contains('composer'))) { at = n; n = n.nextElementSibling; }
    at.parentNode.insertBefore(el, at.nextSibling);
  }

  // ── threads ──
  function noteEl(n) {
    var d = h('div', 'note');
    var hd = h('div', 'nh');
    hd.appendChild(h('b', '', n.author.name));
    hd.appendChild(document.createTextNode(' @' + n.author.username + ' · ' + when(n.createdAt)));
    d.appendChild(hd);
    d.appendChild(h('div', 'nb', n.body));
    return d;
  }
  function threadEl(d) {
    var t = h('div', 'thread' + (d.resolved ? ' resolved' : ''));
    t.dataset.id = d.id;
    if (d.resolved) t.title = 'Resolved';
    d.notes.forEach(function (n) { t.appendChild(noteEl(n)); });
    var rb = h('button', 'link', 'Reply');
    rb.type = 'button';
    rb.addEventListener('click', function () {
      var c = composer({
        label: 'Reply',
        submit: function (body) { return post('/discussions/' + encodeURIComponent(d.id) + '/notes', { body: body }); },
        done: function (note) { t.insertBefore(noteEl(note), c); c.replaceWith(rb); G.relayout(); },
        cancel: function () { c.replaceWith(rb); G.relayout(); }
      });
      rb.replaceWith(c);
      G.relayout();
      c.querySelector('textarea').focus();
    });
    t.appendChild(rb);
    return t;
  }

  /** A comment box. opts: label, hint, submit(body) -> Promise, done(result), cancel(). */
  function composer(opts) {
    var c = h('div', 'composer');
    var ta = h('textarea');
    ta.placeholder = 'Write a comment… (Markdown, Ctrl+Enter to send)';
    ta.setAttribute('aria-label', 'Comment');
    c.appendChild(ta);
    if (opts.hint) c.appendChild(h('div', 'hint', opts.hint));
    var row = h('div', 'row');
    var err = h('span', 'err');
    var cancel = h('button', 'hbtn', 'Cancel');
    var send = h('button', 'hbtn primary', opts.label || 'Comment');
    cancel.type = send.type = 'button';
    row.appendChild(err); row.appendChild(cancel); row.appendChild(send);
    c.appendChild(row);
    function go() {
      var body = ta.value.trim();
      if (!body) { ta.focus(); return; }
      send.disabled = cancel.disabled = true;
      err.textContent = '';
      opts.submit(body).then(opts.done, function (e) {
        err.textContent = e.message;
        send.disabled = cancel.disabled = false;
      });
    }
    send.addEventListener('click', go);
    cancel.addEventListener('click', opts.cancel);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) go();
      if (e.key === 'Escape') { e.stopPropagation(); opts.cancel(); }
    });
    return c;
  }

  var count = M.discussions.length;
  function bump() {
    count++;
    var el = byId('ccount');
    if (el) el.textContent = count + (count === 1 ? ' comment' : ' comments');
  }

  // ── general (not on a line) comments, in the overview panel ──
  var ov = byId('ov');
  var gen = h('div', 'sec');
  gen.style.marginTop = '18px';
  gen.appendChild(h('h3', '', 'Comments on this merge request'));
  var genList = h('div');
  gen.appendChild(genList);
  var newGen = h('button', 'btn', 'Write a comment');
  newGen.type = 'button';
  newGen.addEventListener('click', function () {
    var c = composer({
      submit: function (body) { return post('/discussions', { body: body }); },
      done: function (r) { genList.appendChild(threadEl(r.discussion)); c.replaceWith(newGen); bump(); },
      cancel: function () { c.replaceWith(newGen); }
    });
    newGen.replaceWith(c);
    c.querySelector('textarea').focus();
  });
  gen.appendChild(newGen);
  ov.appendChild(gen);

  // ── place existing threads ──
  M.discussions.forEach(function (d) {
    var row = d.position ? rowFor(d.position) : null;
    if (row) { insertAfterRow(row, threadEl(d)); row.classList.add('has-c'); }
    else genList.appendChild(threadEl(d));
  });

  // Collapsed large files say how many comments they hide.
  qa('.card.big').forEach(function (c) {
    var n = c.querySelectorAll('.thread').length;
    if (n) c.querySelector('.bigbar').appendChild(document.createTextNode(' · ' + n + (n === 1 ? ' comment' : ' comments')));
  });

  // ── click a line number to comment on that line ──
  byId('cv').addEventListener('click', function (e) {
    var g = e.target.closest('.lo, .ln');
    if (!g || G.wasDrag()) return;
    var row = g.closest('.dl');
    if (!row || !row.closest('.card')) return;
    e.stopPropagation();
    qa('.composer.new').forEach(function (c) { c.remove(); });
    var info = lineInfo(row);
    var c = composer({
      hint: info.outside ? 'This file is not part of the merge request, so this is posted as a general comment that quotes the line.' : null,
      submit: function (body) {
        return post('/discussions', {
          body: body,
          code: info.code,
          position: { path: info.path, oldLine: info.oldLine, newLine: info.newLine },
          outside: info.outside
        });
      },
      done: function (r) {
        c.replaceWith(threadEl(r.discussion));
        row.classList.add('has-c');
        bump();
        if (r.fallback && !info.outside) toast("GitLab can't attach a comment to this line, so it was posted as a general comment that quotes it.");
        G.relayout();
      },
      cancel: function () { c.remove(); G.relayout(); }
    });
    c.classList.add('new');
    insertAfterRow(row, c);
    G.relayout();
    c.querySelector('textarea').focus();
  }, true);

  // ── approve ──
  var ab = byId('approve');
  function showApprovals(a) {
    M.approvals = a;
    ab.textContent = a.userHasApproved ? 'Revoke approval' : 'Approve';
    ab.classList.toggle('primary', !a.userHasApproved);
    ab.setAttribute('aria-pressed', String(a.userHasApproved));
    ab.disabled = !a.userHasApproved && !a.userCanApprove;
    var by = byId('approvedby');
    by.hidden = a.approvedBy.length === 0;
    by.textContent = 'Approved by ' + a.approvedBy.length;
    by.title = a.approvedBy.map(function (u) { return u.name; }).join(', ');
  }
  if (ab) ab.addEventListener('click', function () {
    ab.disabled = true;
    post(M.approvals.userHasApproved ? '/unapprove' : '/approve', {}).then(showApprovals, function (e) {
      toast(e.message);
      showApprovals(M.approvals);
    });
  });

  G.relayout();
})();
`;
