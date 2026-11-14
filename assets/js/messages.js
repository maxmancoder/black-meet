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
  function showToast(msg, kind) {
    if (typeof window.bmToast === 'function') return window.bmToast(msg, kind);
    const t = document.getElementById('toast');
    const m = document.getElementById('toast-message');
    if (!t || !m) return;
    m.textContent = msg;
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

  // ---- instant paint from cache (a slow link must not leave the page blank) ----
  const CACHE_CONVS = 'bm_convs_v1';
  const CACHE_THREAD = 'bm_thread_v1';
  const CACHE_PUB = 'bm_pub_v1';
  const CACHE_LIMIT = 120;
  function cacheGet(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function cacheSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* full / blocked */ }
  }
  function trim(arr) {
    const a = Array.isArray(arr) ? arr : [];
    return a.length > CACHE_LIMIT ? a.slice(a.length - CACHE_LIMIT) : a;
  }

  let lastConvsAt = 0;

  function loadConvs(cb) {
    fetch('api/messages/conversations')
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return;
        convs = d.conversations || [];
        lastConvsAt = Date.now();
        renderConvs();
        cacheSet(CACHE_CONVS, { convs, at: lastConvsAt });
        if (cb) cb();
      })
      .catch(() => {});
  }

  // paint the previous list straight away, then refresh it in the background
  function restoreCachedConvs() {
    const c = cacheGet(CACHE_CONVS);
    if (!c || !Array.isArray(c.convs) || !c.convs.length) return false;
    convs = c.convs;
    renderConvs();
    return true;
  }

  function markAllReadLocal() {
    convs.forEach(c => { c.unread = 0; });
    document.querySelectorAll('#conv-list .unread-dot').forEach(d => d.remove());
  }

  // the server clears the flag when a thread is fetched; mirror that in the list without
  // re-downloading every conversation (that extra round trip made opening a chat feel slow)
  function clearUnreadLocal(userId) {
    const c = convs.find(x => Number(x.user_id) === Number(userId));
    if (c) c.unread = 0;
    const box = document.getElementById('conv-list');
    if (!box) return;
    box.querySelectorAll('[data-uid]').forEach(row => {
      if (Number(row.dataset.uid) === Number(userId)) {
        const dot = row.querySelector('.unread-dot');
        if (dot) dot.remove();
      }
    });
  }

  // cheap seen-ack: no payload back, so it can fire on every incoming message
  function markSeen(userId) {
    fetch('api/messages/seen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: CSRF, user_id: String(userId || '') }),
    }).catch(() => {});
  }

  function sendViaHttp(userId, body) {
    return fetch('api/messages/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: CSRF, user_id: String(userId), body }),
    }).then(r => r.json());
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
    if (box) box.innerHTML = '<div class="dash-chat-empty"><span class="dash-chat-empty-ico">' + bmIcon('forum') + '</span><p class="dash-chat-empty-title">یک گفتگو را انتخاب کنید</p><p class="dash-chat-empty-sub">پیام‌های عمومی و گفتگوهای خصوصی اینجا نمایش داده می‌شوند.</p></div>';
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
          dot.className = 'unread-dot dash-unread';
          const av = row.querySelector('.dash-conv-av');
          if (av) av.appendChild(dot);
        } else if (unread === 0 && dot) dot.remove();
      }
    });
  }

  function renderConvs() {
    const q = (document.getElementById('conv-search').value || '').trim().toLowerCase();
    const box = document.getElementById('conv-list');
    box.innerHTML = '';
    const pub = document.createElement('div');
    pub.className = 'dash-conv' + (view && view.type === 'public' ? ' is-active' : '');
    pub.innerHTML = '<div class="dash-conv-av dash-conv-av-pub">' + bmIcon('campaign') + '</div>' +
      '<div class="dash-conv-meta"><h4 class="dash-conv-name">پیام عمومی</h4><p class="dash-conv-sub">اعلان‌ها</p></div>';
    pub.onclick = openPublic;
    box.appendChild(pub);

    convs.filter(c => !q || (c.display_name + ' ' + c.username).toLowerCase().includes(q)).forEach(c => {
      const el = document.createElement('div');
      el.dataset.uid = c.user_id;
      el.className = 'dash-conv' + (view && view.type === 'user' && view.user_id === c.user_id ? ' is-active' : '');
      el.innerHTML = '<div class="dash-conv-av">' + avatarInner(c.avatar, '#4f46e5', c.display_name) +
        (Number(c.unread) > 0 ? '<span class="unread-dot dash-unread"></span>' : '') + '</div>' +
        '<div class="dash-conv-meta"><h4 class="dash-conv-name">' + esc(c.display_name) + '</h4><p class="dash-conv-sub" dir="ltr">@' + esc(c.username) + '</p></div>';
      el.onclick = () => openUser(c);
      box.appendChild(el);
    });
  }

  window.filterConvs = renderConvs;

  // the list is re-rendered from `view` on every loadConvs(), but the public row is
  // built once per render and openPublic() never reloads the list — so the "selected"
  // mark is painted directly from `view` whenever a thread opens.
  function markActive() {
    document.querySelectorAll('#conv-list .dash-conv').forEach(row => {
      const isPublic = !row.hasAttribute('data-uid');
      const on = !!view && (isPublic
        ? view.type === 'public'
        : view.type === 'user' && Number(row.dataset.uid) === Number(view.user_id));
      row.classList.toggle('is-active', on);
    });
  }

  function setHeader(c) {
    const h = document.getElementById('profile-header');
    h.classList.remove('hidden');
    h.classList.add('flex');
    const name = c.display_name || c.name || '';
    document.getElementById('ph-avatar').innerHTML = avatarInner(c.avatar, '#4f46e5', name);
    document.getElementById('ph-name').textContent = name;
    document.getElementById('ph-status').textContent = c.type === 'public' ? 'پیام همگانی' : (isOnline(c.user_id) ? 'آنلاین' : 'آفلاین');
    markActive();
  }

  // Every bubble says WHO wrote it. The rows come with `username` from the server; live
// and optimistic messages only know a display name (or my own), so fall back to those.
  function senderName(m, incoming) {
    if (m && m.username) return '@' + m.username;
    if (m && (m.from_name || m.fromName)) return m.from_name || m.fromName;
    if (window.MS_USERNAME) return '@' + window.MS_USERNAME;
    return incoming ? 'مدیر' : 'من';
  }

  // `from_manager=1` marks a message written by the MAIN manager, so which side of the
  // screen it belongs on depends on who is reading: the manager's own replies belong on
  // his "me" side, while the other party's messages are incoming. (The bubble side used
  // to be derived from the flag alone, so a manager saw his own replies on the far side.)
  function isIncoming(flagFromManager) {
    return !!flagFromManager !== !!window.__IS_MANAGER;
  }

  function appendMessage(m, incoming) {
    const box = document.getElementById('chat-area');
    const el = document.createElement('div');
    el.className = 'dash-bubble-row ' + (incoming ? 'is-them' : 'is-me');
    const label = senderName(m, incoming);
    el.innerHTML = '<span class="bm-msg-sender" dir="ltr">' + esc(label) + '</span>' +
      '<div class="dash-bubble">' + esc(m.body) + '</div>';
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    if (m.id) window._lastThreadId = Math.max(window._lastThreadId || 0, Number(m.id));
    return el;
  }

  function renderChat(messages, type) {
    const box = document.getElementById('chat-area');
    box.innerHTML = '';
    (messages || []).forEach(m => {
      // the public channel is a broadcast feed: every bubble is incoming + labelled
      appendMessage(m, type === 'public' ? true : isIncoming(m.from_manager));
    });
  }

  function openUser(c) {
    view = { type: 'user', user_id: Number(c.user_id), name: c.display_name, username: c.username, avatar: c.avatar, email: c.email };
    setHeader(view);
    refreshHeaderStatus();
    setMobileChat(true);
    // show the last copy of this thread immediately, then replace it with the fresh rows
    const cached = cacheGet(CACHE_THREAD);
    const box = document.getElementById('chat-area');
    if (cached && Number(cached.uid) === Number(c.user_id) && !!cached.mgr === !!window.__IS_MANAGER && Array.isArray(cached.messages)) {
      renderChat(cached.messages, 'user');
    } else if (box) {
      box.innerHTML = '';
    }
    fetch('api/messages/conversations?user_id=' + c.user_id)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return;
        renderChat(d.messages, 'user');
        cacheSet(CACHE_THREAD, { uid: Number(c.user_id), mgr: !!window.__IS_MANAGER, messages: trim(d.messages) });
        clearUnreadLocal(c.user_id);
      })
      .catch(() => {});
  }

  function openPublic() {
    view = { type: 'public', name: 'اعلان عمومی' };
    setHeader(view);
    setMobileChat(true);
    const cached = cacheGet(CACHE_PUB);
    if (cached && Array.isArray(cached.messages) && cached.messages.length) {
      renderChat(cached.messages, 'public');
    } else {
      document.getElementById('chat-area').innerHTML = '';
    }
    fetch('api/announcements')
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return;
        const rows = (d.announcements || []).map(a => ({ id: a.id, body: a.body, from_manager: 1, username: a.username, display_name: a.display_name }));
        renderChat(rows, 'public');
        cacheSet(CACHE_PUB, { messages: trim(rows) });
      })
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
        appendMessage({ id: m.id, body: m.body, from_manager: fromMgr ? 1 : 0, fromName: m.fromName, username: fromMgr ? null : ((view && view.username) || null) }, isIncoming(fromMgr));
        updateConvRow(fromId, { unread: 0 });
        // just acknowledge the thread as read — re-downloading the whole conversation for
        // that doubled the traffic of every single incoming message
        if (bumpsMe) markSeen(fromId);
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
      if (a && Number(a.fromUserId) === Number(window.MS_ID)) return; // my own send — already appended optimistically
      if (view && view.type === 'public' && a && a.body) {
        appendMessage({ id: a.id, body: a.body, from_manager: 1, fromName: a.fromName }, true);
      }
    });

    BMLive.on(EV.PRESENCE_ONLINE, d => { onlineUsers.add(Number(d.userId)); refreshHeaderStatus(); });
    BMLive.on(EV.PRESENCE_OFFLINE, d => { onlineUsers.delete(Number(d.userId)); refreshHeaderStatus(); });
    BMLive.on('live:connected', () => {
      // bootstrap already loaded the list a moment ago — a second render would just flicker
      if (Date.now() - lastConvsAt > 1500) loadConvs();
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
    inp.value = '';
    if (view.type === 'public') {
      // optimistic bubble; rolled back if the POST fails (self echo is skipped anyway)
      const el = appendMessage({ id: null, body, from_manager: 1, username: window.MS_USERNAME }, true);
      fetch('api/announcements', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: CSRF, body }) })
        .then(r => r.json()).then(d => {
          if (!d.ok) { el.remove(); showToast(d.msg || 'خطا'); }
        }).catch(() => { el.remove(); showToast('خطا'); });
      return;
    }

    // optimistic bubble; side depends on who I am (manager's messages right, user's left)
    const ownMgr = !!window.__IS_MANAGER;
    const el = appendMessage({ id: null, body, from_manager: ownMgr ? 1 : 0, username: window.MS_USERNAME }, isIncoming(ownMgr));
    const target = view;
    const failed = (msg) => { el.remove(); inp.value = body; showToast(msg || 'ارسال پیام ناموفق بود'); };

    // ONE round trip: the page already holds a live socket, so both sides send over it.
    // (A premium used to POST over HTTP while the socket sat idle on the same page.)
    const s = window.BMLive && BMLive.socket();
    if (s && s.connected) {
      const clientMsgId = 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      s.emit(EV.PV_SEND, { toUserId: target.user_id, body, clientMsgId }, resp => {
        if (!resp || !resp.ok) failed('ارسال پیام ناموفق بود');
      });
      return;
    }

    // socket down: HTTP still persists the row and pushes it live to the other side
    sendViaHttp(target.user_id, body)
      .then(d => { if (!d.ok) failed(d.msg); })
      .catch(() => failed('خطای شبکه'));
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

  // entering the messages page clears the home badge (server-side seen flags) and loads the
  // conversation list. Both run in PARALLEL now: the badge clear used to serialize a whole
  // round trip in front of the list on every visit.
  function bootstrap() {
    restoreCachedConvs();
    fetch('api/messages/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: CSRF }),
    }).then(() => markAllReadLocal()).catch(() => {});
    loadConvs(function () {
      markAllReadLocal();
      // /messages?chat=admin — jump straight into the admin chat
      if (new URLSearchParams(location.search).get('chat') === 'admin') {
        const row = convs.find(c => c.admin_chat);
        if (row) openUser(row);
      }
    });
  }
  bootstrap();
})();
