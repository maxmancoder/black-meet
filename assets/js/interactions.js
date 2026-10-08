// assets/js/interactions.js — Black Meet organic transitions
// 1) Soft loading overlay between page navigations
// 2) In-button loading spinner for action buttons (all pages except the live call page)
// 3) Adds .bm-soft class so hover/press states get squishy, fluid motion
(function () {
  'use strict';
  var doc = document;
  var skipPages = window.__BM_SKIP_BUTTON_LOADER || [];
  var isCallPage = skipPages.indexOf('call') !== -1 ||
    /(^|\/)(meeting|call\.php)$/i.test(location.pathname);

  // ---------- soft page-transition overlay ----------
  var overlay = null, overlayShown = 0;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = doc.createElement('div');
    overlay.id = 'bm-page-loader';
    overlay.className = 'bm-page-loader';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<div class="bm-dots"><i></i><i></i><i></i></div>';
    if (doc.body) doc.body.appendChild(overlay);
    else doc.addEventListener('DOMContentLoaded', function () { doc.body.appendChild(overlay); });
    return overlay;
  }
  function showOverlay() {
    ensureOverlay();
    overlayShown = Date.now();
    requestAnimationFrame(function () { overlay && overlay.classList.add('bm-show'); });
  }
  function hideOverlay() {
    if (!overlay) return;
    var wait = Math.max(0, 240 - (Date.now() - overlayShown)); // keep it smooth, never a flash
    setTimeout(function () { overlay && overlay.classList.remove('bm-show'); }, wait);
  }

  // ---------- button loading state ----------
  var EXCLUDE_IDS = ['bell-btn', 'sort-old', 'sort-new', 'btn-sidebar'];
  var lastBtn = null, lastArm = 0, activeFetch = 0;

  function excluded(btn) {
    return btn.hasAttribute('data-no-loader') ||
      EXCLUDE_IDS.indexOf(btn.id) !== -1 ||
      !!btn.closest('#emoji-picker, #member-menu, #notif-popup, .bm-no-loader');
  }
  function armButton(btn) {
    if (!btn || btn.disabled || excluded(btn)) return;
    clearNow();
    lastBtn = btn; lastArm = Date.now();
    btn.classList.add('bm-loading');
    // UI-only buttons (dropdowns, section switches...) fire no request:
    // drop the spinner as soon as nothing is in flight instead of waiting for the failsafe
    setTimeout(function () {
      if (activeFetch === 0 && lastBtn === btn) clearNow();
    }, 700);
  }
  function clearNow() {
    if (lastBtn) { lastBtn.classList.remove('bm-loading'); lastBtn = null; }
  }
  function tryClear() {
    if (activeFetch > 0 || !lastBtn) return;
    var held = Date.now() - lastArm;
    var wait = Math.max(0, 380 - held); // minimum organic hold
    setTimeout(function () { if (activeFetch === 0) clearNow(); }, wait);
  }
  // failsafe: never let a button stay stuck
  setInterval(function () { if (lastBtn && Date.now() - lastArm > 6000) clearNow(); }, 1000);
  // exposed for page scripts that swap views without navigation (login flow)
  window.__BMResetBtn = clearNow;

  // ---------- global click handling ----------
  doc.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (a) {
      var href = a.getAttribute('href');
      var realNav = href && href !== '#' && !/^(javascript:|mailto:|tel:)/i.test(a.href) &&
        a.target !== '_blank' && !a.hasAttribute('download') &&
        (a.origin === location.origin);
      if (realNav) { showOverlay(); return; }
      if (!isCallPage && a.hasAttribute('onclick')) { armButton(a); return; } // action-links (logout...)
      return;
    }
    if (!isCallPage) {
      var btn = e.target.closest ? e.target.closest('button') : null;
      if (btn) armButton(btn);
    }
  }, true);

  // ---------- fetch hook: clear the button loader when work settles ----------
  if (window.fetch) {
    var _fetch = window.fetch.bind(window);
    window.fetch = function () {
      activeFetch++;
      var done = function () {
        activeFetch = Math.max(0, activeFetch - 1);
        tryClear();
      };
      return _fetch.apply(null, arguments).then(
        function (r) { done(); return r; },
        function (err) { done(); throw err; }
      );
    };
  }

  // ---------- hide overlay when the new page is ready ----------
  window.addEventListener('pageshow', hideOverlay);
  doc.addEventListener('DOMContentLoaded', hideOverlay);
  window.addEventListener('load', hideOverlay);

  // ---------- squishy hover/press class on non-call pages ----------
  function soften(root) {
    if (isCallPage) return;
    // data-no-soft opts a button out of the squishy transform (e.g. dropdown
    // toggles that must only change colour, never scale)
    (root || doc).querySelectorAll('button:not(.bm-soft):not([data-no-soft]), .btn-primary:not(.bm-soft):not([data-no-soft]), .btn-secondary:not(.bm-soft):not([data-no-soft])')
      .forEach(function (el) { el.classList.add('bm-soft'); });
  }
  doc.addEventListener('DOMContentLoaded', function () { soften(); });
  if (window.MutationObserver) {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var n = muts[i].addedNodes;
        for (var j = 0; j < n.length; j++) {
          if (n[j].nodeType === 1) soften(n[j]);
        }
      }
    });
    doc.addEventListener('DOMContentLoaded', function () {
      mo.observe(doc.body, { childList: true, subtree: true });
    });
  }
})();
