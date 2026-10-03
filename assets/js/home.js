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
    try { localStorage.setItem(SEEN_KEY, String(maxNotifId(window._notifs))); } catch (e) {}
    updateBellDot();
  }
  window.toggleNotifications = function () {
    const p = document.getElementById('notif-popup');
    if (!p) return;
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) loadNotifications(markNotifsSeen);
  };
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

  // realtime: new announcements arrive via notif:new (pushed by PHP internal API)
  if (window.BMLive && EV) {
    BMLive.on(EV.NOTIF_NEW, a => {
      const list = window._notifs || [];
      if (a && a.body && !list.some(x => x.id === a.id || x.body === a.body)) {
        list.unshift(a);
        window._notifs = list;
        renderNotifications(list);
        updateBellDot();
        const p = document.getElementById('notif-popup');
        if (p && !p.classList.contains('hidden')) markNotifsSeen(); // already reading it
        else showToast('اعلان جدید: ' + a.body);
      }
    });
    BMLive.on('live:connected', () => loadNotifications()); // catch-up bootstrap after reconnect
  }

  function renderNotifications(list) {
    const box = document.getElementById('notif-list');
    if (!box) return;
    const arr = list.slice();
    if (notifSort === 'new') arr.reverse();
    if (!arr.length) { box.innerHTML = '<p class="text-on-surface-variant font-body-sm text-center py-4">اعلانى وجود ندارد</p>'; return; }
    box.innerHTML = '';
    arr.forEach(a => {
      const el = document.createElement('div');
      el.className = 'bg-surface-container rounded-lg p-3 border border-outline-variant/20';
      el.innerHTML = '<p class="font-body-sm text-on-surface">' + escapeHtml(a.body) + '</p><p class="font-label-sm text-on-surface-variant text-[11px] mt-1">' + (a.created_at || '') + '</p>';
      box.appendChild(el);
    });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  loadNotifications();
})();
