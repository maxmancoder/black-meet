// assets/js/notify.js — OS notifications for chat messages + the "new message" chime.
//
// The owner's requirement: when a message arrives while the user is NOT on the call tab
// (they switched to another tab / another window) the operating system must raise a real
// notification with the message text and the sender's name, and it must make the Android
// notification sound.
//
// Rules implemented here (all of them matter):
//  * never notify the tab the user is actually LOOKING at — every BM page beats a heartbeat
//    into localStorage, so a hidden call tab knows that the /home tab next to it is visible
//    and stays quiet instead of popping a notification over a call the user is watching;
//  * never notify twice for the same message (a stable `tag` + a shared localStorage guard,
//    so two hidden pages cannot double-notify or double-chime);
//  * use a service worker where the page API is unavailable (Android Chrome throws on
//    `new Notification`);
//  * the sound is synthesised with the Web Audio API — no audio file, no CDN (both are
//    blocked/unreliable in Iran) — and follows the two-note Android notification chime.
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var BASE = window.BASE || '/black-meet';
  var LS_TABS = 'bm_visible_tabs';
  var LS_SEEN = 'bm_notif_seen';

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v || fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* private mode */ }
  }

  /* ------------------------------------------------------------------ visible tab */
  // One tab per browser can be visible at a time; every page writes its own heartbeat while
  // it is visible and drops it when it is hidden.
  var tabId = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  var TTL = 7000;

  function beat() {
    var map = readJSON(LS_TABS, {});
    var now = Date.now();
    var dirty = false;
    Object.keys(map).forEach(function (k) {
      if (!map[k] || now - map[k] > TTL) { delete map[k]; dirty = true; }
    });
    if (document.visibilityState === 'visible') {
      if (map[tabId] !== now) { map[tabId] = now; dirty = true; }
    } else if (map[tabId]) {
      delete map[tabId];
      dirty = true;
    }
    if (dirty) writeJSON(LS_TABS, map);
  }
  function anotherTabVisible() {
    var map = readJSON(LS_TABS, {});
    var now = Date.now();
    return Object.keys(map).some(function (k) {
      return k !== tabId && map[k] && now - map[k] <= TTL;
    });
  }
  beat();
  setInterval(beat, 2500);
  document.addEventListener('visibilitychange', beat);
  window.addEventListener('focus', beat);
  window.addEventListener('pagehide', function () {
    var map = readJSON(LS_TABS, {});
    if (map[tabId]) { delete map[tabId]; writeJSON(LS_TABS, map); }
  });
  window.bmAnotherTabVisible = anotherTabVisible;

  /* ------------------------------------------------------------------ sound */
  var ctx = null;
  function audioCtx() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch (e) { ctx = null; }
    return ctx;
  }
  function unlockAudio() {
    var c = audioCtx();
    if (c && c.state === 'suspended') c.resume().catch(function () {});
  }

  // Two soft bell notes a fifth apart, each with a quick attack and a long fade — the shape
  // of Android's default notification chime. Kept short (≈0.6 s) so it never talks over a
  // call, and quiet (0.35) for the same reason.
  window.bmNotifySound = function () {
    var c = audioCtx();
    if (!c) return false;
    if (c.state === 'suspended') c.resume().catch(function () {});
    var t0 = c.currentTime + 0.02;
    var master = c.createGain();
    master.gain.value = 0.35;
    var lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5600;
    master.connect(lp);
    lp.connect(c.destination);
    [[880, 0, 0.6], [1318.5, 0.15, 0.5]].forEach(function (note) {
      var freq = note[0], at = t0 + note[1], life = note[2];
      [1, 2].forEach(function (mult, i) {
        var osc = c.createOscillator();
        var gain = c.createGain();
        osc.type = i === 0 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq * mult, at);
        var peak = i === 0 ? 0.9 : 0.22;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + life);
        osc.connect(gain);
        gain.connect(master);
        osc.start(at);
        osc.stop(at + life + 0.05);
      });
    });
    return true;
  };

  /* ------------------------------------------------------------------ permission */
  function perm() {
    return (typeof Notification === 'undefined') ? 'unsupported' : Notification.permission;
  }
  var askCount = 0;
  function ask() {
    if (perm() !== 'default') return;
    if (askCount >= 3) return;
    askCount++;
    try {
      var p = Notification.requestPermission(function () { /* legacy callback form */ });
      if (p && p.then) p.then(function () { /* granted/denied */ }).catch(function () {});
    } catch (e) { /* some browsers need the callback form only */ }
  }
  function onGesture() { unlockAudio(); ask(); }
  ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(function (ev) {
    window.addEventListener(ev, onGesture, { passive: true });
  });

  window.bmNotifyPermission = perm;
  window.bmNotifyAsk = ask;

  /* ------------------------------------------------------------------ service worker */
  var swReady = null;
  function swReg() {
    if (swReady) return swReady;
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      swReady = Promise.resolve(null);
      return swReady;
    }
    swReady = navigator.serviceWorker.register(BASE + '/sw.js', { scope: BASE + '/' })
      .then(function (reg) { return reg; })
      .catch(function () { return null; });
    return swReady;
  }
  // warm it up on load so the first message does not wait for registration
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { swReg(); });
  } else {
    swReg();
  }

  /* ------------------------------------------------------------------ show */
  function seenRecently(tag) {
    var map = readJSON(LS_SEEN, {});
    var now = Date.now();
    var dirty = false;
    Object.keys(map).forEach(function (k) {
      if (!map[k] || now - map[k] > 90000) { delete map[k]; dirty = true; }
    });
    var hit = !!map[tag];
    if (!hit) { map[tag] = now; dirty = true; }
    if (dirty) writeJSON(LS_SEEN, map);
    return hit;
  }

  function display(title, body, url, tag) {
    var icon = window.BM_SITE_ICON || '';
    var opts = {
      body: String(body || ''),
      tag: tag,
      renotify: false,
      silent: true,            // our own chime; never the OS one on top of it
      dir: 'rtl',
      lang: 'fa',
      data: { url: url },
    };
    if (icon) { opts.icon = icon; opts.badge = icon; }
    swReg().then(function (reg) {
      if (reg && typeof reg.showNotification === 'function') {
        return reg.showNotification(String(title || 'پیام جدید'), opts);
      }
      try {
        var n = new Notification(String(title || 'پیام جدید'), opts);
        n.onclick = function () {
          try { window.focus(); } catch (e) { /* noop */ }
          if (url) { try { window.location.href = url; } catch (e) { /* noop */ } }
          n.close();
        };
        return null;
      } catch (e) { return null; }
    }).catch(function () { /* notifications are best-effort, never fatal */ });
  }

  /**
   * bmNotify({ title, body, url, tag, force, silent })
   *  - `force: true`  → show even if this tab is visible (used by explicit UI)
   *  - `tag`          → stable id; the same tag is shown + chimed once
   * Returns true when a notification was raised.
   */
  window.bmNotify = function (o) {
    o = o || {};
    if (!o.force) {
      if (document.visibilityState === 'visible' || !document.hidden) return false;
      if (anotherTabVisible()) return false;
    }
    var tag = String(o.tag || ('bm-' + (o.body || '').slice(0, 40) + '-' + Math.floor(Date.now() / 60000)));
    if (seenRecently(tag)) return false;
    if (perm() !== 'granted') { ask(); return false; }
    if (o.silent !== true) window.bmNotifySound();
    var url = o.url ? String(o.url) : (BASE + '/messages');
    display(o.title || 'پیام جدید', o.body || '', url, tag);
    return true;
  };
})();
