// assets/js/admin_members.js — member list + account creation requests
(function () {
  const $ = id => document.getElementById(id);
  const PERM = window.PERM || {};
  let allUsers = window.INIT_USERS || [];
  let allRequests = window.INIT_REQUESTS || [];
  let currentSection = PERM.members ? 'members' : 'requests';
  let openMenu = null;
  let openMenuCard = null;

  const RANK_LABELS = { user: 'کاربر عادی', admin: 'ادمین', premium: 'ادمین پریمیوم', manager: 'مدیر اصلی' };
  const MODE_LABELS = { open: 'ایجاد حساب آزاد', approval: 'فقط با تایید مدیر', closed: 'غیرفعال' };
  const MODE_DOTS = { open: 'bg-secondary', approval: 'bg-primary', closed: 'bg-error' };
  let signupMode = window.SIGNUP_MODE || 'open';

  const fa = n => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showToast(msg, dur) {
    if (typeof window.bmToast === 'function') {
      const errorish = /خطا|نامعتبر|دسترسی|مجاز|نشد|قفل|محدود کنید/i.test(String(msg || ''));
      window.bmToast(msg, errorish ? 'error' : 'success', dur || 4000);
      return;
    }
    const t = $('toast');
    if (!t) return;
    $('toast-message').textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.add('hidden'), dur || 4000);
  }

  function post(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({ csrf: window.CSRF }, data || {}))
    }).then(r => r.json());
  }

  function closeMenus() {
    if (openMenu) { openMenu.classList.add('hidden'); openMenu = null; }
    if (openMenuCard) { openMenuCard.style.zIndex = ''; openMenuCard = null; }
    const mm = $('mode-menu');
    if (mm && !mm.classList.contains('hidden')) {
      mm.classList.add('hidden');
      const b = $('mode-btn');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
    const pm = $('page-size-menu');
    if (pm && !pm.classList.contains('hidden')) {
      pm.classList.add('hidden');
      const pb = $('page-size-btn');
      if (pb) pb.setAttribute('aria-expanded', 'false');
    }
    if (window.bmCloseEditRankMenu) window.bmCloseEditRankMenu();
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest || (!e.target.closest('.rank-menu') && !e.target.closest('.rank-trigger') &&
      !e.target.closest('#mode-menu') && !e.target.closest('#mode-btn') &&
      !e.target.closest('#page-size-menu') && !e.target.closest('#page-size-btn') &&
      !e.target.closest('#ed-rank-menu') && !e.target.closest('#ed-rank-btn'))) closeMenus();
  });

  // ------------------------------------------------------------------
  // page size (themed dropdown; the hidden <select> keeps holding the value)
  // ------------------------------------------------------------------
  const PAGE_SIZES = { 25: '۲۵ کاربر', 50: '۵۰ کاربر', 100: '۱۰۰ کاربر' };
  function paintPageSize() {
    const ps = $('page-size');
    if (!ps) return;
    const v = String(ps.value || '25');
    const lbl = $('page-size-label');
    if (lbl) lbl.textContent = PAGE_SIZES[v] || PAGE_SIZES[25];
  }
  window.togglePageSizeMenu = function (e) {
    if (e) e.stopPropagation();
    const m = $('page-size-menu');
    const b = $('page-size-btn');
    if (!m) return;
    closeMenus();
    const show = m.classList.contains('hidden');
    m.classList.toggle('hidden', !show);
    if (b) b.setAttribute('aria-expanded', show ? 'true' : 'false');
  };
  window.setPageSize = function (n) {
    const ps = $('page-size');
    if (!ps) return;
    ps.value = String(n);
    paintPageSize();
    closeMenus();
    render();
  };

  // ------------------------------------------------------------------
  // section switcher (chips above the list)
  // ------------------------------------------------------------------
  window.toggleSidePanel = function () {
    // legacy entry point: the page now uses the shared dash drawer
    if (typeof window.bmOpenDrawer === 'function') window.bmOpenDrawer();
  };

  window.switchSection = function (name) {
    currentSection = name;
    closeMenus();
    ['members', 'requests'].forEach(s => {
      const sec = $('section-' + s);
      if (sec) sec.classList.toggle('hidden', s !== name);
    });
    ['members', 'requests'].forEach(s => {
      const nav = $('nav-' + s);
      if (!nav) return;
      const active = s === name;
      nav.classList.toggle('is-on', active);
      nav.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (name === 'requests') { renderRequests(); refreshBadge(); }
  };

  // ------------------------------------------------------------------
  // signup mode dropdown
  // ------------------------------------------------------------------
  function setModeUi(mode) {
    const label = $('mode-label'), dot = $('mode-dot');
    if (label) label.textContent = MODE_LABELS[mode] || mode;
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full flex-shrink-0 ' + (MODE_DOTS[mode] || 'bg-secondary');
    document.querySelectorAll('#mode-menu .mode-opt').forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      const chk = b.querySelector('.mode-opt-check');
      if (chk) chk.classList.toggle('hidden', !on);
    });
  }

  window.toggleModeMenu = function (e) {
    if (e) e.stopPropagation();
    const menu = $('mode-menu');
    if (!menu) return;
    const visible = !menu.classList.contains('hidden');
    closeMenus();
    if (!visible) {
      menu.classList.remove('hidden');
      const btn = $('mode-btn');
      if (btn) btn.setAttribute('aria-expanded', 'true');
    }
  };

  window.setSignupMode = function (mode) {
    const menu = $('mode-menu'), btn = $('mode-btn');
    if (btn) btn.disabled = true;
    post('api/admin/signup-mode', { mode })
      .then(d => {
        if (btn) btn.disabled = false;
        if (!d.ok) return showToast(d.msg || 'خطا');
        signupMode = d.mode;
        setModeUi(signupMode);
        if (menu) menu.classList.add('hidden');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        showToast('حالت ایجاد حساب: ' + (MODE_LABELS[signupMode] || signupMode), 3000);
      })
      .catch(() => { if (btn) btn.disabled = false; showToast('خطای شبکه'); });
  };

  // ------------------------------------------------------------------
  // member cards
  // ------------------------------------------------------------------
  function rankBadge(u) {
    if (u.is_manager) {
      return '<span class="mem-badge mem-badge-manager">' + bmIcon('shield_person') + ' مدیر اصلی</span>';
    }
    const r = u.rank === 'premium' ? 'premium' : (u.rank === 'admin' ? 'admin' : 'user');
    if (r === 'premium') {
      return '<span class="mem-badge mem-badge-premium">' + bmIcon('shield_person') + ' ادمین پریمیوم</span>';
    }
    if (r === 'admin') {
      return '<span class="mem-badge mem-badge-admin">' + bmIcon('shield_person') + ' ادمین</span>';
    }
    return '<span class="mem-badge">' + bmIcon('check_circle') + ' کاربر عادی</span>';
  }

  function limitedBadge(u) {
    if (!u.is_limited) return '';
    return '<span class="mem-badge mem-badge-danger">' + bmIcon('block') + ' محدود</span>';
  }

  function avatarHtml(u, size) {
    const initial = esc((u.display_name || '?').slice(0, 2));
    if (u.avatar) {
      const src = (u.avatar.indexOf('http') === 0) ? u.avatar : (window.BASE + '/' + u.avatar.replace(/^\/+/, ''));
      return '<div class="mem-av" style="background:' + esc(u.avatar_color) + '"><img src="' + esc(src) + '" alt=""/></div>';
    }
    return '<div class="mem-av" style="background:' + esc(u.avatar_color) + '">' + initial + '</div>';
  }

  function rankMenuHtml(u) {
    return '<div class="rank-anchor">' +
      '<button type="button" class="rank-trigger mem-act mem-act-caret" data-no-loader onclick="event.stopPropagation();toggleRankMenu(' + u.id + ')" aria-haspopup="menu" aria-expanded="false">' +
      bmIcon('shield_person') + '<span>تغییر درجه</span>' +
      '<span class="bm-caret" aria-hidden="true"></span></button>' +
      '<div id="rank-menu-' + u.id + '" class="rank-menu hidden" role="menu">' +
      ['user', 'admin', 'premium'].map(r =>
        '<button type="button" class="mode-opt" role="menuitem" onclick="setRank(' + u.id + ',\'' + r + '\')">' +
        '<span class="mode-opt-icon">' + bmIcon(r === 'user' ? 'person' : 'shield_person', '', true) + '</span>' +
        '<span class="mem-opt-title">' + RANK_LABELS[r] + '</span>' +
        (u.rank === r ? '<span class="mode-opt-check" aria-hidden="true">' + bmIcon('check_circle', '', true) + '</span>' : '') +
        '</button>').join('') +
      '</div></div>';
  }

  function actionCell(u) {
    if (u.info_hidden) return '<span class="mem-note">اطلاعات مدیر اصلی فقط توسط خودش قابل مشاهده و ویرایش است</span>';
    let html = '';
    if (!u.is_manager) html += rankMenuHtml(u);
    html += '<button type="button" onclick="openEditModal(' + u.id + ')" class="mem-act mem-act-primary">' + bmIcon('edit') + ' ویرایش</button>';
    if (!u.is_manager) {
      const limited = !!u.is_limited;
      const cls = limited ? 'mem-act mem-act-ok' : 'mem-act mem-act-danger';
      const label = limited ? 'رفع محدودیت' : 'محدود کردن';
      html += '<button type="button" id="btn-lim-' + u.id + '" onclick="toggleLimit(' + u.id + ')" class="' + cls + '">' + label + '</button>';
    }
    return html;
  }

  function cardEl(u) {
    const card = document.createElement('div');
    card.id = 'user-row-' + u.id;
    // no `bm-soft`: member cards must not shrink/grow on hover (nor their keys)
    card.className = 'mem-card';

    let info;
    if (u.info_hidden) {
      info = '<div class="mem-row">' + bmIcon('lock') +
        '<span>اطلاعات مدیر اصلی مخفی است</span></div>';
    } else {
      const pw = u.is_manager ? '••••••' : esc(u.password_hash);
      info =
        '<div class="mem-row">' + bmIcon('badge') + '<span>' + esc(u.full_name) + '</span></div>' +
        '<div class="mem-row mem-row-ltr">' + bmIcon('email') + '<span dir="ltr">' + esc(u.email) + '</span></div>' +
        '<div class="mem-row mem-row-ltr">' + bmIcon('key') + '<span class="mem-pass" dir="ltr">' + pw + '</span></div>' +
        '<div class="mem-row mem-row-ltr">' + bmIcon('phone') + '<span dir="ltr">' + esc(u.phone) + '</span></div>' +
        '<div class="mem-row">' + bmIcon('shield_person') +
        '<span>' + esc(RANK_LABELS[u.rank === 'premium' ? 'premium' : (u.rank === 'admin' ? 'admin' : (u.is_manager ? 'manager' : 'user'))]) + '</span></div>';
    }

    card.innerHTML =
      '<div class="mem-card-top">' +
      avatarHtml(u) +
      '<div class="mem-id">' +
      '<h3 class="mem-name">' + esc(u.display_name) + '</h3>' +
      '<p class="mem-handle" dir="ltr">' + (u.info_hidden ? '' : '@' + esc(u.username)) + '</p>' +
      '</div>' +
      '<div id="lim-' + u.id + '" class="mem-flags">' + rankBadge(u) + limitedBadge(u) + '</div>' +
      '</div>' +
      '<div class="mem-rows">' + info + '</div>' +
      '<div id="act-' + u.id + '" class="mem-actions">' + actionCell(u) + '</div>';
    return card;
  }

  function render() {
    const box = $('user-cards');
    if (!box) return;
    const q = ($('member-search').value || '').trim().toLowerCase();
    const size = parseInt($('page-size').value, 10) || 25;
    let list = allUsers;
    if (q) {
      list = allUsers.filter(u =>
        (u.display_name || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.phone || '').includes(q)
      );
    }
    const shown = list.slice(0, size);
    box.innerHTML = '';
    if (!shown.length) {
      box.innerHTML = '<div class="mem-empty">' + bmIcon('search') + '<span>موردی یافت نشد</span></div>';
    } else {
      const frag = document.createDocumentFragment();
      shown.forEach(u => frag.appendChild(cardEl(u)));
      box.appendChild(frag);
    }
    $('result-count').textContent = fa(list.length) + ' کاربر' + (list.length > shown.length ? ' (نمایش ' + fa(shown.length) + ' مورد)' : '');
  }

  window.toggleRankMenu = function (userId) {
    const menu = $('rank-menu-' + userId);
    if (!menu) return;
    const show = menu.classList.contains('hidden');
    closeMenus();
    if (show) {
      menu.classList.remove('hidden');
      openMenu = menu;
      const card = $('user-row-' + userId);
      if (card) { card.style.zIndex = '30'; openMenuCard = card; }
    }
  };

  window.setRank = function (userId, rank) {
    closeMenus();
    post('api/admin/members', { user_id: String(userId), action: 'set_rank', rank })
      .then(d => {
        if (!d.ok) return showToast(d.msg || 'خطا');
        const u = allUsers.find(x => x.id === userId);
        if (u) u.rank = d.rank;
        render();
        showToast('درجه کاربر به «' + (d.label || RANK_LABELS[rank]) + '» تغییر کرد', 3000);
      })
      .catch(() => showToast('خطای شبکه'));
  };

  window.toggleLimit = function (userId) {
    const btn = $('btn-lim-' + userId);
    const u0 = allUsers.find(x => x.id === userId);
    // put the real label back on failure — "تلاش مجدد" used to stick to the card
    const restore = () => {
      if (!btn) return;
      btn.disabled = false;
      const u = allUsers.find(x => x.id === userId);
      btn.textContent = (u && u.is_limited) ? 'رفع محدودیت' : 'محدود کردن';
    };
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    post('api/admin/members', { user_id: String(userId) })
      .then(d => {
        if (!d.ok) { showToast(d.msg || 'خطا'); restore(); return; }
        const u = allUsers.find(x => x.id === userId);
        if (u) u.is_limited = d.is_limited ? 1 : 0;
        render();
        showToast(d.is_limited ? 'کاربر محدود شد' : 'محدودیت برداشته شد', 3000);
      })
      .catch(() => { showToast('خطای شبکه'); restore(); });
  };

  // ------------------------------------------------------------------
  // edit modal (username / email / phone / password / rank)
  // ------------------------------------------------------------------
  let editUserId = null;

  window.openEditModal = function (userId) {
    const u = allUsers.find(x => x.id === userId);
    if (!u || u.info_hidden) return;
    editUserId = userId;
    $('edit-target').textContent = (u.display_name || u.username || ('کاربر #' + userId));
    $('ed-username').value = u.username || '';
    $('ed-display-name').value = u.display_name || '';
    $('ed-email').value = u.email || '';
    $('ed-phone').value = u.phone || '';
    $('ed-password').value = '';
    const rankSel = $('ed-rank');
    let mgrOpt = rankSel.querySelector('option[data-mgr]');
    if (u.is_manager) {
      if (!mgrOpt) {
        mgrOpt = document.createElement('option');
        mgrOpt.value = '';
        mgrOpt.setAttribute('data-mgr', '1');
        mgrOpt.textContent = 'مدیر اصلی';
        rankSel.appendChild(mgrOpt);
      }
      rankSel.value = '';
    } else {
      if (mgrOpt) mgrOpt.remove();
      rankSel.value = ['user', 'admin', 'premium'].indexOf(u.rank) !== -1 ? u.rank : 'user';
    }
    const locked = !!u.is_manager;
    rankSel.disabled = locked;
    $('ed-rank-lock').classList.toggle('hidden', !locked);
    const btn = $('ed-rank-btn');
    if (btn) {
      btn.disabled = locked;
      btn.classList.toggle('opacity-60', locked);
      btn.classList.toggle('cursor-not-allowed', locked);
    }
    paintEditRank();
    $('edit-modal').classList.remove('hidden');
    $('ed-username').focus();
  };

  // ---------- the rank dropdown inside the edit modal (themed face) ----------
  const RANK_TEXT = { user: 'کاربر عادی', admin: 'ادمین', premium: 'ادمین پریمیوم', '': 'مدیر اصلی' };
  function paintEditRank() {
    const sel = $('ed-rank');
    const lbl = $('ed-rank-label');
    if (!sel || !lbl) return;
    const v = String(sel.value);
    const opt = sel.options[sel.selectedIndex];
    lbl.textContent = (opt && opt.textContent) || RANK_TEXT[v] || 'کاربر عادی';
    const m = $('ed-rank-menu');
    if (m) {
      m.querySelectorAll('[data-rank]').forEach(b => {
        b.classList.toggle('bm-opt-active', b.getAttribute('data-rank') === v);
      });
    }
  }
  // the modal is a scroll container, so an absolutely positioned menu inside it gets
  // clipped — pin the menu to the viewport instead (same trick as the call cam menu)
  function positionEditRankMenu() {
    const b = $('ed-rank-btn');
    const m = $('ed-rank-menu');
    if (!b || !m || m.classList.contains('hidden')) return;
    m.style.position = 'fixed';
    m.style.zIndex = '110';
    m.style.left = 'auto';
    m.style.right = 'auto';
    m.style.top = 'auto';
    m.style.bottom = 'auto';
    const r = b.getBoundingClientRect();
    m.style.right = Math.max(8, Math.min(r.right, window.innerWidth - m.offsetWidth - 8)) + 'px';
    if (window.innerHeight - r.bottom > m.offsetHeight + 16) {
      m.style.top = (r.bottom + 8) + 'px';
    } else {
      m.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    }
  }
  window.toggleEditRankMenu = function (e) {
    if (e) e.stopPropagation();
    const m = $('ed-rank-menu');
    const b = $('ed-rank-btn');
    const sel = $('ed-rank');
    if (!m || !sel || sel.disabled) return;
    const show = m.classList.contains('hidden');
    m.classList.toggle('hidden', !show);
    if (b) b.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) positionEditRankMenu();
  };
  window.setEditRank = function (rank) {
    const sel = $('ed-rank');
    if (!sel || sel.disabled) return;
    sel.value = rank;
    paintEditRank();
    const m = $('ed-rank-menu');
    if (m) m.classList.add('hidden');
    const b = $('ed-rank-btn');
    if (b) b.setAttribute('aria-expanded', 'false');
  };
  window.bmCloseEditRankMenu = function () {
    const m = $('ed-rank-menu');
    if (m && !m.classList.contains('hidden')) {
      m.classList.add('hidden');
      const b = $('ed-rank-btn');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
  };
  window.addEventListener('resize', function () {
    const m = $('ed-rank-menu');
    if (m && !m.classList.contains('hidden')) positionEditRankMenu();
  });

  window.closeEditModal = function () {
    $('edit-modal').classList.add('hidden');
    editUserId = null;
  };

  window.submitEdit = function () {
    const userId = editUserId;
    if (userId == null) return;
    post('api/admin/members', {
      user_id: String(userId),
      action: 'update',
      username: $('ed-username').value.trim(),
      display_name: $('ed-display-name').value.trim(),
      email: $('ed-email').value.trim(),
      phone: $('ed-phone').value.trim(),
      password: $('ed-password').value,
      rank: $('ed-rank').value,
    })
      .then(d => {
        if (!d.ok) { showToast(d.msg || 'خطا'); return; }
        if (d.user) {
          const i = allUsers.findIndex(x => x.id === userId);
          if (i !== -1) allUsers[i] = d.user;
        }
        render();
        closeEditModal();
        showToast('اطلاعات کاربر بروزرسانی شد', 3000);
      })
      .catch(() => showToast('خطای شبکه'));
  };

  // ------------------------------------------------------------------
  // account creation requests
  // ------------------------------------------------------------------
  function statusBadge(r) {
    if (r.status === 'approved') {
      return '<span class="mem-badge mem-badge-admin">' + bmIcon('check_circle') + ' تایید شد</span>';
    }
    if (r.status === 'rejected') {
      return '<span class="mem-badge mem-badge-danger">' + bmIcon('close') + ' رد شد</span>';
    }
    return '<span class="mem-badge mem-badge-premium">' + bmIcon('person') + ' در انتظار</span>';
  }

  function reqCard(r) {
    const card = document.createElement('div');
    card.id = 'req-row-' + r.id;
    card.className = 'mem-card';

    const pending = r.status === 'pending';
    const msgs = (r.messages || []).map(m =>
      '<div class="mem-brow ' + (m.from_manager ? 'is-me' : 'is-them') + '">' +
      '<div class="mem-bubble">' + esc(m.body) + '</div></div>').join('');

    let chat = '';
    if (PERM.decide) {
      chat =
        '<div class="mem-thread req-thread">' +
        (msgs || '<span class="mem-thread-empty">پیامی وجود ندارد</span>') +
        '</div>' +
        '<div class="mem-replyrow">' +
        '<input id="req-reply-' + r.id + '" class="dash-input dash-input-plain" placeholder="پاسخ به متقاضی…" aria-label="پاسخ به متقاضی" onkeydown="if(event.key===\'Enter\')sendReqReply(' + r.id + ')"/>' +
        '<button type="button" onclick="sendReqReply(' + r.id + ')" class="dash-btn dash-btn-solid mem-send" aria-label="ارسال پاسخ">' + bmIcon('send') + '</button>' +
        '</div>';
    } else if ((r.messages || []).length) {
      chat = '<div class="mem-thread req-thread">' + msgs + '</div>';
    }

    let footer = '';
    if (PERM.decide && pending) {
      footer =
        '<div class="mem-decide">' +
        '<button type="button" onclick="decideRequest(' + r.id + ',\'approve\')" class="dash-btn dash-btn-solid">تایید و فعال‌سازی</button>' +
        '<button type="button" onclick="decideRequest(' + r.id + ',\'reject\')" class="dash-btn dash-btn-danger">رد</button>' +
        '</div>';
    }

    card.innerHTML =
      '<div class="mem-card-top">' +
      '<div class="mem-av" style="background:#4f46e5">' + esc((r.full_name || '?').slice(0, 2)) + '</div>' +
      '<div class="mem-id">' +
      '<h3 class="mem-name">' + esc(r.full_name) + '</h3>' +
      '<p class="mem-handle" dir="ltr">@' + esc(r.username) + '</p>' +
      '</div>' +
      '<div class="mem-flags">' + statusBadge(r) + '</div>' +
      '</div>' +
      '<div class="mem-rows">' +
      '<div class="mem-row mem-row-ltr">' + bmIcon('email') + '<span dir="ltr">' + esc(r.email) + '</span></div>' +
      '<div class="mem-row mem-row-ltr">' + bmIcon('phone') + '<span dir="ltr">' + esc(r.phone) + '</span></div>' +
      '<div class="mem-row mem-row-ltr">' + bmIcon('key') + '<span class="mem-pass" dir="ltr">' + esc(r.password) + '</span></div>' +
      '<div class="mem-row mem-row-ltr">' + bmIcon('calendar_add_on') + '<span dir="ltr">' + esc(r.created_at || '') + '</span></div>' +
      '</div>' +
      chat + footer;
    return card;
  }

  function renderRequests() {
    const box = $('request-list');
    if (!box) return;
    box.innerHTML = '';
    if (!allRequests.length) {
      box.innerHTML = '<div class="mem-empty">' + bmIcon('person') + '<span>درخواست ایجاد حسابی وجود ندارد</span></div>';
      return;
    }
    const frag = document.createDocumentFragment();
    allRequests.forEach(r => frag.appendChild(reqCard(r)));
    box.appendChild(frag);
  }

  function refreshBadge() {
    const nav = $('nav-requests');
    if (!nav) return;
    const pending = allRequests.filter(r => r.status === 'pending').length;
    let badge = nav.querySelector('.req-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'req-badge';
      nav.appendChild(badge);
    }
    badge.textContent = fa(pending);
    badge.style.display = pending ? '' : 'none';
  }

  window.decideRequest = function (rid, action) {
    post('api/admin/signup-requests', { request_id: String(rid), action })
      .then(d => {
        if (!d.ok) { showToast(d.msg || 'خطا'); return; }
        const r = allRequests.find(x => x.id === rid);
        if (r) r.status = d.status;
        if (action === 'approve' && d.user && PERM.members) {
          allUsers.push(d.user);
          render();
        }
        renderRequests();
        refreshBadge();
        showToast(action === 'approve' ? 'حساب کاربری فعال شد؛ کاربر اکنون می‌تواند وارد شود' : 'درخواست رد شد', 4000);
      })
      .catch(() => showToast('خطای شبکه'));
  };

  let lastSendAt = 0;

  window.sendReqReply = function (rid) {
    const inp = $('req-reply-' + rid);
    if (!inp) return;
    const body = inp.value.trim();
    if (!body) return;
    lastSendAt = Date.now();
    post('api/admin/signup-requests/message', { request_id: String(rid), body })
      .then(d => {
        if (!d.ok) { showToast(d.msg || 'خطا'); return; }
        const msg = d.message || { id: Date.now(), body, from_manager: 1, created_at: '' };
        const r = allRequests.find(x => x.id === rid);
        if (r) {
          r.messages = r.messages || [];
          r.messages.push(msg);
        }
        // optimistic append — no full re-render (keeps focus/scroll)
        const card = $('req-row-' + rid);
        const thread = card && card.querySelector('.req-thread');
        if (thread) {
          const ph = thread.querySelector('.mem-thread-empty');
          if (ph) ph.remove();
          const wrap = document.createElement('div');
          wrap.className = 'mem-brow is-me';
          wrap.innerHTML = '<div class="mem-bubble">' + esc(body) + '</div>';
          thread.appendChild(wrap);
          thread.scrollTop = thread.scrollHeight;
          inp.value = '';
          inp.focus();
        } else {
          renderRequests();
        }
      })
      .catch(() => showToast('خطای شبکه'));
  };

  // live refresh of the request list (new signups / applicant replies) — interval is only
  // the fallback; realtime SR_NEW_* events trigger the same poll immediately
  function pollRequests() {
    if (Date.now() - lastSendAt < 1500) return; // don't clobber a just-sent optimistic reply
    fetch('api/admin/signup-requests').then(r => r.json()).then(d => {
      if (!d.ok) return;
      if (Date.now() - lastSendAt < 1500) return;
      const next = d.requests || [];
      if (JSON.stringify(next) !== JSON.stringify(allRequests)) {
        const ae = document.activeElement;
        const fid = ae && ae.id && ae.id.indexOf('req-reply-') === 0 ? ae.id : null;
        const fv = fid ? ae.value : '';
        allRequests = next;
        renderRequests();
        refreshBadge();
        if (fid) {
          const el = $(fid);
          if (el) { el.value = fv; el.focus(); }
        }
      }
    }).catch(() => {});
  }
  setInterval(pollRequests, 3000);
  if (window.BMLive && window.BMEv) {
    BMLive.on(BMEv.SR_NEW_MESSAGE, pollRequests); // applicant replied — refresh now, not in 3s
    BMLive.on(BMEv.SR_NEW_REQUEST, pollRequests); // new signup request — badge instantly
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  const ms = $('member-search');
  if (ms) ms.addEventListener('input', render);
  const ps = $('page-size');
  if (ps) ps.addEventListener('change', () => { paintPageSize(); render(); });
  paintPageSize();
  paintEditRank();

  setModeUi(signupMode);
  if (PERM.members) render();
  renderRequests();
  refreshBadge();
  if (currentSection !== 'members') switchSection(currentSection);
})();
