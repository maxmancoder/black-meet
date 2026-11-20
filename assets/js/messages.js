// assets/js/messages.js — Phase 1: realtime private messages (no polling)
(function () {
  const BASE = window.BASE;
  const CSRF = window.CSRF;
  const EV = window.BMEv;
  let convs = [];
  let view = null; // {type:'user', user_id, ...} | {type:'public'}
  let replyTo = null;   // {id, body, username} of the message being replied to
  let forwarding = null; // {kind, id} of the message being forwarded
  let searchRows = [];  // username-only results from the search box (no profile data shown)
  let sending = false;  // one shot per click/Enter — no duplicate bubbles or rows
  function setSending(on) {
    sending = on;
    const btn = document.querySelector('.msg-send');
    if (btn) { btn.disabled = on; btn.classList.toggle('bm-btn-busy', on); }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const faNum = n => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
  const unreadText = n => (Number(n) > 99 ? '۹۹+' : faNum(Number(n) || 0));
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

  // ---- role of the person on the other side -------------------------------------
  // the rows carry `rank` / `is_manager`; the label mirrors server/lib/ranks.js and the
  // site manager always gets his yellow star so admins can spot him instantly
  function roleOf(c) {
    if (!c) return { key: 'user', label: 'کاربر عادی' };
    if (Number(c.is_manager)) return { key: 'manager', label: 'مدیر اصلی' };
    if (c.rank === 'premium') return { key: 'premium', label: 'ادمین پریمیوم' };
    if (c.rank === 'admin') return { key: 'admin', label: 'ادمین' };
    return { key: 'user', label: 'کاربر عادی' };
  }
  function mgrStar(c) {
    if (!c || !Number(c.is_manager)) return '';
    return '<span class="dash-star-mgr" title="مدیر سایت" aria-label="مدیر سایت">★</span>';
  }
  function roleChip(c) {
    const r = roleOf(c);
    return '<span class="dash-role dash-role-' + r.key + '">' + esc(r.label) + '</span>';
  }
  function presenceText(c) {
    if (!c || c.type === 'public') return 'پیام همگانی';
    return roleOf(c).label + ' · ' + (isOnline(c.user_id) ? 'آنلاین' : 'آفلاین');
  }
  function refreshHeaderStatus() {
    if (!view || view.type !== 'user') return;
    const el = document.getElementById('ph-status');
    if (el) el.textContent = presenceText(view);
  }

  // ---- instant paint from cache (a slow link must not leave the page blank) ----
  const CACHE_CONVS = 'bm_convs_v2';
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

  // Telegram-style unread badge. The count comes from the server: a message is unread while
  // its `read_at` timestamp is NULL, so it is durable and survives a refresh.
  function unreadBadgeHtml(n) {
    n = Number(n) || 0;
    if (n <= 0) return '';
    return '<span class="dash-unread" data-count="' + n + '" aria-label="' + faNum(n) + ' پیام خواندهنشده">' + unreadText(n) + '</span>';
  }
  function paintUnread(row, n) {
    if (!row) return;
    n = Number(n) || 0;
    row.classList.toggle('is-unread', n > 0);
    let badge = row.querySelector('.dash-unread');
    if (n <= 0) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'dash-unread';
      const av = row.querySelector('.dash-conv-av');
      if (av) av.appendChild(badge); else row.appendChild(badge);
    }
    badge.dataset.count = String(n);
    badge.setAttribute('aria-label', faNum(n) + ' پیام خواندهنشده');
    badge.textContent = unreadText(n);
  }

  // the server clears the flag when a thread is fetched; mirror that in the list without
  // re-downloading every conversation (that extra round trip made opening a chat feel slow)
  function clearUnreadLocal(userId) {
    const c = convs.find(x => Number(x.user_id) === Number(userId));
    if (c) c.unread = 0;
    const box = document.getElementById('conv-list');
    if (!box) return;
    box.querySelectorAll('[data-uid]').forEach(row => {
      if (Number(row.dataset.uid) === Number(userId)) paintUnread(row, 0);
    });
  }

  // Read receipt, fired only once the messages are actually on screen. The server checks
  // conversation ownership and stamps read_at on the received rows of this thread only.
  function markRead(userId) {
    fetch('api/messages/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: CSRF, user_id: String(userId || '') }),
    }).catch(() => {});
  }

  function sendViaHttp(userId, body, replyId, clientMsgId) {
    const data = { csrf: CSRF, user_id: String(userId), body, reply_to: String(replyId || '') };
    if (clientMsgId) data.client_msg_id = clientMsgId;
    return fetch('api/messages/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data),
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
    if (!box) return;
    box.querySelectorAll('[data-uid]').forEach(row => {
      if (Number(row.dataset.uid) === Number(userId)) paintUnread(row, c.unread);
    });
  }

  // A single incoming DM produces TWO live events for a manager console (PV_NEW_MESSAGE to
  // the recipient + PV_CONVERSATION_UPDATED to manager consoles). Claim by message id so the
  // unread badge increments exactly once; the signature fallback covers older payloads.
  const recentIncoming = new Set();
  function claimIncoming(id, userId, ts, body) {
    const key = id ? 'id:' + Number(id)
      : 'sig:' + Number(userId) + '|' + String(ts || '') + '|' + String(body || '');
    if (recentIncoming.has(key)) return false;
    recentIncoming.add(key);
    if (recentIncoming.size > 80) recentIncoming.delete(recentIncoming.values().next().value);
    return true;
  }

  function renderConvs() {
    const inp = document.getElementById('conv-search');
    const q = ((inp && inp.value) || '').trim().toLowerCase();
    const box = document.getElementById('conv-list');
    if (!box) return;
    box.innerHTML = '';

    if (q) {
      // SEARCH MODE: only the username is rendered — never email, phone, avatar, rank
      // or any other account detail. Clicking a result simply opens the DM with that user.
      if (!searchRows.length) {
        const hint = document.createElement('p');
        hint.className = 'lim-empty dash-hint';
        hint.textContent = 'کاربری با این نام کاربری یافت نشد.';
        box.appendChild(hint);
      }
      searchRows.forEach((u) => {
        const el = document.createElement('div');
        el.className = 'dash-conv dash-conv-search';
        el.innerHTML = '<div class="dash-conv-av dash-conv-av-pub">' + bmIcon('person') + '</div>' +
          '<div class="dash-conv-meta"><p class="dash-conv-sub" dir="ltr">@' + esc(u.username || '') + '</p></div>';
        el.onclick = () => openUser({
          user_id: u.user_id, username: u.username, display_name: u.display_name,
          avatar: null, rank: '', is_manager: 0,
        });
        box.appendChild(el);
      });
      return;
    }

    if (window.__CAN_SEE_PUBLIC !== false) {
      const pub = document.createElement('div');
      pub.className = 'dash-conv' + (view && view.type === 'public' ? ' is-active' : '');
      pub.innerHTML = '<div class="dash-conv-av dash-conv-av-pub">' + bmIcon('campaign') + '</div>' +
        '<div class="dash-conv-meta"><h4 class="dash-conv-name">پیام عمومی</h4><p class="dash-conv-sub">اعلان‌ها</p></div>';
      pub.onclick = openPublic;
      box.appendChild(pub);
    }

    convs.forEach(c => {
      const el = document.createElement('div');
      el.dataset.uid = c.user_id;
      el.className = 'dash-conv' + (Number(c.unread) > 0 ? ' is-unread' : '') +
        (view && view.type === 'user' && view.user_id === c.user_id ? ' is-active' : '');
      el.innerHTML = '<div class="dash-conv-av">' + avatarInner(c.avatar, '#4f46e5', c.display_name) +
        unreadBadgeHtml(c.unread) + '</div>' +
        '<div class="dash-conv-meta"><div class="dash-conv-nameline"><h4 class="dash-conv-name">' + esc(c.display_name || c.username || '') + '</h4>' + mgrStar(c) + roleChip(c) + '</div>' +
        '<p class="dash-conv-sub"><span class="dash-conv-user" dir="ltr">@' + esc(c.username || '') + '</span></p></div>';
      el.onclick = () => openUser(c);
      box.appendChild(el);
    });
  }

  let searchTimer = null;
  window.filterConvs = function () {
    const q = ((document.getElementById('conv-search') || {}).value || '').trim();
    if (!q) { searchRows = []; renderConvs(); return; }
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      fetch('api/messages/search?username=' + encodeURIComponent(q))
        .then(r => r.json())
        .then(d => { searchRows = (d && d.ok && d.users) || []; renderConvs(); })
        .catch(() => {});
    }, 220);
  };

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
    document.getElementById('ph-name').innerHTML = esc(name) + mgrStar(c);
    document.getElementById('ph-status').textContent = presenceText(c);
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

  // any signed-in member may copy AND delete any message (owner request); edit stays
  // author-only. `mine` is only used to decide whether the edit button appears.
  function msgButtonsHtml(kind, mine) {
    return '<button type="button" data-no-soft onclick="replyMessage(this)" aria-label="پاسخ">' + bmIcon('arrow_back') + '<span>پاسخ</span></button>' +
      '<button type="button" data-no-soft onclick="copyMessage(this)" aria-label="کپی">' + bmIcon('description') + '<span>کپی</span></button>' +
      (mine ? '<button type="button" data-no-soft onclick="editMessage(this)" aria-label="ویرایش">' + bmIcon('edit') + '<span>ویرایش</span></button>' : '') +
      '<button type="button" data-no-soft onclick="openForward(this)" aria-label="هدایت">' + bmIcon('arrow_forward') + '<span>هدایت</span></button>' +
      '<button type="button" data-no-soft onclick="deleteMessage(this)" aria-label="حذف">' + bmIcon('delete_sweep') + '<span>حذف</span></button>';
  }
  // optimistic bubbles have no server id yet — fill their actions once the ACK arrives
  function fillMsgActions(row) {
    if (!row) return;
    const box = row.querySelector('.bm-msg-actions');
    if (!box || !box.dataset.pending) return;
    box.innerHTML = msgButtonsHtml(row.dataset.kind || 'pv', row.dataset.mine === '1');
    delete box.dataset.pending;
  }

  function appendMessage(m, incoming, kind, targetBox) {
    const box = targetBox || document.getElementById('chat-area');
    if (!box) return null;
    const el = document.createElement('div');
    const side = typeof m.incoming === 'boolean' ? m.incoming : incoming;
    el.className = 'dash-bubble-row bm-msg-row ' + (side ? 'is-them' : 'is-me');
    if (m.id) { el.dataset.msgId = Number(m.id); el.dataset.kind = kind || 'pv'; }
    if (m.clientMsgId) el.dataset.clientId = m.clientMsgId;
    if (typeof m.body === 'string') el.dataset.body = m.body;
    // only the author may EDIT; copy + delete are available to everyone
    const mine = !!(m.mine || (m.senderId && Number(m.senderId) === Number(window.MS_ID)));
    el.dataset.mine = mine ? '1' : '0';
    const label = senderName(m, side);
    let quote = '';
    if (m.reply && m.reply.id) {
      // clickable on BOTH sides: tapping it flashes the original bubble for 2 seconds
      quote = '<div class="bm-msg-quote bm-msg-quote-link" data-reply-id="' + Number(m.reply.id) + '"' +
        ' onclick="bmJumpToReply(this)" role="button" tabindex="0" title="نمایش پیام مورد پاسخ">' +
        '<span class="bm-msg-quote-name" dir="ltr">' +
        esc(m.reply.username ? '@' + m.reply.username : (m.reply.display_name || '')) + '</span>' +
        '<span class="bm-msg-quote-body">' + esc(m.reply.body || '') + '</span></div>';
    }
    const fwd = m.forwarded_from
      ? '<span class="bm-msg-fwd">' + bmIcon('arrow_forward') + ' از @' + esc(m.forwarded_from) + '</span>' : '';
    const acts = '<div class="bm-msg-actions"' + (m.id ? '' : ' data-pending="1"') + '>' +
      (m.id ? msgButtonsHtml(kind || 'pv', mine) : '') + '</div>';
    el.innerHTML = '<span class="bm-msg-sender" dir="ltr">' + esc(label) + '</span>' + quote +
      '<div class="dash-bubble">' + fwd + (window.bmLinkify ? window.bmLinkify(m.body) : esc(m.body)) + '</div>' + acts;
    box.appendChild(el);
    if (box.id === 'chat-area') box.scrollTop = box.scrollHeight;
    if (m.id) window._lastThreadId = Math.max(window._lastThreadId || 0, Number(m.id));
    return el;
  }

  function renderChat(messages, type) {
    const box = document.getElementById('chat-area');
    if (!box) return;
    // Build in a fragment and append once: appending 400 bubbles one by one while reading
    // scrollHeight after each one forced a layout on every message and made opening a
    // conversation with history feel slow. One paint + one scroll is dramatically faster.
    const frag = document.createDocumentFragment();
    const holder = document.createElement('div');
    (messages || []).forEach(m => {
      // the public channel is a broadcast feed: every bubble is incoming + labelled
      appendMessage(m, type === 'public' ? true : (typeof m.incoming === 'boolean' ? m.incoming : isIncoming(m.from_manager)), type, holder);
    });
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    box.innerHTML = '';
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  }

  function focusInput() {
    const inp = document.getElementById('msg-input');
    if (inp) { try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } }
  }

  // ---- message actions --------------------------------------------------------------
  function rowData(btn) {
    const row = btn && btn.closest ? btn.closest('.bm-msg-row') : null;
    if (!row || !row.dataset.msgId) return null;
    const bubble = row.querySelector('.dash-bubble');
    const sender = row.querySelector('.bm-msg-sender');
    return {
      id: Number(row.dataset.msgId),
      kind: row.dataset.kind || 'pv',
      body: row.dataset.body !== undefined ? row.dataset.body : (bubble ? bubble.textContent : ''),
      rawBody: row.dataset.body !== undefined ? row.dataset.body : (bubble ? bubble.textContent : ''),
      sender: sender ? sender.textContent.replace(/^@/, '') : '',
    };
  }
  window.replyMessage = function (btn) {
    const d = rowData(btn);
    if (!d) return;
    replyTo = d;
    const bar = document.getElementById('reply-bar');
    if (bar) bar.classList.remove('hidden');
    const n = document.getElementById('reply-name');
    const b = document.getElementById('reply-body');
    if (n) n.textContent = d.sender || '';
    if (b) b.textContent = d.body;
    focusInput();
  };
  window.clearReply = function () {
    replyTo = null;
    const bar = document.getElementById('reply-bar');
    if (bar) bar.classList.add('hidden');
  };
  window.openForward = function (btn) {
    const d = rowData(btn);
    if (!d) return;
    forwarding = d;
    const list = document.getElementById('fw-list');
    if (list) list.innerHTML = '<p class="dash-hint">در حال بارگذاری…</p>';
    const modal = document.getElementById('forward-modal');
    if (modal) modal.classList.remove('hidden');
    fetch('api/messages/targets').then(r => r.json()).then(d2 => {
      if (!d2 || !d2.ok) return;
      if (list) {
        list.innerHTML = '';
        (d2.targets || []).forEach(t => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'fw-target';
          b.dataset.noSoft = '';
          b.textContent = '@' + t.username;
          b.onclick = () => confirmForward(t.user_id);
          list.appendChild(b);
        });
        if (!(d2.targets || []).length) list.innerHTML = '<p class="dash-hint">کاربری برای هدایت یافت نشد.</p>';
      }
    }).catch(() => { if (list) list.innerHTML = '<p class="dash-hint">خطا در بارگذاری لیست کاربران.</p>'; });
  };
  window.closeForward = function () {
    forwarding = null;
    const modal = document.getElementById('forward-modal');
    if (modal) modal.classList.add('hidden');
  };
  window.confirmForward = function (toId) {
    if (!forwarding) return;
    fetch('api/messages/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: CSRF, kind: forwarding.kind, id: String(forwarding.id), to_user_id: String(toId) }),
    }).then(r => r.json()).then(d => {
      if (!d.ok) showToast(d.msg || 'هدایت پیام ناموفق بود');
      else showToast('پیام هدایت شد');
    }).catch(() => showToast('خطای شبکه')).finally(closeForward);
  };
  window.deleteMessage = function (btn) {
    const d = rowData(btn);
    if (!d) return;
    const row = btn.closest('.bm-msg-row');
    fetch('api/messages/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: CSRF, kind: d.kind, id: String(d.id) }),
    }).then(r => r.json()).then(d2 => {
      if (!d2.ok) showToast(d2.msg || 'حذف پیام ناموفق بود');
      else if (row) row.remove();
    }).catch(() => showToast('خطای شبکه'));
  };

  // ---- copy / edit / jump-to-quote ---------------------------------------------------
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { showToast('کپی ناموفق بود'); }
    ta.remove();
  }
  window.copyMessage = function (btn) {
    const d = rowData(btn);
    if (!d) return;
    const text = d.rawBody || '';
    const done = () => showToast('پیام کپی شد');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  };

  window.bmJumpToReply = function (el) {
    const id = el && el.dataset && el.dataset.replyId;
    if (!id) return;
    const box = document.getElementById('chat-area');
    const target = box && box.querySelector('.bm-msg-row[data-msg-id="' + Number(id) + '"]');
    if (!target) { showToast('پیام مورد پاسخ در این گفتگو موجود نیست'); return; }
    try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { target.scrollIntoView(); }
    target.classList.remove('bm-reply-flash');
    void target.offsetWidth; // restart the animation even on repeated taps
    target.classList.add('bm-reply-flash');
    setTimeout(() => target.classList.remove('bm-reply-flash'), 2000);
  };

  window.bmApplyEdited = function (d) {
    if (!d || !d.id) return;
    const row = document.querySelector('#chat-area .bm-msg-row[data-msg-id="' + Number(d.id) + '"]');
    if (!row) return;
    const bubble = row.querySelector('.dash-bubble');
    if (bubble) bubble.innerHTML = (window.bmLinkify ? window.bmLinkify(d.body) : esc(d.body));
    row.dataset.body = d.body;
    row.classList.add('bm-msg-edited');
    setTimeout(() => row.classList.remove('bm-msg-edited'), 900);
  };

  // inline editor: only shown on rows the server marked as mine (server re-checks anyway)
  window.editMessage = function (btn) {
    const d = rowData(btn);
    if (!d) return;
    const row = btn.closest('.bm-msg-row');
    const bubble = row && row.querySelector('.dash-bubble');
    if (!bubble || row.querySelector('.bm-msg-edit')) return;
    const acts = row.querySelector('.bm-msg-actions');
    const wrap = document.createElement('div');
    wrap.className = 'bm-msg-edit';
    wrap.innerHTML = '<textarea class="dash-input bm-msg-edit-input" maxlength="4000" aria-label="ویرایش پیام"></textarea>' +
      '<div class="bm-msg-edit-actions">' +
        '<button type="button" class="dash-btn dash-btn-ghost bm-msg-edit-cancel">انصراف</button>' +
        '<button type="button" class="dash-btn dash-btn-solid bm-msg-edit-save">ذخیره</button>' +
      '</div>';
    bubble.style.display = 'none';
    if (acts) acts.style.display = 'none';
    row.insertBefore(wrap, bubble.nextSibling);
    const ta = wrap.querySelector('textarea');
    ta.value = d.rawBody || '';
    ta.focus();
    const cleanup = () => {
      if (wrap.parentNode) wrap.remove();
      bubble.style.display = '';
      if (acts) acts.style.display = '';
    };
    wrap.querySelector('.bm-msg-edit-cancel').onclick = cleanup;
    wrap.querySelector('.bm-msg-edit-save').onclick = function () {
      const body = ta.value.trim();
      if (!body) return showToast('متن خالی است');
      const save = this;
      save.disabled = true;
      fetch('api/messages/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: CSRF, kind: d.kind, id: String(d.id), body }),
      }).then(r => r.json()).then(res => {
        if (!res.ok) { showToast(res.msg || 'ویرایش ناموفق بود'); save.disabled = false; return; }
        bubble.innerHTML = (window.bmLinkify ? window.bmLinkify(res.body) : esc(res.body));
        row.dataset.body = res.body;
        cleanup();
        showToast('پیام ویرایش شد');
      }).catch(() => { showToast('خطای شبکه'); save.disabled = false; });
    };
  };

  function openUser(c) {
    clearReply();
    view = { type: 'user', user_id: Number(c.user_id), name: c.display_name, username: c.username, avatar: c.avatar, email: c.email, rank: c.rank, is_manager: c.is_manager };
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
    focusInput();
    fetch('api/messages/conversations?user_id=' + c.user_id)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return;
        renderChat(d.messages, 'user');
        cacheSet(CACHE_THREAD, { uid: Number(c.user_id), mgr: !!window.__IS_MANAGER, messages: trim(d.messages) });
        // only NOW stamp read_at — the messages have been loaded AND displayed
        markRead(c.user_id);
        clearUnreadLocal(c.user_id);
        focusInput();
      })
      .catch(() => {});
  }

  function openPublic() {
    if (window.__CAN_SEE_PUBLIC === false) return;
    clearReply();
    view = { type: 'public', name: 'اعلان عمومی' };
    setHeader(view);
    setMobileChat(true);
    const cached = cacheGet(CACHE_PUB);
    if (cached && Array.isArray(cached.messages) && cached.messages.length) {
      renderChat(cached.messages, 'public');
    } else {
      document.getElementById('chat-area').innerHTML = '';
    }
    focusInput();
    fetch('api/announcements')
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return;
        const rows = (d.announcements || []).map(a => ({ id: a.id, body: a.body, from_manager: 1, username: a.username, display_name: a.display_name }));
        renderChat(rows, 'public');
        cacheSet(CACHE_PUB, { messages: trim(rows) });
        focusInput();
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
      // another tab is in front: tell the user through the operating system
      if (window.bmNotify) {
        window.bmNotify({
          title: (m.fromName || (fromMgr ? 'مدیر' : 'پیام خصوصی')),
          body: m.body,
          tag: 'pv:' + (m.id || m.clientMsgId || m.body || ''),
          url: (window.BASE || '') + '/messages' + (fromMgr && !window.__IS_MANAGER ? '?chat=admin' : ''),
        });
      }
      if (open) {
        // claim it here too: navigating away in the milliseconds before the matching
        // PV_CONVERSATION_UPDATED lands must not resurrect a badge for an already-read DM
        claimIncoming(m.id, fromId, m.ts, m.body);
        appendMessage({
          id: m.id, body: m.body, from_manager: fromMgr ? 1 : 0, fromName: m.fromName,
          username: m.username || (fromMgr ? null : ((view && view.username) || null)),
          reply: m.reply || null, senderId: m.senderId || m.fromUserId, mine: false,
          incoming: Number(m.fromUserId) !== Number(window.MS_ID),
        }, isIncoming(fromMgr), 'pv');
        updateConvRow(fromId, { unread: 0 });
        // the bubble is on screen while the user is watching this thread — stamp read_at
        // immediately (a tiny POST, not a full conversation re-download)
        if (bumpsMe) markRead(fromId);
      } else if (bumpsMe && claimIncoming(m.id, fromId, m.ts, m.body)) {
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
      if (!claimIncoming(d.id, d.userId, d.ts, d.lastBody)) return; // same DM as PV_NEW_MESSAGE
      const c = convs.find(x => Number(x.user_id) === Number(d.userId));
      if (!c) { loadConvs(); return; }
      updateConvRow(d.userId, { unread: Number(c.unread || 0) + 1, last: d.lastBody });
    });

    // public announcements stream into the open public thread
    BMLive.on(EV.NOTIF_NEW, a => {
      if (a && Number(a.fromUserId) === Number(window.MS_ID)) return; // my own send — already appended optimistically
      if (view && view.type === 'public' && a && a.body) {
        appendMessage({ id: a.id, body: a.body, from_manager: 1, fromName: a.fromName,
          username: a.username || a.display_name || '', reply: a.reply || null,
          senderId: a.senderId }, true, 'public');
      }
    });

    // soft delete on any screen: drop the bubble everywhere, no reload needed
    BMLive.on(EV.MSG_DELETED, d => {
      if (!d || !d.id) return;
      const box = document.getElementById('chat-area');
      if (!box) return;
      const row = box.querySelector('.bm-msg-row[data-msg-id="' + Number(d.id) + '"]');
      if (row) row.remove();
    });

    // an edit is repainted on the other side at once (REST is the only write path)
    BMLive.on(EV.MSG_EDITED, d => { if (window.bmApplyEdited) window.bmApplyEdited(d); });

    // turn an optimistic bubble into a real one as soon as the server acknowledges it,
    // so reply/copy/edit/delete work immediately instead of only after a page reload
    BMLive.on(EV.PV_ACK, d => {
      if (!d || !d.ok || !d.clientMsgId || !d.id) return;
      const row = document.querySelector('#chat-area .bm-msg-row[data-client-id="' + d.clientMsgId + '"]');
      if (row && !row.dataset.msgId) { row.dataset.msgId = Number(d.id); row.dataset.kind = 'pv'; fillMsgActions(row); }
    });

    // a read receipt stamped in ANY tab of this user clears the badge in all of them
    BMLive.on(EV.PV_READ, d => {
      if (!d || Number(d.userId) !== Number(window.MS_ID)) return;
      clearUnreadLocal(d.peerId);
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

  // ---- emoji tray: tap an emoji and it is sent as a message (Telegram-style) ----
  const MSG_EMOJIS = [
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😍',
    '🥰', '😘', '😎', '🤩', '🥳', '😉', '😋', '😜', '🤪', '🤗',
    '🤔', '🤨', '😏', '😴', '😭', '😢', '😡', '🤯', '😱', '🥺',
    '😇', '🤠', '👋', '🤝', '👍', '👎', '👏', '🙌', '🙏', '💪',
    '✌️', '🤞', '👌', '❤️', '🧡', '💛', '💚', '💙', '🔥', '✨',
    '🎉', '🎁', '✅', '❌', '💡', '🌟', '☕', '🎂', '🚀', '🏆',
  ];
  function buildMsgEmoji() {
    const grid = document.getElementById('msg-emoji-grid');
    if (!grid || grid.childElementCount) return;
    MSG_EMOJIS.forEach((em) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg-emoji-item';
      b.textContent = em;
      b.title = em;
      b.setAttribute('aria-label', 'ارسال ' + em);
      b.addEventListener('click', () => {
        const inp = document.getElementById('msg-input');
        if (inp) inp.value = em;
        toggleMsgEmoji(null, true);
        window.sendMessage();
      });
      grid.appendChild(b);
    });
  }
  window.toggleMsgEmoji = function (ev, forceHide) {
    const p = document.getElementById('msg-emoji-picker');
    if (!p) return;
    if (ev) ev.stopPropagation();
    if (forceHide === true || !p.classList.contains('hidden')) {
      p.classList.add('hidden');
      const b = document.getElementById('btn-msg-emoji');
      if (b) b.setAttribute('aria-expanded', 'false');
      return;
    }
    buildMsgEmoji();
    p.classList.remove('hidden');
    const btn = document.getElementById('btn-msg-emoji');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    const r = btn ? btn.getBoundingClientRect() : { right: window.innerWidth, top: window.innerHeight };
    p.style.maxHeight = Math.max(180, Math.min(430, r.top - 18)) + 'px';
    const w = p.offsetWidth;
    p.style.right = Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - w - 8)) + 'px';
    p.style.bottom = Math.max(8, window.innerHeight - r.top + 10) + 'px';
  };
  document.addEventListener('click', (e) => {
    const p = document.getElementById('msg-emoji-picker');
    if (!p || p.classList.contains('hidden')) return;
    if (e.target.closest && e.target.closest('#msg-emoji-picker, #btn-msg-emoji')) return;
    toggleMsgEmoji(null, true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleMsgEmoji(null, true);
  });

  window.sendMessage = function () {
    if (sending) return;                       // double click / Enter+click = ONE message
    if (!view) return showToast('ابتدا یک گفتگو انتخاب کنید');
    const inp = document.getElementById('msg-input');
    const body = inp.value.trim();
    if (!body) return;
    inp.value = '';
    setSending(true);
    const clientMsgId = 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    if (view.type === 'public') {
      if (window.__CAN_SEE_PUBLIC === false) { setSending(false); return showToast('دسترسی ندارید'); }
      // optimistic bubble; rolled back if the POST fails (self echo is skipped anyway)
      const el = appendMessage({ id: null, clientMsgId, body, from_manager: 1, username: window.MS_USERNAME,
        mine: true, senderId: window.MS_ID,
        reply: replyTo ? { id: replyTo.id, username: replyTo.sender, body: replyTo.body } : null }, true, 'public');
      const replyId = replyTo ? replyTo.id : null;
      clearReply();
      fetch('api/announcements', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: CSRF, body, reply_to: String(replyId || '') }) })
        .then(r => r.json()).then(d => {
          if (!d.ok) { if (el) el.remove(); showToast(d.msg || 'خطا'); }
          else if (el && d.id) { el.dataset.msgId = Number(d.id); el.dataset.kind = 'public'; fillMsgActions(el); }
        }).catch(() => { if (el) el.remove(); showToast('خطا'); })
        .finally(() => setSending(false));
      return;
    }

    // optimistic bubble; side depends on who I am (manager's messages right, user's left)
    const ownMgr = !!window.__IS_MANAGER;
    const el = appendMessage({
      id: null, clientMsgId, body, from_manager: ownMgr ? 1 : 0, username: window.MS_USERNAME,
      mine: true, senderId: window.MS_ID,
      incoming: false, reply: replyTo ? { id: replyTo.id, username: replyTo.sender, body: replyTo.body } : null,
      forwarded_from: null,
    }, isIncoming(ownMgr), 'pv');
    const target = view;
    const replyId = replyTo ? replyTo.id : null;
    clearReply();
    const failed = (msg) => { if (el) el.remove(); inp.value = body; showToast(msg || 'ارسال پیام ناموفق بود'); };
    const acked = (id) => {
      setSending(false);
      if (el && id) { el.dataset.msgId = Number(id); el.dataset.kind = 'pv'; fillMsgActions(el); }
    };

    // ONE round trip: the page already holds a live socket, so both sides send over it.
    // (A premium used to POST over HTTP while the socket sat idle on the same page.)
    const s = window.BMLive && BMLive.socket();
    if (s && s.connected) {
      s.emit(EV.PV_SEND, { toUserId: target.user_id, body, clientMsgId, replyTo: replyId }, resp => {
        if (!resp || !resp.ok) { setSending(false); failed('ارسال پیام ناموفق بود'); }
        else acked(resp.id);
      });
      return;
    }

    // socket down: HTTP still persists the row and pushes it live to the other side
    sendViaHttp(target.user_id, body, replyId, clientMsgId)
      .then(d => { if (!d.ok) { setSending(false); failed(d.msg); } else acked(d.id); })
      .catch(() => { setSending(false); failed('خطای شبکه'); });
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

  // Landing on /messages shows ONLY the conversation list. Opening a chat is always an
  // explicit tap (even when an old ?chat=admin link is used), so the first thread never
  // auto-opens and the empty "select a conversation" state stays visible.
  // Unread counts come from the DB and stay until THAT conversation is opened — the old
  // read-all-on-visit wiped every badge on each refresh, which is why they never persisted.
  function bootstrap() {
    restoreCachedConvs();
    loadConvs();
  }
  bootstrap();
})();
