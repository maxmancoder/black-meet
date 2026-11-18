// assets/js/call.js — Phase 1: realtime call page
// - handshake-authenticated socket, single `call:join` path
// - perfect negotiation (polite/impolite) + ICE restart recovery
// - incremental member events (member:joined/left/updated/...)
// - admin actions via one socket path (server → PHP → DB → broadcast)
(function () {
  const I = window.INIT;
  const EV = window.BMEv;
  // Fallback only — the server hands the real list in INIT.iceServers (STUN + TURN).
  // A relay is NOT optional: without one, two people on different networks (mobile
  // data vs home wifi, CGNAT, symmetric NAT) never connect and the call is silent
  // in both directions with no error at all.
  const ICE = (I && I.iceServers && I.iceServers.length) ? I.iceServers : [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:turn.jami.net:3478?transport=udp', 'turn:turn.jami.net:3478?transport=tcp'], username: 'ring', credential: 'ring' },
  ];
  const EMOJIS = ['👍', '❤️', '👏', '😂', '🎉', '😮', '🔥', '✅', '🙏', '💡', '😎', '🌟'];

  // ---------- media playback (browser autoplay policy) ----------
  // A <video>/<audio> with SOUND never starts on its own unless the visitor has already
  // interacted with the page: Chrome blocks play() silently, the tile stays black/silent
  // and a page refresh "fixes" it only because clicking refresh unlocked playback.
  // Remember what is blocked and retry on every gesture until it really plays.
  const pendingPlay = new Set();
  let playHintShown = false;
  function tryPlay(v) {
    if (!v || !v.srcObject) return;
    let p;
    try { p = v.play(); } catch (e) { return; }
    if (!p || !p.then) return;
    p.then(() => { pendingPlay.delete(v); })
      .catch(() => {
        pendingPlay.add(v);
        if (!playHintShown && !v.muted) {
          playHintShown = true;
          showToast('برای پخش صدا و تصویر، یک‌بار روی صفحه کلیک کنید');
        }
      });
  }
  function flushPendingPlays() {
    if (!pendingPlay.size) return;
    Array.from(pendingPlay).forEach((v) => {
      if (!v.isConnected) { pendingPlay.delete(v); return; }
      tryPlay(v);
    });
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
    document.addEventListener(ev, flushPendingPlays, { passive: true, capture: true });
    // the silent keepalive track lives in an AudioContext, which starts suspended
    // until the page is touched — a suspended one sends nothing, so resume it too
    document.addEventListener(ev, () => { if (window.bmResumeSilence) window.bmResumeSilence(); }, { passive: true, capture: true });
  });

  let socket = null;
  let localStream = null;
  let cameraTrack = null;
  let screenTrack = null;
  let screenAudioTrack = null;
  let shareAudio = false;
  let currentVideoTrack = null;
  let micOn = false, camOn = false, sharing = false;
  let approved = (I.me.status === 'approved');
  const defaultMedia = !(I.meeting && I.meeting.default_media === 0);

  const pcMap = new Map();        // userId -> { pc, polite, makingOffer, ignoreOffer, srdAnswerPending }
  // the peer connections, exposed for the test suite (and for debugging in the console)
  window.__bmPcMap = pcMap;
  const peerMeta = new Map();     // userId -> {name, avatar_color, avatar}
  const memberStatus = new Map(); // userId -> {muted,cam,sharing}
  const memberInfo = new Map();    // userId -> {full_name,email,phone,is_manager,role,has_password,...}
  const memberNames = new Map();  // userId -> display name
  const localBlock = {};          // userId -> {audio,video,screen} (per-viewer local blocks)
  const localAudio = {};          // userId -> {muted, volume}
  // admin-applied LOCKS on MY controls: locked = admin disabled it and only the
  // admin can re-enable (their "روشن" = unlock, it never turns things on for me)
  const locks = { audio: false, video: false, screen: false };
  const remoteStreams = new Map();
  let menuUserId = null;
  let currentList = [];
  // members the viewer has already seen in the members/admin panel — the dot on the
  // members key means "somebody new is in the room", not "somebody is still pending"
  const seenMemberIds = new Set();
  let joinedRoom = false;

  // ---- box visibility ----
  // Feature 1 (per-user, local): show/hide member tiles in the main stage. Default: show.
  // Stored locally so it only affects this user on this device.
  let localShowMembers = true;
  try { localShowMembers = localStorage.getItem('bm_call_show_members') !== '0'; } catch (e) {}

  // Feature 2 (room-wide, admin-controlled): which stage boxes everyone sees.
  // hidden = set of box keys ('web', 'wb', or String(userId)). All visible by default.
  let adminBoxes = { showNew: true, hidden: new Set() };

  function isMemberTile(el) {
    return !!(el && el.id && (el.id === 'tile-self' || el.id.indexOf('tile-') === 0));
  }
  function boxKeyOf(el) {
    if (!el || !el.id) return '';
    if (el.id === 'web-box') return 'web';
    if (el.id === 'wb-box') return 'wb';
    if (el.id === 'tile-self') return String(I.me.id);
    if (el.id.indexOf('tile-') === 0) return String(el.id.slice(5));
    return '';
  }
  function isSharingTile(el) {
    if (!el || !el.id) return false;
    if (el.id === 'tile-self') return !!sharing;
    if (el.id.indexOf('tile-') === 0) {
      const uid = parseInt(el.id.slice(5), 10);
      const st = memberStatus.get(uid) || {};
      return !!st.sharing;
    }
    return false;
  }
  function isBoxVisible(el) {
    if (!el) return false;
    const key = boxKeyOf(el);
    // admin control applies to every stage box
    if (key && adminBoxes.hidden.has(key)) return false;
    // local "hide member boxes" (feature 1): only member tiles, but keep a sharer's box
    if (isMemberTile(el) && !localShowMembers && !isSharingTile(el)) return false;
    return true;
  }

  function setAdminBoxesState(boxes) {
    boxes = boxes || {};
    adminBoxes.showNew = boxes.showNew !== false;
    const h = boxes.hidden;
    if (h instanceof Set) adminBoxes.hidden = new Set(Array.from(h).map(String));
    else if (Array.isArray(h)) adminBoxes.hidden = new Set(h.map(String));
    else adminBoxes.hidden = new Set();
  }
  const SELF = {
    userId: I.me.id, name: I.me.name, username: I.me.username,
    avatar_color: I.me.avatar_color, avatar: String(I.me.avatar || ''),
    is_admin: !!I.me.is_admin, status: I.me.status || 'pending',
    muted: false, cam: false, sharing: false,
  };

  // ---- roster helpers: currentList always includes SELF so the counter is exact.
  function normalizeMember(m) {
    return {
      userId: m.userId, name: m.name, username: m.username || '',
      avatar_color: m.avatar_color, avatar: String(m.avatar || ''),
      is_admin: !!m.is_admin, status: m.status === 'approved' ? 'approved' : 'pending',
      muted: !!m.muted, cam: m.cam !== false, sharing: !!m.sharing,
      locks: m.locks || null,
    };
  }
  function upsertMember(m) {
    m = normalizeMember(m);
    const i = currentList.findIndex(x => x.userId === m.userId);
    if (i < 0) { currentList.push(m); return m; }
    // merge field by field: a partial update (a bare {userId} or a patch) must never
    // wipe a name/status we already know. `Object.assign` used to overwrite `name` with
    // undefined and reset an approved member to "pending", which removed them from the
    // whiteboard grant list and the admin panel.
    const merged = Object.assign({}, currentList[i]);
    Object.keys(m).forEach((k) => { if (m[k] !== undefined) merged[k] = m[k]; });
    currentList[i] = merged;
    return merged;
  }
  function dropMember(userId) {
    currentList = currentList.filter(x => (x.userId !== userId));
  }

  const $ = id => document.getElementById(id);
  const grid = $('video-grid');

  function showToast(msg) {
    const t = $('toast'); $('toast-message').textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
  }
  window.showToast = showToast;

  function playBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.value = 0.15;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 250);
    } catch (e) {}
  }

  window.alertAdmin = function () {
    if (socket) socket.emit(EV.CALL_ALERT_ADMIN);
    playBeep();
    showToast('درخواست ورود به ادمین ارسال شد');
  };

  window.adminBlock = function (userId) {
    if (socket) socket.emit(EV.CALL_BLOCK, { userId });
    showToast('کاربر از این تماس مسدود شد');
  };

  // ---------- Media ----------
  // Audio and camera are requested SEPARATELY so a missing or denied camera
  // never kills the microphone. Local tracks are added to each peer after both.
  function looksVirtual(label) {
    return /vcam|virtual|obs|manycam|droidcam|snap\s?camera|iriun|epoccam|ndi|camlink|dummy/i.test(label || '');
  }
  function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices()
      .then(ds => ds.filter(d => d.kind === 'videoinput'))
      .catch(() => []);
  }
  // a virtual camera (VCam/OBS/…) can be the OS default — prefer a real one
  function preferRealCamera() {
    return listCameras().then(cams => {
      const real = cams.find(d => d.deviceId && !looksVirtual(d.label));
      if (!real) return null;
      return navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { exact: real.deviceId } }
      }).then(s => s.getVideoTracks()[0] || null).catch(() => null);
    }).catch(() => null);
  }
  function pickCameraConstraint() {
    return listCameras().then(cams => {
      const real = cams.find(d => d.deviceId && !looksVirtual(d.label));
      if (real) return { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { exact: real.deviceId } };
      return { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };
    }).catch(() => ({ width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }));
  }
  // ---------- microphone noise suppression (ON by default, three strengths) ----------
  // The browser's own `noiseSuppression` constraint only removes STATIONARY noise, and
  // `autoGainControl: true` worked against us: in the quiet gaps it raised the input gain
  // so far that the room (fan, street, keyboard) became LOUDER than the speaker. So the
  // real filtering now happens in Web Audio, on the OUTGOING track:
  //
  //   mic -> highpass -> voice gate/expander -> lowpass -> peers
  //
  //   * highpass/lowpass keep only the speech band (rumble + hiss/air noise removed)
  //   * the gate asks a PITCH question, not a level question: is the last 21 ms periodic
  //     like a voice, or aperiodic like a room? A fan/AC/street/keyboard is aperiodic at
  //     ANY level, so it is muted even when it is as loud as the speaker. A level-only
  //     gate can never do that, and the room's own level is learned separately so the
  //     threshold adapts to whatever microphone gain the caller has.
  //   * there is no compressor: Chrome's compressor applies ~+10 dB of internal makeup to
  //     quiet material, which is exactly what made the room louder than the voice.
  //   * autoGainControl AND the browser noise suppressor are OFF: both pump the level.
  //
  // If Web Audio is unavailable the constraint path still applies (weaker, but sound).
  const NS_LEVELS = {
    // openDb: how far above the room's floor the gate opens; ratio: expander steepness
    // floorDb also sets the noise cap: the room is held at floor*8 (-16/-34/-46 dB).
    // makeupDb stays 0: the chain must never make the speaker LOUDER than the raw mic.
    soft:   { hp: 95,  lp: 11000, minThrDb: -50, maxThrDb: -26, openDb: 6,  floorDb: -34, ratio: 3, makeupDb: 0 },
    strong: { hp: 130, lp: 7600,  minThrDb: -46, maxThrDb: -19, openDb: 10, floorDb: -52, ratio: 5, makeupDb: 0 },
    max:    { hp: 175, lp: 6200,  minThrDb: -42, maxThrDb: -16, openDb: 13, floorDb: -64, ratio: 8, makeupDb: 0 },
  };
  let noiseSuppression = (localStorage.getItem('bm_noise_suppression') !== '0');
  let noiseLevel = localStorage.getItem('bm_noise_level');
  if (!NS_LEVELS[noiseLevel]) noiseLevel = 'strong';
  window.bmNoiseSuppressionOn = function () { return noiseSuppression; };
  window.bmNoiseLevel = function () { return noiseLevel; };
  function nsCfg() { return NS_LEVELS[noiseLevel] || NS_LEVELS.strong; }
  function nsLabel() { return noiseLevel === 'soft' ? 'ملایم' : noiseLevel === 'max' ? 'حداکثر' : 'قوی'; }
  function dbToGain(db) { return Math.pow(10, db / 20); }

  function audioConstraints() {
    // `noiseSuppression: true` (the browser/OS suppressor) is deliberately OFF whenever our
    // own chain is active. Measured in Chrome: it chops the room up and down (the same fan
    // alternates between -30 and -60 dBFS), so the adaptive gate cannot find a floor in it
    // and the bursts it lets through arrive at full level - the room was audibly louder than
    // the voice. One suppressor, and it is ours.
    return {
      audio: {
        echoCancellation: noiseSuppression ? true : false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    };
  }

  // ---- the gate itself (AudioWorklet; ScriptProcessor as a fallback) ----
  // Every 5 ms two independent opinions decide whether the microphone is picking up a
  // VOICE or the ROOM:
  //
  //   1. harmonicity - a normalised autocorrelation over voice pitch lags (80…1000 Hz) of
  //      the last ~21 ms of audio. A voice is periodic (score > 0.3); a fan, AC, street,
  //      keyboard, crowd murmur or room rumble is not (white noise scores ~0.06). This is
  //      what lets the gate mute a room that is just as LOUD as the speaker - something no
  //      level-based gate can ever do.
  //   2. syllables - a level that jumps around inside 0.3 s (dev/slow > 0.3) while sitting
  //      far above the learned room (thr * 4) is speech even when the pitch detector cannot
  //      lock: whispering, a breathy voice, a clipped input. Trusted only once the room has
  //      been learned, so a breathing fan at the very start of a call cannot use it.
  //
  // The room's own level is learned ONLY from frames that are not speech (a 3 s ring, read
  // back as its 60th percentile), so speech can never become the "floor", however loud the
  // speaker is or however the microphone is gained. The threshold is floor * openDb.
  //
  // Decisions:
  //   * voice            -> gain 1 (fully open), 120 ms hold after it ends
  //   * 250 ms after it  -> gain 0.3 (-10 dB) so unvoiced consonants stay audible
  //   * anything else    -> expander below the threshold, hard-capped at floor * 8
  //                         (-16 dB soft / -34 dB strong / -46 dB max)
  // The gain is ramped inside every block (no zipper noise) and is NEVER above 1: the
  // chain can only attenuate, so the speaker can never end up louder than the raw mic.
  //
  // NOTE the core is a plain class: the worklet wraps it and the ScriptProcessor fallback
  // instantiates the very same code, so the two can never drift apart.
  const GATE_CORE_SRC = `
class BmGateCore {
  constructor(sr) {
    this.sr = sr || 48000;
    this.winLen = 0;
    this.hist = null;
    this.histPos = 0;
    this.histFill = 0;
    this.lin = null;
    this.dec = null;
    this.cum = null;
    this.med = null;
    this.blockSec = 0;
    this.env = 0;
    this.gain = 1;
    this.target = 1;
    this.hold = 0;
    this.softHold = 0;
    this.harm = 0;
    this.devRatio = 0;
    this.slow = 0;
    this.dev = 0;
    this.floorEst = 0;
    this.ring = null;
    this.ringLen = 0;
    this.ringPos = 0;
    this.ringUsed = 0;
    this.tick = 0;
    this.age = 0;
    this.acc = 0;
    this.hopLen = 0;
    this.hopSec = 0;
    this.blockAtk = 0;
    this.blockRel = 0;
    this.gAtk = 0;
    this.gRel = 0;
    this.holdLen = 1;
    this.softLen = 1;
    this.slowK = 0;
    this.voicedCount = 0;
  }
  init(n) {
    const bs = Math.max(1, n) / this.sr;
    this.blockSec = bs;
    this.winLen = Math.max(n * 2, Math.round(0.021 * this.sr));
    this.hist = new Float32Array(this.winLen);
    this.lin = new Float32Array(this.winLen);
    const half = Math.ceil(this.winLen / 2);
    this.dec = new Float32Array(half);
    this.cum = new Float32Array(half + 1);
    this.ringLen = Math.max(16, Math.round(3 / bs));
    this.ring = new Float32Array(this.ringLen);
    this.med = new Float32Array(this.ringLen);
    this.hopLen = Math.max(n, Math.round(0.005 * this.sr));
    this.hopSec = this.hopLen / this.sr;
    this.blockAtk = 1 - Math.exp(-bs / 0.003);
    this.blockRel = 1 - Math.exp(-bs / 0.080);
    this.gAtk = 1 - Math.exp(-bs / 0.005);
    this.gRel = 1 - Math.exp(-bs / 0.140);
    this.holdLen = Math.max(1, Math.round(0.12 / this.hopSec));
    this.softLen = Math.max(1, Math.round(0.25 / this.hopSec));
    this.slowK = 1 - Math.exp(-this.hopSec / 0.30);
  }
  kth(k, m) {
    const a = this.med;
    let lo = 0, hi = m - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1];
      let i = lo, j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else break;
    }
    return a[k];
  }
  ringValue(pct) {
    const m = this.ringUsed;
    if (m <= 0) return 0;
    for (let i = 0; i < m; i++) this.med[i] = this.ring[i];
    return this.kth(Math.min(m - 1, Math.floor(m * pct)), m);
  }
  thrFor(p) {
    if (!(this.floorEst > 0)) return p.minThr;
    let thr = this.floorEst * p.openK;
    if (thr < p.minThr) thr = p.minThr;
    if (thr > p.maxThr) thr = p.maxThr;
    return thr;
  }
  // Normalised autocorrelation peak over voice pitch lags (80…1000 Hz). 2:1 decimation
  // keeps this under ~50k multiply-adds per analysis; cumulative energy makes the
  // normalisation free.
  pitchScore() {
    const half = this.winLen >> 1;
    const d = this.dec;
    const lin = this.lin;
    for (let i = 0; i < half; i++) d[i] = (lin[2 * i] + lin[2 * i + 1]) * 0.5;
    let mean = 0;
    for (let i = 0; i < half; i++) mean += d[i];
    mean /= half;
    const c = this.cum;
    c[0] = 0;
    for (let i = 0; i < half; i++) {
      const v = d[i] - mean;
      d[i] = v;
      c[i + 1] = c[i] + v * v;
    }
    if (!(c[half] > 1e-7)) return 0;
    const sr2 = this.sr / 2;
    const lo = Math.max(2, Math.floor(sr2 / 1000));
    const hi = Math.min(half - 24, Math.ceil(sr2 / 80));
    let best = 0;
    for (let L = lo; L <= hi; L += 2) {
      const w = half - L;
      if (w < 24) break;
      let num = 0;
      for (let i = 0; i < w; i++) num += d[i] * d[i + L];
      const den = Math.sqrt(c[w] * (c[half] - c[L])) + 1e-12;
      const r = num / den;
      if (r > best) best = r;
    }
    return best > 1 ? 1 : best;
  }
  decide(p) {
    const W = this.winLen;
    const hist = this.hist;
    const lin = this.lin;
    let o = this.histPos;
    for (let i = 0; i < W; i++) { lin[i] = hist[o]; o++; if (o >= W) o = 0; }
    let s = 0;
    for (let i = 0; i < W; i++) { const v = lin[i]; s += v * v; }
    const winRms = Math.sqrt(s / W);
    const dt = this.hopSec;
    this.age += dt;
    // short-term level movement: syllables move, fans and AC do not
    if (!(this.slow > 0)) this.slow = Math.max(winRms, 1e-9);
    this.slow += (winRms - this.slow) * this.slowK;
    this.dev += (Math.abs(winRms - this.slow) - this.dev) * this.slowK;
    const devRatio = this.dev / Math.max(this.slow, 1e-9);
    this.devRatio = devRatio;
    const score = winRms > 1e-5 ? this.pitchScore() : 0;
    this.harm = score;
    const thr = this.thrFor(p);
    const speechish = score > 0.30 ||
      (this.floorEst > 0 && winRms > thr * 4 && devRatio > 0.30);
    if (speechish) {
      this.hold = this.holdLen;
      this.softHold = this.softLen;
      this.voicedCount++;
    } else {
      if (this.hold > 0) this.hold--;
      if (this.softHold > 0) this.softHold--;
    }
    // learn the room from NON-speech frames only - speech never becomes the floor
    if (!speechish && this.hold <= 0) {
      this.ring[this.ringPos] = winRms;
      this.ringPos = (this.ringPos + 1) % this.ringLen;
      if (this.ringUsed < this.ringLen) this.ringUsed++;
    }
    this.tick++;
    if (this.tick >= 8) {
      this.tick = 0;
      const lvl = this.ringValue(0.6);
      if (lvl > 0) this.floorEst = this.floorEst > 0 ? this.floorEst + (lvl - this.floorEst) * 0.25 : lvl;
    }
    let target;
    if (speechish || this.hold > 0) {
      target = 1;
    } else if (this.softHold > 0) {
      target = 0.3;
    } else {
      const ref = thr > 1e-9 ? thr : 1e-9;
      target = Math.pow(this.env / ref, p.ratio);
      const cap = p.floor * 8;
      if (target > cap) target = cap;
      if (target < p.floor) target = p.floor;
    }
    this.target = target;
  }
  step(frame, n, p) {
    if (!this.hist || this.winLen < n * 2) this.init(n || 128);
    const W = this.winLen;
    const hist = this.hist;
    for (let i = 0; i < n; i++) hist[(this.histPos + i) % W] = frame[i] || 0;
    this.histPos = (this.histPos + n) % W;
    if (this.histFill < W) this.histFill = Math.min(W, this.histFill + n);
    let s = 0;
    for (let i = 0; i < n; i++) { const v = frame[i] || 0; s += v * v; }
    const rms = Math.sqrt(s / Math.max(1, n));
    const ka = rms > this.env ? this.blockAtk : this.blockRel;
    this.env += (rms - this.env) * ka;
    this.acc += n;
    if (this.acc >= this.hopLen && this.histFill >= (W >> 1)) {
      this.acc = 0;
      this.decide(p);
    }
    const kg = this.target > this.gain ? this.gAtk : this.gRel;
    const g0 = this.gain;
    this.gain += (this.target - this.gain) * kg;
    return [g0, this.gain];
  }
}
`;
  const GATE_WORKLET_SRC = GATE_CORE_SRC + `
class BmNoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: 0.005, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'maxThreshold', defaultValue: 0.063, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'floor', defaultValue: 0.0025, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'openK', defaultValue: 3.16, minValue: 0.1, maxValue: 100, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 5, minValue: 1, maxValue: 30, automationRate: 'k-rate' }
    ];
  }
  constructor() {
    super();
    this.core = new BmGateCore(sampleRate);
  }
  process(inputs, outputs, params) {
    const out = outputs[0];
    const inp = inputs[0];
    const n = out && out[0] ? out[0].length : 0;
    if (!n) return true;
    if (!inp || !inp.length) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }
    const p = {
      minThr: params.threshold[0],
      maxThr: params.maxThreshold[0],
      floor: params.floor[0],
      openK: params.openK[0],
      ratio: params.ratio[0]
    };
    const g = this.core.step(inp[0], n, p);
    const step = (g[1] - g[0]) / n;
    for (let c = 0; c < out.length; c++) {
      const src = inp[c] || inp[0];
      const dst = out[c];
      let gg = g[0];
      for (let i = 0; i < n; i++) { dst[i] = (src[i] || 0) * gg; gg += step; }
    }
    return true;
  }
}
registerProcessor('bm-noise-gate', BmNoiseGate);
`;

  // one implementation for the worklet and for the ScriptProcessor fallback
  let gateCoreCls = null;
  function gateCoreClass() {
    if (gateCoreCls) return gateCoreCls;
    gateCoreCls = new Function(GATE_CORE_SRC + '\nreturn BmGateCore;')();
    return gateCoreCls;
  }

  let gateUrl = null;
  let micChain = null; // { srcTrack, track, ctx, src, hp, lp, gate, makeup, dest }
  let micResumeArmed = false;
  let nsHintShown = false;

  function gateModuleUrl() {
    if (!gateUrl) {
      gateUrl = URL.createObjectURL(new Blob([GATE_WORKLET_SRC], { type: 'application/javascript' }));
    }
    return gateUrl;
  }

  function gateTune(node, ctx, cfg) {
    const minThr = dbToGain(cfg.minThrDb);
    const maxThr = dbToGain(cfg.maxThrDb);
    const flr = dbToGain(cfg.floorDb);
    const openK = Math.pow(10, cfg.openDb / 20);
    try {
      if (node.parameters && node.parameters.get && node.parameters.get('threshold')) {
        const t = ctx ? ctx.currentTime : 0;
        node.parameters.get('threshold').setValueAtTime(minThr, t);
        node.parameters.get('maxThreshold').setValueAtTime(maxThr, t);
        node.parameters.get('floor').setValueAtTime(flr, t);
        node.parameters.get('openK').setValueAtTime(openK, t);
        node.parameters.get('ratio').setValueAtTime(cfg.ratio, t);
      } else if (node._bmTune) {
        node._bmTune.threshold = minThr;
        node._bmTune.maxThreshold = maxThr;
        node._bmTune.floor = flr;
        node._bmTune.openK = openK;
        node._bmTune.ratio = cfg.ratio;
      }
    } catch (e) {}
  }

  // old browsers / no worklet: the SAME core, driven from a ScriptProcessorNode.
  // `_bmTune` keeps the worklet AudioParam names so gateTune() can retune either node.
  function scriptGate(ctx) {
    // 1024 frames was ~21ms of extra buffering on the no-worklet path — audible as the
    // "voice arrives a beat late" complaint. 512 keeps the CPU cost sane while halving it.
    const block = 512;
    const sp = ctx.createScriptProcessor(block, 1, 1);
    const cfg = nsCfg();
    const st = {
      threshold: dbToGain(cfg.minThrDb),
      maxThreshold: dbToGain(cfg.maxThrDb),
      floor: dbToGain(cfg.floorDb),
      openK: Math.pow(10, cfg.openDb / 20),
      ratio: cfg.ratio,
    };
    const Core = gateCoreClass();
    const core = new Core(ctx.sampleRate || 48000);
    core.init(block);
    sp.onaudioprocess = function (ev) {
      const inp = ev.inputBuffer.getChannelData(0);
      const out = ev.outputBuffer.getChannelData(0);
      const n = out.length;
      const p = {
        minThr: st.threshold,
        maxThr: st.maxThreshold,
        floor: st.floor,
        openK: st.openK,
        ratio: st.ratio,
      };
      const g = core.step(inp, n, p);
      const step = (g[1] - g[0]) / n;
      let gg = g[0];
      for (let i = 0; i < n; i++) { out[i] = inp[i] * gg; gg += step; }
    };
    sp._bmTune = st;
    return sp;
  }

  function gateNode(ctx) {
    if (ctx.audioWorklet && ctx.audioWorklet.addModule) {
      return ctx.audioWorklet.addModule(gateModuleUrl())
        .then(() => new AudioWorkletNode(ctx, 'bm-noise-gate', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        }))
        .catch(() => scriptGate(ctx));
    }
    return Promise.resolve(scriptGate(ctx));
  }

  function destroyMicChain() {
    const c = micChain;
    micChain = null;
    if (!c) return;
    try { c.src && c.src.disconnect(); } catch (e) {}
    try { c.hp && c.hp.disconnect(); } catch (e) {}
    try { c.gate && c.gate.disconnect(); } catch (e) {}
    try { c.lp && c.lp.disconnect(); } catch (e) {}
    try { c.makeup && c.makeup.disconnect(); } catch (e) {}
    try { c.track && c.track.stop(); } catch (e) {}
    try { c.ctx && c.ctx.state !== 'closed' && c.ctx.close(); } catch (e) {}
  }

  function buildMicChain(rawTrack) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) {
      try { ctx = new AC(); } catch (e2) { return null; }
    }
    const cfg = nsCfg();
    let src, hp, lp, makeup, dest;
    try {
      src = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
      hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = cfg.hp; hp.Q.value = 0.707;
      lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = cfg.lp; lp.Q.value = 0.707;
      makeup = ctx.createGain();
      makeup.gain.value = dbToGain(cfg.makeupDb);
      dest = ctx.createMediaStreamDestination();
      src.connect(hp);
      // the gate is spliced between the two filters once the module is ready
      hp.connect(lp);
      lp.connect(makeup);
      makeup.connect(dest);
    } catch (e) {
      try { ctx.close(); } catch (e2) {}
      return null;
    }
    // NOTE: there is deliberately NO DynamicsCompressorNode in the chain. Chrome's
    // compressor applies a large internal makeup gain to QUIET material (~+10 dB at
    // -30 dBFS), so the room ended up louder than the speaker and the gate's silence
    // floor was lifted right back up. The gate only ever attenuates, which is exactly
    // what we want.
    const chain = {
      srcTrack: rawTrack, ctx, src, hp, lp, gate: null, makeup, dest,
      track: dest.stream.getAudioTracks()[0] || null,
    };
    micChain = chain;
    try { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); } catch (e) {}
    // A context that starts SUSPENDED is normal until the visitor has clicked on the page.
    // We keep sending the raw mic (silence would look like a dead microphone), so tell the
    // user once - otherwise the room noise stays audible and the switch looks broken.
    setTimeout(() => {
      if (chain !== micChain || !chain.ctx || chain.ctx.state === 'running') return;
      armMicCtxResume();
      if (!nsHintShown) {
        nsHintShown = true;
        showToast('برای فعال‌شدن نویزگیر، یک‌بار روی صفحه لمس کنید');
      }
    }, 2500);
    // the gate is the part that actually removes the room; the module loads async and is
    // spliced between the high-pass and the low-pass once it is ready
    gateNode(ctx).then((node) => {
      if (!node || chain !== micChain) return false;
      try {
        chain.hp.disconnect();
        chain.hp.connect(node);
        node.connect(chain.lp);
        chain.gate = node;
        gateTune(node, chain.ctx, nsCfg());
        return true;
      } catch (e) { return false; }
    }).catch(() => {});
    return chain;
  }

  function micChainFor(rawTrack) {
    if (!rawTrack || rawTrack.readyState !== 'live') return null;
    if (micChain && micChain.srcTrack === rawTrack && micChain.track && micChain.track.readyState === 'live') return micChain;
    destroyMicChain();
    return buildMicChain(rawTrack);
  }

  function retuneMicChain() {
    const c = micChain;
    if (!c) return;
    const cfg = nsCfg();
    const t = c.ctx ? c.ctx.currentTime : 0;
    try { c.hp.frequency.setValueAtTime(cfg.hp, t); } catch (e) { try { c.hp.frequency.value = cfg.hp; } catch (e2) {} }
    try { c.lp.frequency.setValueAtTime(cfg.lp, t); } catch (e) { try { c.lp.frequency.value = cfg.lp; } catch (e2) {} }
    try { c.makeup.gain.setValueAtTime(dbToGain(cfg.makeupDb), t); } catch (e) { try { c.makeup.gain.value = dbToGain(cfg.makeupDb); } catch (e2) {} }
    if (c.gate) gateTune(c.gate, c.ctx, cfg);
  }

  // An AudioContext created without a gesture stays SUSPENDED, and a suspended context
  // outputs pure silence - that would look like "my mic died". Until it is allowed to
  // run we keep sending the raw mic and swap in the filtered track on the first gesture.
  function armMicCtxResume() {
    if (micResumeArmed) return;
    micResumeArmed = true;
    const kick = () => {
      const c = micChain;
      if (!c || !c.ctx || c.ctx.state !== 'suspended') return;
      c.ctx.resume().then(() => {
        if (c === micChain && micOn) setOutgoingAudio(outgoingAudioTrack());
      }).catch(() => {});
    };
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
      document.addEventListener(ev, kick, { capture: true, passive: true });
    });
  }

  // apply the current setting to the live microphone track
  function applyNoiseSuppression() {
    const track = localStream ? localStream.getAudioTracks()[0] : null;
    const finish = () => {
      if (!noiseSuppression) destroyMicChain();
      // the outgoing track must follow the switch immediately
      if (micOn) setOutgoingAudio(outgoingAudioTrack());
      window.bmUpdateNoiseUI && window.bmUpdateNoiseUI();
      return true;
    };
    if (!track || typeof track.applyConstraints !== 'function') return Promise.resolve(finish());
    const want = {
      echoCancellation: noiseSuppression ? true : false,
      // the browser suppressor stays OFF: our chain is the suppressor (see audioConstraints)
      noiseSuppression: false,
      autoGainControl: false,
    };
    return track.applyConstraints({ advanced: [want] })
      .catch(() => {})
      .then(finish);
  }
  window.bmSetNoiseSuppression = function (on) {
    noiseSuppression = !!on;
    try { localStorage.setItem('bm_noise_suppression', noiseSuppression ? '1' : '0'); } catch (e) {}
    return applyNoiseSuppression().then(() => {
      showToast(noiseSuppression ? 'نویزگیر روشن شد (' + nsLabel() + ')' : 'نویزگیر خاموش شد');
      return noiseSuppression;
    });
  };
  window.bmSetNoiseLevel = function (level) {
    if (!NS_LEVELS[level]) return noiseLevel;
    noiseLevel = level;
    noiseSuppression = true;
    try { localStorage.setItem('bm_noise_level', level); } catch (e) {}
    try { localStorage.setItem('bm_noise_suppression', '1'); } catch (e) {}
    const track = localStream && localStream.getAudioTracks()[0];
    if (track && typeof track.applyConstraints === 'function') {
      track.applyConstraints({ advanced: [{ echoCancellation: true, noiseSuppression: false, autoGainControl: false }] }).catch(() => {});
    }
    retuneMicChain();
    if (micOn) setOutgoingAudio(outgoingAudioTrack());
    window.bmUpdateNoiseUI && window.bmUpdateNoiseUI();
    showToast('قدرت نویزگیر: ' + nsLabel());
    return level;
  };
  window.toggleNoiseSuppression = function () { return window.bmSetNoiseSuppression(!noiseSuppression); };
  // test/debug handles
  window.__bmMicChain = function () { return micChain; };
  window.__bmLocalStream = function () { return localStream; };
  window.__bmOutgoingAudio = function () { return outgoingAudioTrack(); };

  // A capture failure must say WHAT failed. Silence here was indistinguishable
  // from a network problem: the call page just looked empty.
  function mediaErrorText(err, kind) {
    const name = (err && err.name) || '';
    const what = kind === 'audio' ? 'میکروفون' : 'دوربین';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return 'دسترسی به ' + what + ' داده نشد — از آیکون قفل/دوربین کنار آدرس سایت اجازه بدهید';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return what + 'ی پیدا نشد';
    if (name === 'NotReadableError' || name === 'TrackStartError') return what + ' در برنامهٔ دیگری مشغول است';
    if (name === 'OverconstrainedError') return what + ' با این تنظیمات پشتیبانی نمی‌شود';
    return 'راه‌اندازی ' + what + ' ناموفق بود';
  }

  // Audio and video are captured INDEPENDENTLY and on purpose: the old chain took
  // the microphone FIRST and a denied/failed mic aborted the whole function, so the
  // camera was never even requested — one permission problem looked like a dead app.
  function startMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // getUserMedia only exists on https:// or localhost. Opening the LAN address
      // over plain http:// (http://192.168.x.x:3000) has no media API at all.
      showToast('این آدرس اجازهٔ میکروفون/دوربین نمی‌دهد؛ صفحه را از آدرس https یا localhost باز کنید');
      renderSelf();
      updateControlUI();
      return Promise.resolve();
    }
    if (!localStream) localStream = new MediaStream();

    const audioP = navigator.mediaDevices.getUserMedia(audioConstraints())
      .then((s) => {
        const t = s.getAudioTracks()[0];
        if (!t) throw new Error('no audio track');
        // a previous capture (rejoin) must not stay first in the stream: getAudioTracks()[0]
        // is what everything reads, and a stale dead track there would break the chain
        localStream.getAudioTracks().forEach((old) => {
          if (old === t) return;
          try { localStream.removeTrack(old); old.stop(); } catch (e) {}
        });
        localStream.addTrack(t);
        micOn = true;
        // build the filter chain NOW, not when the first peer appears: the very first
        // RTP packet must already carry the filtered (gated) track, never the raw room
        if (noiseSuppression) {
          const chain = micChainFor(t);
          if (chain) { try { if (chain.ctx.state === 'suspended') chain.ctx.resume().catch(() => {}); } catch (e) {} }
        }
      })
      .catch((err) => {
        micOn = false;
        silenceCtxResume(); // the silent keepalive track needs a running context
        showToast(mediaErrorText(err, 'audio'));
      });

    const videoP = navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } })
      .then((videoStream) => {
        const first = videoStream.getVideoTracks()[0] || null;
        if (!first) { cameraTrack = null; camOn = false; return; }
        const keep = () => { cameraTrack = first; localStream.addTrack(first); camOn = true; };
        if (!looksVirtual(first.label)) { keep(); return; }
        return preferRealCamera().then((real) => {
          if (real) { try { first.stop(); } catch (e) {} cameraTrack = real; localStream.addTrack(real); camOn = true; }
          else keep();
        }).catch(keep);
      })
      .catch((err) => {
        camOn = false;
        cameraTrack = null;
        showToast(mediaErrorText(err, 'video'));
      });

    return Promise.all([audioP, videoP]).then(() => {
      currentVideoTrack = cameraTrack;
      updateSelfVideo();
      updateControlUI();
      if (approved) applyDefaultMedia();
      pcMap.forEach((st) => addLocalTracks(st));
    });
  }

  // the outgoing VIDEO track currently being sent (camera, or screen while sharing)
  function outgoingVideoTrack() {
    if (sharing && screenTrack) return screenTrack;
    return cameraTrack || null;
  }

  // exactly ONE video sender per peer, kept in st.videoSender: replaceTrack needs a
  // pre-existing video sender, and it is missing whenever the camera was never
  // captured (denied/no device) — that case silently broke screen share.
  function ensureVideoSender(st) {
    if (st.videoSender) return st.videoSender;
    const t = outgoingVideoTrack();
    if (!t) return null;
    st.videoSender = st.pc.addTrack(t, localStream || new MediaStream([t]));
    return st.videoSender;
  }

  // Chrome ships every RTP encoding with networkPriority:'low'. On the relay path that
  // means audio packets sit in the same queue as video behind a congested link, and the
  // measured jitter buffer grew to 280-380ms even with playoutDelayHint/jitterBufferTarget
  // at 0. Give voice the highest network priority and keep video latency-oriented.
  function tuneSendPriorities(st) {
    try {
      const senders = st.pc.getSenders ? st.pc.getSenders() : [];
      const transceivers = st.pc.getTransceivers ? st.pc.getTransceivers() : [];
      senders.forEach((s) => {
        // a video sender may exist before its track is captured; the transceiver still
        // tells us its media kind, so video does not get skipped and stays at 'low'.
        let kind = s.track && s.track.kind;
        if (!kind) {
          const tr = transceivers.find((x) => x.sender === s);
          kind = (tr && tr.receiver && tr.receiver.track && tr.receiver.track.kind) || '';
        }
        if (kind !== 'audio' && kind !== 'video') return;
        const params = s.getParameters();
        if (!params || !params.encodings || !params.encodings.length) return;
        params.encodings.forEach((enc) => {
          try { enc.networkPriority = kind === 'audio' ? 'high' : 'medium'; } catch (e) {}
          if (kind === 'audio') {
            // shorter audio packets when the link is tight (supported codecs only)
            try { if ('adaptivePtime' in enc) enc.adaptivePtime = true; } catch (e) {}
          }
        });
        if (kind === 'video') {
          try { params.degradationPreference = 'maintain-latency'; } catch (e) {}
        }
        const p = s.setParameters(params);
        if (p && p.catch) p.catch(() => {});
      });
    } catch (e) { /* unsupported browser: the defaults still work */ }
  }

  function addLocalTracks(st) {
    // audio AND video senders are managed on their own: the audio one may be the
    // filtered track (or the silence keepalive), never the raw microphone
    ensureVideoSender(st);
    // an audio sender must ALWAYS exist: even with no mic permission we send silence,
    // so the m-line stays negotiated and the connection keeps its consent alive
    const asnd = ensureAudioSender(st);
    if (asnd) {
      const want = outgoingAudioTrack();
      if (want && asnd.track !== want) {
        const p = asnd.replaceTrack(want);
        if (p && p.catch) p.catch(() => {});
      }
    }
    tuneSendPriorities(st);
  }

  // ------------------------------------------------------------------
  // AUDIO KEEPALIVE
  // ------------------------------------------------------------------
  // A disabled track sends NO RTP at all. When everybody in the call is muted (or
  // nobody talks for a while) no packets flow, the ICE consent check stops getting
  // answers, the NAT mapping expires and the peer connection dies — from then on no
  // sound, and only a page refresh brought it back.
  // The fix: while the mic is off we keep sending a SILENT track instead of nothing,
  // so the connection stays alive and the audio can come back at any time.
  let silentCtx = null;
  let silentTrack = null;
  function getSilentTrack() {
    if (silentTrack && silentTrack.readyState === 'live') return silentTrack;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!silentCtx) {
        try { silentCtx = new AC({ latencyHint: 'interactive' }); } catch (e) { silentCtx = new AC(); }
      }
      const dest = silentCtx.createMediaStreamDestination();
      let src = null;
      if (silentCtx.createConstantSource) {
        src = silentCtx.createConstantSource();
        src.offset.value = 0;
      } else {
        src = silentCtx.createOscillator();
        src.frequency.value = 0;
      }
      const gain = silentCtx.createGain();
      gain.gain.value = 0; // absolute silence
      src.connect(gain);
      gain.connect(dest);
      src.start();
      silentTrack = dest.stream.getAudioTracks()[0] || null;
    } catch (e) { silentTrack = null; }
    return silentTrack;
  }

  // Resume the silent-track AudioContext (it starts suspended until the page is
  // touched). Called on gestures and whenever the microphone is unavailable.
  function silenceCtxResume() {
    try {
      getSilentTrack();
      if (silentCtx && silentCtx.state === 'suspended') silentCtx.resume().catch(() => {});
    } catch (e) {}
  }
  window.bmResumeSilence = silenceCtxResume;

  // the track the peers must receive right now
  function outgoingAudioTrack() {
    if (shareAudio && screenAudioTrack) return screenAudioTrack;
    if (micOn && localStream) {
      const t = localStream.getAudioTracks()[0];
      if (t && t.readyState === 'live') {
        if (noiseSuppression && t.enabled) {
          const chain = micChainFor(t);
          // a suspended AudioContext outputs SILENCE: routing through it then would look
          // like a dead microphone, so send the raw mic until it is allowed to run
          if (chain && chain.track && chain.ctx.state === 'running') return chain.track;
          armMicCtxResume();
        }
        return t;
      }
    }
    return getSilentTrack();
  }

  // one audio sender per peer (tracked, so a replaceTrack(null) can never hide it and
  // a second audio transceiver can never be added by accident)
  function ensureAudioSender(st) {
    if (st.audioSender) return st.audioSender;
    const senders = st.pc.getSenders();
    const found = senders.find(s => s.track && s.track.kind === 'audio')
      || senders.find(s => (s.track && s.track.kind === 'audio') || s._bmKind === 'audio');
    if (found) { st.audioSender = found; return found; }
    const t = outgoingAudioTrack();
    if (!t) return null;
    st.audioSender = st.pc.addTrack(t, new MediaStream([t]));
    try { st.audioSender._bmKind = 'audio'; } catch (e) {}
    return st.audioSender;
  }

  // hand a new audio track to every peer (mic <-> page audio <-> silence)
  function setOutgoingAudio(track) {
    pcMap.forEach((st) => {
      try {
        const sender = ensureAudioSender(st);
        if (!sender) return;
        const p = sender.replaceTrack(track || null);
        if (p && p.catch) p.catch(() => {});
        tuneSendPriorities(st);
      } catch (e) { /* the pc is closed */ }
    });
  }

  function updateSelfVideo() {
    const v = $('self-video');
    const av = $('self-avatar');
    if (currentVideoTrack) {
      const s = new MediaStream([currentVideoTrack]);
      v.srcObject = s; v.style.display = ''; if (av) av.style.display = 'none';
      tryPlay(v);
    } else {
      v.srcObject = null; v.style.display = 'none'; if (av) av.style.display = '';
    }
  }

  function updateControlUI() {
    setBMIcon($('ic-mic'), micOn ? 'mic' : 'mic_off', true);
    $('btn-mic').classList.toggle('ctrl-off', !micOn);
    setBMIcon($('ic-cam'), camOn ? 'videocam' : 'videocam_off', true);
    $('btn-cam').classList.toggle('ctrl-off', !camOn);
    $('btn-share').classList.toggle('ctrl-live', sharing);
    // lock badge: the admin locked this control (it stays off until they unlock)
    ['btn-mic', 'btn-cam', 'btn-share'].forEach((id, i) => {
      const el = $(id);
      if (el) {
        el.classList.toggle('ctrl-locked', !!locks[['audio', 'video', 'screen'][i]]);
        el.setAttribute('aria-disabled', locks[['audio', 'video', 'screen'][i]] ? 'true' : 'false');
      }
    });
    // the camera-source (⋮) button only shows while the camera is live
    const more = $('btn-cam-more');
    if (more) more.classList.toggle('hidden', !(camOn && !sharing && !locks.video));
  }

  // Joining with media off (create-page toggle, state 2): arrive muted + cam off,
  // the meeting admin can still enable mic/cam later via CALL_DISABLE.
  function applyDefaultMedia() {
    if (!approved || I.me.is_admin || defaultMedia) return;
    micOn = false;
    if (!sharing) camOn = false;
    if (localStream) localStream.getTracks().forEach(t => t.enabled = false);
    if (!sharing) currentVideoTrack = null;
    // joined with the mic off: still send silence so the connection does not die
    setOutgoingAudio(outgoingAudioTrack());
    updateSelfVideo();
    updateControlUI();
    broadcastStatus();
  }

  // ---------- Tiles ----------
  // Start the peer connection a tick later so a member's box appears instantly; the
  // handshake itself then happens in the background instead of blocking the render.
  const peerQueue = [];
  let peerFlushTimer = null;
  function schedulePeer(userId, polite) {
    if (pcMap.has(userId)) return;
    peerQueue.push({ userId, polite });
    if (peerFlushTimer) return;
    peerFlushTimer = setTimeout(() => {
      peerFlushTimer = null;
      const q = peerQueue.splice(0, peerQueue.length);
      q.forEach((it) => {
        // read the roster entry — do NOT upsert a bare {userId} stub: normalizeMember
        // would default it to status 'pending' and blank its name (that silently removed
        // an approved member from the grant/admin lists)
        const m = currentList.find(x => x.userId === it.userId) || { userId: it.userId };
        createPC(Object.assign({}, m, { userId: it.userId }), it.polite);
      });
    }, 0);
  }
  function initials(name) {
    const p = (name || '').trim().split(/\s+/);
    if (p.length >= 2) return p[0][0] + p[1][0];
    return (name || '?').slice(0, 2);
  }

  function avatarUrl(a) {
    if (!a) return '';
    if (/^https?:\/\//i.test(a)) return a;
    return I.base + '/' + a.replace(/^\/+/, '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function avatarMarkup(meta) {
    meta = meta || {};
    // picture if the member uploaded one, otherwise the first letter of their USERNAME
    const color = /^#[0-9a-fA-F]{3,8}$/.test(meta.avatar_color || '') ? meta.avatar_color : '#4f46e5';
    if (meta.avatar) {
      return '<img src="' + escapeHtml(avatarUrl(meta.avatar)) + '" class="w-full h-full object-cover" alt=""/>';
    }
    const letter = String(meta.username || meta.name || '؟').trim().charAt(0) || '؟';
    return '<div class="w-full h-full flex items-center justify-center font-display-md text-white" style="background:' + color + '">' + escapeHtml(letter) + '</div>';
  }

  function renderSelf() {
    if ($('tile-self')) return;
    const tile = document.createElement('div');
    tile.id = 'tile-self';
    tile.className = 'aspect-video bg-surface-container relative rounded-xl overflow-hidden shadow-lg border-2 border-secondary';
    tile.onclick = () => toggleFocus('self');
    tile.innerHTML = `
      <video id="self-video" autoplay muted playsinline class="w-full h-full object-cover"></video>
      <div id="self-avatar" class="hidden absolute inset-0 flex items-center justify-center">
        <div class="w-24 h-24 rounded-full flex items-center justify-center font-display-md text-white" style="background:${escapeHtml(I.me.avatar_color)}">${escapeHtml(initials(I.me.name))}</div>
      </div>
      <div id="sa-self" class="hidden absolute top-3 left-3 bg-surface-container-highest/80 backdrop-blur-md px-2 py-1 rounded-md border border-white/10" title="صدای صفحه در حال پخش">
        ${bmIcon('volume_up', 'text-[14px] text-primary', true)}
      </div>
      <div class="absolute bottom-3 right-3 bg-background/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
        <span id="ping-self" class="ping-pill hidden items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/10 text-[10px] text-on-surface-variant">
          ${bmIcon('network_check', 'text-[12px]', false)}<span class="ping-val">—</span>
        </span>
        <span class="font-label-md text-on-surface">${escapeHtml(I.me.name)} (شما)</span>
        <button type="button" id="mx-self" onclick="event.stopPropagation(); window.toggleMaximize('self')" class="mx-btn p-2 -m-1 rounded-full text-on-surface-variant hover:text-on-surface transition-colors" title="بزرگ‌نمایی">
          ${bmIcon('fullscreen', 'text-[14px]')}
        </button>
      </div>
      <div id="mxb-self" class="mx-back hidden absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-surface-container-highest/60 backdrop-blur border border-white/10 text-[11px] text-on-surface-variant">
        ${bmIcon('fullscreen_exit', 'text-[14px]')} بازگشت به حالت عادی
      </div>`;
    grid.appendChild(tile);
    updateSelfVideo();
  }

  function getOrCreateTile(userId, meta) {
    let tile = $('tile-' + userId);
    if (tile) return tile;
    tile = document.createElement('div');
    tile.id = 'tile-' + userId;
    tile.className = 'aspect-video bg-surface-container relative rounded-xl border border-white/10 overflow-hidden shadow-lg';
    tile.onclick = () => toggleFocus(String(userId));
    tile.innerHTML = `
      <video id="vid-${userId}" autoplay playsinline class="w-full h-full object-cover"></video>
      <div id="av-${userId}" class="hidden absolute inset-0 flex items-center justify-center">
        ${avatarMarkup(meta)}
      </div>
      <div class="absolute bottom-3 right-3 bg-background/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
        <span id="ping-${userId}" class="ping-pill hidden items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/10 text-[10px] text-on-surface-variant">
          ${bmIcon('network_check', 'text-[12px]', false)}<span class="ping-val">—</span>
        </span>
        <span class="font-label-md text-on-surface" id="name-${userId}">${escapeHtml((meta && meta.name) || '')}</span>
        <button type="button" id="mx-${userId}" onclick="event.stopPropagation(); window.toggleMaximize('${userId}')" class="mx-btn p-2 -m-1 rounded-full text-on-surface-variant hover:text-on-surface transition-colors" title="بزرگ‌نمایی">
          ${bmIcon('fullscreen', 'text-[14px]')}
        </button>
      </div>
      <div id="mxb-${userId}" class="mx-back hidden absolute top-3 left-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-surface-container-highest/60 backdrop-blur border border-white/10 text-[11px] text-on-surface-variant">
        ${bmIcon('fullscreen_exit', 'text-[14px]')} بازگشت به حالت عادی
      </div>
      <div id="sa-${userId}" class="hidden absolute top-3 left-3 bg-surface-container-highest/80 backdrop-blur-md px-2 py-1 rounded-md border border-white/10" title="صدای صفحه در حال پخش">
        ${bmIcon('volume_up', 'text-[14px] text-primary', true)}
      </div>
      <div class="absolute top-3 right-3 bg-surface-container-highest/80 backdrop-blur-md px-2 py-1 rounded-md border border-white/10">
        ${bmIcon('mic', 'text-[14px] text-secondary', false, 'id="mic-' + userId + '"')}
      </div>`;
    tile.oncontextmenu = (e) => openMemberMenu(e, userId, meta && meta.name);
    grid.appendChild(tile);
    // the tile may come back AFTER its tracks arrived (rejoin): re-bind the stream
    // instead of waiting for another ontrack that will never fire
    const rs0 = remoteStreams.get(userId);
    const v0 = tile.querySelector('video');
    if (rs0 && v0 && !v0.srcObject) { v0.srcObject = rs0; tryPlay(v0); }
    applyMediaOverrides(userId);
    updateTileName(userId);
    layoutGrid();
    return tile;
  }

  function removeTile(userId) {
    const t = $('tile-' + userId);
    // if this member was the maximized one, close the overlay first or it would linger
    if (t && t.classList.contains('maximized-el')) window.bmExitMaximize && window.bmExitMaximize();
    if (t) t.remove();
    remoteStreams.delete(userId);
  }

  // ---------- WebRTC: perfect negotiation ----------
  // ONE place that creates an offer: used by onnegotiationneeded, by the deterministic
  // initiator at connect time, and by the ICE-recovery paths below. Running them in
  // parallel used to produce half-finished SDP exchanges that never healed on their own.
  async function negotiate(st, uid) {
    const pc = st.pc;
    if (!socket || !socket.connected) {
      // An ICE restart during a socket outage used to create a local offer that was never
      // emitted — the retry button looked successful but nothing reached the peer. Keep
      // a flag instead and send the offer as soon as the socket is back.
      st.pendingOffer = true;
      return;
    }
    st.pendingOffer = false;
    // a glare is already in flight (or the state is not answerable right now) — the
    // spec re-fires negotiationneeded once we are stable again if it is still needed
    if (st.makingOffer || pc.signalingState !== 'stable') return;
    try {
      st.makingOffer = true;
      await pc.setLocalDescription();
      socket.emit(EV.CALL_SIGNAL, { to: uid, data: { type: 'desc', sdp: pc.localDescription } });
    } catch (e) {
      // a lost offer = a dead call until the next refresh: retry once we are stable
      if (!st.ignoreOffer) {
        setTimeout(() => {
          try {
            if (pc.signalingState === 'stable' && pc.connectionState !== 'closed') negotiate(st, uid);
          } catch (e2) {}
        }, 1200);
      }
    } finally {
      st.makingOffer = false;
    }
  }

  // After every (re)join, re-run the handshake for peers whose connection died: a
  // dropped websocket or a signal that reached a peer who was briefly gone loses the
  // SDP/ICE exchange on the floor and the call stays silent until F5.
  function recoverPeers() {
    pcMap.forEach((st, uid) => {
      const pc = st.pc;
      if (!pc || pc.connectionState === 'closed') return;
      try {
        const dead = pc.connectionState === 'failed'
          || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected';
        if (dead) { st.iceRestartAt = Date.now(); pc.restartIce(); }
        if (pc.signalingState === 'stable') negotiate(st, uid);
      } catch (e) { /* one bad peer must not break the rest */ }
    });
  }

  function createPC(peer, initiator) {
    if (pcMap.has(peer.userId)) return pcMap.get(peer.userId);
    peerMeta.set(peer.userId, { name: peer.name, avatar_color: peer.avatar_color, avatar: peer.avatar || '' });
    getOrCreateTile(peer.userId, peer);

    // deterministic politeness: the peer with the larger userId is impolite
    const polite = I.me.id < peer.userId;
    const st = {
      pc: new RTCPeerConnection({
        iceServers: ICE,
        // gather candidates early and keep them all: with several STUN servers the
        // browser ends up with more paths to pick from, which lowers the RTT
        iceCandidatePoolSize: 10,
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      }),
      polite,
      makingOffer: false,
      ignoreOffer: false,
      srdAnswerPending: false,
      videoSender: null,
      audioSender: null,
      pendingCandidates: [],
      restartTries: 0,
      restartTimer: null,
      pendingOffer: false,
      iceRestartAt: 0,
    };
    const pc = st.pc;
    pcMap.set(peer.userId, st);
    addLocalTracks(st);
    armNetTimer(st, peer.userId);

    pc.onicecandidate = e => {
      if (e.candidate && socket) socket.emit(EV.CALL_SIGNAL, { to: peer.userId, data: { type: 'ice', candidate: e.candidate } });
    };
    pc.ontrack = e => {
      let rs = remoteStreams.get(peer.userId);
      if (!rs) { rs = new MediaStream(); remoteStreams.set(peer.userId, rs); }
      // tell the decoder what the stream is: motion for video, speech for audio.
      // Without this hint browsers can buffer frames, which shows up as delay.
      try {
        if (e.track.kind === 'video') e.track.contentHint = 'motion';
        else if (e.track.kind === 'audio') { e.track.contentHint = 'speech'; e.track.enabled = true; }
      } catch (err) {}
      // Low-latency playback: without a hint the jitter buffer sits at ~30-50ms and can
      // grow under any packet loss, which is exactly the "everything arrives late" feel.
      // playoutDelayHint is in SECONDS, jitterBufferTarget in MILLISECONDS — browsers
      // that do not know a property simply ignore the assignment.
      try {
        if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
        if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0;
      } catch (err) {}
      rs.addTrack(e.track);
      const v = $('vid-' + peer.userId);
      if (v) { v.srcObject = rs; tryPlay(v); }
      applyMediaOverrides(peer.userId);
    };
    pc.onnegotiationneeded = () => { negotiate(st, peer.userId); };
    // ICE restart: it only works in the 'stable' state, so a request that arrives
    // too early is retried instead of being dropped (that was the "refresh fixes it" bug)
    const askRestart = (force) => {
      // A click on «تلاش دوباره» must never be swallowed by a watchdog backoff timer.
      if (st.restartTimer && !force) return;
      if (force) { clearTimeout(st.restartTimer); st.restartTimer = null; st.iceRestartAt = 0; }
      const attempt = () => {
        st.restartTimer = null;
        if (pc.connectionState === 'closed') return;
        if (!force && (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) return;
        // never restart in a storm: one restart every few seconds at most
        if (!force && Date.now() - (st.iceRestartAt || 0) < 4000) {
          st.restartTimer = setTimeout(attempt, 4000);
          if (st.restartTimer && st.restartTimer.unref) st.restartTimer.unref();
          return;
        }
        if (pc.signalingState !== 'stable') {
          // not ready yet — try again shortly
          st.restartTimer = setTimeout(attempt, 1200);
          if (st.restartTimer && st.restartTimer.unref) st.restartTimer.unref();
          return;
        }
        try {
          pc.restartIce();
          st.iceRestartAt = Date.now();
          st.restartTries++;
          // restartIce marks the NEXT offer as an ICE restart — make sure one is sent
          setTimeout(() => negotiate(st, peer.userId), 300);
        } catch (e) {
          st.restartTimer = setTimeout(attempt, 1200);
          if (st.restartTimer && st.restartTimer.unref) st.restartTimer.unref();
        }
      };
      attempt();
    };
    st.askRestart = askRestart;
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      // 'disconnected' is the state right before 'failed' — waiting for 'failed' only
      // meant minutes of silence; a healthy state cancels the pending retry
      if (s === 'connected' || s === 'completed') {
        if (st.restartTimer) { clearTimeout(st.restartTimer); st.restartTimer = null; }
        return;
      }
      if (s === 'failed') askRestart();
      else if (s === 'disconnected') setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') askRestart();
      }, 2500);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (st.netTimer) { clearTimeout(st.netTimer); st.netTimer = null; }
        setNetBad(peer.userId, false);
        if (st.restartTries) st.restartTries = 0;
      }
      if (pc.connectionState === 'failed') {
        // report it right away — waiting for the ICE retry loop to give up could
        // hide a relay-less network behind 30+ seconds of silence
        setNetBad(peer.userId, true);
        askRestart();
      } else if (pc.connectionState === 'connected' && st.restartTimer) {
        clearTimeout(st.restartTimer); st.restartTimer = null;
      } else if (pc.connectionState === 'disconnected') {
        // transient on a bad network — only complain if it does not recover
        armNetTimer(st, peer.userId);
      }
    };

    if (initiator && socket && socket.connected) {
      // The deterministic initiator sends the first offer. negotiate() guards itself
      // against the onnegotiationneeded that the added tracks also trigger, so this
      // can no longer produce a glare (two parallel offers, one of them dropped).
      negotiate(st, peer.userId);
    }
    return st;
  }

  async function handleSignal(from, data) {
    if (from === I.me.id) return;
    let st = pcMap.get(from);
    if (!st) {
      const meta = peerMeta.get(from) || { name: memberNames.get(from) || '', avatar_color: '#4f46e5', avatar: '' };
      st = createPC({ userId: from, ...meta }, false);
      updateTileName(from);
    }
    const pc = st.pc;
    try {
      if (data.type === 'desc') {
        const offerCollision = data.sdp.type === 'offer' && (st.makingOffer || pc.signalingState !== 'stable');
        st.ignoreOffer = !st.polite && offerCollision;
        if (st.ignoreOffer) return;
        if (offerCollision) {
          const rollback = Promise.resolve(pc.setLocalDescription({ type: 'rollback' }));
          await rollback;
        }
        // a candidate that arrived before the description must not be thrown away
        st.srdAnswerPending = data.sdp.type === 'offer';
        await pc.setRemoteDescription(data.sdp);
        st.srdAnswerPending = false;
        // replay the candidates that were waiting for the description
        const waiting = st.pendingCandidates.splice(0);
        for (const c of waiting) {
          try { await pc.addIceCandidate(c); } catch (e) { /* stale candidate */ }
        }
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription();
          socket.emit(EV.CALL_SIGNAL, { to: from, data: { type: 'desc', sdp: pc.localDescription } });
        }
      } else if (data.type === 'ice') {
        if (!pc.remoteDescription) {
          // no description yet: keep the candidate and add it later
          st.pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!st.ignoreOffer) { /* a stale candidate is normal */ }
        }
      }
    } catch (e) {
      // a failed negotiation must not leave the pair mute forever: ask for a restart
      if (st.askRestart) st.askRestart();
    }
  }

  function destroyPC(userId) {
    const st = pcMap.get(userId);
    if (st) {
      if (st.restartTimer) { clearTimeout(st.restartTimer); st.restartTimer = null; }
      if (st.netTimer) { clearTimeout(st.netTimer); st.netTimer = null; }
      setNetBad(userId, false);
      try { st.pc.close(); } catch (e) {}
      pcMap.delete(userId);
    }
  }

  function replaceOutgoingVideo(track) {
    currentVideoTrack = track;
    pcMap.forEach((st) => {
      const sender = st.videoSender || st.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        st.videoSender = sender;
        sender.replaceTrack(track || null).catch(() => {});
      } else if (track) {
        // no video sender ever existed (camera denied) — create one and renegotiate
        st.videoSender = st.pc.addTrack(track, new MediaStream([track]));
      }
      // the camera track usually arrives after the sender was created; re-apply the
      // priority now that the sender really has video to send.
      tuneSendPriorities(st);
    });
    updateSelfVideo();
  }

  // ---------- Socket ----------
  function broadcastStatus() {
    if (socket) socket.emit(EV.CALL_STATUS, { muted: !micOn, cam: camOn, sharing, shareAudio });
  }

  // adopt (server-provided) members into the roster; merge, never replace.
  function adoptMembers(list, createPcs) {
    (list || []).forEach(m => {
      const mm = upsertMember(m);
      memberNames.set(mm.userId, mm.name);
      peerMeta.set(mm.userId, { name: mm.name, avatar_color: mm.avatar_color, avatar: mm.avatar || '' });
      const prevSt = memberStatus.get(mm.userId) || {};
      memberStatus.set(mm.userId, {
        muted: !!mm.muted, cam: mm.cam !== false, sharing: !!mm.sharing,
        locks: mm.locks || prevSt.locks || null,
      });
      if (mm.full_name || mm.email || mm.phone || mm.is_manager != null || mm.role != null) {
        memberInfo.set(mm.userId, {
          full_name: mm.full_name, username: mm.username, display_name: mm.name,
          email: mm.email, phone: mm.phone, is_manager: !!mm.is_manager,
          role: mm.role, has_password: !!mm.has_password,
        });
      }
      if (createPcs && mm.status === 'approved' && mm.userId !== I.me.id) {
        // the tile first, the peer connection right after: createPC() runs the whole
        // WebRTC handshake (STUN + candidates) and used to delay the box by seconds
        getOrCreateTile(mm.userId, mm);
        schedulePeer(mm.userId, I.me.id > mm.userId);
      }
      renderOneMember(mm);
    });
    renderPendingCards();
  }

  function doJoin(cb) {
    if (!socket || !socket.connected || joinedRoom) { if (typeof cb === 'function') cb({ ok: false }); return; }
    joinedRoom = true;
    socket.emit(EV.CALL_JOIN, {
      room: I.meeting.room,
      token: I.token,
      // one key per page load: the server uses it to tell a network reconnect
      // (same page) apart from opening the meeting on a second device
      sessionKey: window.__BM_CALL_SESSION || (window.__BM_CALL_SESSION = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)),
      user: {
        id: I.me.id, name: I.me.name, username: I.me.username,
        avatar_color: I.me.avatar_color, avatar: I.me.avatar || '',
        is_admin: I.me.is_admin, is_manager: !!window.__BM_isManager, status: I.me.status
      }
    }, (resp) => {
      if (resp && resp.ok) {
        // a reconnect keeps every old RTCPeerConnection around — hadPeers is measured
        // BEFORE the members are adopted, so only a REAL re-join triggers recovery
        const hadPeers = pcMap.size > 0;
        // authoritative bootstrap members — merged into the SSR roster
        adoptMembers(resp.members, true);
        // the server seeds muted/cam/sharing as FALSE at join: say what is really on,
        // otherwise everyone (and every late joiner) hides a camera that is live
        broadcastStatus();
        if (hadPeers) setTimeout(recoverPeers, 500);
      } else if (resp && resp.error === 'BLOCKED') {
        showToast('شما از این تماس مسدود شده‌اید');
        setTimeout(() => location.href = I.base + '/home?err=blocked', 1500);
      } else if (resp && resp.error === 'MEETING_NOT_FOUND') {
        showToast('این تماس دیگر فعال نیست');
        setTimeout(() => location.href = I.base + '/home', 1500);
      }
      if (typeof cb === 'function') cb(resp || { ok: false });
    });
  }

  function connectSocket() {
    // call page uses the meeting token directly at handshake
    socket = io(I.socketUrl || undefined, {
      auth: { token: I.token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });
    window.BM_SOCKET = socket;
    // A STABLE getter for the call socket. live.js also opens a socket on this page and
    // can overwrite window.BM_SOCKET (its token fetch is async on a fresh visit), so the
    // shared box must never read that mutable global at emit time.
    window.bmCallSocket = () => socket;
    // whiteboard events ride on the same socket
    if (window.bmWbSocketBind) window.bmWbSocketBind(socket);

    // the call closes itself when nobody joined within the time limit
    socket.on(EV.CALL_SOLO_ENDED, onSoloEnded);

    socket.on('connect', () => {
      setConn('زنده', 'bg-secondary');
      joinedRoom = false;
      doJoin();
      // The network flapped. Previously only HEALTHY peers were restarted, so the dead
      // ones (the reason the banner appeared) were left for the 15s watchdog — and an
      // offer created while the socket was down was silently dropped. Repair the dead
      // peers and send every deferred offer now that signalling works again.
      setTimeout(() => {
        recoverPeers();
        pcMap.forEach((st, uid) => {
          if (st.pendingOffer) { st.pendingOffer = false; setTimeout(() => negotiate(st, uid), 150); }
        });
      }, 600);
    });
    socket.on('disconnect', () => {
      setConn('قطع', 'bg-error');
    });
    socket.on('reconnect_attempt', () => {
      setConn('اتصال...', 'bg-warning');
    });
    socket.on(EV.ERR, d => showToast(d.msg || d.error || 'خطا'));

    socket.on(EV.YOU_APPROVED, () => {
      approved = true;
      SELF.status = 'approved';
      upsertMember(SELF);
      renderOneMember(SELF);
      renderPendingCards();
      $('waiting-overlay').classList.add('hidden');
      applyDefaultMedia();
      // what is actually on right now (the join-time value may predate the media)
      broadcastStatus();
    });
    socket.on(EV.CALL_WELCOME, (d) => {
      // authoritative initial room state — merged, keeps SELF + SSR entries
      adoptMembers(d.members, true);
      // the room state we just received is not a new arrival
      (d.members || []).forEach(m => { if (m.userId !== I.me.id) seenMemberIds.add(m.userId); });
      updateCounts();
      // my own admin locks (server also replays FORCE_DISABLE as catch-up)
      if (d.you && d.you.locks) {
        ['audio', 'video', 'screen'].forEach((k) => {
          if (d.you.locks[k]) { locks[k] = true; updateControlUI(); }
        });
      }
      // an already-running site/video box must appear for late joiners too
      if (d.web && window.bmWebInit) window.bmWebInit(d.web);
      if (d.wb && d.wb.open && window.bmWbApplySync) window.bmWbApplySync(d.wb);
      if (d.openJoin !== undefined) paintOpenJoin(!!d.openJoin);
      if (d.boxes) setAdminBoxesState(d.boxes);
      renderAdminBoxList();
      layoutGrid();
    });
    socket.on(EV.BOX_VISIBILITY_CHANGED, (d) => {
      if (d && d.boxes) setAdminBoxesState(d.boxes);
      renderAdminBoxList();
      layoutGrid();
    });
    socket.on(EV.OPEN_JOIN_CHANGED, (d) => {
      paintOpenJoin(!!d.openJoin);
      showToast(d.openJoin ? 'ورود بدون تایید فعال شد' : 'ورود بدون تایید خاموش شد');
    });
    socket.on(EV.ADMIN_CHANGED, (d) => {
      // the promoted member must GET the admin panel right away (it is hidden client-side)
      if (d.userId === I.me.id) {
        I.me.is_admin = true;
        SELF.is_admin = true;
        const tab = $('tab-admin');
        if (tab) tab.classList.remove('hidden');
        window.__BM_isManager = window.__BM_isManager || true;
      }
      showToast(d.toast || 'ادمین جدیدی انتخاب شد');
      playBeep();
      renderPendingCards();
      layoutGrid();
    });
    socket.on(EV.MEMBER_JOINED, ({ member }) => {
      adoptMembers([member], true);
      renderAdminBoxList();
      layoutGrid();
    });
    socket.on(EV.MEMBER_LEFT, ({ userId }) => {
      dropMember(userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      if (userId === I.me.id) currentList = currentList.filter(x => x.userId !== userId);
      renderPendingCards();
      renderAdminBoxList();
      layoutGrid();
    });
    socket.on(EV.MEMBER_UPDATED, (d) => {
      if (d.is_admin !== undefined) {
        currentList.forEach((m) => { if (m.userId === d.userId) m.is_admin = d.is_admin; });
        renderPendingCards();
        updateCounts();
      }
      const cur = memberStatus.get(d.userId) || {};
      if (d.muted !== undefined) cur.muted = d.muted;
      if (d.cam !== undefined) cur.cam = d.cam;
      if (d.sharing !== undefined) cur.sharing = d.sharing;
      if (d.shareAudio !== undefined) cur.shareAudio = d.shareAudio;
      if (d.locks !== undefined) cur.locks = d.locks;
      memberStatus.set(d.userId, cur);
      const m = currentList.find(x => x.userId === d.userId);
      if (m) Object.assign(m, d);
      updateTileStatus(d.userId);
      if (I.me.is_admin) renderAdminMembers(currentList);
      if (d.sharing !== undefined) layoutGrid();
    });
    socket.on(EV.MEMBER_PENDING, ({ member }) => {
      adoptMembers([member], false);
      playBeep();
      showToast('درخواست ورود از سمت ' + (member.name || 'یک کاربر'));
    });
    socket.on(EV.MEMBER_APPROVED, ({ member }) => {
      if (member.userId === I.me.id) approved = true;
      adoptMembers([member], true);
      renderAdminBoxList();
      layoutGrid();
    });
    socket.on(EV.MEMBER_KICKED, ({ userId }) => {
      dropMember(userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      renderPendingCards();
      renderAdminBoxList();
      layoutGrid();
    });
    socket.on(EV.MEMBER_BLOCKED, ({ userId }) => {
      dropMember(userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      renderPendingCards();
      renderAdminBoxList();
      layoutGrid();
    });
    socket.on(EV.FORCE_DISABLE, d => {
      if (d.kind === 'audio') {
        if (d.off) {
          locks.audio = true;
          if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
          micOn = false;
          setOutgoingAudio(outgoingAudioTrack()); // silence, not nothing
          updateControlUI(); broadcastStatus();
        } else {
          // unlock only — the mic stays off until the user turns it back on
          locks.audio = false;
          setOutgoingAudio(outgoingAudioTrack());
          updateControlUI();
        }
      } else if (d.kind === 'video') {
        if (d.off) {
          locks.video = true;
          if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = false);
          camOn = false;
          if (!sharing) currentVideoTrack = null;
          updateSelfVideo(); updateControlUI(); broadcastStatus();
        } else {
          locks.video = false; updateControlUI();
        }
      } else if (d.kind === 'screen') {
        if (d.off) { locks.screen = true; if (sharing) stopShare(); else updateControlUI(); }
        else { locks.screen = false; updateControlUI(); }
      }
    });
    socket.on(EV.YOU_REJECTED, () => { showToast('درخواست شما رد شد'); setTimeout(() => location.href = I.base + '/home', 1500); });
    socket.on(EV.YOU_REMOVED, () => { showToast('از تماس حذف شدید'); setTimeout(() => location.href = I.base + '/home', 1500); });
    socket.on(EV.YOU_BLOCKED, () => { showToast('شما مسدود شدید'); setTimeout(() => location.href = I.base + '/home?err=blocked', 2000); });
    socket.on(EV.JOIN_ALERT, d => {
      playBeep();
      // somebody new is in the room: the members key gets a mark until it is pressed
      updateCounts();
      showToast('درخواست ورود از سمت ' + (d.name || 'یک کاربر'));
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification('درخواست ورود', { body: d.name || '' }); } catch (e) {}
    });

    // WebRTC signals (new contract) — legacy 'signal' also kept briefly for safety
    socket.on(EV.CALL_SIGNAL, ({ from, data }) => {
      // one chain per peer: a description and a candidate must not be processed at the
      // same time, or the candidate is dropped before the description is set
      const st = pcMap.get(from);
      if (st) {
        st.signalChain = (st.signalChain || Promise.resolve())
          .then(() => handleSignal(from, data))
          .catch(() => {});
      } else {
        handleSignal(from, data).catch(() => {});
      }
    });

    socket.on(EV.CHAT_NEW_MESSAGE, d => {
      memberNames.set(d.userId, d.name);
      appendMessage(d.userId, d.name, d.body, d.userId === I.me.id);
      if (d.userId !== I.me.id) {
        showChatToast(d.name, d.body);
        // The user may be on another tab/window: raise an OS notification (with the
        // Android-style chime) carrying the sender and the message text. bmNotify is a
        // no-op while this tab is the visible one.
        if (window.bmNotify) {
          window.bmNotify({
            title: (d.name || 'پیام جدید') + ' — پیام تماس',
            body: d.body,
            tag: 'call:' + (d.id || d.clientMsgId || d.body || ''),
            url: location.href,
          });
        }
      }
    });
    socket.on(EV.CHAT_ACK, d => {
      if (!d.ok) showToast('ارسال پیام ناموفق: ' + (d.error || ''));
    });
    socket.on(EV.EMOJI, d => spawnEmoji(d.emoji));

    // ---- latency ----
    socket.on(EV.CALL_PONG, (d) => {
      if (d && d.t) paintPing('self', Math.max(0, Date.now() - d.t));
    });
    socket.on(EV.PING_STATS, (d) => applyPingStats(d && d.pings));

    // ---- shared website / video box ----
    socket.on(EV.WEB_STATE, d => { if (window.bmWebState) window.bmWebState(d); });
    socket.on(EV.WEB_SYNC, d => { if (window.bmWebSync) window.bmWebSync(d); });
    socket.on(EV.WEB_ERR, d => showToast((d && d.msg) || 'خطا'));
    socket.on(EV.WEB_DOWNLOAD, d => { if (window.bmWebDownload) window.bmWebDownload(d); });
    startPingLoop();
    startConnectionWatchdog();
  }

  // ---------- Sidebar / members (incremental) ----------
  function memberRow(m) {
    const isSelf = m.userId === I.me.id;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 p-2 hover:bg-surface-container rounded-lg transition-colors group';
    row.dataset.uid = m.userId;
    const mutedIcon = m.muted
      ? bmIcon('mic_off', 'text-[10px] text-on-error')
      : bmIcon('mic', 'text-[10px] text-on-secondary');
    let actions = `<div class="opacity-0 group-hover:opacity-100 flex gap-1 items-center transition-opacity">
      <button class="p-1.5 text-on-surface-variant hover:text-primary hover:bg-primary/10 rounded-md" title="مشاهده اطلاعات" onclick="openMemberInfo(${m.userId})">${bmIcon('info', 'text-[18px]')}</button>`;
    if (I.me.is_admin && !isSelf) {
      actions += `<button class="p-1.5 text-on-surface-variant hover:text-error hover:bg-error/10 rounded-md" title="حذف" onclick="adminRemove(${m.userId})">${bmIcon('person_remove', 'text-[18px]')}</button>`;
    }
    actions += `</div>`;
    row.innerHTML = `
      <div class="relative">
        <div class="w-10 h-10 rounded-full overflow-hidden border border-outline-variant">${avatarMarkup(m)}</div>
        <span class="absolute -bottom-1 -right-1 w-4 h-4 ${m.status === 'approved' ? 'bg-secondary' : 'bg-error'} rounded-full border-2 border-surface-container-low flex items-center justify-center">${mutedIcon}</span>
      </div>
      <div class="flex-1 min-w-0">
        <h4 class="font-body-sm font-semibold text-on-surface truncate">${escapeHtml(m.name)}${isSelf ? ' (شما)' : ''}</h4>
        <p class="font-label-sm text-on-surface-variant text-[10px]">${m.status === 'approved' ? (m.is_admin ? 'مدیر تماس' : 'عضو') : 'در انتظار تایید'}</p>
      </div>${actions}`;
    row.oncontextmenu = (e) => openMemberMenu(e, m.userId, m.name);
    return row;
  }

  function upsertMemberRow(m) {
    const wrap = $('member-list');
    const existing = wrap.querySelector(`[data-uid="${m.userId}"]`);
    const newRow = memberRow(m);
    if (existing) existing.replaceWith(newRow);
    else wrap.appendChild(newRow);
  }
  function removeMemberRow(userId) {
    const wrap = $('member-list');
    const existing = wrap.querySelector(`[data-uid="${userId}"]`);
    if (existing) existing.remove();
  }
  /** insert in list order; keeps pending members at the bottom */
  function renderOneMember(m) {
    upsertMemberRow(m);
    updateCounts();
    updateTileName(m.userId);
    updateTileStatus(m.userId);
  }
  function setConn(state, cls) {
    document.querySelectorAll('.conn-state').forEach(el => {
      el.textContent = state;
      el.className = 'w-2 h-2 rounded-full ' + cls + ' conn-state';
    });
  }

  function updateCounts() {
    const n = currentList.length;
    document.querySelectorAll('#participant-count, .participant-count').forEach(el => { el.textContent = String(n); });
    // The members key marks members this admin has NOT looked at yet. The old rule
    // (any pending member) kept the dot on forever: pressing the key showed the list
    // but the mark stayed for people who had already been seen.
    const unseen = currentList.some(m => m.userId !== I.me.id && !seenMemberIds.has(m.userId));
    const badge = $('admin-badge'); if (badge) badge.classList.toggle('hidden', !unseen);
    const sBadge = $('sidebar-badge'); if (sBadge) sBadge.classList.toggle('hidden', !unseen);
  }
  // pressing the "members" key means I have seen who is in the room
  window.bmClearJoinBadge = function () {
    currentList.forEach(m => { if (m.userId !== I.me.id) seenMemberIds.add(m.userId); });
    updateCounts();
  };

  function renderPendingCards() {
    const req = $('join-requests');
    if (!req) return;
    req.innerHTML = '';
    let pendingCount = 0;
    currentList.forEach(m => {
      if (m.status !== 'approved' && I.me.is_admin && m.userId !== I.me.id) {
        pendingCount++;
        const card = document.createElement('div');
        card.className = 'bg-surface-container border border-outline-variant/30 rounded-xl p-3 flex flex-col gap-3';
        card.innerHTML = `
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full overflow-hidden border border-outline-variant">${avatarMarkup(m)}</div>
            <div><h4 class="font-body-sm font-semibold text-on-surface">${escapeHtml(m.name)}</h4><p class="font-label-sm text-on-surface-variant text-[10px]">@${escapeHtml(m.username)}</p></div>
          </div>
          <div class="flex gap-2">
            <button class="flex-1 bg-secondary-container hover:bg-secondary text-on-secondary-container font-label-md py-1.5 rounded-md transition-colors" onclick="adminApprove(${m.userId})">تایید</button>
            <button class="flex-1 border border-error/50 text-error hover:bg-error/10 font-label-md py-1.5 rounded-md transition-colors" onclick="adminReject(${m.userId})">رد</button>
          </div>`;
        req.appendChild(card);
      }
    });
    updateCounts();
    if (I.me.is_admin) renderAdminMembers(currentList);
  }

  function renderAdminMembers(list) {
    const wrap = $('admin-members');
    if (!wrap) return;
    wrap.innerHTML = '';
    list.forEach(m => {
      if (m.userId === I.me.id) return;
      const st = memberStatus.get(m.userId) || {};
      const card = document.createElement('div');
      card.className = 'bg-surface-container border border-outline-variant/30 rounded-xl p-3 mb-3';
      const ctrl = (kind, label) => {
        const selfOn = localBlock[m.userId] && localBlock[m.userId][kind];
        const locked = !!(st.locks && st.locks[kind]); // locked = disabled by admin
        return `<div class="flex flex-col items-center gap-1">
          <span class="font-label-sm text-on-surface-variant text-[11px]">${label}</span>
          <div class="flex gap-1">
            <button class="text-[11px] px-2 py-1 rounded-md ${selfOn ? 'bg-error-container text-on-error-container' : 'bg-surface-container-high text-on-surface'} hover:opacity-80" onclick="adminBlockSelf(${m.userId},'${kind}')">برای من</button>
            <button class="text-[11px] px-2 py-1 rounded-md ${locked ? 'bg-error-container text-on-error-container' : 'bg-secondary-container text-on-secondary-container'} hover:opacity-80" onclick="adminDisableAll(${m.userId},'${kind}')">${locked ? 'روشن همه' : 'قطع همه'}</button>
          </div>
        </div>`;
      };
      card.innerHTML = `
        <div class="flex items-center gap-2 mb-3">
          <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px]" style="background:${/^#[0-9a-fA-F]{3,8}$/.test(m.avatar_color || '') ? m.avatar_color : '#4f46e5'}">${escapeHtml(initials(m.name))}</div>
          <span class="font-body-sm text-on-surface truncate">${escapeHtml(m.name)}</span>
        </div>
        <div class="grid grid-cols-3 gap-2 text-center">
          ${ctrl('audio', 'صدا')}
          ${ctrl('video', 'تصویر')}
          ${ctrl('screen', 'صفحه')}
        </div>
        <div class="flex gap-2 mt-3">
          <button class="flex-1 bg-error-container/80 hover:bg-error-container text-on-error-container font-label-md py-1.5 rounded-md transition-colors" onclick="adminRemove(${m.userId})">حذف عضو</button>
          <button class="flex-1 bg-surface-container-high hover:bg-surface-bright text-on-surface font-label-md py-1.5 rounded-md transition-colors" onclick="adminBlock(${m.userId})">مسدود کردن</button>
        </div>`;
      wrap.appendChild(card);
    });
    if (!list.some(m => m.userId !== I.me.id)) {
      wrap.innerHTML = '<p class="font-body-sm text-body-sm text-on-surface-variant">عضو دیگری در تماس نیست.</p>';
    }
  }

  // ---------- Chat ----------
  function appendMessage(userId, name, body, self) {
    const box = $('chat-messages');
    const wrap = document.createElement('div');
    wrap.className = 'font-vazir flex flex-col ' + (self ? 'items-end' : 'items-start') + ' gap-1';
    const meta = peerMeta.get(userId) || { name: name, avatar: '' };
    const av = self
      ? '<div class="w-7 h-7 rounded-full overflow-hidden border border-outline-variant">' + avatarMarkup({ name: I.me.name, avatar: I.me.avatar, avatar_color: I.me.avatar_color }) + '</div>'
      : '<div class="w-7 h-7 rounded-full overflow-hidden border border-outline-variant">' + avatarMarkup(meta) + '</div>';
    wrap.innerHTML = `
      <div class="flex items-center gap-2 mb-1">
        ${av}
        <span class="font-label-sm text-on-surface-variant">${escapeHtml(self ? 'شما' : (name || 'بدون نام'))}</span>
      </div>
      <div class="bm-chat-body ${self ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface'} p-3 rounded-2xl ${self ? 'rounded-tl-sm' : 'rounded-tr-sm'} text-body-sm max-w-[85%] border border-white/5">${window.bmLinkify ? window.bmLinkify(body) : escapeHtml(body)}</div>`;
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  window.sendChat = function () {
    const inp = $('chat-input');
    const body = inp.value.trim();
    if (!body) return;
    const clientMsgId = 'm' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    inp.value = '';
    // optimistic UI: message appears now; server ack + broadcast are idempotent
    appendMessage(I.me.id, I.me.name, body, true);
    if (socket && socket.connected) {
      socket.emit(EV.CALL_CHAT_SEND, { body, clientMsgId }, resp => {
        if (!resp || !resp.ok) showToast('ارسال پیام ناموفق: ' + ((resp && resp.error) || ''));
      });
    } else {
      showToast('اتصال زنده قطع است');
    }
  };

  // ---------- Chat toast: bubble rises from bottom for others' messages ----------
  let chatToastTimer = null;
  let chatToastFadeTimer = null;
  function showChatToast(name, body) {
    const el = $('chat-toast');
    if (!el) return;
    $('ct-name').textContent = name || 'بدون نام';
    $('ct-body').textContent = body || '';
    el.classList.remove('hidden', 'fading', 'show');
    void el.offsetWidth; // restart the rise animation
    el.classList.add('show');
    clearTimeout(chatToastTimer);
    clearTimeout(chatToastFadeTimer);
    chatToastTimer = setTimeout(() => {
      el.classList.add('fading');
      chatToastFadeTimer = setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('show', 'fading');
      }, 350);
    }, 5000);
  }
  window.openChatFromToast = function () {
    clearTimeout(chatToastTimer);
    clearTimeout(chatToastFadeTimer);
    const el = $('chat-toast');
    if (el) { el.classList.add('hidden'); el.classList.remove('show', 'fading'); }
    toggleSidebar(true);
    switchTab('chat');
    const box = $('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
    const inp = $('chat-input');
    if (inp) inp.focus({ preventScroll: true });
  };

  // ---------- Latency (ping) shown in the middle of every tile ----------
  const toFa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  const pingSeen = new Set();

  function pingPill(userId) {
    return $('ping-' + userId) || (String(userId) === 'self' ? $('ping-self') : null);
  }
  function paintPing(userId, ms) {
    const pill = pingPill(userId);
    if (!pill) return;
    const val = pill.querySelector('.ping-val');
    if (ms == null) {
      pill.classList.remove('inline-flex');
      pill.classList.add('hidden');
      return;
    }
    pill.classList.remove('hidden');
    pill.classList.add('inline-flex');
    if (val) val.textContent = toFa(ms) + 'ms';
    pill.classList.remove('text-secondary', 'text-warning', 'text-error', 'text-on-surface-variant');
    pill.classList.add(ms <= 90 ? 'text-secondary' : ms <= 220 ? 'text-warning' : 'text-error');
    const ic = pill.querySelector('svg');
    if (ic) {
      ic.classList.remove('text-secondary', 'text-warning', 'text-error', 'text-on-surface-variant');
      ic.classList.add(ms <= 90 ? 'text-secondary' : ms <= 220 ? 'text-warning' : 'text-error');
    }
  }
  function applyPingStats(pings) {
    pingSeen.clear();
    Object.keys(pings || {}).forEach((k) => {
      const id = parseInt(k, 10);
      pingSeen.add(id);
      paintPing(id, pings[k]);
    });
    paintPing('self', pingSeen.has(I.me.id) ? pings[I.me.id] : null);
  }
  function startPingLoop() {
    setInterval(() => {
      const s = socket;
      if (s && s.connected) s.emit(EV.CALL_PING, { t: Date.now() });
    }, 3000);
  }

  // Watchdog: a peer connection that is not 'connected' any more gets a fresh ICE
  // session. Without it a dead connection stayed dead until the page was reloaded —
  // that was the "the sound only comes back after a refresh" complaint.
  function startConnectionWatchdog() {
    setInterval(() => {
      pcMap.forEach((st) => {
        try {
          const s = st.pc.connectionState;
          if ((s === 'failed' || s === 'disconnected') && st.askRestart) st.askRestart();
        } catch (e) {}
      });
    }, 15000);
  }

  // ---------- Emoji ----------
  function buildEmojiGrid() {
    const g = $('emoji-grid');
    EMOJIS.forEach(em => {
      const b = document.createElement('button');
      b.className = 'text-2xl hover:scale-110 transition-transform p-1';
      b.textContent = em;
      b.onclick = () => { spawnEmoji(em, true); toggleEmojiPicker(true); };
      g.appendChild(b);
    });
  }
  function spawnEmoji(em, broadcast) {
    const canvas = $('emoji-canvas');
    const d = document.createElement('div');
    d.className = 'emoji-float';
    d.textContent = em;
    d.style.left = (Math.random() * 80 + 20) + 'px';
    d.style.bottom = '100px';
    canvas.appendChild(d);
    setTimeout(() => d.remove(), 2000);
    // every emoji has its own little synthesised chime (see emoji-sfx.js)
    if (window.bmEmojiSfx) { try { window.bmEmojiSfx(em); } catch (e) {} }
    if (broadcast && socket) socket.emit(EV.CALL_EMOJI, { emoji: em });
  }
  window.spawnEmoji = spawnEmoji;
  window.toggleEmojiPicker = function (forceHide) {
    const p = $('emoji-picker');
    if (forceHide === true) { p.classList.add('hidden'); return; }
    p.classList.toggle('hidden');
  };

  // ------------------------------------------------------------------
  // CONNECTION HEALTH (silent-failure killer)
  // ------------------------------------------------------------------
  // When a relay is missing/blocked, ICE finds no working candidate pair, the peer
  // connection never leaves `checking`, the remote tile stays black/avatar and
  // nobody hears anybody — and NOTHING on the page says why. That is exactly the
  // "no audio in the call page" report. Now the page admits it and offers a retry.
  const netBad = new Set();
  function peerLabel(userId) {
    const meta = peerMeta.get(userId);
    return memberNames.get(userId) || (meta && meta.name) || 'طرف مقابل';
  }
  function updateNetBanner() {
    const el = $('net-banner');
    if (!el) return;
    const bad = netBad.size > 0;
    el.classList.toggle('hidden', !bad);
    if (!bad) return;
    const t = $('net-banner-text');
    if (!t) return;
    if (netBad.size === 1) {
      const only = netBad.values().next().value;
      t.textContent = 'اتصال صدا و تصویر با «' + peerLabel(only) + '» برقرار نشد. احتمالاً شبکه اجازهٔ عبور رسانه را نمی‌دهد.';
    } else {
      t.textContent = 'اتصال صدا و تصویر با ' + netBad.size + ' نفر برقرار نشد. احتمالاً شبکه اجازهٔ عبور رسانه را نمی‌دهد.';
    }
  }
  function setNetBad(userId, bad) {
    const key = String(userId);
    if (bad) netBad.add(key); else netBad.delete(key);
    updateNetBanner();
  }
  window.bmCloseNetBanner = function () {
    const el = $('net-banner');
    if (el) el.classList.add('hidden');
  };
  // a fresh ICE session for every peer + a new grace window (what F5 used to do)
  let retryConnectArmed = false;
  window.bmRetryIce = function () {
    netBad.clear();
    updateNetBanner();
    showToast('در حال تلاش دوباره برای برقراری اتصال…');

    // The usual "connection dropped mid-call" is the SIGNALLING socket going away.
    // Restarting ICE then can only create an offer that is never emitted (negotiate()
    // refuses while disconnected) — the banner came back 12s later and nothing healed.
    // Reconnect first; the normal connect handler re-joins, then we repair every peer.
    if (!socket || !socket.connected) {
      if (!retryConnectArmed) {
        retryConnectArmed = true;
        const onBack = () => {
          if (!retryConnectArmed) return;
          retryConnectArmed = false;
          setTimeout(() => {
            recoverPeers();
            pcMap.forEach((st, uid) => {
              if (st.pendingOffer) { st.pendingOffer = false; setTimeout(() => negotiate(st, uid), 150); }
            });
          }, 700);
        };
        if (socket) socket.once('connect', onBack);
        try { if (socket) socket.connect(); } catch (e) {}
        setTimeout(() => { if (socket && socket.connected) onBack(); }, 9000);
      }
      return;
    }

    let n = 0;
    pcMap.forEach((st, uid) => {
      try {
        st.restartTries = 0;
        st.iceRestartAt = 0;
        armNetTimer(st, uid);
        // force bypasses any watchdog backoff timer that would swallow the click
        if (st.askRestart) st.askRestart(true);
        else if (st.pc.signalingState === 'stable') negotiate(st, uid);
        n++;
      } catch (e) { /* one broken peer must not stop the rest */ }
    });
    if (n === 0) {
      // no peer objects at all: re-run the join so the server sends the roster again
      joinedRoom = false;
      doJoin();
    }
    // if the link is still dead 9s later, refresh the whole join/roster as a last resort
    setTimeout(() => {
      let healed = false;
      pcMap.forEach((st) => {
        try {
          if (st.pc.connectionState === 'connected' || st.pc.iceConnectionState === 'connected') healed = true;
        } catch (e) {}
      });
      if (!healed && socket && socket.connected) {
        joinedRoom = false;
        doJoin(() => setTimeout(recoverPeers, 500));
      }
    }, 9000);
  };

  // a peer that is not 'connected' after this long is reported (relay setup on a bad
  // network can legitimately take 5-8s, so do not cry wolf earlier)
  const NET_GRACE_MS = 12000;
  function armNetTimer(st, userId) {
    if (st.netTimer) { clearTimeout(st.netTimer); st.netTimer = null; }
    setNetBad(userId, false);
    st.netTimer = setTimeout(() => {
      st.netTimer = null;
      try {
        const ok = st.pc.connectionState === 'connected'
          || st.pc.iceConnectionState === 'connected'
          || st.pc.iceConnectionState === 'completed';
        if (!ok) setNetBad(userId, true);
      } catch (e) {}
    }, NET_GRACE_MS);
  }

  // ---------- Controls ----------

  // The mic can be missing (permission denied) or DEAD (the device was released).
  // Toggling `enabled` on such a track does nothing — which looked exactly like
  // "the sound only comes back after a refresh". Re-capture when we have to.
  async function ensureMicTrack() {
    if (localStream) {
      const t = localStream.getAudioTracks()[0];
      if (t && t.readyState === 'live') return t;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    try {
      const vs = await navigator.mediaDevices.getUserMedia(audioConstraints());
      const t = vs.getAudioTracks()[0];
      if (!t) return null;
      if (!localStream) localStream = new MediaStream();
      if (localStream.getAudioTracks().indexOf(t) === -1) localStream.addTrack(t);
      return t;
    } catch (e) { return null; }
  }

  window.toggleMic = async function () {
    if (locks.audio) { showToast('میکروفون توسط ادمین قفل شده است'); return; }
    micOn = !micOn;
    if (micOn) {
      const t = await ensureMicTrack();
      if (!t) { micOn = false; showToast('دسترسی به میکروفون وجود ندارد'); updateControlUI(); broadcastStatus(); return; }
      t.enabled = true;
    }
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    // muted = keep sending SILENCE, not nothing: the connection stays alive and the
    // sound can come back without a refresh
    setOutgoingAudio(outgoingAudioTrack());
    updateControlUI();
    broadcastStatus();
  };
  // The camera track can be MISSING (never captured — permission denied, or the meeting
  // was opened with the camera off) or DEAD (the device was released by the browser).
  // Toggling `enabled` on such a track does nothing at all, which is why turning the
  // camera back on mid-call left a black tile: capture a fresh one when we have to.
  async function ensureCameraTrack() {
    if (cameraTrack && cameraTrack.readyState === 'live') return cameraTrack;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
    try {
      const vs = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } });
      const t = vs.getVideoTracks()[0];
      if (!t) return null;
      if (cameraTrack) { try { cameraTrack.stop(); } catch (e) {} }
      cameraTrack = t;
      if (!localStream) localStream = new MediaStream();
      if (localStream.getVideoTracks().indexOf(t) === -1) localStream.addTrack(t);
      return t;
    } catch (e) { return null; }
  }

  window.toggleCam = async function () {
    if (locks.video) { showToast('دوربین توسط ادمین قفل شده است'); return; }
    camOn = !camOn;
    let fresh = false;
    if (camOn) {
      const had = cameraTrack && cameraTrack.readyState === 'live';
      const t = await ensureCameraTrack();
      if (!t) { camOn = false; showToast('دسترسی به دوربین وجود ندارد'); updateControlUI(); broadcastStatus(); return; }
      fresh = !had;
      t.enabled = true;
      if (localStream) localStream.getVideoTracks().forEach(x => { x.enabled = (x === t); });
    } else if (localStream) {
      localStream.getVideoTracks().forEach(t => { t.enabled = false; });
    }
    if (!sharing) {
      currentVideoTrack = camOn ? cameraTrack : null;
      // a brand new track has to be handed to every sender (replaceTrack), otherwise
      // the peers keep the dead one and still see black
      if (fresh) replaceOutgoingVideo(cameraTrack);
    }
    updateSelfVideo();
    updateControlUI();
    broadcastStatus();
  };
  window.toggleShare = function () {
    if (sharing) { stopShare(); return; }
    if (locks.screen) { showToast('اشتراک صفحه توسط ادمین قفل شده است'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { startCameraAsShare(); return; }
    // pre-flight panel: pick the video quality and whether the page audio goes out too
    const p = $('share-panel');
    if (p) {
      p.classList.remove('hidden');
      return;
    }
    doShare();
  };
  window.closeSharePanel = function () {
    const p = $('share-panel');
    if (p) p.classList.add('hidden');
  };
  window.confirmShare = function () {
    const q = parseInt(($('share-quality') || {}).value || '720', 10);
    const wantAudio = !!($('share-audio') || {}).checked;
    closeQualityMenu();
    window.closeSharePanel();
    doShare(q, wantAudio);
  };

  // ---------- themed quality picker ----------
  const QUALITY_LABELS = {
    360: '360p — کم‌حجم‌ترین', 480: '480p — سبک', 720: '720p — پیشنهادی',
    1080: '1080p — بهترین کیفیت', 0: 'کیفیت اصلی',
  };
  let shareQuality = 720;

  function closeQualityMenu() {
    const m = $('share-quality-menu');
    const b = $('share-quality-btn');
    if (m) m.classList.add('hidden');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  window.toggleQualityMenu = function (e) {
    if (e) e.stopPropagation();
    const m = $('share-quality-menu');
    const b = $('share-quality-btn');
    if (!m) return;
    const open = m.classList.contains('hidden');
    m.classList.toggle('hidden', !open);
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  window.pickQuality = function (q) {
    shareQuality = parseInt(q, 10) || 0;
    const hidden = $('share-quality');
    const label = $('share-quality-label');
    if (hidden) hidden.value = String(shareQuality);
    if (label) label.textContent = QUALITY_LABELS[shareQuality] || String(shareQuality);
    closeQualityMenu();
  };
  // close when clicking anywhere else
  document.addEventListener('click', (e) => {
    const m = $('share-quality-menu');
    if (!m || m.classList.contains('hidden')) return;
    if (e.target.closest && e.target.closest('#share-quality-menu')) return;
    if (e.target.closest && e.target.closest('#share-quality-btn')) return;
    closeQualityMenu();
  });

  function doShare(quality, wantAudio) {
    const presets = {
      360: { width: 640, height: 360, frameRate: 15, bitrate: 500000 },
      480: { width: 854, height: 480, frameRate: 20, bitrate: 900000 },
      720: { width: 1280, height: 720, frameRate: 30, bitrate: 1600000 },
      1080: { width: 1920, height: 1080, frameRate: 30, bitrate: 3000000 },
    };
    const q = presets[quality];
    const constraints = quality === 0 || !q
      ? { video: true, audio: !!wantAudio }
      : {
        video: {
          width: { ideal: q.width, max: q.width },
          height: { ideal: q.height, max: q.height },
          frameRate: { ideal: q.frameRate, max: q.frameRate },
        },
        audio: !!wantAudio,
      };
    navigator.mediaDevices.getDisplayMedia(constraints).then(screenStream => {
      screenTrack = screenStream.getVideoTracks()[0];
      screenTrack.onended = stopShare;
      // honour the picked quality: browsers only hint, so cap the resolution here too
      if (q && screenTrack) {
        try { screenTrack.applyConstraints({ width: { max: q.width }, height: { max: q.height } }); } catch (e) {}
      }
      // page/system audio, if the user ticked it in the panel AND in Chrome's picker
      const at = screenStream.getAudioTracks()[0] || null;
      if (at) {
        screenAudioTrack = at;
        at.enabled = true;
        setOutgoingAudio(at);
      } else if (wantAudio) {
        showToast('صدای صفحه انتخاب نشد؛ فقط تصویر پخش می‌شود');
      }
      sharing = true;
      shareAudio = !!screenAudioTrack;
      replaceOutgoingVideo(screenTrack);
      layoutGrid();
      // cap the outgoing bitrate to the chosen quality (keeps latency low too)
      if (q) {
        pcMap.forEach((st) => {
          const s = st.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
          if (!s) return;
          try {
            const p = s.getParameters();
            p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
            p.encodings[0].maxBitrate = q.bitrate;
            p.degradationPreference = 'maintain-framerate';
            s.setParameters(p).catch(() => {});
          } catch (e) {}
        });
      }
      updateControlUI();
      updateTileAudioBadge();
      broadcastStatus();
    }).catch(err => {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') showToast('دسترسی به اشتراک صفحه داده نشد');
      else if (name === 'NotSupportedError') { startCameraAsShare(); return; }
      else if (name !== 'AbortError') showToast('اشتراک صفحه ممکن نشد');
    });
  }
  // swap the outgoing audio sender (mic <-> page audio) without touching the local track
  function replaceOutgoingAudio(track) {
    setOutgoingAudio(track);
  }
  function updateTileAudioBadge() {
    const b = $('sa-self');
    if (b) b.classList.toggle('hidden', !shareAudio);
    SELF.shareAudio = shareAudio;
  }

  // Fallback when the device can't share its screen (most mobile browsers):
  // share the camera instead, so the user still broadcasts live video.
  function startCameraAsShare() {
    const useTrack = (t) => {
      if (!t) return false;
      if (!cameraTrack) {
        cameraTrack = t;
        if (localStream) localStream.addTrack(t);
      }
      camOn = true;
      if (localStream) localStream.getVideoTracks().forEach(x => x.enabled = true);
      screenTrack = null; // camera-fallback: stopShare must not stop the camera
      sharing = true;
      replaceOutgoingVideo(cameraTrack);
      updateSelfVideo(); updateControlUI(); broadcastStatus(); layoutGrid();
      showToast('اشتراک صفحه پشتیبانی نمی‌شود؛ دوربین به‌عنوان اشتراک فعال شد');
      return true;
    };
    if (cameraTrack) { useTrack(cameraTrack); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('اشتراک صفحه در این مرورگر/دستگاه پشتیبانی نمی‌شود');
      return;
    }
    pickCameraConstraint()
      .then(c => navigator.mediaDevices.getUserMedia({ video: c }))
      .then(s => { if (!useTrack(s.getVideoTracks()[0])) showToast('اشتراک صفحه در این مرورگر/دستگاه پشتیبانی نمی‌شود'); })
      .catch(() => showToast('اشتراک صفحه در این مرورگر/دستگاه پشتیبانی نمی‌شود'));
  }
  function stopShare() {
    if (screenTrack) { screenTrack.stop(); screenTrack = null; }
    if (screenAudioTrack) {
      try { screenAudioTrack.stop(); } catch (e) {}
      screenAudioTrack = null;
      // the mic (or silence) must go back out to everyone
      setOutgoingAudio(outgoingAudioTrack());
    }
    sharing = false;
    shareAudio = false;
    updateTileAudioBadge();
    // the camera may have been released while we were sharing the screen
    if (camOn) ensureCameraTrack().then(() => {
      currentVideoTrack = camOn ? cameraTrack : null;
      replaceOutgoingVideo(currentVideoTrack);
      updateSelfVideo();
    });
    currentVideoTrack = camOn ? cameraTrack : null;
    replaceOutgoingVideo(currentVideoTrack);
    updateControlUI();
    broadcastStatus();
    layoutGrid();
  }

  // ---------- Camera source menu (⋮ next to the cam button) ----------
  let camSources = [];
  // ---------- per-user: show/hide member boxes (feature 1, local) ----------
  function updateLocalMemberBoxesUI() {
    const mode = localShowMembers ? 'show' : 'hide';
    document.querySelectorAll('#member-boxes-menu .mbox-opt').forEach((btn) => {
      const on = btn.getAttribute('data-mode') === mode;
      btn.classList.toggle('is-active', on);
      const chk = btn.querySelector('.mbox-check');
      if (chk) chk.classList.toggle('hidden', !on);
    });
    const trig = $('btn-member-boxes');
    if (trig) {
      trig.title = localShowMembers ? 'نمایش باکس اعضا' : 'عدم نمایش باکس اعضا';
      trig.setAttribute('aria-expanded', String(!($('member-boxes-menu') && $('member-boxes-menu').classList.contains('hidden'))));
    }
  }

  function positionMemberBoxesMenu() {
    const menu = $('member-boxes-menu');
    const btn = $('btn-member-boxes');
    if (!menu || !btn || menu.classList.contains('hidden')) return;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth || 230;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    menu.style.left = left + 'px';
    menu.style.top = (r.bottom + 8) + 'px';
  }

  window.toggleMemberBoxesMenu = function (e) {
    if (e) e.stopPropagation();
    const menu = $('member-boxes-menu');
    if (!menu) return;
    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !opening);
    if (opening) {
      updateLocalMemberBoxesUI();
      positionMemberBoxesMenu();
    }
    const btn = $('btn-member-boxes');
    if (btn) btn.setAttribute('aria-expanded', String(opening));
  };

  window.setLocalMemberBoxes = function (mode) {
    localShowMembers = mode !== 'hide';
    try { localStorage.setItem('bm_call_show_members', localShowMembers ? '1' : '0'); } catch (e) {}
    updateLocalMemberBoxesUI();
    const menu = $('member-boxes-menu');
    if (menu) menu.classList.add('hidden');
    const btn = $('btn-member-boxes');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    layoutGrid();
  };

  document.addEventListener('click', (e) => {
    const menu = $('member-boxes-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    const btn = $('btn-member-boxes');
    if ((btn && btn.contains(e.target)) || menu.contains(e.target)) return;
    menu.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  });
  window.addEventListener('resize', positionMemberBoxesMenu);

  // ---------- admin: stage box visibility (feature 2, room-wide) ----------
  function adminBoxLabel(key) {
    if (key === 'web') return 'باکس اشتراک/لینک';
    if (key === 'wb') return 'تخته وایت‌برد';
    const uid = parseInt(key, 10);
    if (String(I.me.id) === String(uid)) return (I.me.name || 'شما') + ' (شما)';
    const m = currentList.find(x => String(x.userId) === String(uid));
    if (m && m.name) return m.name;
    const meta = peerMeta.get(uid);
    if (meta && meta.name) return meta.name;
    return 'عضو #' + key;
  }

  function renderAdminBoxList() {
    const box = $('admin-box-list');
    const sw = $('show-new-box');
    if (sw) sw.checked = !!adminBoxes.showNew;
    if (!box) return;

    const keys = [];
    const seen = new Set();
    const add = (k) => { k = String(k); if (!seen.has(k)) { seen.add(k); keys.push(k); } };

    // member boxes (approved/known members including self)
    add(I.me.id);
    (currentList || []).forEach((m) => { if (m && m.userId != null) add(m.userId); });

    // stage content boxes when present/open
    if ($('web-box')) add('web');
    if ($('wb-box')) add('wb');

    box.innerHTML = '';
    keys.forEach((key) => {
      const checked = !adminBoxes.hidden.has(String(key));
      const label = adminBoxLabel(key);
      const row = document.createElement('label');
      row.className = 'flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-surface-container-low border border-outline-variant/25 cursor-pointer';
      row.innerHTML =
        '<span class="font-body-sm text-body-sm text-on-surface truncate min-w-0">' + escapeHtml(label) + '</span>' +
        '<span class="relative inline-flex items-center shrink-0">' +
          '<input type="checkbox" class="peer sr-only abox-cb" data-box="' + escapeHtml(key) + '"' + (checked ? ' checked' : '') + '/>' +
          '<span class="w-11 h-6 rounded-full bg-surface-container-highest border border-outline-variant/40 transition-colors peer-checked:bg-primary/80"></span>' +
          '<span class="absolute right-0.5 w-5 h-5 rounded-full bg-on-surface-variant transition-all peer-checked:right-[22px] peer-checked:bg-on-primary"></span>' +
        '</span>';
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => { window.adminSetBoxVisible(key, cb.checked); });
      box.appendChild(row);
    });
    if (!keys.length) {
      box.innerHTML = '<p class="font-label-sm text-on-surface-variant">باکسی برای نمایش وجود ندارد.</p>';
    }
  }

  function emitBoxVisibility(patch, cb) {
    if (!socket || !socket.connected) { showToast('اتصال برقرار نیست'); if (cb) cb({ ok: false }); return; }
    socket.emit(EV.CALL_SET_BOX_VISIBILITY, patch || {}, (res) => {
      if (res && res.ok && res.boxes) {
        setAdminBoxesState(res.boxes);
        renderAdminBoxList();
        layoutGrid();
      } else if (!res || !res.ok) {
        showToast('خطا در اعمال تغییرات');
        renderAdminBoxList();
      }
      if (cb) cb(res || { ok: false });
    });
  }

  window.adminSetShowNewBox = function (on) {
    emitBoxVisibility({ showNew: !!on });
  };

  window.adminSetBoxVisible = function (boxId, visible) {
    const key = String(boxId);
    const hidden = new Set(Array.from(adminBoxes.hidden || []).map(String));
    if (visible) hidden.delete(key); else hidden.add(key);
    emitBoxVisibility({ showNew: !!adminBoxes.showNew, hidden: Array.from(hidden) });
  };

  // expose for web/whiteboard modules to refresh the admin list when boxes appear/disappear
  window.bmRefreshAdminBoxList = renderAdminBoxList;

  function closeCamMenu() {
    const m = $('cam-menu');
    if (m) m.classList.add('hidden');
  }
  function switchCamera(constraint) {
    if (locks.video) { showToast('دوربین توسط ادمین قفل شده است'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    const want = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (constraint && constraint.deviceId) want.deviceId = { exact: constraint.deviceId };
    else if (constraint && constraint.facingMode) want.facingMode = constraint.facingMode;
    else want.facingMode = 'user';
    navigator.mediaDevices.getUserMedia({ video: want }).then(vs => {
      const nt = vs.getVideoTracks()[0];
      if (!nt) return;
      const old = cameraTrack;
      if (old && localStream) { try { localStream.removeTrack(old); } catch (e) {} }
      cameraTrack = nt;
      if (localStream) localStream.addTrack(nt);
      nt.enabled = camOn;
      if (sharing && screenTrack) {
        // screen share owns the outgoing video — swap takes effect after stopShare
      } else {
        replaceOutgoingVideo(camOn ? nt : null);
      }
      updateSelfVideo();
      updateControlUI();
      if (old) { try { old.stop(); } catch (e) {} }
      showToast('دوربین تغییر کرد');
    }).catch(() => showToast('تغییر دوربین ممکن نشد'));
  }
  function renderCamMenu(menu) {
    camSources = [
      { label: 'دوربین جلو', constraint: { facingMode: 'user' } },
      { label: 'دوربین عقب', constraint: { facingMode: 'environment' } },
    ];
    const rows = () => camSources.map((c, i) => `
      <button class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-right text-on-surface hover:bg-surface-container-high transition text-body-sm" onclick="__pickCam(${i})">
        ${bmIcon(c.constraint && c.constraint.deviceId ? 'videocam' : 'switch_camera', 'text-[18px] text-secondary', false)}
        <span class="truncate">${escapeHtml(c.label)}</span>
      </button>`).join('');
    menu.innerHTML = `
      <p class="font-label-sm text-on-surface-variant px-3 pb-1">منبع تصویر</p>
      ${rows()}
      <div class="h-px bg-white/10 my-1"></div>
      <div id="cam-menu-devices"><p class="font-label-sm text-on-surface-variant px-3 py-1 text-[11px]">در حال جستجوی دوربین…</p></div>`;
    listCameras().then(cams => {
      const box = menu.querySelector('#cam-menu-devices');
      if (!box) return;
      const virtLabels = [];
      const items = [];
      cams.forEach((d, i) => {
        const virt = looksVirtual(d.label);
        if (virt) virtLabels.push(d.label);
        camSources.push({ label: d.label || ('دوربین ' + (i + 1)), constraint: { deviceId: d.deviceId } });
        const idx = camSources.length - 1;
        items.push(`
          <button class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-right text-on-surface hover:bg-surface-container-high transition text-body-sm" onclick="__pickCam(${idx})">
            ${bmIcon('videocam', 'text-[18px] ' + (virt ? 'text-error' : 'text-secondary'), false)}
            <span class="truncate">${escapeHtml((d.label || 'دوربین ' + (i + 1)) + (virt ? ' (مجازی)' : ''))}</span>
          </button>`);
      });
      box.innerHTML = items.join('') || '<p class="font-label-sm text-on-surface-variant px-3 py-1 text-[11px]">دستگاهی یافت نشد</p>';
      menu.innerHTML = `
        <p class="font-label-sm text-on-surface-variant px-3 pb-1">منبع تصویر</p>
        ${rows()}
        <div class="h-px bg-white/10 my-1"></div>
        <div id="cam-menu-devices">${box.innerHTML}</div>`;
      // the device list arrives asynchronously and makes the menu taller
      positionCamMenu();
    }).catch(() => {});
  }
  // Opens exactly ABOVE the ⋮ button. Bottom-anchored when space is tight so the
  // menu grows upward instead of being clipped by the bottom of the screen.
  function positionCamMenu() {
    const menu = $('cam-menu');
    const btn = $('btn-cam-more');
    if (!menu || !btn || menu.classList.contains('hidden')) return;
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 160;
    let left = r.left + r.width / 2 - mw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    menu.style.left = left + 'px';
    menu.style.bottom = '';
    menu.style.top = '';
    const above = r.top - mh - 10;
    if (above >= 8) {
      menu.style.top = above + 'px';
    } else {
      menu.style.bottom = Math.round(window.innerHeight - r.top + 10) + 'px';
    }
  }
  window.addEventListener('resize', positionCamMenu);
  window.__pickCam = function (i) {
    const src = camSources[i];
    closeCamMenu();
    if (src) switchCamera(src.constraint);
  };
  window.toggleCamMenu = function (e) {
    if (e) e.stopPropagation();
    const menu = $('cam-menu');
    if (!menu) return;
    if (!menu.classList.contains('hidden')) { closeCamMenu(); return; }
    renderCamMenu(menu);
    menu.classList.remove('hidden');
    menu.style.visibility = 'hidden';
    positionCamMenu();
    menu.style.visibility = 'visible';
  };
  document.addEventListener('click', (e) => {
    const menu = $('cam-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    const btn = $('btn-cam-more');
    if (btn && btn.contains(e.target)) return;
    if (menu.contains(e.target)) return;
    closeCamMenu();
  });

  // registered once the socket exists (see connectSocket) — at module level `socket` is still
  // null and `socket.on` would throw
  function onSoloEnded(d) {
    // nobody joined within the time limit -> the call closes itself
    try { if (socket) socket.emit(EV.CALL_LEAVE, {}, () => {}); } catch (e) {}
    pcMap.forEach(({ pc }) => { try { pc.close(); } catch (e) {} });
    if (localStream) localStream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
    showAlertAndLeave((d && d.minutes) || 15);
  }

  // the solo call ended by itself: say why before going back home
  function showAlertAndLeave(minutes) {
    const old = $('solo-ended');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'solo-ended';
    box.className = 'fixed inset-0 z-[120] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4';
    box.innerHTML = `
      <div class="glass-panel rounded-3xl p-xl max-w-[420px] text-center border border-primary/25 shadow-2xl">
        <div class="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-secondary-container to-primary-container text-on-secondary-container flex items-center justify-center mb-4">
          ${bmIcon('groups', 'text-[28px]')}
        </div>
        <h3 class="font-headline-md text-headline-md text-on-surface mb-2">تماس پایان یافت</h3>
        <p class="font-body-sm text-body-sm text-on-surface-variant leading-6">
          در این مدت هیچ کاربر دیگری به تماس نپیوست، بنابراین تماس به‌صورت خودکار بسته شد.
        </p>
        <p class="font-label-sm text-on-surface-variant text-[11px] mt-2">محدودیت: ${minutes} دقیقه تنها ماندن</p>
        <button type="button" onclick="window.showAlertAndLeaveHide()"
          class="btn-primary mt-6 px-6 py-2.5">بازگشت به خانه</button>
      </div>`;
    document.body.appendChild(box);
  };
  window.showAlertAndLeaveHide = function () {
    const el = $('solo-ended');
    if (el) el.remove();
    const base = (window.INIT && window.INIT.base) || '/black-meet';
    location.href = base + '/home';
  };

  // ---------- noise suppression menu ----------
  window.bmUpdateNoiseUI = function () {
    const sw = $('noise-suppression');
    if (sw) sw.checked = noiseSuppression;
    const icon = $('ic-noise');
    if (icon && window.setBMIcon) {
      // filled + primary while the filter is on, outline + dimmed while it is off
      window.setBMIcon(icon, 'graphic_eq', noiseSuppression);
      const svg = icon.tagName === 'svg' ? icon : (icon.closest && icon.closest('svg'));
      if (svg) { svg.setAttribute('fill', noiseSuppression ? 'currentColor' : 'none'); svg.classList.toggle('text-primary', noiseSuppression); svg.classList.toggle('text-on-surface-variant', !noiseSuppression); }
    }
    const b = $('btn-noise');
    if (b) b.title = noiseSuppression ? ('نویزگیر روشن است (' + nsLabel() + ')') : 'نویزگیر خاموش است';
    // strength chips
    document.querySelectorAll('.bm-ns-lv').forEach((chip) => {
      const on = chip.getAttribute('data-ns-level') === noiseLevel;
      chip.classList.toggle('is-on', on && noiseSuppression);
      chip.setAttribute('aria-pressed', on && noiseSuppression ? 'true' : 'false');
      chip.disabled = false;
    });
    const hint = $('ns-hint');
    if (hint) {
      hint.textContent = !noiseSuppression
        ? 'نویزگیر خاموش است؛ صدای محیط هم ارسال می‌شود.'
        : noiseLevel === 'soft'
          ? 'حذف ملایم صدای محیط؛ صدا طبیعی‌تر می‌ماند.'
          : noiseLevel === 'max'
            ? 'قوی‌ترین حالت؛ صدای محیط کاملاً قطع می‌شود.'
            : 'صدای محیط کاملاً حذف می‌شود؛ فقط صدای شما ارسال می‌شود.';
    }
  };
  window.toggleNoiseMenu = function (e) {
    if (e) e.stopPropagation();
    const menu = $('noise-menu');
    if (!menu) return;
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    closeCamMenu();
    window.bmUpdateNoiseUI();
    menu.classList.remove('hidden');
    menu.style.visibility = 'hidden';
    positionNoiseMenu();
    menu.style.visibility = 'visible';
  };
  function positionNoiseMenu() {
    const menu = $('noise-menu');
    const btn = $('btn-noise');
    if (!menu || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth || 264;
    const h = menu.offsetHeight || 120;
    // above the button, clamped so it never leaves the screen
    let top = r.top - h - 10;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + 10);
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';
  }
  document.addEventListener('click', (e) => {
    const menu = $('noise-menu');
    if (!menu || menu.classList.contains('hidden')) return;
    const btn = $('btn-noise');
    if (btn && btn.contains(e.target)) return;
    if (menu.contains(e.target)) return;
    menu.classList.add('hidden');
  });
  window.addEventListener('resize', () => {
    const menu = $('noise-menu');
    if (menu && !menu.classList.contains('hidden')) positionNoiseMenu();
  });

  window.copyLink = function () {
    const url = I.publicUrl || location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => showToast('لینک کپی شد')).catch(() => showToast('لینک: ' + url));
    else showToast('لینک تماس: ' + url);
  };

  window.leaveCall = function () {
    if (socket) socket.emit(EV.CALL_LEAVE, {}, () => {});
    pcMap.forEach(({ pc }) => pc.close());
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    location.href = I.base + '/home';
  };

  // ---------- Admin actions (single socket path) ----------
  window.adminApprove = function (userId) {
    socket && socket.emit(EV.CALL_APPROVE, { userId });
  };
  window.adminReject = function (userId) {
    socket && socket.emit(EV.CALL_REJECT, { userId });
  };
  window.adminRemove = function (userId) {
    socket && socket.emit(EV.CALL_KICK, { userId });
  };
  window.adminBlockSelf = function (userId, kind) {
    localBlock[userId] = localBlock[userId] || {};
    localBlock[userId][kind] = !localBlock[userId][kind];
    applyMediaOverrides(userId);
    if (I.me.is_admin) renderAdminMembers(currentList);
  };
  window.adminDisableAll = function (userId, kind) {
    const st = memberStatus.get(userId) || {};
    const lk = st.locks || {};
    // off = !locked → press toggles between "disable+lock" and "unlock only"
    socket && socket.emit(EV.CALL_DISABLE, { userId, kind, off: !lk[kind] });
  };

  // ---------- Tabs ----------
  window.switchTab = function (tab) {
    currentTab = tab;
    ['members', 'chat', 'admin'].forEach(t => {
      const c = $('content-' + t); if (c) { c.classList.add('hidden'); c.classList.remove('flex'); }
      const el = $('tab-' + t); if (el) { el.classList.remove('text-primary', 'border-primary'); el.classList.add('text-on-surface-variant', 'border-transparent'); }
    });
    const c2 = $('content-' + tab); if (c2) { c2.classList.remove('hidden'); c2.classList.add('flex'); }
    const a = $('tab-' + tab); if (a) { a.classList.add('text-primary', 'border-primary'); a.classList.remove('text-on-surface-variant', 'border-transparent'); }
    // the tab row is members/admin only — it must not show while the chat panel is open
    const sb = $('call-sidebar');
    const tabs = sb ? sb.querySelector(':scope > div') : null;
    if (tabs) tabs.classList.toggle('hidden', tab === 'chat');
    const cb = $('btn-chat-panel');
    if (cb) cb.classList.toggle('ctrl-live', tab === 'chat');
    layoutGrid();
  };
  let currentTab = 'members';
  // The chat lives in the bottom bar and the members/admin section lives behind the top
  // button: pressing the chat key NEVER opens members/admin, and closing the chat closes
  // the whole panel so only the video boxes are left.
  window.toggleChatPanel = function () {
    if (currentTab === 'chat') {
      switchTab('members');          // hide the chat panel (nothing is shown)
      toggleSidebar(false);          // and close the panel -> only the boxes remain
    } else {
      toggleSidebar(true);
      switchTab('chat');
      const inp = $('chat-input');
      if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 120);
    }
    layoutGrid();
  };

  // ---------- Right-click member menu ----------
  function openMemberMenu(e, userId, name) {
    e.preventDefault();
    menuUserId = userId;
    const la = localAudio[userId] || {};
    $('member-menu-name').textContent = name || 'عضو';
    $('mm-mute').checked = !!la.muted;
    $('mm-vol').value = (la.volume !== undefined) ? Math.round(la.volume * 100) : 100;
    const menu = $('member-menu');
    menu.classList.remove('hidden');
    menu.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 150) + 'px';
  }
  window.openMemberMenu = openMemberMenu;
  window.memberMenuMute = function (checked) {
    if (!menuUserId) return;
    localAudio[menuUserId] = localAudio[menuUserId] || {};
    localAudio[menuUserId].muted = checked;
    applyMediaOverrides(menuUserId);
  };
  window.memberMenuVolume = function (val) {
    if (!menuUserId) return;
    localAudio[menuUserId] = localAudio[menuUserId] || {};
    localAudio[menuUserId].volume = val / 100;
    applyMediaOverrides(menuUserId);
  };

  // ---------- Member info panel (glowing steel boxes) ----------
  function roleLabel(info) {
    if (info.is_manager) return 'مدیر';
    if (info.role === 'admin') return 'ادمین تماس';
    return 'کاربر عادی';
  }

  function infoBox(title, val, ltrAt) {
    return `<div class="bm-infobox">
      <span class="bm-infobox-title">${escapeHtml(title)}</span>
      <span class="bm-infobox-val"${ltrAt ? ' dir="ltr"' : ''}>${val === '' || val == null ? '—' : escapeHtml(val)}</span>
    </div>`;
  }

  function renderMemberInfoModal(userId) {
    const member = currentList.find(m => m.userId === userId);
    const info = memberInfo.get(userId) || {};
    const meta = peerMeta.get(userId) || {};
    const name = (info.display_name || member && member.name || meta.name || 'کاربر');
    const avatarEl = $('mi-avatar');
    if (avatarEl) {
      if (meta.avatar) {
        avatarEl.innerHTML = `<img src="${escapeHtml(meta.avatar)}" class="w-full h-full object-cover" alt=""/>`;
      } else {
        avatarEl.style.background = (member && member.avatar_color) ? member.avatar_color : '#4f46e5';
        avatarEl.textContent = initials(name);
      }
    }
    $('mi-name').textContent = name;
    // Privacy: manager/admin contact info is hidden from non-managers
    const viewerIsManager = !!(I.me && I.me.is_manager);
    const redacted = !!info.redacted ||
      (!viewerIsManager && userId !== I.me.id && (info.is_manager || info.role === 'admin'));
    $('mi-sub').textContent = redacted ? roleLabel(info) : '@' + (info.username || (member && member.username) || '');
    $('mi-grid').innerHTML = [
      infoBox('نام کامل', info.full_name),
      redacted ? '' : infoBox('نام کاربری', info.username, 1),
      infoBox('نام نمایشی', info.display_name),
      redacted ? infoBox('اطلاعات تماس', 'محرمانه') : infoBox('ایمیل', info.email, 1),
      infoBox('رمز', info.has_password ? '********' : 'ندارد'),
      redacted ? '' : infoBox('شماره موبایل', info.phone, 1),
      infoBox('نقش', roleLabel(info)),
    ].filter(Boolean).join('');
    $('member-info').classList.remove('hidden');
  }

  window.openMemberInfo = function (userId) {
    userId = Number(userId);
    memberInfo.set(userId, Object.assign({}, memberInfo.get(userId) || {}, {
      username: memberInfo.get(userId) && memberInfo.get(userId).username || ((memberNames.get(userId) || '')),
    }));
    renderMemberInfoModal(userId);
    fetch((I.base || '') + '/api/members/' + encodeURIComponent(userId)) // /api/members/:userId — the call-page info panel fetches it
      .then(r => r.json())
      .then(d => {
        if (d && d.ok && d.user) {
          const u = d.user;
          memberInfo.set(userId, {
            full_name: u.full_name, username: u.username, display_name: u.display_name,
            email: u.email, phone: u.phone, is_manager: !!u.is_manager,
            role: (memberInfo.get(userId) || {}).role || '', has_password: !!u.has_password,
            redacted: !!u.redacted,
          });
          renderMemberInfoModal(Number(userId));
        }
      })
      .catch(() => { /* keep SSR data */ });
  };
  window.closeMemberInfo = function () {
    $('member-info').classList.add('hidden');
  };

  // ---------- Overrides & tile helpers ----------
  function applyMediaOverrides(userId) {
    const v = $('vid-' + userId), av = $('av-' + userId);
    if (!v) return;
    const blk = localBlock[userId] || {};
    const la = localAudio[userId] || {};
    const st = memberStatus.get(userId) || {};
    v.muted = !!(blk.audio || la.muted);
    v.volume = (la.volume !== undefined) ? la.volume : 1;
    const hideVideo = blk.video || (st.cam === false && !st.sharing);
    if (hideVideo) { v.style.display = 'none'; if (av) av.style.display = 'flex'; }
    else { v.style.display = ''; if (av) av.style.display = 'none'; }
    // a tile that becomes visible again (camera back on) must actually be RUNNING —
    // autoplay with sound is often still blocked at this point
    if (!hideVideo && v.paused) tryPlay(v);
  }
  function updateTileName(userId) {
    const el = $('name-' + userId);
    if (!el) return;
    const nm = memberNames.get(userId) || (peerMeta.get(userId) || {}).name;
    el.textContent = nm || 'بدون نام';
  }
  let focusedKey = null;
  let maximizedKey = null;
  let barCollapsed = false;
  let maxSidebarWasOpen = false;

  // ---------- Maximize: a fixed full-viewport overlay ----------
  // `position: fixed; inset: 0` IS the whole site area — the browser tabs live
  // outside the viewport, so they stay visible and nothing can overflow the page.
  const maxOverlay = $('max-overlay');
  let maxHolder = null;
  let maxEl = null;

  function isMaximized() { return !!(maxEl && maxEl.isConnected); }

  function enterMaximize(el) {
    if (!el || !maxOverlay || isMaximized()) return;
    maxEl = el;
    // remember where it was so it can go back to the same spot
    const ph = document.createElement('div');
    ph.id = 'max-placeholder';
    ph.style.display = 'none';
    el.parentNode.insertBefore(ph, el);
    maxHolder = ph;
    el.classList.add('maximized-el');
    maxOverlay.appendChild(el);
    maxOverlay.classList.remove('hidden');
    const back = el.querySelector('.mx-back');
    if (back) back.classList.remove('hidden');
    document.body.classList.add('is-maximized');
    // the members/admin panel has no business covering the big box — close it, and
    // remember whether it was open so exiting the box restores the same view
    const sb = $('call-sidebar');
    maxSidebarWasOpen = !!(sb && !sb.classList.contains('hidden'));
    if (window.toggleSidebar) window.toggleSidebar(false);
    setControlBarVisible(false);
    if (window.bmWbOnMaximizeChange) window.bmWbOnMaximizeChange();
  }

  function exitMaximize(opts) {
    opts = opts || {};
    if (!isMaximized()) return;
    const el = maxEl;
    el.classList.remove('maximized-el');
    if (maxHolder && maxHolder.parentNode) {
      maxHolder.parentNode.insertBefore(el, maxHolder);
      maxHolder.remove();
    } else if (grid) {
      grid.appendChild(el);
    }
    maxHolder = null;
    maxEl = null;
    if (maxOverlay) maxOverlay.classList.add('hidden');
    const back = document.querySelector('.mx-back');
    if (back) back.classList.add('hidden');
    document.body.classList.remove('is-maximized');
    if (maxSidebarWasOpen && window.toggleSidebar) window.toggleSidebar(true);
    maxSidebarWasOpen = false;
    setControlBarVisible(true);
    if (opts.relayout !== false) layoutGrid();
    if (window.bmWbOnMaximizeChange) window.bmWbOnMaximizeChange();
  }

  window.toggleMaximize = function (key) {
    if (isMaximized() && maxEl && maxEl.id === 'tile-' + key) { exitMaximize(); return; }
    const el = key ? $('tile-' + key) : null;
    if (!el) return;
    maximizedKey = key;
    focusedKey = null;
    enterMaximize(el);
    layoutGrid();
  };
  // used by the shared site/video box header button
  window.toggleMaximizeWeb = function () {
    if (isMaximized()) { exitMaximize(); return; }
    const box = $('web-box');
    if (!box) return;
    enterMaximize(box);
    if (window.bmWebSetExpanded) window.bmWebSetExpanded(false);
  };
  // used by the whiteboard box header button
  window.bmEnterMaximizeWb = function () {
    if (isMaximized()) return;
    const box = $('wb-box');
    if (!box) return;
    enterMaximize(box);
  };
  window.bmIsMaximized = isMaximized;

  // ---------- control bar collapse ----------
  window.toggleControlBar = function (show) {
    setControlBarVisible(show === undefined ? barCollapsed : show);
  };
  function setControlBarVisible(show) {
    barCollapsed = !show;
    const nav = $('control-bar');
    const dot = $('btn-bar-show');
    // both directions are animated: the bar slides out to the side, the dot pops back in
    if (nav) nav.classList.toggle('bar-collapsed', barCollapsed);
    if (dot) {
      // fully hidden once the bar is back, fully visible (and above the maximized layer)
      // while it is collapsed
      if (barCollapsed) {
        dot.classList.remove('hidden');
        dot.classList.add('bar-in');
      } else {
        dot.classList.remove('bar-in');
        setTimeout(() => { if (!barCollapsed) dot.classList.add('hidden'); }, 300);
      }
    }
    window.setTimeout(layoutGrid, 340);
  }
  function layoutGrid() {
    if (!grid) return;
    grid.style.display = 'grid';
    grid.style.gap = ''; // let .call-grid CSS pick the desktop/mobile gap
    const all = Array.from(grid.children);

    // visibility: admin-controlled (room-wide) + local member-box preference (per-user).
    // Hidden boxes stay in the DOM but take no space and are excluded from layout.
    const visible = [];
    all.forEach(t => {
      const show = isBoxVisible(t);
      t.style.display = show ? '' : 'none';
      if (show) visible.push(t);
    });

    // if the maximized box became hidden (e.g. admin hid it), restore it then re-layout
    if (isMaximized() && !isBoxVisible(maxEl)) {
      exitMaximize({ relayout: false });
      return layoutGrid();
    }
    let focusedEl = focusedKey ? grid.querySelector('#tile-' + focusedKey) : null;
    if (focusedEl && focusedEl.style.display === 'none') { focusedKey = null; focusedEl = null; }
    if (focusedKey && !focusedEl) { focusedKey = null; focusedEl = null; }

    // reset layout properties on visible boxes
    visible.forEach(t => {
      t.style.order = '';
      t.style.gridColumn = '';
      t.style.gridRow = '';
      t.classList.toggle('tile-focused', t === focusedEl);
    });

    // a maximized box lives in the full-viewport overlay, not in the grid
    if (isMaximized()) {
      grid.style.gridTemplateColumns = '';
      grid.style.gridTemplateRows = '';
      grid.style.gridAutoRows = 'minmax(0, 1fr)';
      return;
    }

    const webBox = $('web-box');
    const hasWeb = webBox && webBox.parentElement === grid && webBox.style.display !== 'none';
    if (hasWeb) {
      if (window.bmWebOnLayout) window.bmWebOnLayout();
      grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))';
      grid.style.gridTemplateRows = '';
      grid.style.gridAutoRows = 'minmax(0, 1fr)';
      grid.style.alignContent = 'stretch';
      webBox.style.gridColumn = '';
      webBox.style.gridRow = '';
      webBox.style.height = '';
      const tiles = visible.filter(t => t !== webBox);
      tiles.forEach(t => { t.style.gridColumn = ''; t.style.order = ''; });
      // clicking a tile still enlarges it, exactly like a normal member tile
      if (focusedEl && focusedEl.style.display !== 'none') {
        focusedEl.style.gridColumn = '1 / -1';
        focusedEl.style.order = '-1';
      }
      return;
    }

    grid.style.alignContent = '';
    grid.style.gridTemplateRows = '';
    grid.style.gridAutoRows = 'minmax(0, 1fr)';

    if (!focusedKey || !focusedEl) {
      grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))';
      return;
    }

    const others = visible.filter(t => t !== focusedEl);
    if (window.matchMedia('(max-width: 767px)').matches || others.length === 0) {
      // mobile (or alone in the room): focused tile on top / full width
      grid.style.gridTemplateColumns = others.length ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)';
      focusedEl.style.gridColumn = others.length ? '1 / -1' : '';
      focusedEl.style.order = '-1';
    } else {
      // desktop: focused tile owns the wide column, others stack in the narrow one
      grid.style.gridTemplateColumns = 'minmax(0, 4fr) minmax(0, 1fr)';
      focusedEl.style.gridColumn = '1';
      focusedEl.style.gridRow = '1 / span ' + Math.max(1, others.length);
      others.forEach(t => { t.style.gridColumn = '2'; });
    }
  }
  window.addEventListener('resize', layoutGrid);

  window.toggleFocus = function (key) {
    if (isMaximized()) { exitMaximize(); return; } // clicking a tile leaves the maximized view
    focusedKey = (focusedKey === key) ? null : key;
    if (focusedKey) maximizedKey = null;
    layoutGrid();
  };
  window.bmExitMaximize = exitMaximize;

  // the top-bar button owns the members/admin section
  window.bmSwitchTabToMembers = function () {
    if (currentTab === 'chat') switchTab('members');
  };

  // small hooks used by call-web.js
  window.bmCallRelayout = function () { renderAdminBoxList(); layoutGrid(); };
  window.bmCallRoster = function () { return currentList.slice(); };

  // The stage can change size without a window resize (sidebar open/close, rotation,
  // the browser devtools panel…). Re-measure on every size change so the tiles always
  // fit exactly — otherwise the rows keep their old height and spill off the page.
  if (window.ResizeObserver && grid) {
    let lastW = 0, lastH = 0;
    const ro = new ResizeObserver(() => {
      const w = grid.clientWidth, h = grid.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      requestAnimationFrame(layoutGrid);
    });
    ro.observe(grid);
  }

  function updateTileStatus(userId) {
    const st = memberStatus.get(userId) || {};
    const mic = $('mic-' + userId);
    if (mic) {
      setBMIcon(mic, st.muted ? 'mic_off' : 'mic');
      mic.classList.toggle('text-error', !!st.muted);
      mic.classList.toggle('text-secondary', !st.muted);
    }
    const sa = $('sa-' + userId);
    if (sa) sa.classList.toggle('hidden', !st.shareAudio);
    applyMediaOverrides(userId);
  }

  // ---------- Init ----------
  let mediaReady = false;
  // ---------- "join without approval" ----------
  function paintOpenJoin(on) {
    const sw = $('open-join-call');
    if (sw) sw.checked = !!on;
    const hint = $('openjoin-hint-call');
    if (hint) {
      hint.textContent = on
        ? 'هر کسی با لینک تماس مستقیم وارد می‌شود'
        : 'کاربران تا تایید شما منتظر می‌مانند';
    }
  }
  window.setOpenJoin = function (on) {
    const s = socket;
    if (!s || !s.connected) { showToast('اتصال زنده برقرار نیست'); return; }
    s.emit(EV.CALL_SET_OPEN_JOIN, { on: !!on }, (res) => {
      if (!res || !res.ok) { paintOpenJoin(!on); showToast('تغییر اعمال نشد'); return; }
      paintOpenJoin(!!res.openJoin);
      showToast(res.openJoin
        ? 'ورود بدون تایید فعال شد — هر کسی با لینک وارد می‌شود'
        : 'ورود بدون تایید خاموش شد — کاربران منتظر تایید شما می‌مانند');
    });
  };

  function applyRankRestrictions() {
    const rows = (window.INIT && window.INIT.limits && window.INIT.limits.rows) || {};
    const blocked = key => !!(rows[key] && rows[key].on === false);
    const hide = (id, key) => { if (blocked(key)) { const el = $(id); if (el) el.classList.add('hidden'); } };
    hide('btn-wb', 'can_whiteboard');
    hide('btn-web', 'can_use_web_box');
    hide('btn-share', 'can_share_screen');
    hide('btn-chat-panel', 'can_send_chat');
    hide('btn-emoji', 'can_send_emoji');
    if (blocked('can_send_chat')) {
      const inp = $('chat-input');
      if (inp) { inp.disabled = true; inp.placeholder = 'ارسال پیام برای نوع کاربر شما غیرفعال است'; }
    }
  }

  function init() {
    renderSelf();
    window.bmUpdateNoiseUI && window.bmUpdateNoiseUI();
    paintOpenJoin(!!(I.meeting && I.meeting.open_join));
    if (!approved) $('waiting-overlay').classList.remove('hidden');
    // bootstrap tiles from SSR data (HTTP bootstrap rule) — realtime updates take over after join
    if (I.participants && I.participants.length) {
      const mapped = I.participants.map(p => ({
        userId: p.user_id, name: p.display_name, username: p.username,
        status: p.status, is_admin: (p.role === 'admin'),
        muted: !!p.muted, cam: !!p.cam_on, sharing: !!p.sharing,
        avatar_color: p.avatar_color, avatar: p.avatar
      }));
      mapped.forEach(m => {
        const p = (I.participants || []).find(x => x.user_id === m.userId);
        memberNames.set(m.userId, m.name);
        memberStatus.set(m.userId, { muted: !!m.muted, cam: m.cam !== false, sharing: !!m.sharing });
        if (p && (p.full_name != null || p.email != null || p.phone != null || p.is_manager != null)) {
          memberInfo.set(m.userId, {
            full_name: p.full_name, username: p.username, display_name: p.display_name,
            email: p.email, phone: p.phone, is_manager: !!p.is_manager,
            role: p.role, has_password: true, redacted: !!p.redacted,
          });
        }
        if (m.userId !== I.me.id && m.status === 'approved') getOrCreateTile(m.userId, m);
      });
      currentList = mapped;
      // whoever was already in the room when this page opened is not "new"
      mapped.forEach(m => { if (m.userId !== I.me.id) seenMemberIds.add(m.userId); });
      mapped.forEach(renderOneMember);
      renderPendingCards();
    }
    (I.messages || []).forEach(m => appendMessage(m.user_id, m.display_name, m.body, m.user_id === I.me.id));
    (I.emojis || []).forEach(e => spawnEmoji(e.emoji, false));
    buildEmojiGrid();
    updateLocalMemberBoxesUI();
    renderAdminBoxList();
    layoutGrid();
    const mm = $('member-menu');
    if (mm) mm.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { const m = $('member-menu'); if (m) m.classList.add('hidden'); });

    // Hide the controls this rank is not allowed to use. The server enforces the same
    // switches on every socket event, so this is only the visible half of the rule.
    applyRankRestrictions();
    // always initialise the shared-box module (it also hides rank-restricted menu items);
    // CALL_WELCOME re-calls it with the room's current box when one already exists.
    if (window.bmWebInit) window.bmWebInit(null);

    // whiteboard canvas / pointer wiring (call.ejs ships the markup)
    if (window.bmWbInit) window.bmWbInit();

    // Connect and join as early as possible — do not wait for camera/mic permission
    // or device startup, which can take seconds and made "establishing connection"
    // feel very slow. Media is acquired in parallel and added to peers once ready.
    connectSocket();
    startMedia().then(() => {
      mediaReady = true;
      if (socket && socket.connected) doJoin();
      // attach the newly acquired tracks to every peer and announce the real state
      pcMap.forEach((st) => addLocalTracks(st));
      if (approved) broadcastStatus();
    }).catch(() => {
      mediaReady = true;
      if (socket && socket.connected) doJoin();
    });
  }
  init();
})();
