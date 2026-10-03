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
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  const EMOJIS = ['👍', '❤️', '👏', '😂', '🎉', '😮', '🔥', '✅', '🙏', '💡', '😎', '🌟'];

  let socket = null;
  let localStream = null;
  let cameraTrack = null;
  let screenTrack = null;
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
  function startMedia() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { renderSelf(); return Promise.resolve(); }
    return navigator.mediaDevices.getUserMedia({ audio: true })
      .then(audioStream => {
        localStream = audioStream;
        micOn = true;
        return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } })
          .then(videoStream => {
            cameraTrack = videoStream.getVideoTracks()[0] || null;
            if (cameraTrack) localStream.addTrack(cameraTrack);
            camOn = !!cameraTrack;
          })
          .catch(() => { camOn = false; cameraTrack = null; });
      })
      .then(() => {
        currentVideoTrack = cameraTrack;
        updateSelfVideo();
        updateControlUI();
        if (approved) applyDefaultMedia();
        pcMap.forEach(({ pc }) => addLocalTracks(pc));
      })
      .catch(() => { micOn = false; camOn = false; renderSelf(); updateControlUI(); });
  }

  function addLocalTracks(pc) {
    if (!localStream) return;
    localStream.getTracks().forEach(t => {
      const exists = pc.getSenders().some(s => s.track && s.track.kind === t.kind);
      if (!exists) pc.addTrack(t, localStream);
    });
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
    const init = initials(meta.name || '؟');
    const color = /^#[0-9a-fA-F]{3,8}$/.test(meta.avatar_color || '') ? meta.avatar_color : '#4f46e5';
    if (meta.avatar) {
      return '<img src="' + escapeHtml(avatarUrl(meta.avatar)) + '" class="w-full h-full object-cover" alt=""/>';
    }
    return '<div class="w-full h-full flex items-center justify-center font-display-md text-white" style="background:' + color + '">' + escapeHtml(init) + '</div>';
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
      <div class="absolute bottom-3 right-3 bg-background/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
        <span class="font-label-md text-on-surface">${escapeHtml(I.me.name)} (شما)</span>
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
      <div class="absolute top-3 right-3 bg-surface-container-highest/80 backdrop-blur-md px-2 py-1 rounded-md border border-white/10">
        ${bmIcon('mic', 'text-[14px] text-secondary', false, 'id="mic-' + userId + '"')}
      </div>
      <div class="absolute bottom-3 right-3 bg-background/80 backdrop-blur-md px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2">
        <span class="font-label-md text-on-surface" id="name-${userId}">${escapeHtml((meta && meta.name) || '')}</span>
      </div>`;
    tile.oncontextmenu = (e) => openMemberMenu(e, userId, meta && meta.name);
    grid.appendChild(tile);
    applyMediaOverrides(userId);
    updateTileName(userId);
    layoutGrid();
    return tile;
  }

  function removeTile(userId) {
    const t = $('tile-' + userId); if (t) t.remove();
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
      pc: new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 4 }),
      polite,
      makingOffer: false,
      ignoreOffer: false,
      srdAnswerPending: false,
    };
    const pc = st.pc;
    pcMap.set(peer.userId, st);
    addLocalTracks(pc);

    pc.onicecandidate = e => {
      if (e.candidate && socket) socket.emit(EV.CALL_SIGNAL, { to: peer.userId, data: { type: 'ice', candidate: e.candidate } });
    };
    pc.ontrack = e => {
      let rs = remoteStreams.get(peer.userId);
      if (!rs) { rs = new MediaStream(); remoteStreams.set(peer.userId, rs); }
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
    pcMap.forEach(({ pc }) => {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(track).catch(() => {});
    });
    updateSelfVideo();
  }

  // ---------- Socket ----------
  function broadcastStatus() {
    if (socket) socket.emit(EV.CALL_STATUS, { muted: !micOn, cam: camOn, sharing });
  }

  // adopt (server-provided) members into the roster; merge, never replace.
  function adoptMembers(list, createPcs) {
    (list || []).forEach(m => {
      const mm = upsertMember(m);
      memberNames.set(mm.userId, mm.name);
      peerMeta.set(mm.userId, { name: mm.name, avatar_color: mm.avatar_color, avatar: mm.avatar || '' });
      memberStatus.set(mm.userId, { muted: !!mm.muted, cam: mm.cam !== false, sharing: !!mm.sharing });
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
        if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !d.off);
        micOn = !d.off; updateControlUI(); broadcastStatus();
      } else if (d.kind === 'video') {
        if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = !d.off);
        camOn = !d.off;
        if (camOn && !sharing) currentVideoTrack = cameraTrack;
        else if (!camOn && !sharing) currentVideoTrack = null;
        updateSelfVideo(); updateControlUI(); broadcastStatus();
      } else if (d.kind === 'screen') {
        if (d.off) stopShare();
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
    });
    socket.on(EV.CHAT_ACK, d => {
      if (!d.ok) showToast('ارسال پیام ناموفق: ' + (d.error || ''));
    });
    socket.on(EV.EMOJI, d => spawnEmoji(d.emoji));
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
        const allOff = kind === 'audio' ? st.muted
                     : kind === 'video' ? (st.cam === false)
                     : (st.sharing === false);
        return `<div class="flex flex-col items-center gap-1">
          <span class="font-label-sm text-on-surface-variant text-[11px]">${label}</span>
          <div class="flex gap-1">
            <button class="text-[11px] px-2 py-1 rounded-md ${selfOn ? 'bg-error-container text-on-error-container' : 'bg-surface-container-high text-on-surface'} hover:opacity-80" onclick="adminBlockSelf(${m.userId},'${kind}')">برای من</button>
            <button class="text-[11px] px-2 py-1 rounded-md ${allOff ? 'bg-error-container text-on-error-container' : 'bg-secondary-container text-on-secondary-container'} hover:opacity-80" onclick="adminDisableAll(${m.userId},'${kind}')">${allOff ? 'روشن همه' : 'قطع همه'}</button>
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
    wrap.className = 'flex flex-col ' + (self ? 'items-end' : 'items-start') + ' gap-1';
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
    if (!localStream) { showToast('دسترسی به میکروفون وجود ندارد'); return; }
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    updateControlUI();
    broadcastStatus();
  };
  window.toggleCam = function () {
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
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      showToast('اشتراک صفحه در این مرورگر/دستگاه پشتیبانی نمی‌شود');
      return;
    }
    navigator.mediaDevices.getDisplayMedia({ video: true }).then(screenStream => {
      screenTrack = screenStream.getVideoTracks()[0];
      screenTrack.onended = stopShare;
      sharing = true;
      replaceOutgoingVideo(screenTrack);
      updateControlUI();
      broadcastStatus();
    }).catch(err => {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') showToast('دسترسی به اشتراک صفحه داده نشد');
      else if (name === 'NotSupportedError') showToast('اشتراک صفحه در این دستگاه پشتیبانی نمی‌شود');
      else if (name !== 'AbortError') showToast('اشتراک صفحه ممکن نشد');
    });
  };
  function stopShare() {
    if (screenTrack) { screenTrack.stop(); screenTrack = null; }
    sharing = false;
    currentVideoTrack = camOn ? cameraTrack : null;
    replaceOutgoingVideo(currentVideoTrack);
    updateControlUI();
    broadcastStatus();
  }

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
    const off = kind === 'audio' ? !st.muted : kind === 'video' ? (st.cam !== false) : (st.sharing !== false);
    socket && socket.emit(EV.CALL_DISABLE, { userId, kind, off });
  };

  // ---------- Tabs ----------
  window.switchTab = function (tab) {
    ['members', 'chat', 'admin'].forEach(t => {
      const c = $('content-' + t); if (c) { c.classList.add('hidden'); c.classList.remove('flex'); }
      const el = $('tab-' + t); if (el) { el.classList.remove('text-primary', 'border-primary'); el.classList.add('text-on-surface-variant', 'border-transparent'); }
    });
    const c2 = $('content-' + tab); if (c2) { c2.classList.remove('hidden'); c2.classList.add('flex'); }
    const a = $('tab-' + tab); if (a) { a.classList.add('text-primary', 'border-primary'); a.classList.remove('text-on-surface-variant', 'border-transparent'); }
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
    $('mi-sub').textContent = '@' + (info.username || (member && member.username) || '');
    $('mi-grid').innerHTML = [
      infoBox('نام کامل', info.full_name),
      infoBox('نام کاربری', info.username, 1),
      infoBox('نام نمایشی', info.display_name),
      infoBox('ایمیل', info.email, 1),
      infoBox('رمز هش شده', info.has_password ? 'هش شده' : 'ندارد'),
      infoBox('شماره موبایل', info.phone, 1),
      infoBox('نقش', roleLabel(info)),
    ].join('');
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
    const hideVideo = blk.video || st.cam === false;
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
  function layoutGrid() {
    if (!grid) return;
    grid.style.display = 'grid';
    grid.style.gap = ''; // let .call-grid CSS pick the desktop/mobile gap
    const all = Array.from(grid.children);
    let focusedEl = focusedKey ? grid.querySelector('#tile-' + focusedKey) : null;
    if (focusedKey && !focusedEl) { focusedKey = null; focusedEl = null; }

    // reset every tile first, then apply the active layout
    all.forEach(t => {
      t.style.order = '';
      t.style.gridColumn = '';
      t.style.gridRow = '';
      t.classList.toggle('tile-focused', t === focusedEl);
    });

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
    focusedKey = (focusedKey === key) ? null : key;
    layoutGrid();
  };

  function updateTileStatus(userId) {
    const st = memberStatus.get(userId) || {};
    const mic = $('mic-' + userId);
    if (mic) {
      setBMIcon(mic, st.muted ? 'mic_off' : 'mic');
      mic.classList.toggle('text-error', !!st.muted);
      mic.classList.toggle('text-secondary', !st.muted);
    }
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
            role: p.role, has_password: true,
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
