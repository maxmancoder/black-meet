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

  // copy a member info value from its card (used by the small copy keys in the info panel)
  window.bmCopyInfoText = function (btn) {
    const text = btn && btn.getAttribute ? (btn.getAttribute('data-copy') || '') : '';
    if (!text || text === '—') return;
    const done = () => {
      showToast('کپی شد');
      if (btn && btn.classList) {
        btn.classList.add('is-copied');
        setTimeout(() => btn.classList.remove('is-copied'), 1200);
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        ta.remove();
      });
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      ta.remove();
    }
  };

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
    ['members', 'requests', 'limits'].forEach(s => {
      const sec = $('section-' + s);
      if (sec) sec.classList.toggle('hidden', s !== name);
    });
    ['members', 'requests', 'limits'].forEach(s => {
      const nav = $('nav-' + s);
      if (!nav) return;
      const active = s === name;
      nav.classList.toggle('is-on', active);
      nav.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (name === 'requests') { renderRequests(); refreshBadge(); }
    if (name === 'limits') { renderLimits(); renderLimitUsers(); }
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

  function roleLabel(u) {
    if (u.is_manager) return 'مدیر اصلی';
    if (u.rank === 'premium') return RANK_LABELS.premium || 'ادمین پریمیوم';
    if (u.rank === 'admin') return RANK_LABELS.admin || 'ادمین';
    return RANK_LABELS.user || 'کاربر عادی';
  }

  function avatarHtml(u, size) {
    const lg = size === 'lg';
    const cls = lg ? 'mem-av mem-av-lg' : 'mem-av';
    const initial = esc((u.display_name || '?').slice(0, 2));
    const bg = esc(u.avatar_color || '#4f46e5');
    if (u.avatar) {
      const src = (u.avatar.indexOf('http') === 0) ? u.avatar : (window.BASE + '/' + u.avatar.replace(/^\/+/, ''));
      return '<div class="' + cls + '" style="background:' + bg + '"><img src="' + esc(src) + '" alt=""/></div>';
    }
    return '<div class="' + cls + '" style="background:' + bg + '">' + initial + '</div>';
  }

  function rankMenuHtml(u) {
    return '<div class="rank-anchor">' +
      '<button type="button" class="rank-trigger mem-act mem-act-rank mem-act-caret" data-no-loader onclick="event.stopPropagation();toggleRankMenu(' + u.id + ')" aria-haspopup="menu" aria-expanded="false">' +
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

  function infoCell(icon, label, value, tone, ltr, copyable) {
    const v = (value == null || value === '') ? '—' : String(value);
    const copy = copyable
      ? '<button type="button" class="mem-info-copy" data-no-soft aria-label="کپی ' + esc(label) + '" title="کپی ' + esc(label) + '" onclick="bmCopyInfoText(this)" data-copy="' + esc(v) + '">' + bmIcon('description') + '</button>'
      : '';
    return '<div class="mem-info-cell mem-info-cell-' + esc(tone || 'default') + '">' +
      '<span class="mem-info-ico" aria-hidden="true">' + bmIcon(icon) + '</span>' +
      '<span class="mem-info-meta">' +
        '<span class="mem-info-label">' + esc(label) + '</span>' +
        '<span class="mem-info-value"' + (ltr ? ' dir="ltr"' : '') + '>' + esc(v) + '</span>' +
      '</span>' + copy +
    '</div>';
  }

  function memberInfoPanel(u) {
    if (u.info_hidden) {
      return '<div class="mem-info-panel mem-info-panel-hidden">' +
        '<span class="mem-info-hidden-ico">' + bmIcon('lock') + '</span>' +
        '<span class="mem-note">اطلاعات مدیر اصلی فقط توسط خودش قابل مشاهده و ویرایش است</span>' +
      '</div>';
    }
    const dn = u.display_name || '';
    const un = u.username ? ('@' + u.username) : '';
    return '<div class="mem-info-panel">' +
      '<div class="mem-info-grid">' +
        infoCell('person', 'نام نمایشی', dn, 'violet', false, true) +
        infoCell('badge', 'نام کاربری', un, 'blue', true, true) +
        infoCell('shield_person', 'نقش', roleLabel(u), 'amber', false, false) +
        infoCell('mail', 'ایمیل', u.email || '', 'cyan', true, true) +
        infoCell('lock', 'رمز عبور', '********', 'rose', true, false) +
        infoCell('phone', 'شماره تلفن', u.phone || '', 'green', true, true) +
      '</div>' +
    '</div>';
  }

  function actionCell(u) {
    if (u.info_hidden) return '';
    // order: محدود کردن, ویرایش, تغییر درجه — preserving current conditions/behavior
    let html = '';
    if (!u.is_manager) {
      const limited = !!u.is_limited;
      const cls = limited ? 'mem-act mem-act-ok' : 'mem-act mem-act-danger';
      const label = limited ? 'رفع محدودیت' : 'محدود کردن';
      html += '<button type="button" id="btn-lim-' + u.id + '" onclick="toggleLimit(' + u.id + ')" class="' + cls + '">' +
        bmIcon('block') + '<span>' + esc(label) + '</span></button>';
    }
    html += '<button type="button" onclick="openEditModal(' + u.id + ')" class="mem-act mem-act-primary">' +
      bmIcon('edit') + '<span>ویرایش</span></button>';
    if (!u.is_manager) html += rankMenuHtml(u);
    return html;
  }

  function cardEl(u) {
    const card = document.createElement('div');
    card.id = 'user-row-' + u.id;
    // no `bm-soft`: member cards must not shrink/grow on hover (nor their keys)
    card.className = 'mem-card mem-card-member';

    const dn = esc(u.display_name || '');

    card.innerHTML =
      '<div class="mem-neon-head">' +
        '<div class="mem-avatar-ring">' + avatarHtml(u, 'lg') + '</div>' +
        '<div class="mem-neon-id">' +
          '<p class="mem-name mem-neon-name">' + dn + '</p>' +
        '</div>' +
        '<div id="lim-' + u.id + '" class="mem-flags mem-neon-badges">' + rankBadge(u) + limitedBadge(u) + '</div>' +
      '</div>' +
      memberInfoPanel(u) +
      '<div id="act-' + u.id + '" class="mem-actions mem-actions-neon">' + actionCell(u) + '</div>';
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
    // put the real label back on failure — "تلاش مجدد" used to stick to the card
    const restore = () => {
      if (!btn) return;
      btn.disabled = false;
      const u = allUsers.find(x => x.id === userId);
      const label = (u && u.is_limited) ? 'رفع محدودیت' : 'محدود کردن';
      btn.innerHTML = bmIcon('block') + '<span>' + esc(label) + '</span>';
    };
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    post('api/admin/members', { user_id: String(userId) })
      .then(d => {
        if (!d.ok) { showToast(d.msg || 'خطا'); restore(); return; }
        const u = allUsers.find(x => x.id === userId);
        if (u) u.is_limited = d.is_limited ? 1 : 0;
        render();
        if (currentSection === 'limits') renderLimitUsers();
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
    // always open BELOW the trigger itself — never flip above the box. If the viewport is
    // short, the menu scrolls internally instead of covering the field it belongs to.
    m.style.top = (r.bottom + 8) + 'px';
    m.style.maxHeight = Math.max(120, window.innerHeight - r.bottom - 18) + 'px';
    m.style.overflowY = 'auto';
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
      '<div class="mem-bubble">' + (window.bmLinkify ? window.bmLinkify(m.body) : esc(m.body)) + '</div></div>').join('');

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
          wrap.innerHTML = '<div class="mem-bubble">' + (window.bmLinkify ? window.bmLinkify(body) : esc(body)) + '</div>';
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
  // per-rank restrictions (مدیریت اعضا → محدودیت کاربران)
  // ------------------------------------------------------------------
  let limitState = null;
  const clone = o => JSON.parse(JSON.stringify(o || {}));
  const ico = (n, fill) => (typeof window.bmIcon === 'function' ? window.bmIcon(n, '', !!fill) : '');

  function renderLimits() {
    if (!PERM.limits) return;
    if (!limitState) limitState = clone(window.LIMITS);
    const host = $('limit-ranks');
    if (!host) return;
    const defs = window.LIMIT_DEFS || [];
    const order = ['manager', 'premium', 'admin', 'user'];
    host.innerHTML = order.map((rank) => {
      const rows = defs.map((d) => {
        const cell = (limitState[rank] || {})[d.key] || { on: false, value: 0 };
        const isNum = d.type === 'number';
        const locked = rank === 'manager' && !isNum; // the main manager is never locked out
        const state = !cell.on ? ' is-off' : '';
        return '<div class="lim-row' + state + '" data-lim-row="' + d.key + '">' +
          '<div class="lim-row-main"><span class="lim-row-label">' + esc(d.label) + '</span>' +
          (d.hint ? '<span class="lim-row-hint">' + esc(d.hint) + '</span>' : '') + '</div>' +
          (isNum
            ? '<input class="lim-num" type="number" inputmode="numeric" min="' + d.min + '" max="' + d.max + '"' +
              ' data-lim-rank="' + rank + '" data-lim-key="' + d.key + '" value="' + Number(cell.value || 0) + '"' +
              (cell.on ? '' : ' disabled') + ' aria-label="' + esc(d.label) + '"/>'
            : '') +
          '<label class="bm-switch lim-switch" title="' + (locked ? 'مدیر اصلی همیشه دسترسی کامل دارد' : 'خاموش = اعمال نشود') + '">' +
          '<input type="checkbox" data-lim-rank="' + rank + '" data-lim-key="' + d.key + '"' +
          (cell.on ? ' checked' : '') + (locked ? ' disabled' : '') + '/><span class="bm-switch-slider"></span></label>' +
          '</div>';
      }).join('');
      return '<article class="lim-rank-card" data-rank="' + rank + '">' +
        '<header class="lim-rank-head"><span class="lim-rank-ico">' + ico(rank === 'manager' ? 'shield_person' : 'group', true) + '</span>' +
        '<div><h3>' + esc(RANK_LABELS[rank]) + '</h3><p>' + (rank === 'manager' ? 'دسترسی کامل همیشگی' : 'محدودیت‌های مخصوص همین نوع کاربر') + '</p></div></header>' +
        '<div class="lim-rows">' + rows + '</div></article>';
    }).join('');
  }

  function bindLimitEvents() {
    const host = $('limit-ranks');
    if (!host || host.dataset.bound === '1') return;
    host.dataset.bound = '1';
    host.addEventListener('change', (ev) => {
      const t = ev.target;
      const rank = t && t.dataset && t.dataset.limRank;
      const key = t && t.dataset && t.dataset.limKey;
      if (!rank || !key || !limitState) return;
      if (!limitState[rank]) limitState[rank] = {};
      const cell = limitState[rank][key] = limitState[rank][key] || { on: false, value: 0 };
      if (t.type === 'checkbox') {
        cell.on = !!t.checked;
        const num = host.querySelector('input[type="number"][data-lim-rank="' + rank + '"][data-lim-key="' + key + '"]');
        if (num) num.disabled = !cell.on;
        const row = t.closest('.lim-row');
        if (row) row.classList.toggle('is-off', !cell.on);
      } else {
        cell.value = Number(t.value) || 0;
        cell.on = true;
        const box = host.querySelector('input[type="checkbox"][data-lim-rank="' + rank + '"][data-lim-key="' + key + '"]');
        if (box && !box.checked) { box.checked = true; const row = box.closest('.lim-row'); if (row) row.classList.remove('is-off'); }
      }
      const st = $('lim-save-state');
      if (st) st.textContent = 'تغییرات ذخیره نشده';
    });
  }

  window.saveRestrictions = function () {
    if (!limitState) return;
    const btn = $('lim-save');
    if (btn) btn.disabled = true;
    post('api/admin/members', { action: 'save_restrictions', limits: JSON.stringify(limitState) })
      .then((d) => {
        if (d && d.ok) {
          limitState = clone(d.limits);
          window.LIMITS = d.limits;
          const st = $('lim-save-state');
          if (st) st.textContent = 'ذخیره شد ✓';
          showToast('محدودیت‌ها ذخیره شد');
        } else {
          showToast((d && d.msg) || 'ذخیره محدودیت‌ها ناموفق بود');
        }
      })
      .catch(() => showToast('ارتباط برقرار نشد'))
      .finally(() => { if (btn) btn.disabled = false; });
  };

  // ------------------------------------------------------------------
  // per-MEMBER restrictions: the «محدود کردن» key opens a soft panel under that one
  // card. Every value saved here overrides the rank rule for THIS user only.
  // ------------------------------------------------------------------
  let userLimitState = {};
  (window.USER_LIMITS || []).forEach((x) => {
    try { userLimitState[Number(x.user_id)] = JSON.parse(x.data) || {}; } catch (e) {}
  });
  let expandedUserId = null;

  function userRestrictionRows(uid, u) {
    const defs = window.LIMIT_DEFS || [];
    const rank = u.is_manager ? 'manager' : (u.rank || 'user');
    const base = (window.LIMITS || {})[rank] || {};
    const over = userLimitState[Number(uid)] || {};
    return defs.map((d) => {
      const cell = over[d.key] || base[d.key] || { on: false, value: 0 };
      const isNum = d.type === 'number';
      const locked = !!u.is_manager && !isNum;
      return '<div class="lim-row' + (cell.on ? '' : ' is-off') + '" data-lim-row="' + d.key + '">' +
        '<div class="lim-row-main"><span class="lim-row-label">' + esc(d.label) + '</span>' +
        (d.hint ? '<span class="lim-row-hint">' + esc(d.hint) + '</span>' : '') + '</div>' +
        (isNum ? '<input class="lim-num" type="number" inputmode="numeric" min="' + d.min + '" max="' + d.max + '"' +
          ' data-ulim-key="' + d.key + '" data-ulim-uid="' + uid + '" value="' + Number(cell.value || 0) + '"' +
          (cell.on ? '' : ' disabled') + ' aria-label="' + esc(d.label) + '"/>' : '') +
        '<label class="bm-switch lim-switch"><input type="checkbox" data-ulim-key="' + d.key + '"' +
        ' data-ulim-uid="' + uid + '"' + (cell.on ? ' checked' : '') + (locked ? ' disabled' : '') +
        '/><span class="bm-switch-slider"></span></label></div>';
    }).join('');
  }

  function userPanelHtml(u) {
    return '<div class="lim-user-expand-inner">' +
      '<div class="lim-user-expand-head"><strong>محدودیت مخصوص «' + esc(u.display_name || u.username || 'کاربر') + '»</strong>' +
      '<span class="lim-row-hint">فقط روی همین کاربر اعمال می‌شود</span></div>' +
      '<div class="lim-user-expand-rows bm-chat-scroll">' +
      (u.is_manager ? '' : '<div class="lim-row"><div class="lim-row-main"><span class="lim-row-label">حساب محدود شود</span>' +
        '<span class="lim-row-hint">قفل کلی حساب</span></div><button type="button" class="mem-act ' +
        (u.is_limited ? 'mem-act-ok' : 'mem-act-danger') + '" onclick="toggleLimit(' + u.id + ')">' +
        (u.is_limited ? 'رفع محدودیت' : 'محدود کردن') + '</button></div>') +
      userRestrictionRows(u.id, u) + '</div>' +
      '<div class="lim-user-expand-actions">' +
      '<button type="button" class="dash-btn dash-btn-ghost" data-ulim-clear="' + u.id + '">حذف سفارشی‌ها</button>' +
      '<button type="button" class="dash-btn dash-btn-solid" data-ulim-save="' + u.id + '">ذخیره محدودیت</button>' +
      '</div></div>';
  }

  function closeUserPanels() {
    const host = $('limit-users');
    if (!host) return;
    host.querySelectorAll('.lim-user-card.is-expanded').forEach((c) => {
      c.classList.remove('is-expanded');
      const t = c.querySelector('[data-ulim-toggle]');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
    expandedUserId = null;
  }

  window.toggleUserRestrictions = function (uid) {
    const host = $('limit-users');
    if (!host) return;
    const card = host.querySelector('.lim-user-card[data-uid="' + Number(uid) + '"]');
    if (!card) return;
    const opening = !card.classList.contains('is-expanded');
    closeUserPanels();
    if (!opening) return;
    const u = allUsers.find(x => Number(x.id) === Number(uid));
    if (!u) return;
    const panel = card.querySelector('.lim-user-expand');
    if (panel) panel.innerHTML = userPanelHtml(u);
    card.classList.add('is-expanded');
    expandedUserId = Number(uid);
    const trigger = card.querySelector('[data-ulim-toggle]');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  };

  function saveUserRestrictions(uid) {
    const over = userLimitState[Number(uid)] || {};
    const btn = document.querySelector('[data-ulim-save="' + Number(uid) + '"]');
    if (btn) btn.disabled = true;
    post('api/admin/members', { action: 'save_user_restrictions', target_id: String(uid), limits: JSON.stringify(over) })
      .then(d => {
        if (!d.ok) return showToast((d && d.msg) || 'ذخیره محدودیت ناموفق بود');
        (d.userLimits || []).forEach(x => { try { userLimitState[Number(x.user_id)] = JSON.parse(x.data) || {}; } catch (e) {} });
        showToast('محدودیت کاربر ذخیره شد');
      })
      .catch(() => showToast('ارتباط برقرار نشد'))
      .finally(() => { if (btn) btn.disabled = false; });
  }

  function bindUserLimitEvents() {
    const host = $('limit-users');
    if (!host || host.dataset.ulimBound === '1') return;
    host.dataset.ulimBound = '1';
    host.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!t || !t.closest) return;
      const tog = t.closest('[data-ulim-toggle]');
      if (tog) { window.toggleUserRestrictions(Number(tog.dataset.ulimToggle)); return; }
      const sav = t.closest('[data-ulim-save]');
      if (sav) { saveUserRestrictions(Number(sav.dataset.ulimSave)); return; }
      const clr = t.closest('[data-ulim-clear]');
      if (clr) {
        const uid = Number(clr.dataset.ulimClear);
        post('api/admin/members', { action: 'clear_user_restrictions', target_id: String(uid) })
          .then(d => {
            if (!d.ok) return showToast((d && d.msg) || 'خطا');
            delete userLimitState[uid];
            const card = host.querySelector('.lim-user-card[data-uid="' + uid + '"]');
            const panel = card && card.querySelector('.lim-user-expand');
            const u = allUsers.find(x => Number(x.id) === uid);
            if (panel && u) panel.innerHTML = userPanelHtml(u);
            showToast('محدودیت سفارسی حذف شد');
          });
      }
    });
    host.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!t || !t.dataset || !t.dataset.ulimKey) return;
      const uid = Number(t.dataset.ulimUid);
      if (!userLimitState[uid]) userLimitState[uid] = {};
      const key = t.dataset.ulimKey;
      const def = (window.LIMIT_DEFS || []).find(d => d.key === key);
      if (!def) return;
      const cell = userLimitState[uid][key] = userLimitState[uid][key] || { on: false, value: 0 };
      if (t.type === 'checkbox') {
        cell.on = !!t.checked;
        const num = host.querySelector('[data-ulim-key="' + key + '"][data-ulim-uid="' + uid + '"][type="number"]');
        if (num) num.disabled = !cell.on;
        const row = t.closest('.lim-row');
        if (row) row.classList.toggle('is-off', !cell.on);
      } else {
        cell.on = true;
        cell.value = Number(t.value) || 0;
        const box = host.querySelector('[data-ulim-key="' + key + '"][data-ulim-uid="' + uid + '"][type="checkbox"]');
        if (box && !box.checked) { box.checked = true; const row = box.closest('.lim-row'); if (row) row.classList.remove('is-off'); }
      }
    });
  }

  function renderLimitUsers() {
    const host = $('limit-users');
    if (!host || !PERM.limits) return;
    const inp = $('limit-search');
    const q = String((inp && inp.value) || '').trim().toLowerCase();
    const rows = allUsers.filter((u) => !q || [u.display_name, u.username, u.email, u.phone]
      .some((v) => String(v || '').toLowerCase().indexOf(q) !== -1));
    host.innerHTML = rows.length ? rows.map((u) =>
      '<article class="lim-user-card" data-uid="' + u.id + '">' + avatarHtml(u) +
      '<div class="lim-user-main"><strong>' + esc(u.display_name || u.username || 'کاربر') + '</strong>' +
      '<span class="lim-user-sub" dir="ltr">@' + esc(u.username || '') + '</span>' +
      '<div class="lim-user-badges">' + rankBadge(u) + limitedBadge(u) + '</div></div>' +
      (u.is_manager ? '' : '<button type="button" data-no-soft data-ulim-toggle="' + u.id + '"' +
        ' class="mem-act lim-user-toggle" aria-expanded="false">' +
        (Object.keys(userLimitState[Number(u.id)] || {}).length ? 'ویرایش محدودیت' : 'محدود کردن') + '</button>') +
      '<div class="lim-user-expand"><div></div></div>' +
      '</article>').join('')
      : '<p class="lim-empty">کاربری با این مشخصات پیدا نشد.</p>';
    bindUserLimitEvents();
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  if (PERM.limits) {
    bindLimitEvents();
    renderLimits();
    renderLimitUsers();
    const ls = $('limit-search');
    if (ls) ls.addEventListener('input', renderLimitUsers);
  }
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
