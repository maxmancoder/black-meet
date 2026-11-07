// assets/js/home.js — dashboard data layer (home page only).
// Notifications arrive over the live socket (no polling), the join form talks to
// api/meetings/info, the recent list deletes through api/meetings/delete.
// UI chrome (toast / drawer / confirm / menu) lives in dashboard.js, loaded first.
(function () {
  'use strict';
  var BASE = window.BASE || '/black-meet';
  var EV = window.BMEv;
  try { localStorage.setItem('blackmeet_logged_in', '1'); } catch (e) {}

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function byId(id) { return document.getElementById(id); }

  function faDigits(n) {
    try { return Number(n).toLocaleString('fa-IR'); } catch (e) { return String(n); }
  }

  function showToast(msg, kind) {
    if (window.bmToast) window.bmToast(msg, kind || 'info');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ==================================================================== join */
  function extractRoom(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!v) return '';
    try {
      var u = new URL(v, location.origin);
      var r = u.searchParams.get('room');
      if (r) return r.trim();
    } catch (e) {}
    var m = v.match(/[?&]room=([^&\s#]+)/);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    if (v.indexOf('/') !== -1) v = v.split('/').filter(Boolean).pop() || '';
    return v.trim();
  }

  var joinForm = byId('join-form');
  if (joinForm) {
    var joinInput = byId('join-input');
    var joinBtn = byId('join-submit');
    var joinErr = byId('join-error');

    var setJoinError = function (msg) {
      if (!joinErr) return;
      if (msg) {
        joinErr.textContent = msg;
        joinErr.hidden = false;
        if (joinInput) {
          joinInput.classList.add('is-invalid');
          joinInput.setAttribute('aria-invalid', 'true');
        }
      } else {
        joinErr.textContent = '';
        joinErr.hidden = true;
        if (joinInput) {
          joinInput.classList.remove('is-invalid');
          joinInput.removeAttribute('aria-invalid');
        }
      }
    };

    if (joinInput) {
      joinInput.addEventListener('input', function () {
        if (joinErr && !joinErr.hidden) setJoinError('');
      });
    }

    joinForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var room = extractRoom(joinInput ? joinInput.value : '');
      if (!room) { setJoinError('لینک یا کد تماس را وارد کنید'); return; }
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(room)) { setJoinError('این لینک یا کد معتبر به نظر نمی‌رسد'); return; }

      setJoinError('');
      if (joinBtn) {
        joinBtn.classList.add('is-busy');
        joinBtn.setAttribute('aria-busy', 'true');
        joinBtn.disabled = true;
      }

      fetch('api/meetings/info?room=' + encodeURIComponent(room))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok && d.room_id) {
            location.href = BASE + '/meeting?room=' + encodeURIComponent(d.room_id);
            return;
          }
          setJoinError((d && d.msg) || 'لینک تماس معتبر نیست یا پایان یافته است');
        })
        .catch(function () {
          setJoinError('ارتباط برقرار نشد؛ اتصال اینترنت را بررسی کنید');
        })
        .then(function () {
          if (!joinBtn) return;
          joinBtn.classList.remove('is-busy');
          joinBtn.removeAttribute('aria-busy');
          joinBtn.disabled = false;
        });
    });
  }

  /* ============================================================ recent cards */
  function bumpStat(name, delta) {
    var node = $('[data-stat="' + name + '"]');
    if (!node) return;
    var v = Math.max(0, (Number(node.getAttribute('data-value')) || 0) + delta);
    node.setAttribute('data-value', String(v));
    node.textContent = faDigits(v);
  }

  function recountRecent() {
    var n = $$('[data-recent-card]').length;
    var count = byId('recent-count');
    if (count) count.textContent = n ? faDigits(n) + ' جلسه اخیر' : 'هنوز جلسه‌ای نداری';

    var grid = byId('recent-grid');
    if (grid && n === 0 && !grid.querySelector('.dash-empty')) {
      var tpl = byId('recent-empty-tpl');
      if (tpl && tpl.content) grid.appendChild(tpl.content.cloneNode(true));
    }
    if (grid) {
      var nomatch = byId('recent-nomatch');
      if (nomatch) nomatch.hidden = true;
    }
  }

  window.deleteRecent = function (id, btn) {
    var card = btn && btn.closest ? btn.closest('[data-recent-card]') : null;
    var title = card ? (($('.dash-mcard-title', card) || {}).textContent || '') : '';

    window.bmConfirm({
      title: 'حذف دائمی جلسه',
      body: 'جلسه' + (title ? ' «' + title + '»' : '') + ' برای همیشه حذف می‌شود؛ پیام‌های داخل آن هم پاک می‌شوند و لینک تماس از کار می‌افتد.',
      confirmText: 'حذف کن',
      cancelText: 'انصراف',
      danger: true,
    }).then(function (ok) {
      if (!ok) return;
      if (btn && btn.classList) btn.classList.add('is-pending');

      fetch('api/meetings/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ meeting_id: id, csrf: window.CSRF }),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) {
            if (btn && btn.classList) btn.classList.remove('is-pending');
            showToast((d && d.msg) || 'حذف نشد', 'error');
            return;
          }
          if (card) {
            // keep the counters honest: total always drops, "this month" only for
            // a meeting created in the current month, "active" only if live
            bumpStat('total', -1);
            var now0 = new Date();
            var month = now0.getFullYear() + '-' + String(now0.getMonth() + 1).padStart(2, '0');
            if (card.getAttribute('data-created') === month) bumpStat('month', -1);
            if (card.getAttribute('data-active') === '1') {
              bumpStat('active', -1);
              var activeStat = $('[data-stat-card="active"]');
              if (activeStat && (Number(activeStat.getAttribute('data-value')) || 0) === 0) {
                activeStat.classList.remove('is-live');
              }
            }
            card.remove();
          }
          recountRecent();
          showToast('جلسه حذف شد');
        })
        .catch(function () {
          if (btn && btn.classList) btn.classList.remove('is-pending');
          showToast('خطا در ارتباط با سرور', 'error');
        });
    });
  };

  /* =================================================================== toasts */
  var params = new URLSearchParams(location.search);
  if (params.get('err') === 'blocked') {
    showToast('شما از طرف ادمین مسدود شدید و اجازه ورود به این تماس را ندارید', 'error');
  } else if (params.get('err') === 'nomeeting') {
    showToast('این تماس به پایان رسیده است', 'error');
  }

  /* ============================================================ notifications */
  var SEEN_KEY = 'bm_notif_seen_id';
  var notifSort = 'new';

  function maxNotifId(list) {
    return (list || []).reduce(function (m, a) { return Math.max(m, Number(a.id) || 0); }, 0);
  }

  function seenId() {
    try { return Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (e) { return 0; }
  }

  function updateBellDot() {
    var dot = byId('bell-dot');
    if (!dot) return;
    dot.classList.toggle('hidden', maxNotifId(window._notifs) <= seenId());
  }

  function markNotifsSeen() {
    try {
      var cur = maxNotifId(window._notifs);
      var prev = seenId();
      if (cur > prev) localStorage.setItem(SEEN_KEY, String(cur));
    } catch (e) {}
    updateBellDot();
    var p = byId('notif-popup');
    if (p && !p.classList.contains('hidden') && window._notifs) {
      renderNotifications(window._notifs);
      renderRail(window._notifs);
    }
  }

  function positionNotifPopup() {
    var p = byId('notif-popup');
    var bell = byId('bell-btn');
    if (!p || !bell) return;
    var r = bell.getBoundingClientRect();
    var w = p.offsetWidth || 346;
    p.style.position = 'fixed';
    p.style.top = Math.round(r.bottom + 10) + 'px';
    var gap = Math.round(window.innerWidth - r.right);
    p.style.right = Math.min(Math.max(8, gap), Math.max(8, window.innerWidth - w - 8)) + 'px';
    p.style.left = 'auto';
  }

  window.toggleNotifications = function () {
    var p = byId('notif-popup');
    if (!p) return;
    var opening = p.classList.contains('hidden');
    p.classList.toggle('hidden');
    if (opening) {
      positionNotifPopup();
      markNotifsSeen();
      loadNotifications(markNotifsSeen);
    } else {
      markNotifsSeen();
    }
  };

  window.addEventListener('resize', function () {
    var p = byId('notif-popup');
    if (p && !p.classList.contains('hidden')) positionNotifPopup();
  });

  window.setNotifSort = function (s) {
    notifSort = s === 'old' ? 'old' : 'new';
    var bNew = byId('sort-new');
    var bOld = byId('sort-old');
    if (bNew) bNew.classList.toggle('is-on', notifSort === 'new');
    if (bOld) bOld.classList.toggle('is-on', notifSort === 'old');
    renderNotifications(window._notifs || []);
  };

  function renderNotifications(list) {
    var box = byId('notif-list');
    if (!box) return;
    var arr = (list || []).slice();
    // the API is newest-first: only the "old" view has to be reversed
    if (notifSort === 'old') arr.reverse();

    if (!arr.length) {
      box.innerHTML = '<p>هنوز پیام عمومی‌ای منتشر نشده است</p>';
      return;
    }

    var seen = seenId();
    var html = '';
    arr.forEach(function (a) {
      var isNew = (Number(a.id) || 0) > seen;
      html +=
        '<div class="dash-nitem ' + (isNew ? 'is-new' : 'is-read') + '">' +
          '<div class="dash-nitem-row">' +
            '<p class="dash-nitem-text">' + escapeHtml(a.body) + '</p>' +
            (isNew
              ? '<span class="dash-nitem-new">جدید</span>'
              : '<span class="dash-nitem-ok" title="خوانده شده">' + (window.bmIcon ? bmIcon('check_circle') : '') + '</span>') +
          '</div>' +
          '<p class="dash-nitem-time">' + escapeHtml(a.created_at || '') + '</p>' +
        '</div>';
    });
    box.innerHTML = html;
  }

  var rail = byId('dash-announce');

  function renderRail(list) {
    if (!rail) return;
    rail.setAttribute('aria-busy', 'false');
    var arr = (list || []).slice(0, 4);
    if (!arr.length) {
      rail.innerHTML =
        '<div class="dash-announce-empty">' +
          (window.bmIcon ? bmIcon('campaign') : '') +
          '<span>هنوز پیام عمومی‌ای منتشر نشده است</span>' +
        '</div>';
      return;
    }

    var seen = seenId();
    var html = '';
    arr.forEach(function (a) {
      var isNew = (Number(a.id) || 0) > seen;
      html +=
        '<div class="dash-acard ' + (isNew ? '' : 'is-read') + '" data-announce-id="' + (Number(a.id) || 0) + '" role="button" tabindex="0">' +
          '<span class="dash-acard-ico">' + (window.bmIcon ? bmIcon('campaign') : '') + '</span>' +
          '<div class="dash-acard-body">' +
            '<p class="dash-acard-text">' + escapeHtml(a.body) + '</p>' +
            '<div class="dash-acard-meta">' +
              (isNew ? '<span class="dash-acard-new">جدید</span>' : '') +
              '<span>' + escapeHtml(a.created_at || '') + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
    });
    rail.innerHTML = html;
  }

  function renderRailError() {
    if (!rail) return;
    rail.setAttribute('aria-busy', 'false');
    rail.innerHTML =
      '<div class="dash-announce-empty">' +
        (window.bmIcon ? bmIcon('error') : '') +
        '<span>دریافت پیام‌ها ممکن نشد.</span>' +
        '<button type="button" class="dash-btn dash-btn-soft dash-announce-retry" data-no-loader>تلاش دوباره</button>' +
      '</div>';
  }

  if (rail) {
    rail.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.dash-announce-retry')) { loadNotifications(); return; }
      if (t.closest('.dash-acard')) {
        var p = byId('notif-popup');
        if (p && p.classList.contains('hidden')) window.toggleNotifications();
        else {
          var list = byId('notif-list');
          if (list) list.scrollTop = 0;
        }
      }
    });
    rail.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest ? e.target.closest('.dash-acard') : null;
      if (!card) return;
      e.preventDefault();
      card.click();
    });
  }

  function loadNotifications(cb) {
    fetch('api/announcements')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error('bad payload');
        window._notifs = d.announcements || [];
        renderNotifications(window._notifs);
        renderRail(window._notifs);
        updateBellDot();
        if (cb) cb();
      })
      .catch(function () {
        renderRailError();
        var box = byId('notif-list');
        if (box && !box.children.length) box.innerHTML = '<p>دریافت پیام‌ها ممکن نشد</p>';
        if (cb) cb();
      });
  }
  window.bmReloadNotifs = loadNotifications;

  /* ============================================== unread private message badge */
  var msgUnread = 0;

  function setMsgBadge(n) {
    msgUnread = Math.max(0, Number(n) || 0);
    var txt = faDigits(msgUnread);
    $$('[data-msg-badge]').forEach(function (b) {
      b.textContent = txt;
      b.classList.toggle('hidden', msgUnread <= 0);
    });
    var d = byId('msg-unread-badge');
    if (d) {
      d.textContent = txt;
      d.classList.toggle('hidden', msgUnread <= 0);
    }
  }

  if ($('[data-msg-badge], #msg-unread-badge')) {
    fetch('api/messages/unread')
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) setMsgBadge(d.count); })
      .catch(function () {});
  }

  /* ================================================================ realtime */
  if (window.BMLive && EV) {
    BMLive.on(EV.PV_NEW_MESSAGE, function (m) {
      if (!m) return;
      var bumpsMe = window.__isManager ? !m.fromManager : !!m.fromManager;
      if (bumpsMe && Number(m.fromUserId) !== Number(window.MS_ID || 0)) setMsgBadge(msgUnread + 1);
    });

    BMLive.on(EV.NOTIF_NEW, function (a) {
      if (!a || !a.body) return;
      // announcements are broadcast to everyone: never echo the sender's own post
      if (Number(a.fromUserId) === Number(window.MS_ID || 0)) return;
      var list = window._notifs || [];
      if (list.some(function (x) { return x.id === a.id || x.body === a.body; })) return;
      list.unshift(a);
      window._notifs = list;
      renderNotifications(list);
      renderRail(list);
      updateBellDot();
      var p = byId('notif-popup');
      if (p && !p.classList.contains('hidden')) markNotifsSeen();
      else showToast('پیام عمومی جدید: ' + a.body, 'info');
    });

    // catch-up bootstrap after a reconnect (live.js may have been down)
    BMLive.on('live:connected', function () { loadNotifications(); });
  }

  loadNotifications();
})();
