// assets/js/whiteboard.js — the call page's shared whiteboard.
//
// It is a BOX on the call stage (the same kind of cell the shared site/video/audio/file
// boxes use), not a sidebar tab: the owner asked for a dedicated white board with a WHITE
// background that never appears anywhere else on the page. The admin opens it from the
// bottom bar; everyone in the room gets the same box. Strokes are batched per animation
// frame and sent with a volatile emit, so a slow link drops stale points instead of
// queueing seconds of them (which is what made the board feel ~4 seconds behind).
// Plain browser script, no bundler/import/export; the public API lives on window.
(function () {
  'use strict';

  const I = window.INIT;
  const EV = window.BMEv;

  // ---------- private state ----------
  let sock = null;
  let box = null, wrap = null, canvas = null, ctx = null;
  let open = false, canDraw = false, isAdmin = false;
  let granted = [];
  let drawing = false, lx = 0, ly = 0;
  let tool = 'pen';
  // a white board needs dark ink: the old default was #ffffff (invisible on white)
  let color = '#1f2937';
  let size = 3;
  const myId = (I && I.me) ? I.me.id : null;

  // pending segments for the current animation frame
  let pending = [];

  function $(id) { return document.getElementById(id); }
  function toast(msg) { if (window.showToast) window.showToast(msg); }
  function ico(name, cls, fill) {
    return window.bmIcon ? window.bmIcon(name, cls, fill) : '';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function meAdmin() {
    return !!(I && I.me && (I.me.is_admin || I.me.is_manager));
  }

  // ---------- geometry ----------
  function resizeCanvas() {
    if (!canvas || !wrap) return;
    const w = Math.max(1, Math.round(wrap.clientWidth));
    const h = Math.max(1, Math.round(wrap.clientHeight));
    if (canvas.width === w && canvas.height === h) return;
    // keep what is already drawn: scale the old bitmap into the new size
    const prev = document.createElement('canvas');
    prev.width = canvas.width || 1;
    prev.height = canvas.height || 1;
    try { prev.getContext('2d').drawImage(canvas, 0, 0); } catch (e) { /* first run */ }
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (prev.width > 1 && prev.height > 1) {
      try { ctx.drawImage(prev, 0, 0, w, h); } catch (e) { /* ignore */ }
    }
  }

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: r.width ? (e.clientX - r.left) / r.width : 0,
      y: r.height ? (e.clientY - r.top) / r.height : 0,
    };
  }

  function drawSeg(x1, y1, x2, y2, col, w, tl) {
    if (!canvas || !ctx) return;
    ctx.save();
    if (tl === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.lineWidth = Math.max(6, (w || size) * 3);
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = col || color;
      ctx.lineWidth = w || size;
    }
    ctx.beginPath();
    ctx.moveTo(x1 * canvas.width, y1 * canvas.height);
    ctx.lineTo(x2 * canvas.width, y2 * canvas.height);
    ctx.stroke();
    ctx.restore();
  }

  // a relayed packet: { pts:[x1,y1,x2,y2,...], color, size, tool } (older builds sent x1..y2)
  function drawPacket(d) {
    if (!d) return;
    if (Array.isArray(d.pts)) {
      for (let i = 0; i + 3 < d.pts.length; i += 4) {
        drawSeg(d.pts[i], d.pts[i + 1], d.pts[i + 2], d.pts[i + 3], d.color, d.size, d.tool);
      }
      return;
    }
    if (typeof d.x1 === 'number') drawSeg(d.x1, d.y1, d.x2, d.y2, d.color, d.size, d.tool);
  }

  // ---------- local input ----------
  function onDown(e) {
    if (!canDraw || !open) return;
    if (e.button != null && e.button !== 0 && e.pointerType === 'mouse') return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
    drawing = true;
    const p = point(e);
    lx = p.x; ly = p.y;
    e.preventDefault();
  }

  function onMove(e) {
    if (!drawing || !canDraw) return;
    const p = point(e);
    drawSeg(lx, ly, p.x, p.y, color, size, tool);
    pending.push(lx, ly, p.x, p.y);
    lx = p.x; ly = p.y;
    if (!pending.raf) {
      pending.raf = requestAnimationFrame(flush);
    }
    e.preventDefault();
  }

  function onUp() { drawing = false; }

  // one socket message per animation frame instead of one per pointermove
  function flush() {
    const pts = pending.slice(0);
    pending = [];
    if (!pts.length || !sock || !sock.connected) return;
    const msg = { pts: pts, color: color, size: size, tool: tool };
    // volatile: if the socket buffer is backed up the stale packet is dropped, never queued
    try { sock.volatile.emit(EV.WB_DRAW, msg); } catch (e) { try { sock.emit(EV.WB_DRAW, msg); } catch (e2) { } }
  }

  // ---------- box rendering ----------
  function renderBox() {
    if (box) { paint(); return; }
    const grid = $('video-grid');
    if (!grid) return;

    box = document.createElement('div');
    box.id = 'wb-box';
    box.className = 'wb-box';
    box.innerHTML = `
      <div class="wb-head">
        <span class="wb-head-ico">${ico('draw', 'text-[18px]', false)}</span>
        <span class="wb-head-title">تخته وایت‌برد</span>
        <div class="wb-tools" id="wb-toolbar" style="display:none">
          <button type="button" id="wb-btn-pen" class="wb-tool ctrl-live" onclick="bmWbSetTool('pen')" title="قلم" data-no-soft>${ico('draw', 'text-[17px]')}</button>
          <button type="button" id="wb-btn-eraser" class="wb-tool" onclick="bmWbSetTool('eraser')" title="پاک‌کن" data-no-soft>${ico('ink_eraser', 'text-[17px]')}</button>
          <input type="color" id="wb-color" value="#1f2937" oninput="bmWbSetColor(this.value)" title="رنگ" class="wb-color"/>
          <input type="range" id="wb-size" min="2" max="40" value="3" oninput="bmWbSetSize(+this.value)" title="ضخامت" class="wb-size"/>
        </div>
        <span class="wb-spacer"></span>
        <span id="wb-viewer-badge" class="wb-viewer hidden">${ico('visibility', 'text-[14px]')} فقط مشاهده</span>
        <button type="button" id="wb-btn-clear" class="wb-hbtn hidden" onclick="bmWbClear()" title="پاک کردن کل تخته" data-no-soft>${ico('delete_sweep', 'text-[17px]')}</button>
        <button type="button" id="wb-btn-grant" class="wb-hbtn hidden" onclick="toggleWbGrants(event)" title="دسترسی نقاشی" data-no-soft>${ico('shield_person', 'text-[17px]')}</button>
        <button type="button" class="wb-hbtn" onclick="toggleWbMaximize()" title="تمام‌صفحه" data-no-soft>${ico('fullscreen', 'text-[17px]', false, 'id="wb-max-ico"')}</button>
        <button type="button" id="wb-btn-close" class="wb-hbtn wb-hbtn-danger hidden" onclick="bmWbToggle()" title="بستن تخته" data-no-soft>${ico('close', 'text-[17px]')}</button>
      </div>
      <div class="wb-body" id="wb-canvas-wrap">
        <canvas id="wb-canvas"></canvas>
        <div class="wb-grant hidden" id="wb-grant-panel">
          <div class="wb-grant-head">
            <span>دسترسی نقاشی</span>
            <button type="button" onclick="toggleWbGrants(event)" class="wb-grant-x" data-no-soft>${ico('close', 'text-[15px]')}</button>
          </div>
          <div id="wb-grant-list" class="wb-grant-list"></div>
        </div>
      </div>
      <div class="mx-back hidden" id="wb-mx-back" onclick="toggleWbMaximize()">
        ${ico('fullscreen_exit', 'text-[15px]')} بازگشت به حالت عادی
      </div>`;

    grid.insertBefore(box, grid.firstChild);
    wrap = $('wb-canvas-wrap');
    canvas = $('wb-canvas');
    ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    canvas.style.pointerEvents = 'none';
    resizeCanvas();

    if (window.ResizeObserver && wrap) {
      const ro = new ResizeObserver(() => resizeCanvas());
      ro.observe(wrap);
    }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onUp);

    paint();
    relayout();
  }

  function removeBox() {
    if (box && box.classList.contains('maximized-el') && window.bmExitMaximize) window.bmExitMaximize();
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null; wrap = null; canvas = null; ctx = null;
    drawing = false;
    pending = [];
    relayout();
  }

  function relayout() { if (window.bmCallRelayout) window.bmCallRelayout(); }

  function toolbarVisible(on) {
    const t = $('wb-toolbar');
    if (t) t.style.display = on ? '' : 'none';
  }

  // apply the room state to the UI
  function paint() {
    if (!box) return;
    toolbarVisible(canDraw);
    const badge = $('wb-viewer-badge');
    if (badge) badge.classList.toggle('hidden', canDraw);
    const clear = $('wb-btn-clear');
    if (clear) clear.classList.toggle('hidden', !isAdmin);
    const grant = $('wb-btn-grant');
    if (grant) grant.classList.toggle('hidden', !isAdmin);
    const close = $('wb-btn-close');
    if (close) close.classList.toggle('hidden', !isAdmin);
    if (canvas) canvas.style.pointerEvents = canDraw ? 'auto' : 'none';
    if (isAdmin) renderGrantList();
    // the toolbar keys reflect the active tool
    const pen = $('wb-btn-pen');
    const eraser = $('wb-btn-eraser');
    if (pen) pen.classList.toggle('ctrl-live', tool === 'pen');
    if (eraser) eraser.classList.toggle('ctrl-live', tool === 'eraser');
    const wbb = $('btn-wb');
    if (wbb) wbb.classList.toggle('ctrl-live', open);
  }

  function applyState(d) {
    open = !!(d && d.open);
    granted = (d && Array.isArray(d.granted)) ? d.granted : [];
    isAdmin = meAdmin();
    canDraw = isAdmin || granted.indexOf(myId) !== -1;
    if (open) { renderBox(); paint(); }
    else { removeBox(); paintBtn(); }
  }

  function paintBtn() {
    const wbb = $('btn-wb');
    if (wbb) wbb.classList.toggle('ctrl-live', !!open);
  }

  // ---------- admin grant/revoke panel ----------
  function renderGrantList() {
    const list = $('wb-grant-list');
    if (!list) return;
    const roster = (window.bmCallRoster && window.bmCallRoster()) || [];
    const rows = [];
    roster.forEach((m) => {
      if (!m || m.userId === myId) return;
      if (m.status && m.status !== 'approved') return;
      const on = granted.indexOf(m.userId) !== -1;
      const label = on ? 'گرفتن دسترسی' : 'دادن دسترسی';
      const fn = on ? 'bmWbRevoke' : 'bmWbGrant';
      rows.push(
        '<div class="wb-grant-row">' +
        '<span class="wb-grant-name">' + esc(m.name || ('کاربر ' + m.userId)) + '</span>' +
        '<button type="button" data-no-soft class="wb-grant-btn' + (on ? ' is-on' : '') + '" onclick="' + fn + '(' + Number(m.userId) + ')">' + label + '</button>' +
        '</div>'
      );
    });
    list.innerHTML = rows.length ? rows.join('') : '<p class="wb-grant-empty">عضو دیگری در اتاق نیست</p>';
  }

  window.toggleWbGrants = function (e) {
    if (e) e.stopPropagation();
    const p = $('wb-grant-panel');
    if (!p) return;
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) renderGrantList();
  };

  window.toggleWbMaximize = function () {
    if (!box) return;
    if (window.bmIsMaximized && window.bmIsMaximized()) { window.bmExitMaximize(); return; }
    if (window.bmEnterMaximizeWb) window.bmEnterMaximizeWb();
    const badge = $('wb-max-ico');
    if (badge) { /* the caller repaints the icon */ }
    setTimeout(paint, 30);
  };

  // ---------- public API ----------
  window.bmWbInit = function () {
    isAdmin = meAdmin();
    // nothing else happens until the room says the board is open
  };

  window.bmWbSocketBind = function (socket) {
    sock = socket;
    if (!sock) return;

    sock.on(EV.WB_STATE, (d) => applyState(d));

    sock.on(EV.WB_DRAW, (d) => drawPacket(d));

    sock.on(EV.WB_CLEAR, () => {
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    });

    sock.on(EV.CALL_WELCOME, (d) => {
      if (d && d.wb && d.wb.open) window.bmWbApplySync(d.wb);
    });
  };

  window.bmWbApplySync = function (wbData) {
    if (!wbData || !wbData.open) return;
    const g = wbData.granted || [];
    applyState({ open: true, granted: g });
    (wbData.strokes || []).forEach(drawPacket);
  };

  window.bmWbToggle = function () {
    if (!sock) return;
    if (!meAdmin()) {
      // a viewer cannot open/close the room's board — the key opens it full screen instead
      if (open) window.toggleWbMaximize();
      else toast('تخته وایت‌برد را ادمین تماس باز می‌کند');
      return;
    }
    sock.emit(open ? EV.WB_CLOSE : EV.WB_OPEN);
  };

  window.bmWbClear = function () {
    if (!sock) return;
    sock.emit(EV.WB_CLEAR);
  };

  window.bmWbSetTool = function (t) {
    tool = t;
    const pen = $('wb-btn-pen');
    const eraser = $('wb-btn-eraser');
    if (pen) pen.classList.toggle('ctrl-live', t === 'pen');
    if (eraser) eraser.classList.toggle('ctrl-live', t === 'eraser');
  };

  window.bmWbSetColor = function (c) { color = c || color; };
  window.bmWbSetSize = function (s) { size = Number(s) || size; };

  window.bmWbGrant = function (userId) {
    if (!sock) return;
    sock.emit(EV.WB_GRANT, { userId: userId });
  };
  window.bmWbRevoke = function (userId) {
    if (!sock) return;
    sock.emit(EV.WB_REVOKE, { userId: userId });
  };

  // the maximized layer must repaint its icon when call.js moves the box in/out
  window.bmWbOnMaximizeChange = function () { setTimeout(paint, 30); };
})();
