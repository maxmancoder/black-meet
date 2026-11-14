// assets/js/meetings.js — the meetings index (dash shell).
// dashboard.js owns shell chrome (toast/drawer/confirm/clipboard/#recent-search text filter).
// This file: status chips, counters, delete/end flows, and realtime list updates.
(function () {
  'use strict';

  var doc = document;
  var EV = window.BMEv || {};

  function byId(id) { return doc.getElementById(id); }
  function $$(sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function faDigits(n) {
    return String(n == null ? 0 : n).replace(/[0-9]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[Number(d)]; });
  }
  function svgIcon(name, fill) {
    if (window.bmIcon) return window.bmIcon(name, fill);
    return '';
  }

  // approximate Persian relative time for realtime-inserted cards
  function timeAgo(dt) {
    if (!dt) return '';
    var t = Date.parse(String(dt).replace(' ', 'T'));
    if (isNaN(t)) return esc(dt);
    var diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (diff < 60) return 'همین الان';
    if (diff < 3600) return faDigits(Math.floor(diff / 60)) + ' دقیقه پیش';
    if (diff < 86400) return faDigits(Math.floor(diff / 3600)) + ' ساعت پیش';
    if (diff < 2592000) return faDigits(Math.floor(diff / 86400)) + ' روز پیش';
    return faDigits(Math.floor(diff / 2592000)) + ' ماه پیش';
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
    if (count) {
      count.textContent = all.length
        ? faDigits(all.length) + ' تماس'
        : (window.CAN_SEE_ALL_MEETINGS ? 'هنوز تماسی ثبت نشده است' : 'هنوز تماسی نساخته‌اید');
    }
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

  /* ---------------------------------------------------------------- actions */
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

  window.endMeeting = function (id, btn) {
    var card = btn && btn.closest ? btn.closest('[data-recent-card]') : null;
    var titleEl = card ? card.querySelector('.dash-mcard-title') : null;
    var title = titleEl ? titleEl.textContent : '';

    window.bmConfirm({
      title: 'قطع تماس',
      body: 'تماس' + (title ? ' «' + title + '»' : '') + ' قطع می‌شود و شرکت‌کنندگان از آن خارج می‌شوند.',
      confirmText: 'قطع کن',
      cancelText: 'انصراف',
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      if (btn && btn.classList) btn.classList.add('is-pending');
      fetch((window.BASE || '') + '/api/meetings/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ meeting_id: id, csrf: window.CSRF }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) {
            if (btn && btn.classList) btn.classList.remove('is-pending');
            window.bmToast((d && d.msg) || 'تماس قطع نشد', 'error');
            return;
          }
          markCardEnded(id);
          window.bmToast('تماس قطع شد');
        })
        .catch(function () {
          if (btn && btn.classList) btn.classList.remove('is-pending');
          window.bmToast('خطا در ارتباط با سرور', 'error');
        });
    });
  };

  function cardById(id) {
    return doc.querySelector('[data-meeting-id="' + String(id) + '"]');
  }

  function markCardEnded(id) {
    var card = cardById(id);
    if (!card) return;
    card.setAttribute('data-active', '0');
    card.classList.remove('is-live');
    var right = card.querySelector('.dash-mcard-right');
    if (right) right.innerHTML = '<span class="dash-tag">پایان‌یافته</span>';
    // remove active-only actions (copy/join/end), keep delete
    card.querySelectorAll('.dash-mini-open, [onclick^="copyMeetLink"], [onclick^="endMeeting"]').forEach(function (el) {
      var n = el.closest ? el.closest('a,button') : el;
      if (n) n.remove();
    });
    apply();
  }

  function removeCard(id) {
    var card = cardById(id);
    if (!card) return;
    card.remove();
    apply();
  }

  function canSeeMeeting(m) {
    if (window.CAN_SEE_ALL_MEETINGS) return true;
    return Number(m.creator_id) === Number(window.MS_ID);
  }

  function buildCard(m) {
    var id = Number(m.id);
    var active = Number(m.active) ? 1 : 0;
    var room = String(m.room_id || '');
    var title = String(m.title || '');
    var creatorId = Number(m.creator_id || 0);
    var creatorName = String(m.creator_name || '');
    var members = Number(m.members) || 0;
    var canManage = !!(window.CAN_MANAGE_ALL_MEETINGS || creatorId === Number(window.MS_ID));
    var canDelete = !!(window.__isManager || creatorId === Number(window.MS_ID));
    var link = (window.PUBLIC_URL || '') + '/meeting?room=' + encodeURIComponent(room);
    var joinHref = (window.BASE || '') + '/meeting?room=' + encodeURIComponent(room);

    var art = doc.createElement('article');
    art.className = 'dash-mcard' + (active ? ' is-live' : '');
    art.setAttribute('data-recent-card', '');
    art.setAttribute('data-meeting-id', String(id));
    art.setAttribute('data-room', room);
    art.setAttribute('data-creator', String(creatorId));
    art.setAttribute('data-active', String(active));
    art.setAttribute('data-created', String(m.created_at || '').slice(0, 7));
    art.setAttribute('data-title', title.toLowerCase());

    var actions = '';
    if (active) {
      actions += '<button type="button" class="dash-mini" data-no-loader onclick="copyMeetLink(this)" data-link="' + esc(link) + '" title="کپی لینک تماس" aria-label="کپی لینک تماس">' + svgIcon('link') + '</button>';
      actions += '<a class="dash-mini dash-mini-open" href="' + esc(joinHref) + '" title="ورود به تماس" aria-label="ورود به تماس">' + svgIcon('login') + '</a>';
      if (canManage) {
        actions += '<button type="button" class="dash-mini dash-mini-danger" data-no-loader onclick="endMeeting(' + id + ', this)" title="قطع تماس" aria-label="قطع تماس">' + svgIcon('call_end') + '</button>';
      }
    }
    if (canDelete) {
      actions += '<button type="button" class="dash-mini dash-mini-danger" data-no-loader onclick="deleteRecent(' + id + ', this)" title="حذف دائمی تماس" aria-label="حذف دائمی تماس">' + svgIcon('close') + '</button>';
    }

    art.innerHTML =
      '<div class="dash-mcard-top">' +
        '<span class="dash-mcard-ico">' + svgIcon('video_library') + '</span>' +
        '<span class="dash-mcard-right">' + (active
          ? '<span class="dash-tag dash-tag-live"><span class="dash-live-dot" aria-hidden="true"></span> در حال اجرا</span>'
          : '<span class="dash-tag">پایان‌یافته</span>') + '</span>' +
      '</div>' +
      '<h3 class="dash-mcard-title" title="' + esc(title) + '">' + esc(title) + '</h3>' +
      '<p class="dash-mcard-meta">' + svgIcon('groups') + '<span>' + faDigits(members) + ' عضو</span>' +
        '<span class="dash-dot-sep" aria-hidden="true"></span><span>' + esc(timeAgo(m.created_at)) + '</span></p>' +
      (window.CAN_SEE_ALL_MEETINGS && creatorName ? '<p class="dash-mcard-meta dash-mcard-creator">' + svgIcon('person') + '<span>سازنده: ' + esc(creatorName) + '</span></p>' : '') +
      '<div class="dash-mcard-foot">' +
        '<span class="dash-mcard-room" dir="ltr">' + esc(room.slice(0, 8)) + '…</span>' +
        '<span class="dash-mcard-actions">' + actions + '</span>' +
      '</div>';
    return art;
  }

  function insertOrUpdateCard(m) {
    if (!m || !canSeeMeeting(m)) return;
    var id = Number(m.id);
    if (!id) return;
    var existing = cardById(id);
    if (existing) {
      // update minimal fields (active/members/title)
      if (Number(m.active) === 0) { markCardEnded(id); }
      var t = existing.querySelector('.dash-mcard-title');
      if (t && m.title) { t.textContent = String(m.title); t.title = String(m.title); existing.setAttribute('data-title', String(m.title).toLowerCase()); }
      return;
    }
    var grid = byId('recent-grid');
    if (!grid) return;
    var empty = grid.querySelector('#recent-empty');
    if (empty) empty.remove();
    grid.insertBefore(buildCard(m), grid.firstChild);
    apply();
  }

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

  // realtime: reflect meeting lifecycle without page refresh
  if (window.BMLive && EV) {
    if (EV.MEETING_CREATED) {
      window.BMLive.on(EV.MEETING_CREATED, function (m) {
        if (!m) return;
        // creator already sees their own meeting after redirect; ignore if duplicate
        insertOrUpdateCard(m);
      });
    }
    if (EV.MEETING_ENDED) {
      window.BMLive.on(EV.MEETING_ENDED, function (m) {
        if (!m) return;
        markCardEnded(m.id);
      });
    }
    if (EV.MEETING_DELETED) {
      window.BMLive.on(EV.MEETING_DELETED, function (m) {
        if (!m) return;
        removeCard(m.id);
      });
    }
  }

  paintCounts();
})();
