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
    const t = $('toast'); $('toast-message').textContent = msg;
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
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest || (!e.target.closest('.rank-menu') && !e.target.closest('.rank-trigger') &&
      !e.target.closest('#mode-menu') && !e.target.closest('#mode-btn'))) closeMenus();
  });

  // ------------------------------------------------------------------
  // section switcher (left sidebar)
  // ------------------------------------------------------------------
  window.toggleSidePanel = function () {
    const sp = $('side-panel');
    if (sp) sp.classList.toggle('hidden');
  };

  window.switchSection = function (name) {
    currentSection = name;
    closeMenus();
    // mobile: close the panel after picking a section
    if (window.innerWidth < 768) {
      const sp = $('side-panel');
      if (sp) sp.classList.add('hidden');
    }
    ['members', 'requests'].forEach(s => {
      const sec = $('section-' + s);
      if (sec) sec.classList.toggle('hidden', s !== name);
    });
    ['members', 'requests'].forEach(s => {
      const nav = $('nav-' + s);
      if (!nav) return;
      const active = s === name;
      nav.classList.toggle('bg-primary-container', active);
      nav.classList.toggle('text-on-primary-container', active);
      nav.classList.toggle('text-on-surface-variant', !active);
      nav.classList.toggle('hover:bg-surface-container-high', !active);
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
      return '<span class="inline-flex items-center gap-1 text-white bg-gradient-to-br from-amber-500 to-orange-600 px-2 py-1 rounded-full font-label-sm shadow-lg">' +
        bmIcon('shield_person', 'text-[16px]') + ' مدیر اصلی</span>';
    }
    const r = u.rank === 'premium' ? 'premium' : (u.rank === 'admin' ? 'admin' : 'user');
    if (r === 'premium') {
      return '<span class="inline-flex items-center gap-1 text-on-primary-container bg-primary-container px-2 py-1 rounded-full font-label-sm">' +
        bmIcon('shield_person', 'text-[16px]') + ' ادمین پریمیوم</span>';
    }
    if (r === 'admin') {
      return '<span class="inline-flex items-center gap-1 text-on-secondary-container bg-secondary-container/70 px-2 py-1 rounded-full font-label-sm">' +
        bmIcon('shield_person', 'text-[16px]') + ' ادمین</span>';
    }
    return '<span class="inline-flex items-center gap-1 text-secondary-container bg-secondary-container/20 px-2 py-1 rounded-full font-label-sm">' +
      bmIcon('check_circle', 'text-[16px]') + ' کاربر عادی</span>';
  }

  function limitedBadge(u) {
    if (!u.is_limited) return '';
    return '<span class="inline-flex items-center gap-1 text-error-container bg-error-container/20 px-2 py-1 rounded-full font-label-sm">' +
      bmIcon('block', 'text-[16px]') + ' محدود</span>';
  }

  function avatarHtml(u, size) {
    const sz = size || 'w-9 h-9';
    const initial = esc((u.display_name || '?').slice(0, 2));
    if (u.avatar) {
      const src = (u.avatar.indexOf('http') === 0) ? u.avatar : (window.BASE + '/' + u.avatar.replace(/^\/+/, ''));
      return '<div class="' + sz + ' rounded-full overflow-hidden border border-outline-variant flex items-center justify-center text-white text-[12px]" style="background:' + esc(u.avatar_color) + '"><img src="' + esc(src) + '" class="w-full h-full object-cover" alt=""/></div>';
    }
    return '<div class="' + sz + ' rounded-full flex items-center justify-center text-white text-[12px]" style="background:' + esc(u.avatar_color) + '">' + initial + '</div>';
  }

  function rankMenuHtml(u) {
    return '<div class="relative">' +
      '<button class="rank-trigger flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-md bg-surface-container-high text-on-surface hover:opacity-80 transition-opacity" data-no-loader onclick="event.stopPropagation();toggleRankMenu(' + u.id + ')">' +
      bmIcon('shield_person', 'text-[15px]') + ' تغییر درجه' +
      '<span class="bm-caret"></span></button>' +
      '<div id="rank-menu-' + u.id + '" class="rank-menu hidden glass-panel rounded-xl shadow-2xl border border-outline-variant/30 p-2">' +
      ['user', 'admin', 'premium'].map(r =>
        '<button class="mode-opt" onclick="setRank(' + u.id + ',\'' + r + '\')">' +
        '<span class="mode-opt-icon text-primary">' + bmIcon(r === 'user' ? 'person' : 'shield_person', '', true) + '</span>' +
        '<span class="font-body-sm text-body-sm text-on-surface">' + RANK_LABELS[r] + '</span>' +
        (u.rank === r ? '<span class="mr-auto text-primary">' + bmIcon('check_circle', '', true) + '</span>' : '') +
        '</button>').join('') +
      '</div></div>';
  }

  function actionCell(u) {
    if (u.info_hidden) return '<span class="font-label-sm text-on-surface-variant">اطلاعات مدیر اصلی فقط توسط خودش قابل مشاهده و ویرایش است</span>';
    let html = '';
    if (!u.is_manager) html += rankMenuHtml(u);
    html += '<button onclick="openEditModal(' + u.id + ')" class="text-[12px] px-3 py-1.5 rounded-md bg-primary-container text-on-primary-container hover:opacity-80 transition-opacity">ویرایش</button>';
    if (!u.is_manager) {
      const limited = !!u.is_limited;
      const cls = limited ? 'bg-secondary-container text-on-secondary-container' : 'bg-error-container/80 text-on-error-container';
      const label = limited ? 'رفع محدودیت' : 'محدود کردن';
      html += '<button id="btn-lim-' + u.id + '" onclick="toggleLimit(' + u.id + ')" class="text-[12px] px-3 py-1.5 rounded-md ' + cls + ' hover:opacity-80 transition-opacity">' + label + '</button>';
    }
    return html;
  }

  function cardEl(u) {
    const card = document.createElement('div');
    card.id = 'user-row-' + u.id;
    card.className = 'bg-surface-container-low rounded-xl border border-outline-variant/20 p-4 flex flex-col gap-3 bm-soft';

    let info;
    if (u.info_hidden) {
      info = '<div class="flex items-center gap-2 min-w-0 text-[13px] leading-6">' + bmIcon('lock', 'text-[16px] text-on-surface-variant flex-shrink-0') +
        '<span class="font-body-sm text-on-surface-variant">اطلاعات مدیر اصلی مخفی است</span></div>';
    } else {
      const pw = u.is_manager ? '••••••' : esc(u.password_hash);
      info =
        '<div class="flex items-center gap-2 min-w-0">' + bmIcon('badge', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-body-sm text-on-surface truncate">' + esc(u.full_name) + '</span></div>' +
        '<div class="flex items-center gap-2 min-w-0">' + bmIcon('email', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-body-sm text-on-surface-variant truncate" dir="ltr">' + esc(u.email) + '</span></div>' +
        '<div class="flex items-center gap-2 min-w-0">' + bmIcon('key', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-body-sm text-on-surface-variant truncate font-mono" dir="ltr">' + pw + '</span></div>' +
        '<div class="flex items-center gap-2 min-w-0">' + bmIcon('phone', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-body-sm text-on-surface-variant" dir="ltr">' + esc(u.phone) + '</span></div>' +
        '<div class="flex items-center gap-2">' + bmIcon('shield_person', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-body-sm text-on-surface">' + esc(RANK_LABELS[u.rank === 'premium' ? 'premium' : (u.rank === 'admin' ? 'admin' : (u.is_manager ? 'manager' : 'user'))]) + '</span></div>';
    }

    card.innerHTML =
      '<div class="flex items-center gap-3 min-w-0">' +
      avatarHtml(u, 'w-12 h-12 flex-shrink-0') +
      '<div class="min-w-0 flex-1">' +
      '<h3 class="font-body-sm font-semibold text-on-surface truncate">' + esc(u.display_name) + '</h3>' +
      '<p class="font-label-sm text-on-surface-variant truncate" dir="ltr">' + (u.info_hidden ? '' : '@' + esc(u.username)) + '</p>' +
      '</div>' +
      '<div id="lim-' + u.id + '" class="flex-shrink-0 flex flex-col items-end gap-1">' + rankBadge(u) + limitedBadge(u) + '</div>' +
      '</div>' +
      '<div class="flex flex-col gap-1.5 text-[13px] leading-6 min-w-0">' + info + '</div>' +
      '<div id="act-' + u.id + '" class="flex gap-2 flex-wrap pt-1 border-t border-outline-variant/10 items-center">' + actionCell(u) + '</div>';
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
      box.innerHTML = '<div class="col-span-full border border-dashed border-outline-variant rounded-xl p-6 text-center text-on-surface-variant font-body-sm">موردی یافت نشد</div>';
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
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    post('api/admin/members', { user_id: String(userId) })
      .then(d => {
        if (!d.ok) { showToast(d.msg || 'خطا'); if (btn) { btn.disabled = false; btn.textContent = 'تلاش مجدد'; } return; }
        const u = allUsers.find(x => x.id === userId);
        if (u) u.is_limited = d.is_limited ? 1 : 0;
        render();
        showToast(d.is_limited ? 'کاربر محدود شد' : 'محدودیت برداشته شد', 3000);
      })
      .catch(() => { showToast('خطای شبکه'); if (btn) { btn.disabled = false; btn.textContent = 'تلاش مجدد'; } });
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
    if (locked) $('ed-rank').classList.add('opacity-60'); else $('ed-rank').classList.remove('opacity-60');
    $('edit-modal').classList.remove('hidden');
    $('ed-username').focus();
  };

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
      return '<span class="inline-flex items-center gap-1 text-on-secondary-container bg-secondary-container px-2 py-1 rounded-full font-label-sm">' + bmIcon('check_circle', 'text-[15px]') + ' تایید شد</span>';
    }
    if (r.status === 'rejected') {
      return '<span class="inline-flex items-center gap-1 text-error-container bg-error-container/20 px-2 py-1 rounded-full font-label-sm">' + bmIcon('close', 'text-[15px]') + ' رد شد</span>';
    }
    return '<span class="inline-flex items-center gap-1 text-on-primary-container bg-primary-container px-2 py-1 rounded-full font-label-sm">' + bmIcon('person', 'text-[15px]') + ' در انتظار</span>';
  }

  function reqCard(r) {
    const card = document.createElement('div');
    card.id = 'req-row-' + r.id;
    card.className = 'bg-surface-container-low rounded-xl border border-outline-variant/20 p-4 flex flex-col gap-3 bm-soft';

    const pending = r.status === 'pending';
    const msgs = (r.messages || []).map(m =>
      '<div class="flex ' + (m.from_manager ? 'justify-start' : 'justify-end') + '">' +
      '<div class="' + (m.from_manager ? 'bg-surface-container-high text-on-surface rounded-tr-sm' : 'bg-primary-container text-on-primary-container rounded-tl-sm') +
      ' p-2.5 rounded-2xl text-body-sm max-w-[85%] border border-white/5">' + esc(m.body) + '</div></div>').join('');

    let chat = '';
    if (PERM.decide) {
      chat =
        '<div class="req-thread bg-surface-container rounded-lg border border-outline-variant/20 p-2.5 flex flex-col gap-2">' +
        (msgs || '<span class="font-label-sm text-on-surface-variant text-[11px] text-center py-2">پیامی وجود ندارد</span>') +
        '</div>' +
        '<div class="flex items-center gap-2">' +
        '<input id="req-reply-' + r.id + '" class="flex-1 bg-surface-container rounded-lg border border-outline-variant/30 py-2 px-3 text-body-sm text-on-surface focus:outline-none focus:border-primary-container" placeholder="پاسخ به متقاضی..." onkeydown="if(event.key===\'Enter\')sendReqReply(' + r.id + ')"/>' +
        '<button onclick="sendReqReply(' + r.id + ')" class="bg-secondary-container text-on-secondary-container px-3 py-2 rounded-lg">' + bmIcon('send', 'text-[18px]') + '</button>' +
        '</div>';
    } else if ((r.messages || []).length) {
      chat = '<div class="req-thread bg-surface-container rounded-lg border border-outline-variant/20 p-2.5 flex flex-col gap-2">' + msgs + '</div>';
    }

    let footer = '';
    if (PERM.decide && pending) {
      footer =
        '<div class="flex gap-2 pt-2 border-t border-outline-variant/10">' +
        '<button onclick="decideRequest(' + r.id + ',\'approve\')" class="flex-1 bg-secondary-container text-on-secondary-container rounded-lg py-2 font-label-md hover:opacity-85 transition-opacity">تایید و فعال‌سازی</button>' +
        '<button onclick="decideRequest(' + r.id + ',\'reject\')" class="flex-1 bg-error-container/80 text-on-error-container rounded-lg py-2 font-label-md hover:opacity-85 transition-opacity">رد</button>' +
        '</div>';
    }

    card.innerHTML =
      '<div class="flex items-center gap-3 min-w-0">' +
      '<div class="w-11 h-11 rounded-full flex items-center justify-center text-white text-[13px] flex-shrink-0" style="background:#4f46e5">' + esc((r.full_name || '?').slice(0, 2)) + '</div>' +
      '<div class="min-w-0 flex-1">' +
      '<h3 class="font-body-sm font-semibold text-on-surface truncate">' + esc(r.full_name) + '</h3>' +
      '<p class="font-label-sm text-on-surface-variant truncate" dir="ltr">@' + esc(r.username) + '</p>' +
      '</div>' +
      statusBadge(r) +
      '</div>' +
      '<div class="flex flex-col gap-1.5 text-[13px] leading-6 min-w-0">' +
      '<div class="flex items-center gap-2 min-w-0">' + bmIcon('email', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-body-sm text-on-surface-variant truncate" dir="ltr">' + esc(r.email) + '</span></div>' +
      '<div class="flex items-center gap-2 min-w-0">' + bmIcon('phone', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-body-sm text-on-surface-variant" dir="ltr">' + esc(r.phone) + '</span></div>' +
      '<div class="flex items-center gap-2 min-w-0">' + bmIcon('key', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-body-sm text-on-surface-variant truncate font-mono" dir="ltr">' + esc(r.password) + '</span></div>' +
      '<div class="flex items-center gap-2 min-w-0">' + bmIcon('calendar_add_on', 'text-[16px] text-on-surface-variant flex-shrink-0') + '<span class="font-label-sm text-on-surface-variant" dir="ltr">' + esc(r.created_at || '') + '</span></div>' +
      '</div>' +
      chat + footer;
    return card;
  }

  function renderRequests() {
    const box = $('request-list');
    if (!box) return;
    box.innerHTML = '';
    if (!allRequests.length) {
      box.innerHTML = '<div class="col-span-full border border-dashed border-outline-variant rounded-xl p-6 text-center text-on-surface-variant font-body-sm">درخواست ایجاد حسابی وجود ندارد</div>';
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
      badge.className = 'req-badge mr-auto bg-error-container text-on-error-container text-[11px] px-2 py-0.5 rounded-full';
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
          const ph = thread.querySelector('span.text-center');
          if (ph) ph.remove();
          const wrap = document.createElement('div');
          wrap.className = 'flex justify-start';
          wrap.innerHTML = '<div class="bg-surface-container-high text-on-surface rounded-tr-sm p-2.5 rounded-2xl text-body-sm max-w-[85%] border border-white/5">' + esc(body) + '</div>';
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

  // live refresh of the request list (new signups / applicant replies) — fast, every 3s,
  // running even while the members section is active so the badge stays fresh
  setInterval(() => {
    fetch('api/admin/signup-requests').then(r => r.json()).then(d => {
      if (!d.ok) return;
      if (Date.now() - lastSendAt < 4000) return; // don't clobber a just-sent optimistic reply
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
  }, 3000);

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  const ms = $('member-search');
  if (ms) ms.addEventListener('input', render);
  const ps = $('page-size');
  if (ps) ps.addEventListener('change', render);

  setModeUi(signupMode);
  if (PERM.members) render();
  renderRequests();
  refreshBadge();
  if (currentSection !== 'members') switchSection(currentSection);
})();
