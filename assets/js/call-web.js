// assets/js/call-web.js — the call page's "web surface": a shared website box and a
// synced video box. Both are appended into #video-grid and always win the layout
// (biggest cell; optional full-stage mode). The site box is same-origin through
// /black-meet/site-proxy so scroll/click can genuinely be replayed for everyone.
(function () {
  'use strict';

  const I = window.INIT;
  const EV = window.BMEv;
  const $ = (id) => document.getElementById(id);
  const socket = () => window.BM_SOCKET;

  let web = null;              // authoritative server state for the active box
  let expanded = false;        // full-stage mode (per client, cosmetic)
  let modalKind = 'site';
  let applying = false;        // guard so relayed input never echoes back
  let frameBound = false;
  let lastOwnEmit = 0;

  function toast(msg) { window.showToast && window.showToast(msg); }

  // ---------- top menu ----------
  window.toggleWebMenu = function (e) {
    if (e) e.stopPropagation();
    const m = $('web-menu');
    if (!m) return;
    m.classList.toggle('hidden');
    if (!m.classList.contains('hidden')) {
      // anchor under the button, clamped to the viewport
      const btn = $('btn-web');
      const r = btn.getBoundingClientRect();
      const w = m.offsetWidth || 220;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
      m.style.left = left + 'px';
      m.style.top = (r.bottom + 8) + 'px';
    }
  };
  window.closeWebMenu = function () { const m = $('web-menu'); if (m) m.classList.add('hidden'); };

  // ---------- modal ----------
  window.openWebModal = function (kind) {
    modalKind = kind === 'video' ? 'video' : 'site';
    closeWebMenu();
    const m = $('web-modal');
    if (!m) return;
    $('web-modal-title').textContent = modalKind === 'video' ? 'پخش لینک ویدیو' : 'نمایش لینک سایت';
    $('web-modal-hint').textContent = modalKind === 'video'
      ? 'لینک آپارات، یوتیوب یا لینک مستقیم ویدیو (mp4/webm) را وارد کنید'
      : 'آدرس سایتی که می‌خواهید به همه نشان دهید را وارد کنید';
    $('web-url').value = web && web.kind === modalKind ? web.url : '';
    $('web-url').setAttribute('placeholder', modalKind === 'video' ? 'https://www.aparat.com/v/xxxx' : 'https://example.com');
    m.classList.remove('hidden');
    setTimeout(() => { const i = $('web-url'); if (i) i.focus(); }, 60);
  };
  window.closeWebModal = function () { const m = $('web-modal'); if (m) m.classList.add('hidden'); };
  window.submitWebModal = function () {
    const url = ($('web-url').value || '').trim();
    if (!url) { toast('لینک را وارد کنید'); return; }
    const s = socket();
    if (!s || !s.connected) { toast('اتصال زنده برقرار نیست'); return; }
    s.emit(EV.CALL_WEB_OPEN, { kind: modalKind, url }, (res) => {
      if (res && res.ok) closeWebModal();
    });
  };

  // ---------- admin rights ----------
  window.openWebAdmin = function () {
    if (!web) return;
    const m = $('web-admin');
    if (!m) return;
    renderWebAdmin();
    m.classList.remove('hidden');
  };
  window.closeWebAdmin = function () { const m = $('web-admin'); if (m) m.classList.add('hidden'); };

  function roster() {
    const list = (window.bmCallRoster && window.bmCallRoster()) || [];
    return list.filter((m) => m.status === 'approved' || m.status === undefined);
  }
  function chipRow(sel, all) {
    const box = document.createElement('div');
    box.className = 'flex flex-wrap gap-2';
    const mk = (id, label, on) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = String(id);
      b.className = 'px-3 py-1.5 rounded-full text-[12px] border transition ' + (on
        ? 'bg-primary text-on-primary border-primary'
        : 'bg-surface-container-highest text-on-surface-variant border-outline-variant/40 hover:text-on-surface');
      b.textContent = label + (on ? ' ✓' : '');
      b.onclick = () => {
        const on2 = b.classList.contains('bg-primary');
        b.classList.toggle('bg-primary', !on2);
        b.classList.toggle('text-on-primary', !on2);
        b.classList.toggle('border-primary', !on2);
        b.textContent = label + (!on2 ? ' ✓' : '');
      };
      box.appendChild(b);
    };
    mk('all', 'همه کاربران', all);
    roster().forEach((m) => mk(m.userId, m.name || ('کاربر ' + m.userId), !all && sel.indexOf(m.userId) !== -1));
    return box;
  }
  function renderWebAdmin() {
    const ctrlBox = $('web-admin-control');
    const viewBox = $('web-admin-view');
    const ctrlAll = !web || web.controlAll !== false;
    const viewAll = !web || web.viewersAll !== false;
    ctrlBox.innerHTML = '';
    ctrlBox.appendChild(chipRow((web && web.controllers) || [], ctrlAll));
    if (viewBox) {
      viewBox.innerHTML = '';
      viewBox.appendChild(chipRow((web && web.viewers) || [], viewAll));
      viewBox.parentElement.classList.toggle('hidden', !web || web.kind !== 'video');
    }
  }
  function pickedIds(container) {
    const chips = Array.from(container.querySelectorAll('button'));
    const allChip = chips.find((b) => b.dataset.id === 'all');
    const allOn = allChip && allChip.classList.contains('bg-primary');
    if (allOn) return 'all';
    return chips.filter((b) => b.dataset.id !== 'all' && b.classList.contains('bg-primary'))
      .map((b) => parseInt(b.dataset.id, 10)).filter(Number.isInteger);
  }
  window.applyWebAdmin = function () {
    const s = socket();
    if (!s) return;
    const msg = { control: pickedIds($('web-admin-control')) };
    if ($('web-admin-view') && !$('web-admin-view').parentElement.classList.contains('hidden')) {
      msg.view = pickedIds($('web-admin-view'));
    }
    s.emit(EV.CALL_WEB_RIGHTS, msg, () => { closeWebAdmin(); toast('تنظیمات اعمال شد'); });
  };
  window.removeWebBox = function () {
    const s = socket();
    if (!s) return;
    s.emit(EV.CALL_WEB_CLOSE, {}, () => toast('باکس حذف شد'));
  };
  window.toggleWebExpanded = function () {
    expanded = !expanded;
    renderWebBox();
    relayout();
  };

  function relayout() { window.bmCallRelayout && window.bmCallRelayout(); }

  function canControl() {
    if (!web) return false;
    if (web.controlAll !== false) return true;
    return (web.controllers || []).indexOf(I.me.id) !== -1;
  }
  function canView() {
    if (!web) return false;
    if (web.viewersAll !== false) return true;
    return (web.viewers || []).indexOf(I.me.id) !== -1;
  }

  // ---------- rendering ----------
  function headerHtml(kind, host, isAdmin) {
    const label = kind === 'video' ? 'ویدیو' : 'سایت';
    const lockNote = canControl() ? '' :
      `<span class="text-[11px] text-on-surface-variant flex items-center gap-1">${bmIcon('lock', 'text-[14px]', false)} فقط ادمین کنترل می‌کند</span>`;
    return `
      <div class="flex items-center gap-2 px-3 py-2 bg-surface-container-highest/90 backdrop-blur border-b border-white/10 shrink-0">
        ${bmIcon(kind === 'video' ? 'movie' : 'link', 'text-[18px] text-primary shrink-0')}
        <span class="font-label-md text-on-surface shrink-0">${label}</span>
        <span class="text-[12px] text-on-surface-variant truncate" dir="ltr">${escapeHtml(host || '')}</span>
        <div class="flex-1"></div>
        ${lockNote}
        <button type="button" onclick="toggleWebExpanded()" class="px-2.5 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface" title="${expanded ? 'کوچک‌نمایی' : 'تمام‌صفحه'}">
          ${bmIcon(expanded ? 'fullscreen_exit' : 'fullscreen', 'text-[16px]')}
        </button>
        ${isAdmin ? `<button type="button" onclick="openWebAdmin()" class="px-2.5 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface" title="تنظیمات دسترسی">${bmIcon('shield_person', 'text-[16px]')}</button>` : ''}
        ${isAdmin ? `<button type="button" onclick="removeWebBox()" class="px-2.5 py-1.5 rounded-lg bg-error-container text-on-error-container" title="حذف باکس">${bmIcon('close', 'text-[16px]')}</button>` : ''}
      </div>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderWebBox() {
    const old = $('web-box');
    if (!web || !canView()) { if (old) { old.remove(); relayout(); } return; }
    const isAdmin = !!(I.me.is_manager || I.me.is_admin);
    const kind = web.kind;

    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'web-box';
    box.className = 'web-box relative rounded-xl overflow-hidden border border-primary/40 shadow-lg bg-surface-container';
    box.innerHTML = `
      ${headerHtml(kind, web.host, isAdmin)}
      <div class="web-body relative flex-1 min-h-0 bg-black"></div>`;
    $('video-grid').insertBefore(box, $('video-grid').firstChild);

    const body = box.querySelector('.web-body');
    if (kind === 'site') mountSite(body);
    else mountVideo(body);

    applyExpanded();
    relayout();
  }

  function applyExpanded() {
    const box = $('web-box');
    if (!box) return;
    const grid = $('video-grid');
    if (!grid) return;
    Array.from(grid.children).forEach((el) => {
      if (el.id === 'web-box') return;
      if (expanded) {
        if (el.dataset.bmHidden !== '1') { el.dataset.bmPrevDisplay = el.style.display; el.dataset.bmHidden = '1'; }
        el.style.display = 'none';
      } else if (el.dataset.bmHidden === '1') {
        delete el.dataset.bmHidden;
        el.style.display = el.dataset.bmPrevDisplay || '';
      }
    });
    box.classList.toggle('web-expanded', expanded);
  }
  window.bmWebLayoutState = function () {
    const box = $('web-box');
    return { present: !!box, expanded };
  };
  window.bmWebOnLayout = function () { applyExpanded(); };

  // ---------- site box ----------
  function siteSrc() {
    return '/black-meet/site-proxy?u=' + encodeURIComponent(web.url);
  }

  function mountSite(body) {
    const frame = document.createElement('iframe');
    frame.id = 'web-frame';
    frame.setAttribute('title', 'shared site');
    frame.className = 'absolute inset-0 w-full h-full border-0 bg-white';
    frame.src = siteSrc();
    body.appendChild(frame);
    frame.addEventListener('load', () => { bindFrame(frame); });
    // some pages swap their document after load (client-side routing) — rebind cheaply
    [800, 2500, 6000].forEach((ms) => setTimeout(() => bindFrame(frame), ms));
    // same-origin: apply the last known position as soon as the doc is reachable
    const tryApply = () => {
      if (!web || !web.scroll) return;
      try { scrollToRatio(web.scroll.ratio); } catch (e) {}
    };
    frame.addEventListener('load', tryApply);
  }

  function docOf(frame) {
    try {
      const w = frame.contentWindow;
      const d = w && w.document;
      if (!d || !d.documentElement) return null;
      // cross-origin documents throw on access
      void d.body;
      return d;
    } catch (e) { return null; }
  }

  function scrollToRatio(ratio) {
    const frame = $('web-frame');
    if (!frame) return;
    const d = docOf(frame);
    if (!d) return;
    const de = d.documentElement;
    const max = Math.max(0, (de.scrollHeight || 0) - (frame.clientHeight || 0));
    applying = true;
    try { frame.contentWindow.scrollTo(0, (Number(ratio) || 0) * max); } catch (e) {}
    setTimeout(() => { applying = false; }, 120);
  }

  function send(kind, payload) {
    if (!canControl()) return;
    const s = socket();
    if (!s || !s.connected) return;
    s.emit(EV.CALL_WEB_SYNC, Object.assign({ kind }, payload));
  }

  // one binding per DOCUMENT (a page can swap its document after load)
  const boundDocs = new WeakSet();

  function bindFrame(frame) {
    const d = docOf(frame);
    if (!d) return;
    if (boundDocs.has(d)) return;
    boundDocs.add(d);
    try {
      frame.contentWindow.addEventListener('scroll', () => {
        if (applying || !canControl()) return;
        const now = Date.now();
        if (now - lastOwnEmit < 140) return;
        lastOwnEmit = now;
        const de = d.documentElement;
        const max = Math.max(1, (de.scrollHeight || 0) - (frame.clientHeight || 0));
        send('scroll', { ratio: (frame.contentWindow.pageYOffset || 0) / max });
      }, { passive: true });

      d.addEventListener('click', (e) => {
        if (applying || !canControl()) return;
        const de = d.documentElement;
        const a = e.target && e.target.closest && e.target.closest('a[href]');
        if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
          // a link is a NAVIGATION for everyone: let this tab follow it and tell the room
          let abs = a.getAttribute('href') || '';
          try { abs = new URL(abs, d.baseURI || web.url).href; } catch (err) {}
          if (/^https?:/i.test(abs)) send('navigate', { url: abs });
          return;
        }
        // normalize against the FULL document, so the receiver can convert back to
        // viewport coordinates with elementFromPoint (which is viewport-relative)
        const sw = Math.max(1, de.scrollWidth || 1);
        const sh = Math.max(1, de.scrollHeight || 1);
        send('click', { x: (e.pageX || 0) / sw, y: (e.pageY || 0) / sh });
      }, true);

      d.addEventListener('submit', (e) => { if (canControl()) e.preventDefault(); }, true);
    } catch (e) { /* frame vanished / not reachable */ }
  }

  // ---------- video box ----------
  function isDirectMedia(u) {
    return /\.(mp4|webm|ogv|ogg|mov|m4v|m3u8)(\?|#|$)/i.test(u);
  }

  function mountVideo(body) {
    const isEmbed = !!web.src && web.src !== web.url;
    if (!isEmbed && isDirectMedia(web.url)) {
      const v = document.createElement('video');
      v.id = 'web-video';
      v.src = web.url;
      v.controls = true;
      v.playsInline = true;
      v.className = 'absolute inset-0 w-full h-full bg-black';
      v.autoplay = true;
      body.appendChild(v);
      v.addEventListener('play', () => send('video', { cmd: 'play', t: v.currentTime }));
      v.addEventListener('pause', () => send('video', { cmd: 'pause', t: v.currentTime }));
      v.addEventListener('seeked', () => send('video', { cmd: 'seek', t: v.currentTime }));
      // keep late joiners in sync with the player that is already running
      setTimeout(() => {
        if (web && web.video && !v.paused) { applyVideoCmd(web.video); }
      }, 400);
      return;
    }
    const f = document.createElement('iframe');
    f.id = 'web-frame';
    f.setAttribute('title', 'shared video');
    f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    f.setAttribute('allowfullscreen', 'true');
    f.className = 'absolute inset-0 w-full h-full border-0 bg-black';
    let src = web.src || web.url;
    // youtube's postMessage command API needs enablejsapi=1
    if (/youtube\.com\/embed\//.test(src) && src.indexOf('enablejsapi') === -1) {
      src += (src.indexOf('?') === -1 ? '?' : '&') + 'enablejsapi=1&rel=0';
    }
    f.src = src;
    body.appendChild(f);
  }

  function ytCommand(cmd, t) {
    const f = $('web-frame');
    if (!f || !f.contentWindow || !/youtube\.com\/embed\//.test(f.src || '')) return;
    try {
      if (t != null) f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [Number(t) || 0, true] }), '*');
      f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: cmd, args: [] }), '*');
    } catch (e) {}
  }
  function applyVideoCmd(v) {
    if (!v) return;
    const el = $('web-video');
    if (el) {
      if (Math.abs((el.currentTime || 0) - (Number(v.t) || 0)) > 1.2) {
        try { el.currentTime = Number(v.t) || 0; } catch (e) {}
      }
      if (v.playing) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
      else el.pause();
      return;
    }
    if (v.playing) ytCommand('playVideo');
    else ytCommand('pauseVideo');
  }

  // ---------- socket hooks ----------
  window.bmWebState = function (d) {
    const prev = web;
    web = (d && d.web) || null;
    if (!web) {
      expanded = false;
      const box = $('web-box');
      if (box) box.remove();
      relayout();
      return;
    }
    renderWebBox();
    if (prev && prev.kind === web.kind && prev.url === web.url) {
      // same box re-announced (rights change): nothing else to do
      return;
    }
  };

  window.bmWebSync = function (d) {
    if (!web || !d) return;
    if (web.kind === 'site') {
      if (d.kind === 'scroll') scrollToRatio(d.ratio);
      else if (d.kind === 'navigate') {
        const frame = $('web-frame');
        if (!frame || !d.url) return;
        applying = true;
        try { frame.src = '/black-meet/site-proxy?u=' + encodeURIComponent(d.url); } catch (e) {}
        setTimeout(() => { applying = false; }, 400);
      } else if (d.kind === 'click') {
        const frame = $('web-frame');
        if (!frame) return;
        const doc = docOf(frame);
        if (!doc) return;
        applying = true;
        try {
          const w = frame.contentWindow;
          const de = doc.documentElement;
          // document-space ratio -> viewport space, clamped inside the visible area
          const vx = Math.max(0, Math.min((frame.clientWidth || 1) - 1,
            (Number(d.x) || 0) * (de.scrollWidth || 1) - (w.pageXOffset || 0)));
          const vy = Math.max(0, Math.min((frame.clientHeight || 1) - 1,
            (Number(d.y) || 0) * (de.scrollHeight || 1) - (w.pageYOffset || 0)));
          const el = doc.elementFromPoint(vx, vy);
          if (el && el.click) el.click();
        } catch (e) {}
        setTimeout(() => { applying = false; }, 120);
      }
    } else if (web.kind === 'video' && d.kind === 'video') {
      applyVideoCmd({ cmd: d.cmd, t: d.t, playing: d.cmd === 'play' });
    }
  };

  // ---------- boot ----------
  window.addEventListener('DOMContentLoaded', () => {
    const urlInput = $('web-url');
    if (urlInput) {
      urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitWebModal(); });
    }
    document.addEventListener('click', (e) => {
      const menu = $('web-menu');
      const btn = $('btn-web');
      if (menu && !menu.classList.contains('hidden') && (!btn || !btn.contains(e.target))) closeWebMenu();
    });
  });

  window.bmWebInit = function (initialWeb) {
    if (initialWeb) { web = initialWeb; renderWebBox(); }
  };
})();
