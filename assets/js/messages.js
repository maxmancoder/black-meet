// assets/js/messages.js — Phase 1: realtime private messages (no polling)
(function () {
  const BASE = window.BASE;
  const CSRF = window.CSRF;
  const EV = window.BMEv;
  let convs = [];
  let view = null; // {type:'user', user_id, ...} | {type:'public'}

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function aUrl(a) {
    if (!a) return '';
    if (/^https?:\/\//i.test(a)) return a;
    return BASE + '/' + a.replace(/^\/+/, '');
  }
  function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toast-message').textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
  }
  function avatarInner(avatar, color, name) {
    if (avatar) return '<img src="' + esc(aUrl(avatar)) + '" class="w-full h-full object-cover" alt=""/>';
    const p = (name || '').trim().split(/\s+/);
    const init = p.length >= 2 ? p[0][0] + p[1][0] : (name || '؟').slice(0, 2);
    return '<div class="w-full h-full flex items-center justify-center font-display-md text-white" style="background:' + (color || '#4f46e5') + '">' + esc(init) + '</div>';
  }

  // ---- presence (realtime online/offline instead of last_activity) ----
  const onlineUsers = new Set();
  function isOnline(userId) { return onlineUsers.has(Number(userId)); }
  function refreshHeaderStatus() {
    if (!view || view.type !== 'user') return;
    const el = document.getElementById('ph-status');
    if (el) el.textContent = isOnline(view.user_id) ? 'آنلاین' : 'آفلاین';
  }

  function loadConvs(cb) {
    fetch('api/messages/conversations')
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return;
        convs = d.conversations || [];
        renderConvs();
        if (cb) cb();
      })
      .catch(() => {});
  }

  // mobile: show the chat pane instead of the conversation list
  function setMobileChat(on) {
    const m = document.getElementById('msg-main');
    if (m) m.classList.toggle('chat-open', !!on);
  }

  window.backToConvs = function (e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    view = null;
    setMobileChat(false);
    const h = document.getElementById('profile-header');
    if (h) { h.classList.add('hidden'); h.classList.remove('flex'); }
    const box = document.getElementById('chat-area');
    if (box) box.innerHTML = '<div class="m-auto text-center text-on-surface-variant font-body-sm">یک گفتگو را انتخاب کنید</div>';
  };

  // incremental conversation row update (no full re-render)
  function updateConvRow(userId, patch) {
    const c = convs.find(x => Number(x.user_id) === Number(userId));
    if (!c) { loadConvs(); return; }
    Object.assign(c, patch);
    const box = document.getElementById('conv-list');
    const rows = box.querySelectorAll('[data-uid]');
    rows.forEach(row => {
      if (Number(row.dataset.uid) === Number(userId)) {
        const unread = Number(c.unread || 0);
        let dot = row.querySelector('.unread-dot');
        if (unread > 0 && !dot) {
          dot = document.createElement('span');
          dot.className = 'unread-dot absolute top-0 right-0 w-3 h-3 bg-primary rounded-full border-2 border-surface-container-low';
          row.querySelector('.relative') && row.querySelector('.relative').appendChild(dot);
        } else if (unread === 0 && dot) dot.remove();
      }
    });
  }

  function renderConvs() {
    const q = (document.getElementById('conv-search').value || '').trim().toLowerCase();
    const box = document.getElementById('conv-list');
    box.innerHTML = '';
    const pub = document.createElement('div');
    pub.className = 'flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ' + (view && view.type === 'public' ? 'bg-primary-container/40' : 'hover:bg-surface-container-high');
    pub.innerHTML = '<div class="w-10 h-10 rounded-full bg-secondary-container flex items-center justify-center text-on-secondary-container">' + bmIcon('campaign') + '</div>' +
      '<div class="flex-1 min-w-0"><h4 class="font-body-sm font-semibold text-on-surface truncate">پیام عمومی</h4><p class="font-label-sm text-on-surface-variant text-[10px]">اعلان‌ها</p></div>';
    pub.onclick = openPublic;
    box.appendChild(pub);

    convs.filter(c => !q || (c.display_name + ' ' + c.username).toLowerCase().includes(q)).forEach(c => {
      const el = document.createElement('div');
      el.dataset.uid = c.user_id;
      el.className = 'flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ' + (view && view.type === 'user' && view.user_id === c.user_id ? 'bg-primary-container/40' : 'hover:bg-surface-container-high');
      el.innerHTML = '<div class="relative w-10 h-10 rounded-full overflow-hidden border border-outline-variant">' + avatarInner(c.avatar, '#4f46e5', c.display_name) +
        (Number(c.unread) > 0 ? '<span class="unread-dot absolute top-0 right-0 w-3 h-3 bg-primary rounded-full border-2 border-surface-container-low"></span>' : '') + '</div>' +
        '<div class="flex-1 min-w-0"><h4 class="font-body-sm font-semibold text-on-surface truncate">' + esc(c.display_name) + '</h4><p class="font-label-sm text-on-surface-variant text-[10px]">@' + esc(c.username) + '</p></div>';
      el.onclick = () => openUser(c);
      box.appendChild(el);
    });
  }

  window.filterConvs = renderConvs;

  function setHeader(c) {
    const h = document.getElementById('profile-header');
    h.classList.remove('hidden');
    h.classList.add('flex');
    const name = c.display_name || c.name || '';
    document.getElementById('ph-avatar').innerHTML = avatarInner(c.avatar, '#4f46e5', name);
    document.getElementById('ph-name').textContent = name;
    document.getElementById('ph-status').textContent = c.type === 'public' ? 'پیام همگانی' : (isOnline(c.user_id) ? 'آنلاین' : 'آفلاین');
  }

  function appendMessage(m, fromMgr) {
    const box = document.getElementById('chat-area');
    const el = document.createElement('div');
    el.className = 'flex flex-col ' + (fromMgr ? 'items-start' : 'items-end');
    el.innerHTML = '<div class="' + (fromMgr ? 'bg-surface-container-high text-on-surface' : 'bg-primary-container text-on-primary-container') + ' p-3 rounded-2xl ' + (fromMgr ? 'rounded-tr-sm' : 'rounded-tl-sm') + ' text-body-sm max-w-[80%] border border-white/5">' + esc(m.body) + '</div>';
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    if (m.id) window._lastThreadId = Math.max(window._lastThreadId || 0, Number(m.id));
  }

  function renderChat(messages, type) {
    const box = document.getElementById('chat-area');
    box.innerHTML = '';
    (messages || []).forEach(m => {
      const fromMgr = (type === 'public') ? true : !!m.from_manager;
      appendMessage(m, fromMgr);
    });
  }

  function openUser(c) {
    view = { type: 'user', user_id: Number(c.user_id), name: c.display_name, username: c.username, avatar: c.avatar, email: c.email };
    setHeader(view);
    refreshHeaderStatus();
    setMobileChat(true);
    fetch('api/messages/conversations?user_id=' + c.user_id)
      .then(r => r.json())
      .then(d => { if (d.ok) renderChat(d.messages, 'user'); loadConvs(); })
      .catch(() => {});
  }

  function openPublic() {
    view = { type: 'public', name: 'اعلان عمومی' };
    setHeader(view);
    setMobileChat(true);
    fetch('api/announcements')
      .then(r => r.json())
      .then(d => { if (d.ok) renderChat((d.announcements || []).map(a => ({ id: a.id, body: a.body, from_manager: 1 })), 'public'); })
      .catch(() => {});
  }

  // ---- realtime: incoming PV messages ----
  if (window.BMLive && EV) {
    BMLive.on(EV.PV_NEW_MESSAGE, m => {
      const fromMgr = !!m.fromManager;
      const fromId = Number(m.fromUserId);
      if (fromId === Number(window.MS_ID)) return; // echo of my own send
      // a message counts as "mine to read" for the manager when it comes FROM the user,
      // and for a premium user when it comes FROM the admin
      const bumpsMe = window.__IS_MANAGER ? !fromMgr : fromMgr;
      const open = view && view.type === 'user' && Number(view.user_id) === fromId;
      if (open) {
        appendMessage({ id: m.id, body: m.body, from_manager: fromMgr ? 1 : 0 }, fromMgr);
        updateConvRow(fromId, { unread: 0 });
        if (bumpsMe) fetch('api/messages/conversations?user_id=' + fromId); // mark seen server-side
      } else if (bumpsMe) {
        const c = convs.find(x => Number(x.user_id) === fromId);
        if (!c) loadConvs();
        else updateConvRow(fromId, { unread: Number(c.unread || 0) + 1, last: m.body });
      }
    });

    BMLive.on(EV.PV_CONVERSATION_UPDATED, d => {
      const open = view && view.type === 'user' && Number(view.user_id) === Number(d.userId);
      if (open) return; // live append is handled by PV_NEW_MESSAGE
      const bumpsMe = window.__IS_MANAGER ? !d.fromManager : !!d.fromManager;
      if (!bumpsMe) return;
      const c = convs.find(x => Number(x.user_id) === Number(d.userId));
      if (!c) { loadConvs(); return; }
      updateConvRow(d.userId, { unread: Number(c.unread || 0) + 1, last: d.lastBody });
    });

    // public announcements stream into the open public thread
    BMLive.on(EV.NOTIF_NEW, a => {
      if (view && view.type === 'public' && a && a.body) {
        appendMessage({ id: a.id, body: a.body, from_manager: 1 }, true);
      }
    });

    BMLive.on(EV.PRESENCE_ONLINE, d => { onlineUsers.add(Number(d.userId)); refreshHeaderStatus(); });
    BMLive.on(EV.PRESENCE_OFFLINE, d => { onlineUsers.delete(Number(d.userId)); refreshHeaderStatus(); });
    BMLive.on('live:connected', () => {
      loadConvs();
      // ask server who is online right now
      const s = BMLive.socket();
      if (s && s.connected) s.emit('presence:list', resp => {
        if (resp && resp.ok) { (resp.online || []).forEach(u => onlineUsers.add(Number(u))); refreshHeaderStatus(); }
      });
    });

    // ---- 1:1 call request UI ----
    let incomingCall = null;
    BMLive.on(EV.CALLREQ_INCOMING, d => {
      incomingCall = d;
      showToast('تماس ورودی از ' + (d.fromName || 'کاربر') + ' — کنسول پیام‌ها');
      const accept = confirm('تماس ورودی از ' + (d.fromName || 'کاربر') + ' را می‌پذیرید؟');
      if (!BMLive.socket()) return;
      if (accept) BMLive.socket().emit(EV.CALLREQ_ACCEPT, { requestId: d.requestId });
      else BMLive.socket().emit(EV.CALLREQ_REJECT, { requestId: d.requestId });
      incomingCall = null;
    });
  }

  window.sendMessage = function () {
    if (!view) return showToast('ابتدا یک گفتگو انتخاب کنید');
    const inp = document.getElementById('msg-input');
    const body = inp.value.trim();
    if (!body) return;
    if (view.type === 'public') {
      fetch('api/announcements', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: CSRF, body }) })
        .then(r => r.json()).then(d => {
          if (!d.ok) return showToast(d.msg || 'خطا');
          inp.value = '';
          appendMessage({ id: null, body, from_manager: 1 }, true);
          showToast('اعلان ارسال شد');
        }).catch(() => showToast('خطا'));
      return;
    }
    // optimistic bubble; side depends on who I am (manager's messages right, user's left)
    const ownMgr = !!window.__IS_MANAGER;
    appendMessage({ id: null, body, from_manager: ownMgr ? 1 : 0 }, ownMgr);
    inp.value = '';

    if (!ownMgr) {
      // premium chats over HTTP (persisted as from_manager=0 under his own thread)
      fetch('api/messages/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: CSRF, user_id: String(view.user_id), body }),
      })
        .then(r => r.json())
        .then(d => { if (!d.ok) showToast(d.msg || 'ارسال پیام ناموفق بود'); })
        .catch(() => showToast('خطای شبکه'));
      return;
    }

    // manager: realtime PV send with client id (idempotent)
    const clientMsgId = 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    const s = window.BMLive && BMLive.socket();
    if (!s || !s.connected) { showToast('اتصال زنده قطع است — بعداً دوباره تلاش کنید'); return; }
    s.emit(EV.PV_SEND, { toUserId: view.user_id, body, clientMsgId }, resp => {
      if (!resp || !resp.ok) showToast('ارسال پیام ناموفق بود');
    });
  };

  window.openProfileModal = function () {
    if (!view || view.type !== 'user') return;
    document.getElementById('pm-avatar').innerHTML = avatarInner(view.avatar, '#4f46e5', view.name);
    document.getElementById('pm-name').textContent = view.name;
    document.getElementById('pm-username').textContent = '@' + view.username;
    document.getElementById('pm-email').textContent = view.email || '';
    document.getElementById('profile-modal').classList.remove('hidden');
  };
  window.closeProfileModal = function () { document.getElementById('profile-modal').classList.add('hidden'); };

  loadConvs(function () {
    // /messages?chat=admin — jump straight into the admin chat
    if (new URLSearchParams(location.search).get('chat') === 'admin') {
      const row = convs.find(c => c.admin_chat);
      if (row) openUser(row);
    }
  });
})();
