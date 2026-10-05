// assets/js/home.js — Phase 1: notifications via realtime (no polling)
(function () {
  const BASE = window.BASE;
  const EV = window.BMEv;
  localStorage.setItem('blackmeet_logged_in', '1');

  function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toast-message').textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
  }

  function extractRoom(val) {
    val = val.trim();
    if (!val) return '';
    const m = val.match(/[?&]room=([^&\s]+)/);
    if (m) return m[1];
    return val;
  }

  const form = document.getElementById('join-form');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    const raw = document.getElementById('join-input').value;
    const room = extractRoom(raw);
    if (!room) return showToast('لینک یا کد تماس را وارد کنید');
    fetch('api/meetings/info?room=' + encodeURIComponent(room))
      .then(r => r.json())
      .then(d => {
        if (d.ok) location.href = BASE + '/meeting?room=' + encodeURIComponent(d.room_id);
        else showToast('لینک تماس معتبر نیست');
      })
      .catch(() => showToast('خطا در برقراری ارتباط'));
  });

  window.logout = function (e) {
    if (e) e.preventDefault();
    fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'csrf=' + encodeURIComponent(window.CSRF) })
      .then(r => r.json())
      .then(d => {
        localStorage.removeItem('blackmeet_logged_in');
        location.href = d.redirect || BASE + '/login';
      });
  };

  const params = new URLSearchParams(location.search);
  if (params.get('err') === 'blocked') showToast('شما از طرف ادمین مسدود شدید و اجازه ورود به این تماس را ندارید');

  // ---- Notifications: bootstrap once via HTTP, then realtime only ----
  // the bell dot means "there is an announcement you haven't opened yet"
  const SEEN_KEY = 'bm_notif_seen_id';
  let notifSort = 'new';
  function maxNotifId(list) {
    return (list || []).reduce((m, a) => Math.max(m, Number(a.id) || 0), 0);
  }
  function markNotifsSeen() {
    // never regress: only move the seen id forward (stale/empty data can't re-dot the bell)
    try {
      const cur = maxNotifId(window._notifs);
      const prev = Number(localStorage.getItem(SEEN_KEY)) || 0;
      if (cur > prev) localStorage.setItem(SEEN_KEY, String(cur));
    } catch (e) {}
    updateBellDot();
    // while the popup is open, items flip to their "read" styling right away
    const p = document.getElementById('notif-popup');
    if (p && !p.classList.contains('hidden') && window._notifs) renderNotifications(window._notifs);
  }
  function positionNotifPopup() {
    const p = document.getElementById('notif-popup');
    const bell = document.getElementById('bell-btn');
    if (!p || !bell) return;
    const r = bell.getBoundingClientRect();
    const w = p.offsetWidth || 320;
    p.style.position = 'fixed';
    p.style.top = Math.round(r.bottom + 10) + 'px';
    // anchor the popup's right edge to the bell's right edge (RTL), kept on screen
    const gap = Math.round(window.innerWidth - r.right);
    p.style.right = Math.min(Math.max(8, gap), Math.max(8, window.innerWidth - w - 8)) + 'px';
    p.style.left = 'auto';
  }
  window.toggleNotifications = function () {
    const p = document.getElementById('notif-popup');
    if (!p) return;
    const opening = p.classList.contains('hidden');
    p.classList.toggle('hidden');
    if (opening) { positionNotifPopup(); markNotifsSeen(); loadNotifications(markNotifsSeen); }
    else markNotifsSeen(); // remember on close too, so the dot stays away
  };
  window.addEventListener('resize', function () {
    const p = document.getElementById('notif-popup');
    if (p && !p.classList.contains('hidden')) positionNotifPopup();
  });
  window.setNotifSort = function (s) {
    notifSort = s;
    document.getElementById('sort-old').className = 'text-[12px] px-2 py-1 rounded-md ' + (s === 'old' ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container-high text-on-surface');
    document.getElementById('sort-new').className = 'text-[12px] px-2 py-1 rounded-md ' + (s === 'new' ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container-high text-on-surface');
    renderNotifications(window._notifs || []);
  };
  function loadNotifications(cb) {
    fetch('api/announcements')
      .then(r => r.json())
      .then(d => { window._notifs = (d.announcements || []); renderNotifications(window._notifs); updateBellDot(); if (cb) cb(); })
      .catch(() => {});
  }
  function updateBellDot() {
    const dot = document.getElementById('bell-dot');
    if (!dot) return;
    let seen = 0;
    try { seen = Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (e) {}
    dot.classList.toggle('hidden', maxNotifId(window._notifs) <= seen);
  }

  // ---- unread private messages badge (next to the messages sidebar link) ----
  // shown from the server count on load, bumped live, cleared by visiting /messages
  let msgUnread = 0;
  function setMsgBadge(n) {
    msgUnread = Math.max(0, Number(n) || 0);
    const b = document.getElementById('msg-unread-badge');
    if (!b) return;
    try { b.textContent = msgUnread.toLocaleString('fa-IR'); } catch (e) { b.textContent = String(msgUnread); }
    b.classList.toggle('hidden', msgUnread <= 0);
  }
  if (document.getElementById('msg-unread-badge')) {
    fetch('api/messages/unread')
      .then(r => r.json())
      .then(d => { if (d && d.ok) setMsgBadge(d.count); })
      .catch(() => {});
  }

  // realtime: new announcements arrive via notif:new (pushed by PHP internal API)
  if (window.BMLive && EV) {
    // live bump of the unread-messages badge
    BMLive.on(EV.PV_NEW_MESSAGE, m => {
      const bumpsMe = window.__isManager ? !m.fromManager : !!m.fromManager;
      if (bumpsMe && Number(m.fromUserId) !== Number(window.MS_ID || 0)) setMsgBadge(msgUnread + 1);
    });
    BMLive.on(EV.NOTIF_NEW, a => {
      const list = window._notifs || [];
      if (a && a.body && !list.some(x => x.id === a.id || x.body === a.body)) {
        list.unshift(a);
        window._notifs = list;
        renderNotifications(list);
        updateBellDot();
        const p = document.getElementById('notif-popup');
        if (p && !p.classList.contains('hidden')) markNotifsSeen(); // already reading it
        else showToast('پیام عمومی جدید: ' + a.body);
      }
    });
    BMLive.on('live:connected', () => loadNotifications()); // catch-up bootstrap after reconnect
  }

  function renderNotifications(list) {
    const box = document.getElementById('notif-list');
    if (!box) return;
    const arr = list.slice();
    // API returns newest-first (ORDER BY id DESC): 'new' needs no reverse, 'old' does
    if (notifSort === 'old') arr.reverse();
    if (!arr.length) { box.innerHTML = '<p class="text-on-surface-variant font-body-sm text-center py-4">اعلانى وجود ندارد</p>'; return; }
    let seen = 0;
    try { seen = Number(localStorage.getItem(SEEN_KEY)) || 0; } catch (e) {}
    box.innerHTML = '';
    arr.forEach(a => {
      const id = Number(a.id) || 0;
      const isNew = id > seen; // "new" only until the item has actually been viewed
      const el = document.createElement('div');
      el.className = 'bg-surface-container rounded-lg p-3 border ' +
        (isNew ? 'border-primary/50' : 'border-outline-variant/20 opacity-75');
      el.innerHTML =
        '<div class="flex items-start justify-between gap-2">' +
          '<p class="font-body-sm text-on-surface flex-1">' + escapeHtml(a.body) + '</p>' +
          (isNew
            ? '<span class="shrink-0 self-start bg-primary text-on-primary font-label-sm text-[10px] px-1.5 py-0.5 rounded-full">جدید</span>'
            : '<span class="shrink-0 self-start text-secondary" title="خوانده شده">' + bmIcon('check_circle', 'text-[14px]') + '</span>') +
        '</div>' +
        '<p class="font-label-sm text-on-surface-variant text-[11px] mt-1">' + (a.created_at || '') + '</p>';
      box.appendChild(el);
    });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  loadNotifications();
})();
