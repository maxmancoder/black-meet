// assets/js/live.js — Phase 1: ONE shared authenticated realtime connection per page.
// Handshake-authenticated (user token from api/socket-token), heartbeat,
// connection status events, bm-event bridging. No polling fallbacks.
(function () {
  'use strict';
  var handlers = {};   // ev -> [fn]
  var socket = null;
  var started = false;
  var joined = {};     // bm room -> true
  var authed = false;
  var heartbeatTimer = null;
  var wedgedSince = null;

  var EV = window.BMEv;

  function on(ev, fn) {
    (handlers[ev] = handlers[ev] || []).push(fn);
    if (socket && socket.connected) bindOne(ev);
    return function off() {
      handlers[ev] = (handlers[ev] || []).filter(function (f) { return f !== fn; });
    };
  }
  function emitLocal(ev, data) {
    (handlers[ev] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { /* keep other handlers alive */ }
    });
  }

  function bindAll() {
    if (!socket) return;
    Object.keys(handlers).forEach(bindOne);
  }
  function bindOne(ev) {
    var key = (ev.indexOf('bm:') === 0) ? ev : EV.BM_EVENT; // announcements use bm:event envelope
    socket.off(key);
    socket.on(key, function (data) {
      if (key === EV.BM_EVENT && data && data.event) emitLocal('bm:' + data.event, data.data);
      else emitLocal(ev, data);
    });
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (socket && socket.connected) socket.emit(EV.PRESENCE_PING);
    }, 25000);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function connect() {
    if (window.__BM_LIVE_URL === null) return;      // page opted out entirely
    var url = window.__BM_LIVE_URL || undefined;    // '' → same origin (proxied)

    // fetch a per-user token, then connect with it (handshake auth is mandatory)
    fetch((window.BASE || '') + '/api/socket-token')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !d.token) { emitLocal('live:error', { error: 'NO_TOKEN' }); return; }
        openSocket(url, d.token);
      })
      .catch(function () {
        // token endpoint unreachable (e.g. logged out): retry quietly
        setTimeout(connect, 8000);
      });
  }

  function openSocket(url, token) {
    // forceNew: never reuse a cached Manager — a manager wedged on a dead sid
    // (e.g. after a server restart) would otherwise fail forever.
    socket = io(url, {
      auth: { token: token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
      timeout: 15000,
      forceNew: true
    });
    window.BM_SOCKET = socket;

    socket.on('connect', function () {
      emitLocal('live:connected', true);
      emitLocal('conn:state', { state: 'connected' });
      bindAll();
      Object.keys(joined).forEach(function (room) { socket.emit(EV.BM_SUBSCRIBE, { room: room }); });
      startHeartbeat();
    });
    socket.on('disconnect', function () {
      emitLocal('live:disconnected', true);
      emitLocal('conn:state', { state: 'disconnected' });
      stopHeartbeat();
    });
    socket.on('reconnect_attempt', function () {
      emitLocal('conn:state', { state: 'reconnecting' });
    });
    socket.on('connect_error', function (err) {
      // UNAUTHORIZED at handshake → token expired: fetch a fresh one once
      if (String(err && err.message).indexOf('UNAUTHORIZED') >= 0 && !authed) {
        authed = true;
        stopHeartbeat();
        if (socket) socket.close();
        setTimeout(function () { authed = false; connect(); }, 500);
      } else {
        emitLocal('conn:state', { state: 'reconnecting' });
      }
    });

    // forward presence events to page handlers
    EV.ALL.forEach(function (ev) {
      if (ev === EV.BM_EVENT) return;
      socket.on(ev, function (data) { emitLocal(ev, data); });
    });
  }

  // watchdog: if the socket stays disconnected >10s (wedged engine, dead sid),
  // tear the whole manager down and rebuild with a fresh token.
  setInterval(function () {
    if (socket && !socket.connected) {
      wedgedSince = wedgedSince || Date.now();
      if (Date.now() - wedgedSince > 10000) {
        wedgedSince = null;
        stopHeartbeat();
        try { if (socket.io && typeof socket.io.destroy === 'function') socket.io.destroy(); else socket.io.disconnect(); } catch (e) { /* noop */ }
        socket = null;
        connect();
      }
    } else {
      wedgedSince = null;
    }
  }, 5000);

  function subscribe(room) {
    if (!room) return;
    joined[room] = true;
    if (socket && socket.connected) socket.emit(EV.BM_SUBSCRIBE, { room: room });
  }

  window.BMLive = {
    on: on,
    subscribe: subscribe,
    socket: function () { return socket; },
    isLive: function () { return !!(socket && socket.connected); }
  };

  function start() {
    if (started) return;
    started = true;
    if (typeof io === 'undefined' || typeof window.BMEv === 'undefined') {
      setTimeout(start, 5000); // socket.io script not loaded yet — retry quietly
      return;
    }
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
