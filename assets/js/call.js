// assets/js/call.js — Phase 1: realtime call page
// - handshake-authenticated socket, single `call:join` path
// - perfect negotiation (polite/impolite) + ICE restart recovery
// - incremental member events (member:joined/left/updated/...)
// - admin actions via one socket path (server → PHP → DB → broadcast)
(function () {
  const I = window.INIT;
  const EV = window.BMEv;
  const ICE = (I && I.iceServers && I.iceServers.length) ? I.iceServers : [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302?transport=udp' },
  ];
  const EMOJIS = ['👍', '❤️', '👏', '😂', '🎉', '😮', '🔥', '✅', '🙏', '💡', '😎', '🌟'];

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
  let joinedRoom = false;
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
    const merged = i >= 0 ? Object.assign({}, currentList[i], m) : m;
    if (i >= 0) currentList[i] = merged; else currentList.push(merged);
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
  function startMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { renderSelf(); return Promise.resolve(); }
    return navigator.mediaDevices.getUserMedia({ audio: true })
      .then(audioStream => {
        localStream = audioStream;
        micOn = true;
        return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } })
          .then(videoStream => {
            const first = videoStream.getVideoTracks()[0] || null;
            if (!first) { cameraTrack = null; camOn = false; return; }
            const keep = () => { cameraTrack = first; localStream.addTrack(first); camOn = true; };
            if (!looksVirtual(first.label)) { keep(); return; }
            return preferRealCamera().then(real => {
              if (real) { try { first.stop(); } catch (e) {} cameraTrack = real; localStream.addTrack(real); camOn = true; }
              else keep();
            }).catch(keep);
          })
          .catch(() => { camOn = false; cameraTrack = null; });
      })
      .then(() => {
        currentVideoTrack = cameraTrack;
        updateSelfVideo();
        updateControlUI();
        if (approved) applyDefaultMedia();
        pcMap.forEach((st) => addLocalTracks(st));
      })
      .catch(() => { micOn = false; camOn = false; renderSelf(); updateControlUI(); });
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

  function addLocalTracks(st) {
    const pc = st.pc;
    if (localStream) {
      localStream.getTracks().forEach(t => {
        if (t.kind === 'video') return; // video sender is managed by ensureVideoSender
        const exists = pc.getSenders().some(s => s.track && s.track.kind === t.kind);
        if (!exists) pc.addTrack(t, localStream);
      });
    }
    ensureVideoSender(st);
  }

  function updateSelfVideo() {
    const v = $('self-video');
    const av = $('self-avatar');
    if (currentVideoTrack) {
      const s = new MediaStream([currentVideoTrack]);
      v.srcObject = s; v.style.display = ''; if (av) av.style.display = 'none';
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
    updateSelfVideo();
    updateControlUI();
    broadcastStatus();
  }

  // ---------- Tiles ----------
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
        <button type="button" id="mx-self" onclick="event.stopPropagation(); window.toggleMaximize('self')" class="mx-btn text-on-surface-variant hover:text-on-surface transition-colors" title="بزرگ‌نمایی">
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
        <button type="button" id="mx-${userId}" onclick="event.stopPropagation(); window.toggleMaximize('${userId}')" class="mx-btn text-on-surface-variant hover:text-on-surface transition-colors" title="بزرگ‌نمایی">
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
    };
    const pc = st.pc;
    pcMap.set(peer.userId, st);
    addLocalTracks(st);

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
      rs.addTrack(e.track);
      const v = $('vid-' + peer.userId);
      if (v) v.srcObject = rs;
      applyMediaOverrides(peer.userId);
    };
    pc.onnegotiationneeded = async () => {
      if (!socket) return;
      try {
        st.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit(EV.CALL_SIGNAL, { to: peer.userId, data: { type: 'desc', sdp: pc.localDescription } });
      } catch (e) {
      } finally {
        st.makingOffer = false;
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        // ICE restart — no page refresh needed for routine recovery
        try { pc.restartIce(); } catch (e) {}
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch (e) {}
      }
    };

    if (initiator && socket && socket.connected) {
      // explicit initial offer from the deterministic initiator
      try {
        st.makingOffer = true;
        pc.createOffer().then(async (offer) => {
          await pc.setLocalDescription(offer);
          socket.emit(EV.CALL_SIGNAL, { to: peer.userId, data: { type: 'desc', sdp: pc.localDescription } });
        }).finally(() => { st.makingOffer = false; });
      } catch (e) { st.makingOffer = false; }
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
        await pc.setRemoteDescription(data.sdp);
        st.srdAnswerPending = false;
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription();
          socket.emit(EV.CALL_SIGNAL, { to: from, data: { type: 'desc', sdp: pc.localDescription } });
        }
      } else if (data.type === 'ice') {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!st.ignoreOffer) throw err;
        }
      }
    } catch (e) { /* recoverable: ICE restart will kick in on failure states */ }
  }

  function destroyPC(userId) {
    const st = pcMap.get(userId);
    if (st) { try { st.pc.close(); } catch (e) {} pcMap.delete(userId); }
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
        getOrCreateTile(mm.userId, mm);
        createPC(mm, I.me.id > mm.userId);
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
        // authoritative bootstrap members — merged into the SSR roster
        adoptMembers(resp.members, true);
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

    socket.on('connect', () => {
      setConn('زنده', 'bg-secondary');
      joinedRoom = false;
      if (mediaReady) doJoin();
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
    });
    socket.on(EV.CALL_WELCOME, (d) => {
      // authoritative initial room state — merged, keeps SELF + SSR entries
      adoptMembers(d.members, true);
      // my own admin locks (server also replays FORCE_DISABLE as catch-up)
      if (d.you && d.you.locks) {
        ['audio', 'video', 'screen'].forEach((k) => {
          if (d.you.locks[k]) { locks[k] = true; updateControlUI(); }
        });
      }
      // an already-running site/video box must appear for late joiners too
      if (d.web && window.bmWebInit) window.bmWebInit(d.web);
    });
    socket.on(EV.MEMBER_JOINED, ({ member }) => {
      adoptMembers([member], true);
    });
    socket.on(EV.MEMBER_LEFT, ({ userId }) => {
      dropMember(userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      if (userId === I.me.id) currentList = currentList.filter(x => x.userId !== userId);
      renderPendingCards();
      layoutGrid();
    });
    socket.on(EV.MEMBER_UPDATED, (d) => {
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
    });
    socket.on(EV.MEMBER_PENDING, ({ member }) => {
      adoptMembers([member], false);
      playBeep();
      showToast('درخواست ورود از سمت ' + (member.name || 'یک کاربر'));
    });
    socket.on(EV.MEMBER_APPROVED, ({ member }) => {
      if (member.userId === I.me.id) approved = true;
      adoptMembers([member], true);
    });
    socket.on(EV.MEMBER_KICKED, ({ userId }) => {
      dropMember(userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      renderPendingCards();
    });
    socket.on(EV.MEMBER_BLOCKED, ({ userId }) => {
      dropMember(userId);
      removeMemberRow(userId);
      destroyPC(userId);
      removeTile(userId);
      renderPendingCards();
    });
    socket.on(EV.FORCE_DISABLE, d => {
      if (d.kind === 'audio') {
        if (d.off) {
          locks.audio = true;
          if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
          micOn = false; updateControlUI(); broadcastStatus();
        } else {
          // unlock only — the mic stays off until the user turns it back on
          locks.audio = false; updateControlUI();
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
      showToast('درخواست ورود از سمت ' + (d.name || 'یک کاربر'));
      try { if ('Notification' in window && Notification.permission === 'granted') new Notification('درخواست ورود', { body: d.name || '' }); } catch (e) {}
    });

    // WebRTC signals (new contract) — legacy 'signal' also kept briefly for safety
    socket.on(EV.CALL_SIGNAL, ({ from, data }) => { handleSignal(from, data); });

    socket.on(EV.CHAT_NEW_MESSAGE, d => {
      memberNames.set(d.userId, d.name);
      appendMessage(d.userId, d.name, d.body, d.userId === I.me.id);
      if (d.userId !== I.me.id) showChatToast(d.name, d.body);
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
    startPingLoop();
  }

  // ---------- Sidebar / members (incremental) ----------
  function memberRow(m) {
    const isSelf = m.userId === I.me.id;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 p-2 hover:bg-surface-container rounded-lg transition-colors group';
    row.dataset.uid = m.userId;
const mutedIcon = m.muted ? '' + bmIcon('mic_off', 'text-[10px] text-on-error') + '' : '' + bmIcon('mic', 'text-[10px] text-on-secondary') + '';
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
    const pendingCount = currentList.filter(m => m.status !== 'approved' && m.userId !== I.me.id).length;
    const badge = $('admin-badge'); if (badge) badge.classList.toggle('hidden', pendingCount === 0);
    const sBadge = $('sidebar-badge'); if (sBadge) sBadge.classList.toggle('hidden', pendingCount === 0);
  }

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
      <div class="${self ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface'} p-3 rounded-2xl ${self ? 'rounded-tl-sm' : 'rounded-tr-sm'} text-body-sm max-w-[85%] border border-white/5">${escapeHtml(body)}</div>`;
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

  // ---------- Controls ----------
  window.toggleMic = function () {
    if (locks.audio) { showToast('میکروفون توسط ادمین قفل شده است'); return; }
    if (!localStream) { showToast('دسترسی به میکروفون وجود ندارد'); return; }
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    updateControlUI();
    broadcastStatus();
  };
  window.toggleCam = function () {
    if (locks.video) { showToast('دوربین توسط ادمین قفل شده است'); return; }
    if (!localStream) { showToast('دسترسی به دوربین وجود ندارد'); return; }
    camOn = !camOn;
    localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    if (camOn && !sharing) { currentVideoTrack = cameraTrack; }
    else if (!camOn && !sharing) { currentVideoTrack = null; }
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
        replaceOutgoingAudio(at);
      } else if (wantAudio) {
        showToast('صدای صفحه انتخاب نشد؛ فقط تصویر پخش می‌شود');
      }
      sharing = true;
      shareAudio = !!screenAudioTrack;
      replaceOutgoingVideo(screenTrack);
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
    pcMap.forEach((st) => {
      try {
        const sender = st.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) sender.replaceTrack(track || null);
        else if (track) st.pc.addTrack(track);
      } catch (e) { /* pc closed */ }
    });
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
      updateSelfVideo(); updateControlUI(); broadcastStatus();
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
      // the mic must go back out to everyone
      const mic = localStream && localStream.getAudioTracks()[0];
      replaceOutgoingAudio(mic || null);
    }
    sharing = false;
    shareAudio = false;
    updateTileAudioBadge();
    currentVideoTrack = camOn ? cameraTrack : null;
    replaceOutgoingVideo(currentVideoTrack);
    updateControlUI();
    broadcastStatus();
  }

  // ---------- Camera source menu (⋮ next to the cam button) ----------
  let camSources = [];
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
  // The chat lives in the bottom bar: pressing it shows ONLY the chat (members/admin are
  // closed), pressing it again returns to members/admin. The button turns red while open.
  window.toggleChatPanel = function () {
    const sb = $('call-sidebar');
    const tabs = sb ? sb.querySelector(':scope > div') : null;
    if (currentTab === 'chat') {
      toggleSidebar(true);
      switchTab('members'); // back to the members/admin section (members by default)
    } else {
      toggleSidebar(true);
      switchTab('chat');
      if (tabs) tabs.classList.add('hidden');
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
    setControlBarVisible(false);
  }

  function exitMaximize() {
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
    setControlBarVisible(true);
    layoutGrid();
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
      dot.classList.remove('hidden');
      dot.classList.toggle('bar-in', barCollapsed);
    }
    window.setTimeout(layoutGrid, 340);
  }
  function layoutGrid() {
    if (!grid) return;
    grid.style.display = 'grid';
    grid.style.gap = ''; // let .call-grid CSS pick the desktop/mobile gap
    const all = Array.from(grid.children);
    const webBox = $('web-box');
    let focusedEl = focusedKey ? grid.querySelector('#tile-' + focusedKey) : null;
    if (focusedKey && !focusedEl) { focusedKey = null; focusedEl = null; }

    // reset every tile first, then apply the active layout.
    // `display` MUST be cleared here: the maximize/fullscreen branches hide boxes with
    // style.display and would otherwise leave them invisible for good.
    all.forEach(t => {
      t.style.order = '';
      t.style.gridColumn = '';
      t.style.gridRow = '';
      t.style.display = '';
      t.classList.toggle('tile-focused', t === focusedEl);
    });

    // a maximized box lives in the full-viewport overlay, not in the grid
    if (isMaximized()) {
      grid.style.gridTemplateColumns = '';
      grid.style.gridTemplateRows = '';
      grid.style.gridAutoRows = 'minmax(0, 1fr)';
      return;
    }

    // the shared website/video box always outranks the camera tiles
    if (webBox && webBox.parentElement === grid) {
      if (window.bmWebOnLayout) window.bmWebOnLayout();
      const state = (window.bmWebLayoutState && window.bmWebLayoutState()) || { expanded: false };
      const tiles = all.filter(t => t !== webBox);
      // rows are sized from the space we actually have, so nothing ever overflows
      const stage = Math.max(0, (grid.clientHeight || 0));
      if (state.expanded) {
        grid.style.gridTemplateColumns = 'minmax(0, 1fr)';
        grid.style.gridTemplateRows = 'minmax(0, 1fr)';
        grid.style.gridAutoRows = 'minmax(0, 1fr)';
        grid.style.alignContent = 'stretch';
        webBox.style.gridColumn = '1';
        webBox.style.gridRow = '1';
        webBox.style.height = '';
      } else {
        grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))';
        // the box takes the top row, the member tiles share everything below it
        const webH = Math.max(200, Math.min(430, Math.round(stage * 0.42)));
        grid.style.gridTemplateRows = webH + 'px minmax(0, 1fr)';
        grid.style.gridAutoRows = 'minmax(0, 1fr)';
        grid.style.alignContent = 'stretch';
        webBox.style.gridColumn = '1 / -1';
        webBox.style.gridRow = '1';
        webBox.style.height = webH + 'px';
      }
      tiles.forEach(t => {
        if (state.expanded) t.style.display = 'none';
        else { t.style.display = ''; t.style.gridColumn = ''; t.style.order = ''; }
      });
      // clicking a tile still enlarges it: it takes the full width of a row below the box
      if (!state.expanded && focusedEl && focusedEl.style.display !== 'none') {
        focusedEl.style.gridColumn = '1 / -1';
        focusedEl.style.order = '-1';
      }
      return;
    }
    grid.style.alignContent = '';
    grid.style.gridTemplateRows = '';
    grid.style.gridAutoRows = 'minmax(0, 1fr)';

    if (!focusedKey) {
      grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))';
      return;
    }

    const others = all.filter(t => t !== focusedEl);
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

  // small hooks used by call-web.js
  window.bmCallRelayout = function () { layoutGrid(); };
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
  function init() {
    renderSelf();
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
      mapped.forEach(renderOneMember);
      renderPendingCards();
    }
    (I.messages || []).forEach(m => appendMessage(m.user_id, m.display_name, m.body, m.user_id === I.me.id));
    (I.emojis || []).forEach(e => spawnEmoji(e.emoji, false));
    buildEmojiGrid();
    layoutGrid();
    const mm = $('member-menu');
    if (mm) mm.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { const m = $('member-menu'); if (m) m.classList.add('hidden'); });

    startMedia().then(() => {
      mediaReady = true;
      connectSocket();
      // if socket already connected (fast reconnect), join now
      if (socket && socket.connected) doJoin();
    });
  }
  init();
})();
