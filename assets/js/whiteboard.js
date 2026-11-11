// assets/js/whiteboard.js — the call page's shared whiteboard: a canvas that the admin
// opens and grants draw access on, with strokes relayed in real time (WB_* events).
// Plain browser script, no bundler/import/export; public API lives on window.
(function () {
  'use strict';

  // ---------- private state ----------
  let wbCanvas, wbCtx;
  let wbOpen = false;
  let wbCanDraw = false;
  let wbIsAdmin = false;
  let wbDrawing = false;
  let wbLastX = 0, wbLastY = 0;
  let wbTool = 'pen';
  let wbColor = '#ffffff';
  let wbSize = 4;
  let wbSocket = null;
  let wbMyId = null;      // current user's id — set from window.INIT.me.id in bmWbInit
  let wbWasOpen = false;  // track "just opened" so we only auto-switch the sidebar once

  function $(id) { return document.getElementById(id); }

  function wbPoint(e) {
    const r = wbCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    };
  }

  function wbResizeCanvas() {
    const c = wbCanvas;
    if (!c || !wbCtx) return;
    // save the pixels, resize to the element's CSS box, then put them back
    let img = null;
    try { img = wbCtx.getImageData(0, 0, c.width, c.height); } catch (e) {}
    c.width = c.offsetWidth;
    c.height = c.offsetHeight;
    wbCtx.lineCap = 'round';
    wbCtx.lineJoin = 'round';
    if (img) {
      try { wbCtx.putImageData(img, 0, 0); } catch (e) {}
    }
  }

  function wbDrawSegment(x1, y1, x2, y2, color, size, tool) {
    const c = wbCanvas;
    const ctx = wbCtx;
    if (!c || !ctx) return;
    ctx.save();
    if (tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = color;
    }
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.moveTo(x1 * c.width, y1 * c.height);
    ctx.lineTo(x2 * c.width, y2 * c.height);
    ctx.stroke();
    ctx.restore();
  }

  function wbOnDown(e) {
    if (!wbCanDraw || !wbOpen) return;
    try { wbCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    wbDrawing = true;
    const p = wbPoint(e);
    wbLastX = p.x;
    wbLastY = p.y;
  }

  function wbOnMove(e) {
    if (!wbDrawing) return;
    const p = wbPoint(e);
    wbDrawSegment(wbLastX, wbLastY, p.x, p.y, wbColor, wbSize, wbTool);
    if (wbSocket) {
      wbSocket.emit(BMEv.WB_DRAW, {
        x1: wbLastX, y1: wbLastY, x2: p.x, y2: p.y,
        color: wbColor, size: wbSize, tool: wbTool,
      });
    }
    wbLastX = p.x;
    wbLastY = p.y;
  }

  function wbOnUp() {
    wbDrawing = false;
  }

  function wbShow(el, show) {
    if (!el) return;
    el.classList.toggle('hidden', !show);
  }

  // Renders the admin grant/revoke panel from the live room roster.
  function bmWbRenderGrantList(granted) {
    const list = $('wb-grant-list');
    if (!list) return;
    const gset = Array.isArray(granted) ? granted : [];
    const roster = (window.bmCallRoster && window.bmCallRoster()) || [];
    const rows = [];
    roster.forEach(function (m) {
      if (!m || m.userId === wbMyId) return;
      if (m.status && m.status !== 'approved') return;
      const on = gset.indexOf(m.userId) !== -1;
      const label = on ? 'گرفتن دسترسی' : 'دادن دسترسی';
      const fn = on ? 'bmWbRevoke' : 'bmWbGrant';
      const cls = on
        ? 'px-2.5 py-1 rounded-lg text-[11px] font-medium bg-error-container text-on-error-container'
        : 'px-2.5 py-1 rounded-lg text-[11px] font-medium bg-primary-container text-on-primary-container';
      rows.push(
        '<div class="flex items-center justify-between gap-2 py-1.5 border-b border-white/5 last:border-0">' +
          '<span class="text-[12px] text-on-surface truncate">' + String(m.name || ('کاربر ' + m.userId)).replace(/</g, '&lt;') + '</span>' +
          '<button type="button" class="' + cls + '" onclick="' + fn + '(' + Number(m.userId) + ')">' + label + '</button>' +
        '</div>'
      );
    });
    list.innerHTML = rows.length ? rows.join('') : '<p class="text-[12px] text-on-surface-variant">عضو دیگری در اتاق نیست</p>';
  }

  // UI update shared by the live WB_STATE event and the late-joiner sync.
  function bmWbApplyState(d) {
    wbOpen = !!(d && d.open);
    const granted = (d && d.granted) ? d.granted : [];
    const I = window.INIT;
    wbIsAdmin = !!(I && I.me && I.me.is_admin);
    wbCanDraw = wbIsAdmin || granted.indexOf(wbMyId) !== -1;

    if (wbOpen) {
      // auto-switch the sidebar to the whiteboard tab the moment it opens
      if (!wbWasOpen) {
        wbWasOpen = true;
        if (typeof window.switchTab === 'function') window.switchTab('wb');
        if (typeof window.toggleSidebar === 'function') window.toggleSidebar(true);
      }
      const badge = $('wb-viewer-badge');
      wbShow(badge, !wbCanDraw);
      wbShow($('wb-toolbar'), wbCanDraw);
      if (wbIsAdmin) {
        wbShow($('wb-btn-clear'), true);
        wbShow($('wb-admin-panel'), true);
        bmWbRenderGrantList(granted);
      } else {
        wbShow($('wb-btn-clear'), false);
        wbShow($('wb-admin-panel'), false);
      }
      if (wbCanvas) wbCanvas.style.pointerEvents = wbCanDraw ? 'auto' : 'none';
      const wbb = $('btn-wb');
      if (wbb) wbb.classList.add('ctrl-live');
    } else {
      wbWasOpen = false;
      wbCanDraw = false;
      const wbbOff = $('btn-wb');
      if (wbbOff) wbbOff.classList.remove('ctrl-live');
      // closing the board hides the panel again; when the whiteboard tab was the one
      // on screen we return to the members section instead of leaving an empty pane
      const wbPanel = $('content-wb');
      if (wbPanel && !wbPanel.classList.contains('hidden') && typeof window.switchTab === 'function') {
        window.switchTab('members');
      }
      wbShow(wbPanel, false);
      if (wbCtx && wbCanvas) wbCtx.clearRect(0, 0, wbCanvas.width, wbCanvas.height);
      wbShow($('wb-toolbar'), false);
      wbShow($('wb-admin-panel'), false);
      wbShow($('wb-viewer-badge'), false);
      if (wbCanvas) wbCanvas.style.pointerEvents = 'none';
    }
  }

  // ---------- public API ----------

  window.bmWbInit = function () {
    const I = window.INIT;
    wbMyId = I && I.me ? I.me.id : null;
    wbCanvas = $('wb-canvas');
    if (!wbCanvas) return;
    wbCtx = wbCanvas.getContext('2d');
    wbCtx.lineCap = 'round';
    wbCtx.lineJoin = 'round';
    wbResizeCanvas();

    if (typeof ResizeObserver !== 'undefined' && wbCanvas.parentElement) {
      const ro = new ResizeObserver(function () { wbResizeCanvas(); });
      ro.observe(wbCanvas.parentElement);
    }

    wbCanvas.addEventListener('pointerdown', wbOnDown);
    wbCanvas.addEventListener('pointermove', wbOnMove);
    wbCanvas.addEventListener('pointerup', wbOnUp);
    wbCanvas.addEventListener('pointercancel', wbOnUp);
  };

  window.bmWbSocketBind = function (socket) {
    wbSocket = socket;
    if (!wbSocket) return;

    wbSocket.on(BMEv.WB_STATE, function (d) {
      bmWbApplyState(d);
    });

    wbSocket.on(BMEv.WB_DRAW, function (d) {
      if (!d) return;
      wbDrawSegment(d.x1, d.y1, d.x2, d.y2, d.color, d.size, d.tool);
    });

    wbSocket.on(BMEv.WB_CLEAR, function () {
      if (wbCtx && wbCanvas) wbCtx.clearRect(0, 0, wbCanvas.width, wbCanvas.height);
    });

    // late joiner: CALL_WELCOME carries the full canvas
    wbSocket.on(BMEv.CALL_WELCOME, function (d) {
      if (d && d.wb && d.wb.open) window.bmWbApplySync(d.wb);
    });
  };

  window.bmWbApplySync = function (wbData) {
    if (!wbData || !wbData.open) return;
    wbOpen = true;
    const granted = wbData.granted || [];
    const I = window.INIT;
    wbIsAdmin = !!(I && I.me && I.me.is_admin);
    wbCanDraw = wbIsAdmin || granted.indexOf(wbMyId) !== -1;
    (wbData.strokes || []).forEach(function (s) {
      wbDrawSegment(s.x1, s.y1, s.x2, s.y2, s.color, s.size, s.tool);
    });
    // trigger a WB_STATE-style UI update
    bmWbApplyState({ open: true, granted: granted });
  };

  window.bmWbToggle = function () {
    if (!wbSocket) return;
    wbSocket.emit(wbOpen ? BMEv.WB_CLOSE : BMEv.WB_OPEN);
  };

  window.bmWbClear = function () {
    if (!wbSocket) return;
    wbSocket.emit(BMEv.WB_CLEAR);
  };

  window.bmWbSetTool = function (tool) {
    wbTool = tool;
    const pen = $('wb-btn-pen');
    const eraser = $('wb-btn-eraser');
    if (pen) pen.classList.toggle('ctrl-live', tool === 'pen');
    if (eraser) eraser.classList.toggle('ctrl-live', tool === 'eraser');
  };

  window.bmWbSetColor = function (color) { wbColor = color; };

  window.bmWbSetSize = function (size) { wbSize = size; };

  window.bmWbGrant = function (userId) {
    if (!wbSocket) return;
    wbSocket.emit(BMEv.WB_GRANT, { userId: userId });
  };

  window.bmWbRevoke = function (userId) {
    if (!wbSocket) return;
    wbSocket.emit(BMEv.WB_REVOKE, { userId: userId });
  };
})();
