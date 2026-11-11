// assets/js/meetings.js — the «همهٔ تماس‌ها» index (dash shell).
// dashboard.js already owns the shell chrome: toast, drawer, user menu, confirm
// dialog, clipboard and the #recent-search → [data-recent-card] text filter.
// This file only adds the status chips, the honest counters and the delete flow.
(function () {
  'use strict';

  var doc = document;

  function byId(id) { return doc.getElementById(id); }
  function $$(sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); }
  function faDigits(n) {
    return String(n).replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[Number(d)]; });
  }

  // Persian/Arabic normalisation so «ی/ي» and ZWNJ never break a match
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[\u064A\u0649]/g, '\u06CC')
      .replace(/\u0643/g, '\u06A9')
      .replace(/[\u200B-\u200F\uFEFF]/g, '')
      .replace(/[\u0660-\u0669]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
      .replace(/[\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); })
      .replace(/\s+/g, ' ')
      .trim();
  }

  var search = byId('recent-search');
  var filter = 'all';

  function cards() { return $$('[data-recent-card]'); }
  function isLive(card) { return card.getAttribute('data-active') === '1'; }
  function matches(card) {
    var q = norm(search ? search.value : '');
    var hay = norm(card.getAttribute('data-title') || '');
    var qHit = !q || hay.indexOf(q) !== -1;
    var fHit = filter === 'all' || (filter === 'live' ? isLive(card) : !isLive(card));
    return qHit && fHit;
  }

  function paintCounts() {
    var all = cards();
    var live = all.filter(isLive).length;
    var ended = all.length - live;
    var counts = { all: all.length, live: live, ended: ended };
    Object.keys(counts).forEach(function (key) {
      var node = doc.querySelector('[data-count="' + key + '"]');
      if (node) node.textContent = faDigits(counts[key]);
    });

    var count = byId('meetings-count');
    if (count) count.textContent = all.length ? faDigits(all.length) + ' تماس' : 'هنوز تماسی نساخته‌اید';

    var grid = byId('recent-grid');
    if (grid && all.length === 0 && !grid.querySelector('.dash-empty')) {
      var tpl = byId('recent-empty-tpl');
      if (tpl && tpl.content) grid.appendChild(tpl.content.cloneNode(true));
    }
  }

  // Runs AFTER dashboard.js's own query filter (same element, registered later), so
  // the final visibility always reflects query + status together.
  function apply() {
    var all = cards();
    var q = norm(search ? search.value : '');
    var shown = 0;
    all.forEach(function (card) {
      var hit = matches(card);
      card.classList.toggle('hidden', !hit);
      if (hit) shown++;
    });
    var nomatch = byId('recent-nomatch');
    if (nomatch) nomatch.hidden = !(all.length > 0 && shown === 0 && (q !== '' || filter !== 'all'));
    paintCounts();
  }

  window.setMeetFilter = function (next) {
    if (next !== 'all' && next !== 'live' && next !== 'ended') return;
    filter = next;
    $$('#meet-filter .dash-chip').forEach(function (chip) {
      var on = chip.getAttribute('data-filter') === next;
      chip.classList.toggle('is-on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    apply();
  };

  $$('#meet-filter .dash-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      window.setMeetFilter(chip.getAttribute('data-filter'));
    });
  });

  if (search) search.addEventListener('input', apply);
  if (search) search.addEventListener('search', apply);

  /* ---------------------------------------------------------------- delete */
  window.deleteRecent = function (id, btn) {
    var card = btn && btn.closest ? btn.closest('[data-recent-card]') : null;
    var titleEl = card ? card.querySelector('.dash-mcard-title') : null;
    var title = titleEl ? titleEl.textContent : '';

    window.bmConfirm({
      title: 'حذف دائمی تماس',
      body: 'تماس' + (title ? ' «' + title + '»' : '') + ' برای همیشه حذف می‌شود؛ پیام‌های داخل آن هم پاک می‌شوند و لینک تماس از کار می‌افتد.',
      confirmText: 'حذف کن',
      cancelText: 'انصراف',
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      if (btn && btn.classList) btn.classList.add('is-pending');

      fetch((window.BASE || '') + '/api/meetings/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ meeting_id: id, csrf: window.CSRF }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) {
            if (btn && btn.classList) btn.classList.remove('is-pending');
            window.bmToast((d && d.msg) || 'تماس حذف نشد', 'error');
            return;
          }
          if (card) card.remove();
          apply();
          window.bmToast('تماس حذف شد');
        })
        .catch(function () {
          if (btn && btn.classList) btn.classList.remove('is-pending');
          window.bmToast('خطا در ارتباط با سرور', 'error');
        });
    });
  };

  /* ------------------------------------------------ meeting creation mode (manager) */
  var createMode = window.MEETING_CREATE_MODE || 'all';
  var CREATE_MODE_LABELS = { all: 'فعال برای همه', premium: 'فعال برای پریمیوم‌ها', admin: 'فعال برای ادمین‌ها' };
  var CREATE_MODE_DOTS = { all: 'bg-secondary', premium: 'bg-primary', admin: 'bg-error' };

  function setCreateModeUi(mode) {
    var label = byId('create-mode-label');
    var dot = byId('create-mode-dot');
    if (label) label.textContent = CREATE_MODE_LABELS[mode] || mode;
    if (dot) dot.className = 'mem-mode-dot ' + (CREATE_MODE_DOTS[mode] || 'bg-secondary');
    $$('#create-mode-menu .mode-opt').forEach(function (b) {
      var on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('active', on);
      var chk = b.querySelector('.mode-opt-check');
      if (chk) chk.classList.toggle('hidden', !on);
    });
  }

  function closeCreateModeMenu() {
    var menu = byId('create-mode-menu');
    var btn = byId('create-mode-btn');
    if (menu && !menu.classList.contains('hidden')) {
      menu.classList.add('hidden');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  }

  window.toggleCreateModeMenu = function (e) {
    if (e) e.stopPropagation();
    var menu = byId('create-mode-menu');
    var btn = byId('create-mode-btn');
    if (!menu) return;
    var open = menu.classList.contains('hidden');
    closeCreateModeMenu();
    if (open) {
      menu.classList.remove('hidden');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    }
  };

  window.setMeetingCreateMode = function (mode) {
    var btn = byId('create-mode-btn');
    if (btn) btn.disabled = true;
    fetch((window.BASE || '') + '/api/admin/meeting-create-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ mode: mode, csrf: window.CSRF }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (btn) btn.disabled = false;
        if (!d || !d.ok) {
          window.bmToast((d && d.msg) || 'خطا در تغییر حالت', 'error');
          return;
        }
        createMode = d.mode;
        window.MEETING_CREATE_MODE = createMode;
        setCreateModeUi(createMode);
        closeCreateModeMenu();
        window.bmToast('دسترسی ایجاد تماس: ' + (CREATE_MODE_LABELS[createMode] || createMode), 'success');
      })
      .catch(function () {
        if (btn) btn.disabled = false;
        window.bmToast('خطا در ارتباط با سرور', 'error');
      });
  };

  doc.addEventListener('click', function (e) {
    if (e.target && e.target.closest && (e.target.closest('#create-mode-menu') || e.target.closest('#create-mode-btn'))) return;
    closeCreateModeMenu();
  });

  if (window.CAN_CHANGE_MEETING_MODE) setCreateModeUi(createMode);

  paintCounts();
})();
