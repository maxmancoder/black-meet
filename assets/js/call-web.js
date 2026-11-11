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
  let modalMode = 'link';
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
    modalKind = kind === 'video' ? 'video'
      : (kind === 'audio' ? 'audio' : (kind === 'file' ? 'file' : 'site'));
    closeWebMenu();
    const m = $('web-modal');
    if (!m) return;
    const badge = $('web-modal-badge');
    const tone = {
      video: 'bg-gradient-to-br from-tertiary-container to-secondary-container text-on-tertiary-container shadow-tertiary/20',
      audio: 'bg-gradient-to-br from-secondary-container to-primary-container text-on-secondary-container shadow-secondary/20',
      file: 'bg-gradient-to-br from-primary-container to-tertiary-container text-on-primary-container shadow-primary/20',
      site: 'bg-gradient-to-br from-primary-container to-secondary-container text-on-primary-container shadow-primary/20',
    }[modalKind];
    const ico = { video: 'movie', audio: 'volume_up', file: 'upload', site: 'link' }[modalKind];
    if (badge) {
      badge.className = 'w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg ' + tone;
      badge.innerHTML = bmIcon(ico, 'text-[26px]', false);
    }
    $('web-modal-title').textContent = modalKind === 'video' ? 'پخش لینک ویدیو'
      : (modalKind === 'audio' ? 'پخش لینک صدا'
        : (modalKind === 'file' ? 'آپلود فایل برای همه' : 'نمایش لینک سایت'));
    $('web-modal-hint').textContent = modalKind === 'video'
      ? 'لینک آپارات، یوتیوب یا لینک مستقیم ویدیو (mp4/webm) را وارد کنید'
      : (modalKind === 'audio'
        ? 'لینک مستقیم یک فایل صوتی یا آهنگ (mp3 / m4a / ogg) را وارد کنید'
        : (modalKind === 'file'
          ? 'فایلی که می‌خواهید به همه‌ی اعضای این جلسه نشان دهید را انتخاب کنید'
          : 'آدرس سایتی که می‌خواهید به همه نشان دهید را وارد کنید'));
    // 'link' = the URL field, 'upload' = the picker. site is link-only, audio/video have both.
    const canUpload = (modalKind === 'file' || modalKind === 'audio' || modalKind === 'video');
    modalMode = (modalKind === 'file') ? 'upload' : 'link';
    $('web-url').parentElement.classList.toggle('hidden', modalMode !== 'link');
    $('web-file-zone').classList.toggle('hidden', modalMode !== 'upload');
    const tabs = $('web-mode-tabs');
    if (tabs) {
      tabs.classList.toggle('hidden', !canUpload);
      const lu = tabs.querySelector('[data-mode="link"]');
      const uf = tabs.querySelector('[data-mode="upload"]');
      if (lu) lu.className = 'flex-1 py-2 rounded-xl text-[12px] font-medium transition-colors ' +
        (modalMode === 'link' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-highest');
      if (uf) uf.className = 'flex-1 py-2 rounded-xl text-[12px] font-medium transition-colors ' +
        (modalMode === 'upload' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-highest');
    }
    const noteEl = $('web-note');
    if (noteEl) noteEl.classList.toggle('hidden', modalMode !== 'upload');
    $('web-url').value = web && web.kind === modalKind && modalMode === 'link' ? web.url : '';
    $('web-url').setAttribute('placeholder',
      modalKind === 'video' ? 'https://www.aparat.com/v/xxxx'
        : (modalKind === 'audio' ? 'https://example.com/music.mp3' : 'https://example.com'));
    const hintEl = $('web-upload-hint');
    if (hintEl && modalMode === 'upload') {
      hintEl.textContent = modalKind === 'audio'
        ? 'فقط فایل صوتی یا آهنگ (mp3 / m4a / ogg / wav)'
        : (modalKind === 'video'
          ? 'فقط فایل ویدیویی، حداکثر ۲۰ مگابایت (mp4 / webm)'
          : 'تصویر، PDF، متن، ویدیو، صدا و… — حداکثر ۵۰ مگابایت');
    }
    const sw = $('web-follow');
    if (sw) sw.checked = followOn();
    $('web-submit').textContent = modalMode === 'upload' ? 'بارگذاری و نمایش' : 'تایید';
    m.classList.remove('hidden');
    setTimeout(() => {
      if (modalMode === 'upload') { const d = $('web-file-drop'); if (d) d.click(); }
      else { const i = $('web-url'); if (i) i.focus(); }
    }, 60);
  };
  // switch between "paste a link" and "upload a file" inside the same dialog
  window.setWebMode = function (mode) {
    if (mode === modalMode) return;
    modalMode = (mode === 'upload') ? 'upload' : 'link';
    $('web-url').parentElement.classList.toggle('hidden', modalMode !== 'link');
    $('web-file-zone').classList.toggle('hidden', modalMode !== 'upload');
    const noteEl = $('web-note');
    if (noteEl) noteEl.classList.toggle('hidden', modalMode !== 'upload');
    const tabs = $('web-mode-tabs');
    if (tabs) {
      const lu = tabs.querySelector('[data-mode="link"]');
      const uf = tabs.querySelector('[data-mode="upload"]');
      if (lu) lu.className = 'flex-1 py-2 rounded-xl text-[12px] font-medium transition-colors ' +
        (modalMode === 'link' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-highest');
      if (uf) uf.className = 'flex-1 py-2 rounded-xl text-[12px] font-medium transition-colors ' +
        (modalMode === 'upload' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-highest');
    }
    $('web-submit').textContent = modalMode === 'upload' ? 'بارگذاری و نمایش' : 'تایید';
  };
  window.closeWebModal = function () { const m = $('web-modal'); if (m) m.classList.add('hidden'); };
  window.submitWebModal = function () {
    if (modalMode === 'upload') return uploadWebFile();
    const url = ($('web-url').value || '').trim();
    if (!url) { toast('لینک را وارد کنید'); return; }
    const s = socket();
    if (!s || !s.connected) { toast('اتصال زنده برقرار نیست'); return; }
    const sw = $('web-follow');
    s.emit(EV.CALL_WEB_OPEN, { kind: modalKind, url, follow: !sw || sw.checked }, (res) => {
      if (res && res.ok) closeWebModal();
    });
  };

  // ---------- upload ----------
  let pickedFile = null;
  window.clearWebFile = function () {
    pickedFile = null;
    const inp = $('web-file-input');
    if (inp) inp.value = '';
    const card = $('web-file-card');
    if (card) { card.classList.add('hidden'); card.classList.remove('flex'); }
    $('web-file-bar') && $('web-file-bar').classList.add('hidden');
    const d = $('web-file-drop');
    if (d) d.classList.remove('hidden');
  };
  function faSize(bytes) {
    const n = Number(bytes) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' مگابایت';
    if (n >= 1024) return Math.round(n / 1024) + ' کیلوبایت';
    return n + ' بایت';
  }
  // Persian digits for the counters (the UI is Persian RTL everywhere else)
  function faNum(n) {
    return String(Number(n) || 0).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
  }
  // the random id of a shared file, taken from its served URL
  function fileIdOf() {
    const u = String((web && web.url) || '');
    const m = u.match(/call-file\/([a-f0-9]{16,64})/i);
    return m ? m[1] : '';
  }
  function pickWebFile(f) {
    if (!f) return;
    const AUDIO = /^audio\//i;
    const VIDEO = /^video\//i;
    const maxVideo = 20 * 1024 * 1024;
    const maxAll = window.BM_CALL_FILE_MAX || (50 * 1024 * 1024);
    // the dialog knows which kind of file this box is for
    if (modalKind === 'audio' && !AUDIO.test(f.type)) { toast('برای این بخش فقط فایل صوتی یا آهنگ می‌توانید آپلود کنید'); return; }
    if (modalKind === 'video') {
      if (!VIDEO.test(f.type)) { toast('برای این بخش فقط فایل ویدیویی می‌توانید آپلود کنید'); return; }
      if (f.size > maxVideo) { toast('حجم ویدیو باید کمتر از ۲۰ مگابایت باشد'); return; }
    }
    if (f.size > maxAll) { toast('حجم فایل بیش از ' + faSize(maxAll) + ' است'); return; }
    pickedFile = f;
    const card = $('web-file-card');
    const drop = $('web-file-drop');
    if (drop) drop.classList.add('hidden');
    if (card) {
      card.classList.remove('hidden');
      card.classList.add('flex');
      $('web-file-name').textContent = f.name;
      $('web-file-size').textContent = faSize(f.size);
    }
  }
  function uploadWebFile() {
    if (!pickedFile) { toast('اول یک فایل انتخاب کنید'); return; }
    const s = socket();
    if (!s || !s.connected) { toast('اتصال زنده برقرار نیست'); return; }
    const bar = $('web-file-bar');
    const prog = $('web-file-prog');
    const msg = $('web-file-msg');
    const btn = $('web-submit');
    if (bar) bar.classList.remove('hidden');
    if (prog) prog.style.width = '15%';
    if (msg) msg.textContent = 'در حال ارسال…';
    if (btn) btn.disabled = true;

    const room = (I.meeting && I.meeting.room) || (I.room || '');
    const fd = new FormData();
    fd.append('file', pickedFile);
    fd.append('room', room);
    // the API validates CSRF from the BODY (req.body.csrf), so it has to be in the form too
    fd.append('csrf', window.CSRF || '');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', (window.BASE || '/black-meet') + '/api/call/file');
    xhr.setRequestHeader('X-CSRF-Token', window.CSRF || '');
    xhr.upload.onprogress = (ev) => {
      if (prog && ev.lengthComputable) prog.style.width = Math.round(15 + (ev.loaded / ev.total) * 60) + '%';
    };
    xhr.onload = () => {
      if (prog) prog.style.width = '100%';
      let d = {};
      try { d = JSON.parse(xhr.responseText); } catch (e) {}
      if (btn) btn.disabled = false;
      if (xhr.status !== 200 || !d.ok || !d.file) {
        if (msg) msg.textContent = (d && d.msg) || 'بارگذاری انجام نشد';
        toast((d && d.msg) || 'بارگذاری فایل انجام نشد');
        return;
      }
      if (msg) msg.textContent = 'آپلود شد — در حال نمایش به همه…';
      const sw = $('web-follow');
      s.emit(EV.CALL_WEB_OPEN, {
        // `kind` = which box, `mode` = that a call-file is shown as audio/video/file
        kind: modalKind,
        mode: modalKind === 'file' ? 'file' : modalKind,
        url: d.file.url,
        follow: !sw || sw.checked,
      }, (res) => {
        closeWebModal();
        clearWebFile();
        if (res && res.ok) toast('فایل برای همه‌ی اعضا نمایش داده شد');
      });
    };
    xhr.onerror = () => {
      if (btn) btn.disabled = false;
      if (msg) msg.textContent = 'ارتباط برقرار نشد';
      toast('ارتباط برقرار نشد');
    };
    xhr.send(fd);
  }
  window.pickWebFile = pickWebFile;

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
  // Opens the downloaders window for the file currently in the box. The page is
  // login-gated and member-gated on the server; we only pass the room + file id.
  window.openFileDownloaders = function () {
    const id = fileIdOf();
    if (!id) { toast('فایلی برای نمایش وجود ندارد'); return; }
    const base = (window.BASE || '/black-meet').replace(/\/$/, '');
    const url = base + '/file-downloads?room=' + encodeURIComponent(fileRoom())
      + '&id=' + encodeURIComponent(id);
    window.open(url, '_blank', 'noopener');
  };
  // live counter pushed by the server whenever somebody really downloads the file
  window.bmWebDownload = function (d) {
    if (!d) return;
    const id = String(d.fileId || '');
    if (!id || id !== fileIdOf()) return;      // another file's news
    if (web) web.downloads = Number(d.total) || 0;
    const num = $('web-dl-num');
    if (num) num.textContent = faNum(web ? web.downloads : 0);
    const btn = $('web-dl-count');
    if (btn) {
      btn.classList.add('ring-1', 'ring-primary/60');
      setTimeout(() => btn.classList.remove('ring-1', 'ring-primary/60'), 900);
    }
  };
  window.toggleWebExpanded = function () {
    if (expanded) { window.bmExitMaximize && window.bmExitMaximize(); return; }
    // the whole-viewport overlay lives in call.js (it also handles the control bar)
    if (window.toggleMaximizeWeb) { window.toggleMaximizeWeb(); return; }
    expanded = true;
    renderWebBox();
    relayout();
  };
  window.toggleWebMaximize = window.toggleWebExpanded;

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
    const label = kind === 'video' ? 'ویدیو' : (kind === 'audio' ? 'صدا' : (kind === 'file' ? 'فایل' : 'سایت'));
    const icon = kind === 'video' ? 'movie' : (kind === 'audio' ? 'volume_up' : (kind === 'file' ? 'description' : 'link'));
    const lockNote = canControl() ? '' :
      `<span class="text-[11px] text-on-surface-variant flex items-center gap-1">${bmIcon('lock', 'text-[14px]', false)} فقط ادمین کنترل می‌کند</span>`;
    // a file box also offers an explicit download, so a viewer can always keep it
    const dl = kind === 'file' && web && web.url
      ? `<a href="${escapeHtml(web.url)}?room=${encodeURIComponent(fileRoom())}&download=1" target="_blank" rel="noopener" class="px-2.5 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface" title="دانلود فایل">${bmIcon('download', 'text-[16px]')}</a>` : '';
    // how many people have downloaded this file, and WHO they are — the owner asked for a
    // visible counter that opens the list of downloaders in a new window
    const dlCount = kind === 'file'
      ? `<button type="button" id="web-dl-count" onclick="openFileDownloaders()"
                class="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface shrink-0"
                title="تعداد دانلود — فهرست دانلودکنندگان">
           ${bmIcon('groups', 'text-[15px]')}
           <span id="web-dl-num">${faNum(Number(web && web.downloads) || 0)}</span>
         </button>` : '';
    return `
      <div class="web-head flex items-center gap-2 px-3 py-2 bg-surface-container-highest/90 backdrop-blur border-b border-white/10 shrink-0">
        ${bmIcon(icon, 'text-[18px] text-primary shrink-0')}
        <span class="font-label-md text-on-surface shrink-0">${label}</span>
        <span class="text-[12px] text-on-surface-variant truncate" dir="auto" title="${escapeHtml(host || '')}">${escapeHtml(host || '')}</span>
        ${kind === 'file' && web && web.size ? `<span class="text-[11px] text-on-surface-variant shrink-0">${faSize(web.size)}</span>` : ''}
        <div class="flex-1"></div>
        ${lockNote}
        ${dlCount}
        ${dl}
        <button type="button" onclick="toggleWebMaximize()" class="px-2.5 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface" title="تمام‌صفحه">
          ${bmIcon((window.bmIsMaximized && window.bmIsMaximized()) ? 'fullscreen_exit' : 'fullscreen', 'text-[16px]')}
        </button>
        ${isAdmin ? `<button type="button" onclick="openWebAdmin()" class="px-2.5 py-1.5 rounded-lg bg-surface-container-highest hover:bg-surface-bright text-on-surface" title="تنظیمات دسترسی">${bmIcon('shield_person', 'text-[16px]')}</button>` : ''}
        ${isAdmin ? `<button type="button" onclick="removeWebBox()" class="px-2.5 py-1.5 rounded-lg bg-error-container text-on-error-container" title="حذف باکس">${bmIcon('close', 'text-[16px]')}</button>` : ''}
      </div>`;
  }

  // the room id is needed to read a shared file: it is only ever readable by members
  function fileRoom() {
    return (I.meeting && I.meeting.room) || (I.room || '');
  }
  // a call-file is served by us and gated by ?room=…; leave remote URLs untouched
  function withRoom(u) {
    const s = String(u || '');
    if (s.indexOf('/black-meet/call-file/') !== 0) return s;
    return s + (s.indexOf('?') === -1 ? '?' : '&') + 'room=' + encodeURIComponent(fileRoom());
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
    box.className = 'web-box web-kind-' + kind + ' relative rounded-xl overflow-hidden border border-primary/40 shadow-lg bg-surface-container';
    box.innerHTML = `
      ${headerHtml(kind, web.host, isAdmin)}
      <div class="web-body relative flex-1 min-h-0 bg-black"></div>
      ${kind === 'video' ? videoControlsMarkup() : ''}`;
    $('video-grid').insertBefore(box, $('video-grid').firstChild);

    const body = box.querySelector('.web-body');
    if (kind === 'site') mountSite(body);
    else if (kind === 'file') mountFile(body);
    else if (kind === 'audio') {
      mountAudio(body);
      const hint = $('web-a-hint');
      if (!canControl() && hint) hint.textContent = 'فقط ادمین می‌تواند این صدا را کنترل کند';
    } else {
      mountVideo(body);
      const play = $('web-v-play');
      const seek = $('web-v-seek');
      if (!canControl()) {
        if (play) { play.disabled = true; play.classList.add('opacity-40', 'cursor-not-allowed'); }
        if (seek) { seek.disabled = true; seek.classList.add('opacity-40'); }
      }
      paintControls();
    }

    applyExpanded();
    relayout();
  }

  // The box's "full screen" is the same full-viewport overlay every tile uses (call.js), so
// there is no second "expanded" layout here any more: the box is just another grid cell.
  function applyExpanded() {
    const box = $('web-box');
    if (!box) { restoreTiles(); return; }
    box.classList.remove('web-expanded');
  }
  function restoreTile(el) {
    if (!el || el.dataset.bmHidden !== '1') return;
    delete el.dataset.bmHidden;
    el.style.display = el.dataset.bmPrevDisplay || '';
    delete el.dataset.bmPrevDisplay;
  }
  function restoreTiles() {
    const grid = $('video-grid');
    if (!grid) return;
    Array.from(grid.children).forEach(restoreTile);
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
    // same-origin: re-apply the room's position whenever the document (re)loads —
    // a proxied page can grow for seconds after the first paint
    const tryApply = () => {
      if (lastRatio > 0) scrollToRatio(lastRatio, true);
      else if (web && web.scroll) applyScrollNow(web.scroll.ratio);
    };
    frame.addEventListener('load', tryApply);
    [700, 1600, 3200, 5200].forEach((ms) => setTimeout(tryApply, ms));
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

  // The last scroll position we know about. Proxied pages can take seconds to finish
  // loading, so a scroll that arrives while the receiver is still parsing would be lost —
  // we keep the ratio and re-apply it until the document is tall enough to move.
  //
  // IMPORTANT (the "everyone jumps to the bottom first" bug): the position must be applied
  // INSTANTLY. The old code asked for `behavior:'smooth'` and re-issued it every 450 ms,
  // and a proxied page often carries its own `scroll-behavior: smooth`; the two animations
  // fought, the receiver relayed its own in-flight scroll back, and everyone bounced
  // between the top/bottom of the page before settling on the sender's spot.
  let lastRatio = 0;
  let scrollRetry = null;
  let scrollTries = 0;
  let applyingUntil = 0;      // ignore our own scroll events for this long
  function suppressEcho(ms) { applyingUntil = Math.max(applyingUntil, Date.now() + (ms || 700)); }
  function isApplying() { return applying || Date.now() < applyingUntil; }

  // instant, and immune to a `scroll-behavior: smooth` declared by the proxied page
  function jumpTop(frame, d, top) {
    const de = d.documentElement;
    const body = d.body;
    const prevDe = de ? de.style.scrollBehavior : '';
    const prevBody = body ? body.style.scrollBehavior : '';
    if (de) de.style.scrollBehavior = 'auto';
    if (body) body.style.scrollBehavior = 'auto';
    try {
      const w = frame.contentWindow;
      if (w && typeof w.scrollTo === 'function') {
        try { w.scrollTo({ top: top, left: 0, behavior: 'instant' }); }
        catch (e) { w.scrollTo(0, top); }
      }
    } catch (e) { /* frame gone */ }
    if (de) de.style.scrollBehavior = prevDe;
    if (body) body.style.scrollBehavior = prevBody;
  }

  function scrollToRatio(ratio, retry) {
    const frame = $('web-frame');
    if (!frame) return;
    const d = docOf(frame);
    if (!d) { if (retry) scheduleScroll(ratio); return; }
    const de = d.documentElement;
    const max = Math.max(0, (de.scrollHeight || 0) - (frame.clientHeight || 0));
    const top = Math.max(0, clamp01(ratio) * max);
    // the document is still growing: nothing to scroll to yet, try again shortly
    if (max <= 1 && retry && scrollTries < 24) { scheduleScroll(ratio); return; }
    applying = true;
    suppressEcho(700);
    jumpTop(frame, d, top);
    setTimeout(() => { applying = false; }, 60);
    if (retry) {
      // one settle pass: if the page grew while we moved, correct it — instantly, and
      // without re-sending anything (transient jumps to the wrong place are exactly what
      // the owner saw)
      const want = Math.abs(top - (frame.contentWindow.pageYOffset || 0));
      if (want > 4 && scrollTries < 24) {
        scrollTries += 1;
        scheduleScroll(ratio, 220);
      } else {
        scrollTries = 0;
        clearTimeout(scrollRetry);
      }
    }
  }
  function scheduleScroll(ratio, delay) {
    clearTimeout(scrollRetry);
    scrollRetry = setTimeout(() => scrollToRatio(ratio, true), delay || 300);
  }
  function applyScrollNow(ratio) {
    // clamp: a bogus ratio (an old pixel value relayed by a stale document) must never
    // be able to teleport the room to the bottom of the page
    lastRatio = clamp01(ratio);
    scrollTries = 0;
    scrollToRatio(lastRatio, true);
  }

  function send(kind, payload) {
    if (!canControl()) return;
    // "دسترسی همزمان" off -> everyone drives their own copy, nothing is relayed
    if (!followOn()) return;
    const s = socket();
    if (!s || !s.connected) return;
    // volatile: a stale scroll/click must be DROPPED, never queued behind a slow link
    // (that queueing is what made the other side lag seconds behind the admin)
    const msg = Object.assign({ kind }, payload);
    try { s.volatile.emit(EV.CALL_WEB_SYNC, msg); }
    catch (e) { s.emit(EV.CALL_WEB_SYNC, msg); }
  }
  function followOn() {
    return !web || web.follow !== false;
  }
  window.setWebFollow = function (on) {
    const s = socket();
    if (!s || !s.connected) return;
    s.emit(EV.CALL_WEB_FOLLOW, { on: !!on });
  };

  // one binding per DOCUMENT (a page can swap its document after load)
  const boundDocs = new WeakSet();

  // keep pushing our scroll position for a moment so receivers converge on it
  let resendTimers = [];
  function clamp01(n) { return Math.min(1, Math.max(0, Number(n) || 0)); }
  function currentRatio(frame) {
    try {
      const d = docOf(frame);
      if (!d) return null;
      const max = Math.max(1, (d.documentElement.scrollHeight || 0) - (frame.clientHeight || 0));
      return clamp01((frame.contentWindow.pageYOffset || 0) / max);
    } catch (e) { return null; }
  }
  function scheduleScrollResend(frame) {
    resendTimers.forEach(clearTimeout);
    resendTimers = [500, 1500, 3000].map((ms) => setTimeout(() => {
      if (!canControl() || !followOn()) return;
      const r = currentRatio(frame);
      if (r != null) send('scroll', { ratio: r });
    }, ms));
  }

  function bindFrame(frame) {
    const d = docOf(frame);
    if (!d) return;
    if (boundDocs.has(d)) return;
    boundDocs.add(d);
    try {
      frame.contentWindow.addEventListener('scroll', () => {
        // a relayed scroll is being applied: never echo it back (that ping-pong is what
        // made both sides jump around)
        if (isApplying() || !canControl()) return;
        // A listener bound to a document that has since been REPLACED must never emit.
        // The iframe starts as the initial `about:blank`, whose document has a
        // scrollHeight of roughly one viewport — `pageYOffset / max(1, scrollHeight - height)`
        // then divides the pixel offset by 1 and sends e.g. `3544` as a "ratio", which
        // teleported every receiver to the BOTTOM of the page. That was the owner's
        // "it jumps to the end first" bug.
        const cur = docOf(frame);
        if (!cur || cur !== d) return;
        const now = Date.now();
        if (now - lastOwnEmit < 140) return;
        lastOwnEmit = now;
        const de = cur.documentElement;
        const max = Math.max(1, (de.scrollHeight || 0) - (frame.clientHeight || 0));
        const ratio = clamp01((frame.contentWindow.pageYOffset || 0) / max);
        send('scroll', { ratio: ratio });
        // A page that is still loading keeps changing its height, so the first ratio can
        // be stale. Re-send a few times: everyone ends up on the same spot.
        if (followOn()) scheduleScrollResend(frame);
      }, { passive: true });

      d.addEventListener('click', (e) => {
        // a replayed click must not navigate this tab (the room follows the sender)
        if (applying) { e.preventDefault(); return; }
        if (!canControl()) return;
        // same guard as the scroll listener: never measure a replaced document
        const cur = docOf(frame);
        if (!cur || cur !== d) return;
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

      d.addEventListener('submit', (e) => { if (applying) e.preventDefault(); }, true);
    } catch (e) { /* frame vanished / not reachable */ }
  }

  // ---------- video box ----------
  function isDirectMedia(u) {
    // an uploaded call-file has no extension to look at — the server tells us the mime
    const s = String(u || '');
    if (s.indexOf('/black-meet/call-file/') === 0) return /^video\//i.test(String((web && web.mime) || ''));
    return /\.(mp4|webm|ogv|ogg|mov|m4v|m3u8)(\?|#|$)/i.test(s);
  }

  // One shared video: play/pause/seek go through the socket, so stopping it anywhere
  // stops it for everybody. The box header carries the shared transport controls
  // (provider embeds cannot be driven from the page reliably, so we provide our own).
  function videoControlsMarkup() {
    return `
      <div class="flex items-center gap-2 px-3 py-2 bg-surface-container-low border-t border-white/10 shrink-0" dir="ltr">
        <button type="button" id="web-v-play" onclick="webVideoCommand(playerPlaying() ? 'pause' : 'play')" class="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-[12px] font-medium" title="پخش / توقف برای همه">Play</button>
        <input id="web-v-seek" oninput="onWebSeek(this.value)" type="range" min="0" max="1000" value="0" class="flex-1"/>
        <span id="web-v-time" class="text-[11px] text-on-surface-variant w-10 text-center">0:00</span>
      </div>`;
  }
  window.playerPlaying = playerPlaying;

  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function playerTime() {
    const el = mediaEl();
    if (el && !el.paused) return el.currentTime;
    return ytTime;
  }
  function playerPlaying() {
    const el = mediaEl();
    if (el) return !el.paused;
    return ytPlaying;
  }
  // the direct-media element of whichever box is open (video or audio)
  function mediaEl() { return $('web-video') || $('web-audio'); }

  function paintControls() {
    const btn = $('web-v-play');
    const seek = $('web-v-seek');
    const time = $('web-v-time');
    const dur = videoDuration();
    if (btn) btn.textContent = playerPlaying() ? 'Pause' : 'Play';
    if (seek && Date.now() >= seekHoldUntil) {
      const t = playerTime();
      seek.value = dur > 0 ? Math.round((t / dur) * 1000) : 0;
    }
    if (time) {
      const held = Date.now() < seekHoldUntil && dur > 0 && seek
        ? (Number(seek.value) / 1000) * dur : playerTime();
      time.textContent = fmtTime(held);
    }
  }

  function videoDuration() {
    const el = mediaEl();
    if (el && el.duration && isFinite(el.duration)) return el.duration;
    return ytDuration;
  }

  let ytTime = 0, ytDuration = 0, ytPlaying = false;
  let videoCtrlTimer = null;

  function startVideoControls() {
    clearInterval(videoCtrlTimer);
    videoCtrlTimer = setInterval(() => {
      if (!web || web.kind !== 'video') { clearInterval(videoCtrlTimer); return; }
      paintControls();
    }, 700);
    paintControls();
  }

  // The header transport bar is used by every member (the provider's own controls are
  // hidden on purpose). It must act on THIS player first and only then tell the room —
  // relaying alone left the person who pressed the key waiting for a round trip that never
  // even came back (socket.to() excludes the sender).
  window.webVideoCommand = function (cmd, t) {
    const at = t != null ? Number(t) : playerTime();
    const el = mediaEl();
    if (el) {
      applying = true;
      try {
        if (Math.abs((el.currentTime || 0) - at) > 1.2) el.currentTime = at;
        if (cmd === 'play') {
          playWanted = true;
          hidePlayHint();
          const p = el.play();
          if (p && p.catch) p.catch(() => { });
        } else if (cmd === 'pause') {
          stopPlayRetry();
          el.pause();
        }
      } catch (e) { }
      setTimeout(() => { applying = false; }, 140);
    } else {
      ytTime = at;
      ytPlaying = cmd === 'play';
      ytCommand(cmd, at);
    }
    send('video', { cmd: cmd, t: at });
    paintControls();
    paintAudio();
  };
  window.onWebSeek = function (val) {
    const dur = videoDuration();
    const t = dur > 0 ? (Number(val) / 1000) * dur : 0;
    seekHoldUntil = Date.now() + 1200;
    const el = mediaEl();
    if (el) {
      applying = true;
      try { el.currentTime = t; } catch (e) { }
      lastSeekSent = Date.now();
      setTimeout(() => { applying = false; }, 140);
    } else {
      ytTime = t;
      ytCommand('seek', t);
    }
    send('video', { cmd: 'seek', t: t });
    paintControls();
    paintAudio();
  };

  function mountVideo(body) {
    const isEmbed = !!web.src && web.src !== web.url;
    if (!isEmbed && isDirectMedia(web.url)) {
      const v = document.createElement('video');
      v.id = 'web-video';
      v.src = withRoom(web.url);
      v.controls = false;
      v.playsInline = true;
      v.className = 'absolute inset-0 w-full h-full bg-black';
      body.appendChild(v);
      v.addEventListener('play', () => { if (canControl()) send('video', { cmd: 'play', t: v.currentTime }); paintControls(); hidePlayHint(); });
      v.addEventListener('pause', () => { if (canControl()) send('video', { cmd: 'pause', t: v.currentTime }); paintControls(); });
      v.addEventListener('seeked', () => {
        if (applying || Date.now() < lastSeekSent + 300) return;
        lastSeekSent = Date.now();
        if (canControl()) send('video', { cmd: 'seek', t: v.currentTime });
      });
      v.addEventListener('timeupdate', () => {
        if (v.paused) return;
        if (Math.abs(v.currentTime - ytTime) > 2) send('video', { cmd: 'seek', t: v.currentTime });
      });
      startVideoControls();
      // the room starts together: the opener plays, everybody else receives the command
      if (canControl()) tryPlay(v, 'برای پخش هم‌زمان ویدیو کلیک کنید');
      // late joiners land on the position the room is already at
      setTimeout(() => { if (web && web.video) applyVideoCmd(web.video); }, 500);
      return;
    }
    const f = document.createElement('iframe');
    f.id = 'web-frame';
    f.setAttribute('title', 'shared video');
    f.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    f.setAttribute('allowfullscreen', 'true');
    f.className = 'absolute inset-0 w-full h-full border-0 bg-black';
    let src = web.src || web.url;
    if (/youtube\.com\/embed\//.test(src)) {
      if (src.indexOf('enablejsapi') === -1) src += (src.indexOf('?') === -1 ? '?' : '&') + 'enablejsapi=1&rel=0';
      // provider controls are hidden on purpose: play/pause/seek must go through the
      // shared bar so one person's press is applied for everybody
      if (src.indexOf('controls') === -1) src += '&controls=0&modestbranding=1';
      if (canControl() && src.indexOf('autoplay') === -1) src += '&autoplay=1';
    }
    f.src = src;
    body.appendChild(f);
    startVideoControls();
    // YouTube embeds report player state back through postMessage when enablejsapi=1
    window.addEventListener('message', (ev) => {
      let d = ev.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return; } }
      if (!d || d.event !== 'infoDelivery' || !d.info) return;
      const f2 = $('web-frame');
      if (!f2 || ev.source !== f2.contentWindow) return;
      const info = d.info;
      if (typeof info.currentTime === 'number') {
        const jump = Math.abs(info.currentTime - ytTime) > 1.5;
        ytTime = info.currentTime;
        if (typeof info.duration === 'number' && info.duration) ytDuration = info.duration;
        if (jump && canControl() && !applying) send('video', { cmd: 'seek', t: ytTime });
      }
      if (typeof info.playerState === 'number') {
        const playing = info.playerState === 1;
        if (playing !== ytPlaying) {
          ytPlaying = playing;
          if (canControl() && !applying) send('video', { cmd: playing ? 'play' : 'pause', t: ytTime });
        }
      }
      paintControls();
    });
    // fall back to the room's known state once the frame is up
    setTimeout(() => { if (web && web.video) applyVideoCmd(web.video); }, 1500);
  }

  function ytCommand(cmd, t) {
    const f = $('web-frame');
    if (!f || !f.contentWindow) return;
    try {
      if (cmd !== 'seek' && t != null) {
        f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [Number(t) || 0, true] }), '*');
      }
      const fn = cmd === 'play' ? 'playVideo' : (cmd === 'pause' ? 'pauseVideo' : null);
      if (fn) f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: fn, args: [] }), '*');
      if (cmd === 'seek') f.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [Number(t) || 0, true] }), '*');
    } catch (e) {}
  }
  // ---------- audio box: our own player (the native one is too small to share) ----------
  let seekHoldUntil = 0;   // while the listener drags the seek slider, the repaint must not fight it
  let lastSeekSent = 0;    // suppress the echo of a seek we just sent
  function isAudioUrl(u) {
    return /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|mp4)(\?|#|$)/i.test(u) || /\b(audio|music|track)\b/i.test(u);
  }

  // ---------- file box ----------
  // The file is served by US (/black-meet/call-file/:id?room=…) so it only loads for members
  // of this session. Images / pdf / text / video / audio are shown in place, everything else
  // gets a card with a download button (the server forces `attachment` for those anyway).
  function mountFile(body) {
    const src = web.src || web.url;
    const url = src + (src.indexOf('?') === -1 ? '?' : '&') + 'room=' + encodeURIComponent(fileRoom());
    body.classList.remove('bg-black');
    body.classList.add('bg-surface-container-low');

    if (web.viewable === false) {
      body.innerHTML = `
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
          ${bmIcon('description', 'text-[40px] text-primary')}
          <p class="font-body-sm text-body-sm text-on-surface break-all">${escapeHtml(web.name || 'فایل')}</p>
          <p class="font-label-sm text-on-surface-variant text-[11px]">این فرمت به‌صورت مستقیم نمایش داده نمی‌شود</p>
          <a href="${escapeHtml(url)}&download=1" target="_blank" rel="noopener"
             class="btn-primary px-4 py-2 inline-flex items-center gap-2">${bmIcon('download', 'text-[18px]')} دانلود فایل</a>
        </div>`;
      return;
    }

    // A dedicated viewer per type instead of a bare iframe: an image gets a real
    // light-box-free fit view, video/audio get the shared player.
    const mime = String(web.mime || '');
    if (/^image\//i.test(mime)) {
      body.innerHTML = `
        <div class="absolute inset-0 flex items-center justify-center bg-black/90 p-2">
          <img src="${escapeHtml(url)}" alt="${escapeHtml(web.name || '')}"
               class="max-w-full max-h-full object-contain rounded-lg"/>
        </div>`;
      return;
    }
    if (/^video\//i.test(mime)) {
      body.innerHTML = `<video id="web-file-video" src="${escapeHtml(url)}" controls playsinline
        class="absolute inset-0 w-full h-full bg-black"></video>`;
      return;
    }
    if (/^audio\//i.test(mime)) {
      body.innerHTML = `
        <div class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6">
          <div class="w-28 h-28 rounded-full bg-gradient-to-br from-primary-container to-secondary-container flex items-center justify-center shadow-xl shadow-primary/20">
            ${bmIcon('volume_up', 'text-[46px] text-on-primary-container', true)}
          </div>
          <p class="font-body-sm text-body-sm text-on-surface text-center break-all">${escapeHtml(web.name || 'فایل صوتی')}</p>
          <audio id="web-file-audio" src="${escapeHtml(url)}" controls class="w-full max-w-sm"></audio>
        </div>`;
      return;
    }

    const frame = document.createElement('iframe');
    frame.id = 'web-file-frame';
    frame.setAttribute('title', 'shared file');
    frame.className = 'absolute inset-0 w-full h-full border-0 bg-white';
    frame.src = url;
    body.appendChild(frame);
    // an image needs no chrome; a pdf/text does fine full-bleed too
    frame.addEventListener('load', () => bindFileFrame(frame));
  }

  // Scroll relay for a shared file. Only SAME-ORIGIN documents are measurable (images and
  // text are, the browser's built-in pdf viewer is not) — so this works when it can and
  // silently does nothing when it can not. Uses its own 'fscroll' sync kind so a file box
  // never collides with the shared-website box.
  function bindFileFrame(frame) {
    if (frame.dataset.bmBound === '1') return;
    frame.dataset.bmBound = '1';
    const push = () => {
      const r = currentRatio(frame);
      if (r != null) send('fscroll', { ratio: r });
    };
    frame.addEventListener('load', push);
    [800, 1800, 3600].forEach((ms) => setTimeout(push, ms));
    frame.addEventListener('scroll', () => {
      clearTimeout(frame._bmScrollT);
      frame._bmScrollT = setTimeout(push, 140);
    }, { passive: true });
  }

  function applyFileScroll(ratio) {
    const frame = $('web-file-frame');
    if (!frame) return;
    try {
      const d = docOf(frame);
      if (!d) return;
      const de = d.documentElement;
      const max = Math.max(0, (de.scrollHeight || 0) - (frame.clientHeight || 0));
      // instant, like the site box: a smooth animation here relays its own in-flight
      // positions and makes both sides bounce
      const prev = de.style.scrollBehavior;
      de.style.scrollBehavior = 'auto';
      frame.contentWindow.scrollTo({ top: Math.round(clamp01(ratio) * max), behavior: 'instant' });
      de.style.scrollBehavior = prev;
    } catch (e) { /* not same-origin (pdf): nothing to do */ }
  }

  // ---------- shared playback: autoplay is blocked until the user interacts ----------
  // Chrome refuses to start media with sound on a page the user has not touched yet, so the
  // receivers silently stayed paused. We retry a few times and, if it is still refused,
// show a one-tap overlay. The error used to be swallowed by `.catch(() => {})`, which is
  // exactly why "play for everybody" looked broken.
  let playHintEl = null;
  let playRetry = null;
  // what the room last asked for — a retry loop must never resurrect a paused player
  let playWanted = false;

  function stopPlayRetry() {
    if (playRetry) { clearInterval(playRetry); playRetry = null; }
    playWanted = false;
  }

  function showPlayHint(el, what) {
    hidePlayHint();
    const box = document.getElementById('web-box');
    if (!box) return;
    const hint = document.createElement('button');
    hint.type = 'button';
    hint.id = 'web-play-hint';
    hint.className = 'absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-sm text-white';
    hint.innerHTML = bmIcon('play', 'text-[44px]', true) +
      '<span class="font-body-sm text-body-sm">' + (what || 'برای پخش هم‌زمان کلیک کنید') + '</span>';
    hint.onclick = (e) => {
      e.stopPropagation();
      try { const p = el.play(); if (p && p.catch) p.catch(() => { }); } catch (err) { }
      hidePlayHint();
    };
    box.appendChild(hint);
    playHintEl = hint;
  }
  function hidePlayHint() {
    if (playHintEl && playHintEl.parentNode) playHintEl.parentNode.removeChild(playHintEl);
    playHintEl = null;
  }
  // returns true when the element is actually playing
  // `opts.gesture === false` => do NOT attach the global pointerdown/keydown retry: that
  // listener is why the audio box sometimes started playing on its own the moment anybody
  // clicked anywhere on the call page.
  function tryPlay(el, what, opts) {
    if (!el) return false;
    const gesture = !opts || opts.gesture !== false;
    playWanted = true;
    try {
      const p = el.play();
      if (!p || !p.catch) { hidePlayHint(); return true; }
      p.catch(() => {
        if (!playWanted) return;
        // NotAllowedError = autoplay blocked. Try once on the next gesture, then ask.
        if (gesture) {
          const once = () => {
            document.removeEventListener('pointerdown', once, true);
            document.removeEventListener('keydown', once, true);
            if (playWanted) tryPlay(el, what, opts);
          };
          document.addEventListener('pointerdown', once, true);
          document.addEventListener('keydown', once, true);
        }
        if (playRetry) clearInterval(playRetry);
        let tries = 0;
        playRetry = setInterval(() => {
          if (!playWanted) { clearInterval(playRetry); playRetry = null; return; }
          tries++;
          if (tries > 8) { clearInterval(playRetry); playRetry = null; showPlayHint(el, what); return; }
          try {
            const q = el.play();
            if (q && q.then) q.then(() => { if (playRetry) { clearInterval(playRetry); playRetry = null; } hidePlayHint(); }).catch(() => { });
          } catch (e) { }
        }, 350);
      });
      return true;
    } catch (e) { showPlayHint(el, what); return false; }
  }
  // one user pressed play/pause -> everybody must do the same
  function broadcastPlayState(el, what) {
    if (!el) return;
    const kind = web && web.kind === 'audio' ? 'audio' : 'video';
    send(kind, { cmd: el.paused ? 'pause' : 'play', t: el.currentTime });
    if (!el.paused) hidePlayHint();
  }

  function mountAudio(body) {
    body.classList.add('audio-body');
    body.innerHTML = `
      <div class="audio-player">
        <div class="audio-row">
          <button type="button" id="web-a-back" onclick="onAudioSkip(-10)" class="audio-btn" title="۱۰ ثانیه عقب">
            ${bmIcon('replay_10', 'text-[22px]')}
          </button>
          <div class="audio-disc" id="web-a-disc">
            <button type="button" id="web-a-play" onclick="audioToggle()" title="پخش / توقف برای همه">
              ${bmIcon('play', 'text-[30px]', true)}
            </button>
          </div>
          <button type="button" id="web-a-fwd" onclick="onAudioSkip(10)" class="audio-btn" title="۱۰ ثانیه جلو">
            ${bmIcon('forward_10', 'text-[22px]')}
          </button>
        </div>
        <p class="audio-title" id="web-a-title">—</p>
        <div class="audio-bar" dir="ltr">
          <span id="web-a-cur" class="audio-time">0:00</span>
          <input id="web-a-seek" oninput="onAudioSeek(this.value)" type="range" min="0" max="1000" value="0"/>
          <span id="web-a-dur" class="audio-time">0:00</span>
        </div>
        <div class="audio-vol" dir="ltr" title="صدای پخش">
          ${bmIcon('volume_down', 'text-[18px] text-primary')}
          <input id="web-a-vol" oninput="onAudioVolume(this.value)" type="range" min="0" max="100" value="100"/>
          ${bmIcon('volume_up', 'text-[18px] text-primary')}
        </div>
        <p class="audio-hint" id="web-a-hint">پخش برای همه‌ی اعضای تماس</p>
      </div>
      <audio id="web-audio" preload="metadata" class="hidden" src=""></audio>`;
    const a = $('web-audio');
    if (!a) return;
    a.src = withRoom(web.url || web.src);
    const title = $('web-a-title');
    if (title) {
      title.textContent = decodeURIComponent(String(web.url || '').split('/').pop().split('?')[0]) || 'فایل صوتی';
    }
    a.addEventListener('play', () => {
      spinDisc(true);
      paintAudio();
      if (!applying && canControl()) send('audio', { cmd: 'play', t: a.currentTime });
    });
    a.addEventListener('pause', () => {
      spinDisc(false);
      paintAudio();
      if (!applying && canControl()) send('audio', { cmd: 'pause', t: a.currentTime });
    });
    a.addEventListener('seeked', () => {
      // a relayed seek must not echo back; the local one already went out from onAudioSeek
      if (applying || Date.now() < lastSeekSent + 300) return;
      lastSeekSent = Date.now();
      if (canControl()) send('audio', { cmd: 'seek', t: a.currentTime });
    });
    a.addEventListener('loadedmetadata', () => { if (web && web.video) applyMediaCmd(web.video); paintAudio(); });
    a.addEventListener('error', () => {
      const h = $('web-a-hint');
      if (h) h.textContent = 'این لینک صوتی پشتیبانی نشد؛ یک لینک مستقیم فایل صوتی (mp3 / m4a / ogg) بدهید';
    });
    // NO autoplay on `canplay`: that handler is what started the track "by itself" without
    // anybody pressing play. The room decides — a late joiner who enters while the room is
    // already playing lands on `applyMediaCmd(web.video)` a few lines up.
    paintAudio();
    setInterval(paintAudio, 500);
  }
  function spinDisc(on) {
    const d = $('web-a-disc');
    if (d) d.classList.toggle('playing', !!on);
  }
  function paintAudio() {
    const a = $('web-audio');
    if (!a) return;
    const btn = $('web-a-play');
    const seek = $('web-a-seek');
    const cur = $('web-a-cur');
    const dur = $('web-a-dur');
    const playing = !a.paused;
    if (btn) btn.innerHTML = bmIcon(playing ? 'pause' : 'play', 'text-[30px]', true);
    const d = a.duration && isFinite(a.duration) ? a.duration : 0;
    // while the listener drags the slider, the 500ms repaint must NOT move it back —
    // that "snap back to where it was" is exactly the reported bug
    if (seek && Date.now() >= seekHoldUntil) {
      seek.value = d > 0 ? Math.round((a.currentTime / d) * 1000) : 0;
    }
    // while dragging, show the position the listener is pointing at, not the old one
    const dragged = seek && Date.now() < seekHoldUntil && d > 0
      ? (Number(seek.value) / 1000) * d : a.currentTime;
    if (cur) cur.textContent = fmtTime(dragged);
    if (dur) dur.textContent = fmtTime(d);
  }
  window.audioToggle = function () {
    const a = $('web-audio');
    if (!a) return;
    if (a.paused) {
      // the move is applied locally first (no lag) AND relayed, so stopping it anywhere
      // stops it for everybody
      playWanted = true;
      hidePlayHint();
      const p = a.play();
      if (p && p.catch) p.catch(() => { });
      if (canControl()) send('audio', { cmd: 'play', t: a.currentTime });
    } else {
      stopPlayRetry();
      a.pause();
      if (canControl()) send('audio', { cmd: 'pause', t: a.currentTime });
    }
    paintAudio();
  };
  // seek / skip: move THIS player immediately, then tell the room. Sending only (the old
  // behaviour) left the sender's own slider to be repainted from the untouched position.
  function audioSeekTo(t) {
    const a = $('web-audio');
    if (!a || !(a.duration > 0)) return;
    const target = Math.max(0, Math.min(a.duration, Number(t) || 0));
    applying = true;
    try { a.currentTime = target; } catch (e) { }
    seekHoldUntil = Date.now() + 900;
    lastSeekSent = Date.now();
    if (canControl()) send('audio', { cmd: 'seek', t: target });
    paintAudio();
    setTimeout(() => { applying = false; }, 80);
  }
  window.onAudioSeek = function (val) {
    const a = $('web-audio');
    if (!a || !(a.duration > 0)) return;
    // the slider itself is the intent — hold the repaint while the finger is down
    seekHoldUntil = Date.now() + 1200;
    audioSeekTo((Number(val) / 1000) * a.duration);
  };
  // jump forward/back: the move is applied locally too (no lag for the person pressing)
  window.onAudioSkip = function (secs) {
    const a = $('web-audio');
    if (!a || !(a.duration > 0)) return;
    audioSeekTo(a.currentTime + Number(secs || 0));
  };
  window.onAudioVolume = function (val) {
    const a = $('web-audio');
    if (a) a.volume = Math.max(0, Math.min(1, Number(val) / 100));
  };

  // one shared player for both the video and the audio box
  function applyMediaCmd(v) {
    if (!v) return;
    applying = true;
    const el = mediaEl();
    if (el) {
      try {
        if (Math.abs((el.currentTime || 0) - (Number(v.t) || 0)) > 1.2) el.currentTime = Number(v.t) || 0;
        if (v.playing) {
          // autoplay may still be refused on this client -> retry / one-tap overlay.
          // For the AUDIO box the retry must never hook a global click: that made the
          // track start on its own whenever somebody pressed anything.
          const isAudio = !!(web && web.kind === 'audio');
          tryPlay(el, isAudio ? 'برای پخش هم‌زمان صدا کلیک کنید' : 'برای پخش هم‌زمان ویدیو کلیک کنید',
            { gesture: !isAudio });
        } else { stopPlayRetry(); el.pause(); hidePlayHint(); }
      } catch (e) {}
      ytTime = Number(v.t) || 0;
      ytPlaying = !!v.playing;
    } else {
      ytTime = Number(v.t) || 0;
      ytPlaying = !!v.playing;
      ytCommand(v.cmd === 'seek' ? 'seek' : (v.playing ? 'play' : 'pause'), ytTime);
    }
    paintControls();
    paintAudio();
    setTimeout(() => { applying = false; }, 150);
  }
  const applyVideoCmd = applyMediaCmd;

  // ---------- socket hooks ----------
  window.bmWebState = function (d) {
    const prev = web;
    web = (d && d.web) || null;
    if (!web) {
      // box removed: every tile must come back exactly where it was
      const box = $('web-box');
      if (box && box.classList.contains('maximized-el') && window.bmExitMaximize) {
        window.bmExitMaximize();
      }
      expanded = false;
      if (box) box.remove();
      restoreTiles();
      relayout();
      return;
    }
    if (web.scroll && typeof web.scroll.ratio === 'number') lastRatio = clamp01(web.scroll.ratio);
    if (prev && prev.kind === web.kind && prev.url === web.url) {
      // same box re-announced (the follow switch or the access rights changed):
      // refresh the header IN PLACE — re-creating the iframe would reload the page
      updateWebHeader();
      return;
    }
    renderWebBox();
  };
  function updateWebHeader() {
    const box = $('web-box');
    if (!box) return;
    const isAdmin = !!(I.me.is_manager || I.me.is_admin);
    const head = box.querySelector('.web-head');
    if (head) head.outerHTML = headerHtml(web.kind, web.host, isAdmin);
    if (web.kind === 'video') paintControls();
  }

  window.bmWebSync = function (d) {
    if (!web || !d) return;
    if (web.kind === 'site') {
      if (d.kind === 'scroll') applyScrollNow(d.ratio);
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
      applyMediaCmd({ cmd: d.cmd, t: d.t, playing: d.cmd === 'play' });
    } else if (web.kind === 'audio' && d.kind === 'audio') {
      applyMediaCmd({ cmd: d.cmd, t: d.t, playing: d.cmd === 'play' });
    } else if (web.kind === 'file' && d.kind === 'fscroll') {
      applying = true;
      applyFileScroll(Number(d.ratio) || 0);
      setTimeout(() => { applying = false; }, 120);
    }
  };

  // ---------- boot ----------
  window.addEventListener('DOMContentLoaded', () => {
    const urlInput = $('web-url');
    if (urlInput) {
      urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitWebModal(); });
    }
    // file picker + drag & drop
    const fInput = $('web-file-input');
    if (fInput) fInput.addEventListener('change', () => pickWebFile(fInput.files && fInput.files[0]));
    const drop = $('web-file-drop');
    if (drop) {
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        drop.classList.add('bg-primary-container/40');
      }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        drop.classList.remove('bg-primary-container/40');
      }));
      drop.addEventListener('drop', (e) => {
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) pickWebFile(f);
      });
    }
    // drag & drop anywhere on the call page while the file dialog is open
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => {
      const zone = $('web-file-zone');
      if (zone && !zone.classList.contains('hidden')) {
        e.preventDefault();
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) pickWebFile(f);
      }
    });
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
