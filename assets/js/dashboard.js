// assets/js/dashboard.js — dashboard UI chrome (home page only).
// Owns everything that is not data: toast, drawer, user menu, header search,
// greeting, confirm dialog, copy-to-clipboard and keyboard shortcuts.
// Loaded BEFORE home.js, which delegates its toasts to window.bmToast.
(function () {
  'use strict';
  var doc = document;
  var body = doc.body;

  function $(sel, root) { return (root || doc).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
  function el(id) { return doc.getElementById(id); }

  /* ------------------------------------------------------------------ toast */
  var toastEl = el('bm-toast');
  var toastIcon = el('bm-toast-ico');
  var toastMsg = el('bm-toast-msg');
  var toastTimer = null;
  var toastLeaveTimer = null;

  window.bmToast = function (msg, kind, ms) {
    if (!toastEl || !toastMsg) return;
    if (toastLeaveTimer) { clearTimeout(toastLeaveTimer); toastLeaveTimer = null; }
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    toastMsg.textContent = String(msg == null ? '' : msg);
    toastEl.classList.remove('is-leaving', 'is-error', 'is-info', 'is-success');
    if (kind === 'error') toastEl.classList.add('is-error');
    else if (kind === 'info') toastEl.classList.add('is-info');
    else toastEl.classList.add('is-success');

    if (toastIcon && window.setBMIcon) {
      window.setBMIcon(toastIcon, kind === 'error' ? 'error' : kind === 'info' ? 'info' : 'check_circle');
    }

    toastEl.hidden = false;
    // restart the entry animation
    toastEl.style.animation = 'none';
    void toastEl.offsetWidth;
    toastEl.style.animation = '';

    toastTimer = setTimeout(function () { window.bmToastHide(); }, ms || 3800);
  };

  window.bmToastHide = function () {
    if (!toastEl || toastEl.hidden) return;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    toastEl.classList.add('is-leaving');
    toastLeaveTimer = setTimeout(function () {
      toastEl.hidden = true;
      toastEl.classList.remove('is-leaving');
      toastLeaveTimer = null;
    }, 200);
  };

  if (toastEl) {
    var toastX = $('.dash-toast-x', toastEl);
    if (toastX) toastX.addEventListener('click', window.bmToastHide);
  }

  /* ----------------------------------------------------------- scroll lock */
  var lockCount = 0;
  function lockScroll(on) {
    lockCount = Math.max(0, lockCount + (on ? 1 : -1));
    body.classList.toggle('is-locked', lockCount > 0);
  }

  /* ---------------------------------------------------------------- drawer */
  var drawer = el('dash-drawer');
  var drawerLastFocus = null;

  function drawerOpen() {
    if (!drawer) return;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    $$('[data-drawer-open]').forEach(function (b) { b.setAttribute('aria-expanded', 'true'); });
    lockScroll(true);
    drawerLastFocus = doc.activeElement;
    var first = $('.dash-nav-item, button, a', drawer);
    if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 60);
  }

  function drawerClose() {
    if (!drawer || !drawer.classList.contains('is-open')) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    $$('[data-drawer-open]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    lockScroll(false);
    if (drawerLastFocus && drawerLastFocus.focus) {
      try { drawerLastFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    drawerLastFocus = null;
  }

  window.bmOpenDrawer = drawerOpen;
  window.bmCloseDrawer = drawerClose;

  $$('[data-drawer-open]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); drawerOpen(); });
  });
  if (drawer) {
    $$('[data-drawer-close]', drawer).forEach(function (b) {
      b.addEventListener('click', drawerClose);
    });
  }

  /* ------------------------------------------------------------- user menu */
  var userMenu = el('user-menu');
  var userMenuOpen = false;

  function placeUserMenu(trigger) {
    if (!userMenu || !trigger) return;
    userMenu.style.visibility = 'hidden';
    userMenu.hidden = false;
    var r = trigger.getBoundingClientRect();
    var w = userMenu.offsetWidth || 258;
    var h = userMenu.offsetHeight || 260;
    var rightGap = window.innerWidth - r.right;
    rightGap = Math.min(Math.max(8, rightGap), Math.max(8, window.innerWidth - w - 8));
    var top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) {
      var above = r.top - h - 8;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - h - 8);
    }
    userMenu.style.top = Math.round(top) + 'px';
    userMenu.style.right = Math.round(rightGap) + 'px';
    userMenu.style.left = 'auto';
    userMenu.style.visibility = '';
  }

  function openUserMenu(trigger) {
    if (!userMenu) return;
    userMenuOpen = true;
    userMenu.classList.remove('hidden');
    placeUserMenu(trigger);
    $$('[data-user-menu-trigger]').forEach(function (b) { b.setAttribute('aria-expanded', 'true'); });
    var first = $('.dash-menu-item', userMenu);
    if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 50);
  }

  window.bmCloseUserMenu = function (restoreFocus) {
    if (!userMenu || !userMenuOpen) return;
    userMenuOpen = false;
    userMenu.classList.add('hidden');
    $$('[data-user-menu-trigger]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    if (restoreFocus) {
      var t = $('[data-user-menu-trigger]');
      if (t && t.focus) { try { t.focus({ preventScroll: true }); } catch (e) {} }
    }
  };

  $$('[data-user-menu-trigger]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (userMenuOpen) window.bmCloseUserMenu(false);
      else openUserMenu(b);
    });
  });
  if (userMenu) {
    // position-only re-layout without toggling state
    window.addEventListener('resize', function () {
      if (!userMenuOpen) return;
      var t = $('[data-user-menu-trigger][aria-expanded="true"]');
      if (t) placeUserMenu(t);
    });
  }

  /* ------------------------------------------------------- notifications */
  function notificationsOpen() {
    var p = el('notif-popup');
    return !!(p && !p.classList.contains('hidden'));
  }

  /* --------------------------------------------------------- confirm dialog */
  var modal = el('bm-confirm');
  var modalTitle = el('bm-confirm-title');
  var modalBody = el('bm-confirm-body');
  var modalIcon = el('bm-confirm-ico');
  var modalYes = el('bm-confirm-yes');
  var modalNo = el('bm-confirm-no');
  var modalResolve = null;
  var modalLastFocus = null;

  function settleConfirm(value) {
    if (!modal || !modalResolve) return;
    var done = modalResolve;
    modalResolve = null;
    modal.classList.add('hidden');
    lockScroll(false);
    if (modalLastFocus && modalLastFocus.focus) {
      try { modalLastFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    modalLastFocus = null;
    done(value);
  }

  window.bmConfirm = function (opts) {
    opts = opts || {};
    if (!modal || !modalYes) return Promise.resolve(window.confirm(opts.body || 'مطمئن هستید؟'));
    if (modalResolve) settleConfirm(false);

    modalTitle.textContent = opts.title || 'تایید';
    modalBody.textContent = opts.body || '';
    modalYes.textContent = opts.confirmText || 'تایید';
    if (modalNo) modalNo.textContent = opts.cancelText || 'انصراف';
    modalYes.classList.toggle('dash-btn-danger', !!opts.danger);
    modalYes.classList.toggle('dash-btn-solid', !opts.danger);
    if (modalIcon && window.setBMIcon) window.setBMIcon(modalIcon, opts.danger ? 'error' : 'info');
    if (modalNo) modalNo.classList.toggle('dash-btn-ghost', true);

    modalLastFocus = doc.activeElement;
    modal.classList.remove('hidden');
    lockScroll(true);
    setTimeout(function () {
      (opts.danger ? modalNo || modalYes : modalYes).focus({ preventScroll: true });
    }, 50);

    return new Promise(function (resolve) { modalResolve = resolve; });
  };

  if (modalYes) modalYes.addEventListener('click', function () { settleConfirm(true); });
  if (modalNo) modalNo.addEventListener('click', function () { settleConfirm(false); });
  if (modal) {
    var bd = $('[data-confirm-cancel]', modal);
    if (bd) bd.addEventListener('click', function () { settleConfirm(false); });
  }

  /* ------------------------------------------------------------- clipboard */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      body.appendChild(ta);
      ta.select();
      var ok = doc.execCommand('copy');
      body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  window.copyMeetLink = function (btn) {
    var link = btn && btn.getAttribute ? btn.getAttribute('data-link') : '';
    if (!link) return window.bmToast('لینکی برای کپی پیدا نشد', 'error');
    Promise.resolve(copyText(link)).then(function (ok) {
      if (ok === false) return window.bmToast('کپی خودکار ممکن نشد؛ لینک را دستی بردار', 'error');
      window.bmToast('لینک تماس کپی شد', 'success');
      if (btn && btn.classList) {
        btn.classList.add('is-copied');
        setTimeout(function () { btn.classList.remove('is-copied'); }, 1200);
      }
    });
  };

  /* -------------------------------------------------------------- greeting */
  var greetEl = $('[data-greeting]');
  if (greetEl) {
    var hour = new Date().getHours();
    greetEl.textContent =
      hour < 5 ? 'شب بخیر' :
      hour < 12 ? 'صبح بخیر' :
      hour < 17 ? 'ظهر بخیر' :
      hour < 21 ? 'عصر بخیر' : 'شب بخیر';
  }

  /* ---------------------------------------------------------------- search */
  var searchInput = el('recent-search');

  // Persian/Arabic normalisation so "ي"/"ك" and ZWNJ never break a match
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

  function applySearch(q) {
    var query = norm(q);
    var cards = $$('[data-recent-card]');
    var shown = 0;
    cards.forEach(function (card) {
      var hay = norm(card.getAttribute('data-title') || '');
      var hit = !query || hay.indexOf(query) !== -1;
      card.classList.toggle('hidden', !hit);
      if (hit) shown++;
    });
    var nomatch = el('recent-nomatch');
    if (nomatch) nomatch.hidden = !(query && cards.length > 0 && shown === 0);
  }

  if (searchInput) searchInput.addEventListener('input', function () { applySearch(searchInput.value); });

  window.bmFocusSearch = function () {
    if (!searchInput) return;
    var recent = $('.dash-recent');
    if (recent) recent.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(function () {
      try { searchInput.focus({ preventScroll: true }); searchInput.select(); } catch (e) { searchInput.focus(); }
    }, 120);
  };

  window.bmFocusJoin = function () {
    var input = el('join-input');
    if (!input) return;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(function () {
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }, 140);
  };

  /* ------------------------------------------------------- header shadow + kbd */
  var header = el('dash-header');
  function paintHeader() {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 3);
  }
  window.addEventListener('scroll', paintHeader, { passive: true });
  paintHeader();

  /* ------------------------------------------------------------ focus trap */
  function trapIn(container, e) {
    if (!container || e.key !== 'Tab') return;
    var focusables = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', container)
      .filter(function (n) { return n.offsetWidth > 0 || n.offsetHeight > 0; });
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    var active = doc.activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  doc.addEventListener('keydown', function (e) {
    // a real dialog keeps the keyboard inside it
    if (modal && modalResolve) trapIn(modal, e);
    else if (drawer && drawer.classList.contains('is-open')) trapIn($('.dash-drawer-panel', drawer), e);

    var k = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'k') {
      e.preventDefault();
      window.bmFocusSearch();
      return;
    }
    if (k === 'escape') {
      if (modalResolve) { settleConfirm(false); return; }
      if (userMenuOpen) { window.bmCloseUserMenu(true); return; }
      if (drawer && drawer.classList.contains('is-open')) { drawerClose(); return; }
      if (notificationsOpen() && window.toggleNotifications) { window.toggleNotifications(); }
    }
  });

  /* ------------------------------------------------------ outside-click close */
  doc.addEventListener('pointerdown', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    if (userMenuOpen && !t.closest('#user-menu') && !t.closest('[data-user-menu-trigger]')) {
      window.bmCloseUserMenu(false);
    }
    if (notificationsOpen() && !t.closest('#notif-popup') && !t.closest('#bell-btn') && !t.closest('[data-notif-open]')) {
      if (window.toggleNotifications) window.toggleNotifications();
    }
  }, true);

  // keep aria-expanded in sync no matter who opened/closed the popup
  var pop = el('notif-popup');
  var bell = el('bell-btn');
  if (pop && bell && window.MutationObserver) {
    new window.MutationObserver(function () {
      bell.setAttribute('aria-expanded', pop.classList.contains('hidden') ? 'false' : 'true');
    }).observe(pop, { attributes: true, attributeFilter: ['class'] });
  }
})();
