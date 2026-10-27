'use strict';
const crypto = require('crypto');
const { Server } = require('socket.io');
const EV = require('../shared/socket-events');
const state = require('./lib/state');
const dbm = require('./lib/db');
const internalRaw = require('./lib/internal');
const internal = {};
for (const k of Object.keys(internalRaw)) {
  internal[k] = (...a) => Promise.resolve(internalRaw[k](...a));
}
const { verifySocketToken } = require('./lib/helpers');
const callfiles = require('./lib/callfiles');
const { appConfig } = require('./lib/config');

const SECRET = appConfig().secret;
const pendingClose = new Map();
const callRequests = new Map();

const { rooms, userSockets } = state;

function addGlobalSocket(uid, sid) {
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(sid);
}

function removeGlobalSocket(uid, sid) {
  const set = userSockets.get(uid);
  if (!set) return;
  set.delete(sid);
  if (set.size === 0) userSockets.delete(uid);
}

function memberInfo(s) {
  return {
    userId: s.userId, name: s.name, username: s.username,
    avatar_color: s.avatar_color, avatar: s.avatar,
    is_admin: s.is_admin, muted: s.muted, cam: s.cam, sharing: s.sharing,
    approved: s.approved, status: s.approved ? 'approved' : 'pending',
  };
}

function emitMemberJoined(roomId, member) { io.to(roomId).emit(EV.MEMBER_JOINED, { member }); }
function emitMemberLeft(roomId, userId) { io.to(roomId).emit(EV.MEMBER_LEFT, { userId }); }
function emitMemberUpdated(roomId, userId, patch) {
  io.to(roomId).emit(EV.MEMBER_UPDATED, Object.assign({ userId }, patch));
}

function memberList(roomId) {
  const r = rooms.get(roomId);
  if (!r) return [];
  const list = [];
  r.sockets.forEach((s) => list.push(memberInfo(s)));
  return list;
}

// ---------- solo call time limit ----------
// A call nobody joins is a dead call: after SOLO_LIMIT_MS with one participant the room is
// closed and everyone still inside is told why. It restarts whenever a second person joins.
const SOLO_LIMIT_MS = Number(process.env.BM_SOLO_LIMIT_MS || 15 * 60 * 1000);
const soloTimers = new Map();

function cancelSoloTimer(roomId) {
  const t = soloTimers.get(roomId);
  if (t) { clearTimeout(t); soloTimers.delete(roomId); }
}
function armSoloTimer(roomId) {
  cancelSoloTimer(roomId);
  const r = rooms.get(roomId);
  if (!r) return;
  const t = setTimeout(() => {
    soloTimers.delete(roomId);
    const room = rooms.get(roomId);
    if (!room) return;
    // only if still alone AND still connected
    const people = new Set();
    room.sockets.forEach((s) => people.add(s.userId));
    if (people.size !== 1 || room.sockets.size === 0) return;
    console.log('[call] solo call in room ' + roomId + ' passed the time limit -> closing');
    try {
      room.sockets.forEach((s, sid) => {
        // the socket itself (not the room) — nobody has to have joined the room channel
        io.to(sid).emit(EV.CALL_SOLO_ENDED, { minutes: Math.round(SOLO_LIMIT_MS / 60000) || SOLO_LIMIT_MS });
      });
    } catch (e) { console.log('[call] could not notify the room: ' + e.message); }
    rooms.delete(roomId);
    internal.closeMeeting(roomId);
  }, SOLO_LIMIT_MS);
  if (t.unref) t.unref();
  soloTimers.set(roomId, t);
}
// keeps the timer honest: run it whenever the room's population changes
function updateSoloTimer(roomId) {
  const r = rooms.get(roomId);
  if (!r) return;
  const people = new Set();
  r.sockets.forEach((s) => people.add(s.userId));
  if (people.size <= 1) armSoloTimer(roomId);
  else cancelSoloTimer(roomId);
}

function scheduleCloseMeeting(roomId) {
  if (pendingClose.has(roomId)) return;
  const t = setTimeout(() => {
    pendingClose.delete(roomId);
    internal.closeMeeting(roomId);
  }, 5000);
  pendingClose.set(roomId, t);
}

function verifyToken(token) {
  const dec = {};
  if (verifySocketToken(token, dec)) return dec;
  return null;
}

let io = null;

function attach(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const dec = token ? verifyToken(token) : null;
    if (!dec || !dec.user_id) return next(new Error('UNAUTHORIZED'));
    socket.data.userId = dec.user_id;
    socket.data.meetingId = dec.meeting_id || 0;
    next();
  });

  io.on('connection', (socket) => {
    const uid = socket.data.userId;
    // manager flag is SERVER-derived (DB) at connect time — it gates PV_SEND,
    // pvToManagers and pvConversationUpdated. Never trust a client payload for it.
    try {
      const u = dbm.get('SELECT is_manager FROM users WHERE id=?', [uid]);
      socket.data.isManager = !!(u && u.is_manager);
    } catch (err) {
      socket.data.isManager = false;
    }
    addGlobalSocket(uid, socket.id);

    const firstConn = userSockets.get(uid) && userSockets.get(uid).size === 1;
    if (firstConn) io.emit(EV.PRESENCE_ONLINE, { userId: uid });
    socket.emit(EV.CONN_STATE, { state: 'connected', userId: uid });

    socket.on(EV.PRESENCE_PING, () => {});

    socket.on('presence:list', (cb) => {
      if (typeof cb === 'function') cb({ ok: true, online: Array.from(userSockets.keys()) });
    });

    socket.on(EV.AUTH_HELLO, (msg = {}) => {
      if (msg.name && typeof msg.name === 'string') socket.data.name = msg.name.slice(0, 120);
      if (msg.username && typeof msg.username === 'string') socket.data.username = msg.username.slice(0, 60);
    });

    socket.on(EV.BM_SUBSCRIBE, (msg = {}) => {
      const allowed = ['announcements'];
      const room = String(msg.room || '');
      if (allowed.includes(room)) socket.join('bm:' + room);
    });

    socket.on(EV.CALL_JOIN, (payload = {}, cb) => {
      const { room, user } = payload;
      const token = payload.token || (socket.handshake.auth && socket.handshake.auth.token);
      const dec = token ? verifyToken(token) : null;
      if (!room || !dec || dec.user_id !== uid || !user || (parseInt(user.id, 10) !== uid)) {
        const e = { ok: false, error: 'NOT_AUTHORIZED' };
        socket.emit(EV.ERR, e);
        if (typeof cb === 'function') cb(e);
        return;
      }
      internal.meetingState(room, uid).then((st) => {
        if (!st.ok) {
          const err = st.error === 'BLOCKED' ? 'BLOCKED' : 'MEETING_NOT_FOUND';
          const e = { ok: false, error: err };
          socket.emit(err === 'BLOCKED' ? EV.YOU_BLOCKED : EV.ERR, e);
          if (typeof cb === 'function') cb(e);
          return;
        }
        const meetingId = st.meeting.id;
        const role = st.isAdmin ? 'admin' : (st.you ? st.you.role : 'member');
        const approvedBefore = !!(st.you && st.you.status === 'approved') || st.isAdmin;

        if (!rooms.has(room)) {
          rooms.set(room, { meetingId, sockets: new Map(), userSockets: new Map(), pending: new Set(), blocked: new Set() });
          if (pendingClose.has(room)) { clearTimeout(pendingClose.get(room)); pendingClose.delete(room); }
        }
        const r = rooms.get(room);
        const prevSet = r.userSockets.get(uid);
        if (prevSet) {
          prevSet.forEach((sid) => {
            const prev = r.sockets.get(sid);
            if (prev && sid !== socket.id) {
              r.sockets.delete(sid);
              // A reconnect of the SAME page (flaky mobile network) re-registers with the
              // same session key: drop the stale socket SILENTLY. Telling it "you were
              // removed" would throw that user out of the call while they only talked.
              const sameSession = prev.sessionKey && payload.sessionKey && prev.sessionKey === payload.sessionKey;
              const stale = io.of('/').sockets.get(sid);
              if (stale && !sameSession) stale.emit(EV.YOU_REMOVED, { ok: true, reason: 'replaced' });
              if (stale && sameSession) { stale.leave(room); stale.data.room = null; }
            }
          });
        }

        const info = {
          userId: uid, name: String(user.name || ''), username: String(user.username || ''),
          avatar_color: String(user.avatar_color || '#4f46e5'), avatar: String(user.avatar || ''),
          is_admin: role === 'admin', muted: false, cam: false, sharing: false,
          approved: approvedBefore || role === 'admin',
          // stable per page load: tells a reconnect apart from a second device
          sessionKey: String(payload.sessionKey || '').slice(0, 64),
        };
        // "ورود بدون تایید ادمین": with the switch on, anyone with the link walks straight in
        // NOTE: internal.* wraps every helper in a Promise, so a boolean must come from
        // internalRaw — a Promise is always truthy and would approve EVERYONE.
        if (!info.approved && internalRaw.isOpenJoin(meetingId)) {
          dbm.run(
            "INSERT INTO meeting_participants (meeting_id, user_id, display_name, username, status, role, muted, cam_on, sharing, joined_at) " +
            'VALUES (?,?,?,?,?,?,0,0,0,?) ' +
            "ON CONFLICT(meeting_id, user_id) DO UPDATE SET status='approved'",
            [meetingId, uid, info.name, info.username, 'approved', 'member', require('./lib/helpers').sqlNow()]
          );
          info.approved = true;
          info.openJoin = true;
        }
        socket.data.room = room;
        socket.data.is_admin = info.is_admin;
        socket.join(room);
        r.sockets.set(socket.id, info);
        if (!r.userSockets.has(uid)) r.userSockets.set(uid, new Set());
        r.userSockets.get(uid).add(socket.id);

        const you = memberInfo(info);
        const members = memberList(room)
          .filter((m) => m.userId !== uid)
          .map((m) => Object.assign(m, { locks: (r.locks && r.locks[m.userId]) || null }));
        you.locks = (r.locks && r.locks[uid]) || null;
        socket.emit(EV.CALL_WELCOME, {
          meeting: st.meeting, you, members, blocked: Array.from(r.blocked),
          web: publicWeb(r), openJoin: internalRaw.isOpenJoin(meetingId),
        });
        ensurePingTimer(room);

        // re-apply this user's admin locks after (re)join — off=true = locked
        const myLocks = r.locks && r.locks[uid];
        if (myLocks) {
          ['audio', 'video', 'screen'].forEach((k) => {
            if (myLocks[k]) io.to(socket.id).emit(EV.FORCE_DISABLE, { kind: k, off: true });
          });
        }

        if (info.approved) {
          socket.emit(EV.YOU_APPROVED, { ok: true });
          emitMemberJoined(room, you);
        } else {
          r.pending.add(uid);
          io.to(room).emit(EV.MEMBER_PENDING, { member: you });
        }
        // a call that never gets a second person ends by itself
        updateSoloTimer(room);
        if (typeof cb === 'function') cb({ ok: true, you, members });
      });
    });

    socket.on(EV.CALL_SIGNAL, (msg = {}) => {
      const r = rooms.get(socket.data.room);
      if (!r || typeof msg.to !== 'number' || !msg.data) return;
      const targets = r.userSockets.get(msg.to);
      if (!targets) return;
      targets.forEach((sid) => io.to(sid).emit(EV.CALL_SIGNAL, { from: uid, data: msg.data }));
    });

    socket.on(EV.CALL_CHAT_SEND, (msg = {}, cb) => {
      const room = socket.data.room;
      const body = String(msg.body || '').trim().slice(0, 2000);
      const clientMsgId = String(msg.clientMsgId || '').slice(0, 64);
      if (!room || body === '' || clientMsgId === '') {
        const e = { ok: false, error: 'BAD_REQUEST' };
        if (typeof cb === 'function') cb(e);
        return;
      }
      const sInfo = rooms.get(room) && rooms.get(room).sockets.get(socket.id);
      if (!sInfo || !sInfo.approved) {
        const e = { ok: false, error: 'NOT_A_MEMBER' };
        socket.emit(EV.ERR, e);
        if (typeof cb === 'function') cb(e);
        return;
      }
      internal.chatPersist(room, uid, body, clientMsgId).then((res) => {
        if (!res.ok) {
          const e = { ok: false, error: res.error || 'SAVE_FAILED', clientMsgId };
          socket.emit(EV.CHAT_ACK, e);
          if (typeof cb === 'function') cb(e);
          return;
        }
        const payload = { id: res.id, userId: uid, name: res.name || sInfo.name, body, clientMsgId, ts: Date.now() };
        socket.emit(EV.CHAT_ACK, { ok: true, clientMsgId, id: res.id });
        socket.to(room).emit(EV.CHAT_NEW_MESSAGE, payload);
        if (typeof cb === 'function') cb({ ok: true, id: res.id });
      });
    });

    socket.on(EV.CALL_EMOJI, (msg = {}) => {
      const room = socket.data.room;
      if (!room || typeof msg.emoji !== 'string' || msg.emoji.length > 8) return;
      const r = rooms.get(room);
      socket.to(room).emit(EV.EMOJI, { userId: uid, name: (r && r.sockets.get(socket.id) || {}).name || '', emoji: msg.emoji });
    });

    socket.on(EV.CALL_STATUS, (st = {}) => {
      const room = socket.data.room;
      const r = rooms.get(room);
      if (!r) return;
      const s = r.sockets.get(socket.id);
      if (!s) return;
      const patch = {};
      if (typeof st.muted === 'boolean') { s.muted = st.muted; patch.muted = st.muted; }
      if (typeof st.cam === 'boolean') { s.cam = st.cam; patch.cam = st.cam; }
      if (typeof st.sharing === 'boolean') { s.sharing = st.sharing; patch.sharing = st.sharing; }
      if (typeof st.shareAudio === 'boolean') { s.shareAudio = st.shareAudio; patch.shareAudio = st.shareAudio; }
      emitMemberUpdated(room, uid, patch);
    });

    function requireRoomAdmin() {
      const r = rooms.get(socket.data.room);
      if (!r) return null;
      const me = r.sockets.get(socket.id);
      if (!me || !me.is_admin) return null;
      return r;
    }

    // ---------- per-user latency (ping) ----------
    // Clients emit CALL_PING {t}; we time it ourselves (never trust the client)
    // and broadcast the map of userId -> rtt every few seconds.
    socket.on(EV.CALL_PING, (msg = {}) => {
      const t = Number(msg && msg.t);
      if (!Number.isFinite(t)) return;
      socket.emit(EV.CALL_PONG, { t });
      const r = rooms.get(socket.data.room);
      if (!r) return;
      const s = r.sockets.get(socket.id);
      if (!s) return;
      s.rtt = Math.max(0, Math.min(9999, Math.round(Date.now() - t)));
    });

    let pingTimer = null;
    function ensurePingTimer(room) {
      if (pingTimer) return;
      pingTimer = setInterval(() => {
        const r = rooms.get(room);
        if (!r || !r.sockets.size) {
          if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
          return;
        }
        const pings = {};
        r.sockets.forEach((s) => { if (Number.isFinite(s.rtt)) pings[s.userId] = s.rtt; });
        io.to(room).emit(EV.PING_STATS, { pings });
      }, 3000);
      if (pingTimer.unref) pingTimer.unref();
    }

    // ---------- shared web surface (site box / video box) ----------
    function publicWeb(r) {
      const w = r && r.web;
      if (!w || !w.kind || !w.url) return null;
      return {
        kind: w.kind, url: w.url, src: w.src, host: w.host,
        name: w.name || '', size: Number(w.size) || 0, viewable: w.viewable !== false,
        mime: w.mime || '', mode: w.mode || '',
        ownerId: w.ownerId, ownerName: w.ownerName || '',
        controlAll: w.controlAll !== false,
        controllers: Array.from(w.controllers || []),
        viewersAll: w.viewersAll !== false,
        viewers: Array.from(w.viewers || []),
        scroll: w.scroll || null,
        video: w.video || null,
        follow: w.follow !== false,
      };
    }
    function webRoom() {
      const r = rooms.get(socket.data.room);
      return r ? r : null;
    }
    function canControlWeb(r, s) {
      const w = r && r.web;
      if (!w) return false;
      if (w.controlAll !== false) return true;
      return !!(s && (w.controllers || new Set()).has(s.userId));
    }
    function canViewWeb(r, s) {
      const w = r && r.web;
      if (!w) return false;
      if (w.viewersAll !== false) return true;
      return !!(s && (w.viewers || new Set()).has(s.userId));
    }
    // An uploaded file: NEVER a free-form URL. The client posts the bytes to /api/call/file and
    // gets back an id; only that server-owned path is accepted, so a member cannot point the
    // box at a remote page and call it "a file". `kind` is the MODE: file | audio | video.
    function normalizeCallFile(kind, rawUrl) {
      const m2 = String(rawUrl || '').match(/^\/black-meet\/call-file\/([a-f0-9]{24,64})(?:\?|$)/);
      if (!m2) return { ok: false, error: 'BAD_URL' };
      const meta = callfiles.meta(socket.data.room, m2[1]);
      if (!meta) return { ok: false, error: 'NO_FILE' };
      const url = '/black-meet/call-file/' + meta.id;
      const common = {
        ok: true, url, src: url, host: meta.name,
        name: meta.name, size: meta.size, viewable: meta.viewable, mime: meta.mime,
      };
      // the mode only decides HOW it is shown: in our own player, or as a document
      if (kind === 'audio') return Object.assign({ audio: true }, common);
      return common;
    }

    // normalize + validate an incoming web target (server-side, both kinds)
    function normalizeWebTarget(kind, rawUrl) {
      const u = String(rawUrl || '').trim();
      if (u.length > 2000) return { ok: false, error: 'BAD_URL' };
      // An uploaded file is a PATH of ours, not a URL — check it BEFORE the URL parser
      // turns it into an absolute https:// URL (that dropped the ?room= the client needs).
      if (u.indexOf('/black-meet/call-file/') === 0) return normalizeCallFile(kind, u);
      let abs;
      try {
        abs = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
      } catch (e) {
        return { ok: false, error: 'BAD_URL' };
      }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return { ok: false, error: 'BAD_URL' };
      const host = abs.hostname.toLowerCase();
      if (!host) return { ok: false, error: 'BAD_URL' };
if (kind === 'audio') {
        // any http(s) URL; the browser decides whether it can stream it
        return { ok: true, url: abs.href, host, src: abs.href, audio: true };
      }
      if (kind === 'video') {
        // embed-ify the known providers, otherwise hand the URL to an <iframe>/<video>
        let embed = null;
        let m = host.match(/(?:^|\.)youtu\.be$/);
        if (m) embed = 'https://www.youtube.com/embed/' + abs.pathname.split('/').filter(Boolean)[0];
        if (!embed && (host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com')) {
          const v = abs.searchParams.get('v');
          const parts = abs.pathname.split('/').filter(Boolean);
          const id = v || (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live' ? parts[1] : '');
          if (id) embed = 'https://www.youtube.com/embed/' + id;
        }
        if (!embed && /(^|\.)aparat\.com$/.test(host)) {
          const m2 = abs.href.match(/aparat\.com\/(?:video\/)?v\/([a-zA-Z0-9]+)/);
          if (m2) embed = 'https://www.aparat.com/video/video/embed/videohash/' + m2[1] + '/vt/frame';
        }
        return { ok: true, url: abs.href, host, src: embed || abs.href, embed: !!embed };
      }
      return { ok: true, url: abs.href, host, src: abs.href };
    }

    socket.on(EV.CALL_WEB_OPEN, (msg = {}, cb) => {
      const r = webRoom();
      const s = r && r.sockets.get(socket.id);
      if (!r || !s) return;
      if (!s.approved) { if (typeof cb === 'function') cb({ ok: false, error: 'NOT_A_MEMBER' }); return; }
      const kind = msg.kind === 'video' ? 'video'
        : (msg.kind === 'audio' ? 'audio' : (msg.kind === 'file' ? 'file' : 'site'));
      // a call-file may be shown in one of three modes; 'file' is the default
      const fileKind = kind === 'file';
      const norm = normalizeWebTarget(fileKind ? String(msg.mode || 'file') : kind, msg.url);
      if (!norm.ok) {
        socket.emit(EV.WEB_ERR, {
          msg: norm.error === 'NO_FILE' ? 'این فایل دیگر در دسترس نیست' : 'لینک وارد شده معتبر نیست',
        });
        if (typeof cb === 'function') cb({ ok: false, error: norm.error });
        return;
      }
      // Rights carry over only while the SAME target stays on screen. Opening a new link
      // starts fresh with "everyone may control" — otherwise an old restriction would
      // silently make it look like only the admin can drive the shared page.
      const sameTarget = !!(r.web && r.web.kind === kind && r.web.url === norm.url);
      const keepRights = sameTarget ? {
        controlAll: r.web.controlAll, controllers: r.web.controllers,
        viewersAll: r.web.viewersAll, viewers: r.web.viewers,
      } : { controlAll: true, controllers: new Set(), viewersAll: true, viewers: new Set() };
      r.web = Object.assign({
        kind, mode: norm.audio ? 'audio' : (fileKind && norm.embed === false ? 'video' : (fileKind ? 'file' : '')),
        url: norm.url, src: norm.src, host: norm.host,
        name: norm.name || '', size: norm.size || 0, viewable: norm.viewable !== false,
        mime: norm.mime || '',
        ownerId: uid, ownerName: s.name || '', scroll: null, video: null,
        // "دسترسی همزمان": when on, one person's scroll/click/play drives everyone
        follow: msg.follow !== false,
      }, keepRights);
      io.to(socket.data.room).emit(EV.WEB_STATE, { web: publicWeb(r) });
      if (typeof cb === 'function') cb({ ok: true, web: publicWeb(r) });
    });

    // the shared-box "simultaneous access" switch (room-wide, any member may flip it)
    socket.on(EV.CALL_WEB_FOLLOW, (msg = {}) => {
      const r = webRoom();
      const s = r && r.sockets.get(socket.id);
      if (!r || !s || !s.approved || !r.web) return;
      r.web.follow = !!msg.on;
      io.to(socket.data.room).emit(EV.WEB_STATE, { web: publicWeb(r) });
    });

    socket.on(EV.CALL_WEB_CLOSE, (_msg = {}, cb) => {
      const r = requireRoomAdmin();
      if (!r) { socket.emit(EV.WEB_ERR, { msg: 'فقط ادمین می‌تواند این باکس را حذف کند' }); return; }
      r.web = null;
      io.to(socket.data.room).emit(EV.WEB_STATE, { web: null });
      if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on(EV.CALL_WEB_RIGHTS, (msg = {}, cb) => {
      const r = requireRoomAdmin();
      if (!r || !r.web) return;
      const pick = (v) => {
        if (v === 'all' || v === undefined) return { all: true, set: new Set() };
        if (!Array.isArray(v)) return { all: true, set: new Set() };
        return { all: false, set: new Set(v.map((x) => parseInt(x, 10)).filter(Number.isInteger)) };
      };
      if (msg.control !== undefined) {
        const p = pick(msg.control);
        r.web.controlAll = p.all; r.web.controllers = p.set;
      }
      if (msg.view !== undefined) {
        const p = pick(msg.view);
        r.web.viewersAll = p.all; r.web.viewers = p.set;
      }
      io.to(socket.data.room).emit(EV.WEB_STATE, { web: publicWeb(r) });
      if (typeof cb === 'function') cb({ ok: true, web: publicWeb(r) });
    });

    // relays control/scroll/playback actions from a permitted controller
    socket.on(EV.CALL_WEB_SYNC, (msg = {}) => {
      const r = webRoom();
      const s = r && r.sockets.get(socket.id);
      if (!r || !s || !r.web) return;
      if (!canControlWeb(r, s)) return;
      const kind = String(msg.kind || '').slice(0, 16);
      const payload = { kind, userId: uid };
      if (kind === 'scroll') {
        const ratio = Math.max(0, Math.min(1, Number(msg.ratio) || 0));
        r.web.scroll = { ratio, at: Date.now() };
        payload.ratio = ratio;
      } else if (kind === 'click') {
        const x = Math.max(0, Math.min(1, Number(msg.x) || 0));
        const y = Math.max(0, Math.min(1, Number(msg.y) || 0));
        payload.x = x; payload.y = y;
      } else if (kind === 'navigate') {
        const norm = normalizeWebTarget('site', msg.url);
        if (!norm.ok) return;
        payload.url = norm.url;
      } else if (kind === 'video' || kind === 'audio') {
        const cmd = ['play', 'pause', 'seek'].indexOf(msg.cmd) !== -1 ? msg.cmd : 'play';
        const t = Math.max(0, Math.min(86400, Number(msg.t) || 0));
        payload.cmd = cmd; payload.t = t;
        r.web.video = { cmd, t, at: Date.now(), playing: cmd === 'play' };
      } else if (kind === 'fscroll') {
        // a shared FILE box: the viewer relays how far it is scrolled (images/text are
        // same-origin so the client can measure them; a PDF viewer is not, and simply
        // sends nothing)
        const ratio = Math.max(0, Math.min(1, Number(msg.ratio) || 0));
        r.web.scroll = { ratio, at: Date.now() };
        payload.ratio = ratio;
      } else return;
      socket.to(socket.data.room).emit(EV.WEB_SYNC, payload);
    });

    socket.on(EV.CALL_APPROVE, (msg = {}, cb) => {
      const room = socket.data.room;
      const targetId = parseInt(msg.userId, 10);
      if (!room || !Number.isInteger(targetId)) return;
      const r = requireRoomAdmin();
      if (!r) { socket.emit(EV.ERR, { ok: false, error: 'NOT_AUTHORIZED' }); if (typeof cb === 'function') cb({ ok: false, error: 'NOT_AUTHORIZED' }); return; }
      internal.approve(room, uid, targetId).then((res) => {
        if (!res.ok) { socket.emit(EV.ERR, { ok: false, error: res.error || 'ACTION_FAILED' }); if (typeof cb === 'function') cb({ ok: false, error: res.error }); return; }
        r.pending.delete(targetId);
        (r.userSockets.get(targetId) || new Set()).forEach((sid) => {
          const s = r.sockets.get(sid);
          if (s) { s.approved = true; io.to(sid).emit(EV.YOU_APPROVED, { ok: true }); }
        });
        io.to(room).emit(EV.MEMBER_APPROVED, { member: res.member });
        if (typeof cb === 'function') cb({ ok: true, member: res.member });
      });
    });

    function kickFlow(evt, reasonEvt) {
      return (msg = {}, cb) => {
        const room = socket.data.room;
        const targetId = parseInt(msg.userId, 10);
        if (!room || !Number.isInteger(targetId)) return;
        const r = requireRoomAdmin();
        if (!r) { socket.emit(EV.ERR, { ok: false, error: 'NOT_AUTHORIZED' }); if (typeof cb === 'function') cb({ ok: false, error: 'NOT_AUTHORIZED' }); return; }
        internal.kick(room, uid, targetId).then((res) => {
          if (!res.ok) { socket.emit(EV.ERR, { ok: false, error: res.error || 'ACTION_FAILED' }); if (typeof cb === 'function') cb({ ok: false, error: res.error }); return; }
          r.pending.delete(targetId);
          (r.userSockets.get(targetId) || new Set()).forEach((sid) => {
            const s = r.sockets.get(sid);
            if (s) s.approved = false;
            io.to(sid).emit(reasonEvt, { ok: true, reason: evt });
            const t = io.of('/').sockets.get(sid);
            if (t && t.data.room === room) { t.leave(room); t.data.room = null; }
          });
          r.userSockets.delete(targetId);
          io.to(room).emit(EV.MEMBER_KICKED, { userId: targetId, reason: evt });
          if (typeof cb === 'function') cb({ ok: true });
        });
      };
    }
    socket.on(EV.CALL_REJECT, kickFlow('call:reject', EV.YOU_REJECTED));
    socket.on(EV.CALL_KICK, kickFlow('call:kick', EV.YOU_REMOVED));

    socket.on(EV.CALL_BLOCK, (msg = {}, cb) => {
      const room = socket.data.room;
      const targetId = parseInt(msg.userId, 10);
      if (!room || !Number.isInteger(targetId)) return;
      const r = requireRoomAdmin();
      if (!r) { socket.emit(EV.ERR, { ok: false, error: 'NOT_AUTHORIZED' }); if (typeof cb === 'function') cb({ ok: false, error: 'NOT_AUTHORIZED' }); return; }
      internal.block(room, uid, targetId).then((res) => {
        if (!res.ok) { socket.emit(EV.ERR, { ok: false, error: res.error || 'ACTION_FAILED' }); if (typeof cb === 'function') cb({ ok: false, error: res.error }); return; }
        r.blocked.add(targetId);
        (r.userSockets.get(targetId) || new Set()).forEach((sid) => {
          io.to(sid).emit(EV.YOU_BLOCKED, { ok: true });
          const t = io.of('/').sockets.get(sid);
          if (t && t.data.room === room) { t.leave(room); t.data.room = null; }
        });
        r.userSockets.delete(targetId);
        io.to(room).emit(EV.MEMBER_BLOCKED, { userId: targetId });
        if (typeof cb === 'function') cb({ ok: true });
      });
    });

    // the admin switches "join without approval" for THIS call
    socket.on(EV.CALL_SET_OPEN_JOIN, (msg = {}, cb) => {
      const r = webRoom();
      if (!r || !r.sockets.get(socket.id)) return;
      const me = r.sockets.get(socket.id);
      if (!me || !me.is_admin) {
        if (typeof cb === 'function') cb({ ok: false, error: 'NOT_AUTHORIZED' });
        return;
      }
      const on = !!msg.on;
      internalRaw.setOpenJoin(r.meetingId, on);
      r.openJoin = on;
      io.to(socket.data.room).emit(EV.WEB_STATE, { web: publicWeb(r), openJoin: on });
      socket.to(socket.data.room).emit(EV.OPEN_JOIN_CHANGED, { openJoin: on });
      if (on) releasePending(r);
      if (typeof cb === 'function') cb({ ok: true, openJoin: on });
    });

    // Turning the switch ON must also release the people who are ALREADY waiting on the
    // screen — otherwise the admin has to approve them one by one anyway.
    function releasePending(r) {
      let n = 0;
      r.sockets.forEach((s, sid) => {
        if (s.approved) return;
        s.approved = true;
        r.pending.delete(s.userId);
        try {
          const pid = dbm.get('SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=?',
            [r.meetingId, s.userId]);
          if (pid) dbm.run("UPDATE meeting_participants SET status='approved' WHERE id=?", [pid.id]);
        } catch (e) { }
        io.to(sid).emit(EV.YOU_APPROVED, { ok: true, via: 'open-join' });
        emitMemberJoined(socket.data.room, memberInfo(s));
        n++;
      });
      if (n) console.log('[call] released ' + n + ' waiting member(s) after the switch was turned on');
      updateSoloTimer(socket.data.room);
    }

    socket.on(EV.CALL_ALERT_ADMIN, () => {
      const room = socket.data.room;
      const r = rooms.get(room);
      if (!r) return;
      const me = r.sockets.get(socket.id);
      if (!me) return;
r.sockets.forEach((s, sid) => {
        if (s.is_admin) io.to(sid).emit(EV.JOIN_ALERT, { userId: uid, name: me.name || '' });
      });
    });

    socket.on(EV.CALL_DISABLE, (msg = {}) => {
      const room = socket.data.room;
      const targetId = parseInt(msg.userId, 10);
      const kind = msg.kind;
      if (!room || !Number.isInteger(targetId) || !['audio', 'video', 'screen'].includes(kind)) return;
      const r = requireRoomAdmin();
      if (!r) { socket.emit(EV.ERR, { ok: false, error: 'NOT_AUTHORIZED' }); return; }
      const off = !!msg.off; // true = disable AND lock, false = unlock only (never force-on)
      if (!r.locks) r.locks = {};
      const lk = r.locks[targetId] || (r.locks[targetId] = { audio: false, video: false, screen: false });
      (r.userSockets.get(targetId) || new Set()).forEach((sid) => {
        const s = r.sockets.get(sid);
        if (!s) return;
        if (off) {
          // lock: force the control off right now
          if (kind === 'audio') s.muted = true;
          else if (kind === 'video') s.cam = false;
          else if (kind === 'screen') s.sharing = false;
        }
        io.to(sid).emit(EV.FORCE_DISABLE, { kind, off });
      });
      lk[kind] = off;
      const patch = { locks: Object.assign({}, lk) };
      if (off) {
        if (kind === 'audio') patch.muted = true;
        else if (kind === 'video') patch.cam = false;
        else if (kind === 'screen') patch.sharing = false;
      } else {
        // unlock only: report the user's CURRENT state (we never turn things on for them)
        const anyS = Array.from(r.userSockets.get(targetId) || []).map((sid) => r.sockets.get(sid)).find(Boolean);
        if (anyS) {
          patch.muted = !!anyS.muted;
          patch.cam = !!anyS.cam;
          patch.sharing = !!anyS.sharing;
        }
      }
      emitMemberUpdated(room, targetId, patch);
    });

    function leaveRoom(sock) {
      const room = sock.data.room;
      if (!room) return;
      const r = rooms.get(room);
      sock.data.room = null;
      sock.leave(room);
      if (!r) return;
      const s = r.sockets.get(sock.id);
      r.sockets.delete(sock.id);
      const set = r.userSockets.get(uid);
      if (set) {
        set.delete(sock.id);
        if (set.size === 0) {
          r.userSockets.delete(uid);
          r.pending.delete(uid);
          emitMemberLeft(room, uid);
          // the host just left: hand the room to the most talkative member (or a random
          // one) so the call never ends up without an admin
          if (s && s.is_admin) scheduleAdminHandover(room, r.meetingId, uid);
        }
      }
      if (r.sockets.size === 0) {
        rooms.delete(room);
        cancelSoloTimer(room);
        scheduleCloseMeeting(room);
      } else {
        updateSoloTimer(room);
      }
    }

    // A reload looks exactly like a leave: the old socket drops a moment before the new one
    // registers. Handing the room over immediately therefore moved the admin away on every
    // refresh (and before the chat had even been written). Wait a beat and check whether the
    // person came back.
    const handoverTimers = new Map();
    function scheduleAdminHandover(room, meetingId, userId) {
      if (handoverTimers.has(room)) clearTimeout(handoverTimers.get(room));
      const t = setTimeout(() => {
        handoverTimers.delete(room);
        const r = rooms.get(room);
        if (!r) return;
        // still here? then it was only a reload
        for (const [, mem] of r.sockets) { if (mem.userId === userId) return; }
        try {
          const next = internalRaw.promoteNewAdmin(meetingId);
          if (!next) return;
          r.sockets.forEach((mem, sid) => {
            mem.is_admin = (mem.userId === next.userId);
            io.to(sid).emit(EV.MEMBER_UPDATED, { userId: mem.userId, is_admin: mem.is_admin });
          });
          io.to(room).emit(EV.ADMIN_CHANGED, {
            userId: next.userId, name: next.name, reason: 'host-left',
            toast: (next.messages > 0)
              ? (next.name || 'یکی از اعضا') + ' به‌عنوان ادمین جدید انتخاب شد (فعال‌ترین در چت)'
              : (next.name || 'یکی از اعضا') + ' به‌عنوان ادمین جدید انتخاب شد',
          });
          console.log('[call] admin handed over to user ' + next.userId + ' in room ' + room);
        } catch (e) { /* never block the leave */ }
      }, 2500);
      if (t.unref) t.unref();
      handoverTimers.set(room, t);
    }

    socket.on(EV.CALL_LEAVE, (_msg, cb) => {
      const room = socket.data.room;
      if (room) {
        internal.leave(room, uid).then(() => {});
        leaveRoom(socket);
      }
      if (typeof cb === 'function') cb({ ok: true });
    });

    function callReqTargets(uidArg) { return userSockets.get(uidArg) || new Set(); }

    socket.on(EV.CALLREQ_SEND, (msg = {}, cb) => {
      const toId = parseInt(msg.toUserId, 10);
      if (!Number.isInteger(toId) || toId === uid) { if (typeof cb === 'function') cb({ ok: false, error: 'BAD_REQUEST' }); return; }
      if (!callReqTargets(toId).size) { if (typeof cb === 'function') cb({ ok: false, error: 'USER_OFFLINE' }); return; }
      for (const [, rq] of callRequests) {
        if (rq.status === 'ringing' && (rq.from === uid || rq.to === uid || rq.from === toId || rq.to === toId)) {
          if (typeof cb === 'function') cb({ ok: false, error: 'BUSY' }); return;
        }
      }
      const requestId = crypto.randomUUID();
      callRequests.set(requestId, { from: uid, to: toId, ts: Date.now(), roomId: msg.roomId || null, status: 'ringing' });
      const me = socket.data.name || ('user#' + uid);
      callReqTargets(toId).forEach((sid) => io.to(sid).emit(EV.CALLREQ_INCOMING, { requestId, fromUserId: uid, fromName: me }));
      if (typeof cb === 'function') cb({ ok: true, requestId });
      setTimeout(() => {
        const rq = callRequests.get(requestId);
        if (rq && rq.status === 'ringing') { rq.status = 'timeout'; callReqTargets(rq.from).forEach((sid) => io.to(sid).emit(EV.CALLREQ_CANCELLED, { requestId, reason: 'timeout' })); }
      }, 45000);
    });

    socket.on(EV.CALLREQ_ACCEPT, (msg = {}, cb) => {
      const rq = callRequests.get(msg.requestId);
      if (!rq || rq.to !== uid || rq.status !== 'ringing') { if (typeof cb === 'function') cb({ ok: false, error: 'NOT_FOUND' }); return; }
      rq.status = 'accepted';
      callReqTargets(rq.from).forEach((sid) => io.to(sid).emit(EV.CALLREQ_ACCEPTED, { requestId: msg.requestId, fromUserId: uid, roomId: rq.roomId }));
      if (typeof cb === 'function') cb({ ok: true, roomId: rq.roomId });
    });

    socket.on(EV.CALLREQ_REJECT, (msg = {}, cb) => {
      const rq = callRequests.get(msg.requestId);
      if (!rq || rq.to !== uid || rq.status !== 'ringing') { if (typeof cb === 'function') cb({ ok: false, error: 'NOT_FOUND' }); return; }
      rq.status = 'rejected';
      callReqTargets(rq.from).forEach((sid) => io.to(sid).emit(EV.CALLREQ_REJECTED, { requestId: msg.requestId, fromUserId: uid }));
      if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on(EV.CALLREQ_CANCEL, (msg = {}, cb) => {
      const rq = callRequests.get(msg.requestId);
      if (!rq || rq.from !== uid || rq.status !== 'ringing') { if (typeof cb === 'function') cb({ ok: false, error: 'NOT_FOUND' }); return; }
      rq.status = 'cancelled';
      callReqTargets(rq.to).forEach((sid) => io.to(sid).emit(EV.CALLREQ_CANCELLED, { requestId: msg.requestId, reason: 'caller' }));
      if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on(EV.CALLREQ_BUSY, (msg = {}) => {
      const rq = callRequests.get(msg.requestId);
      if (!rq || rq.to !== uid || rq.status !== 'ringing') return;
      rq.status = 'busy';
      callReqTargets(rq.from).forEach((sid) => io.to(sid).emit(EV.CALLREQ_BUSY, { requestId: msg.requestId, fromUserId: uid }));
    });

    socket.on(EV.CALLREQ_ENDED, (msg = {}) => {
      const rq = callRequests.get(msg.requestId);
      if (!rq) return;
      rq.status = 'ended';
      const other = rq.from === uid ? rq.to : rq.from;
      callReqTargets(other).forEach((sid) => io.to(sid).emit(EV.CALLREQ_ENDED, { requestId: msg.requestId, byUserId: uid }));
    });

    socket.on(EV.PV_SEND, (msg = {}, cb) => {
      const toId = parseInt(msg.toUserId, 10);
      const body = String(msg.body || '').trim().slice(0, 2000);
      const clientMsgId = String(msg.clientMsgId || '').slice(0, 64);
      if (!Number.isInteger(toId) || body === '' || clientMsgId === '') { if (typeof cb === 'function') cb({ ok: false, error: 'BAD_REQUEST' }); return; }
      // only the manager console pushes manager-side messages over the socket
      // (premium chats via POST /messages/conversations, persisted as from_manager=0)
      if (!socket.data.isManager) { if (typeof cb === 'function') cb({ ok: false, error: 'NOT_AUTHORIZED' }); return; }
      internal.pvPersist(toId, true, uid, body, clientMsgId).then((res) => {
        if (!res.ok) {
          const e = { ok: false, error: res.error || 'SAVE_FAILED', clientMsgId };
          socket.emit(EV.ERR, e);
          if (typeof cb === 'function') cb(e);
          return;
        }
        const payload = { id: res.id, fromUserId: uid, fromName: res.from_name || '', body, clientMsgId, fromManager: 1, ts: res.ts };
        socket.emit(EV.PV_ACK, { ok: true, clientMsgId, id: res.id });
        (userSockets.get(uid) || new Set()).forEach((sid) => io.to(sid).emit(EV.PV_NEW_MESSAGE, payload));
        callReqTargets(toId).forEach((sid) => io.to(sid).emit(EV.PV_NEW_MESSAGE, payload));
        io.of('/').sockets.forEach((s) => {
          if (s.data.isManager && s.data.userId !== uid) {
            s.emit(EV.PV_CONVERSATION_UPDATED, { userId: toId, lastBody: body, fromManager: 1, ts: res.ts });
          }
        });
        if (typeof cb === 'function') cb({ ok: true, id: res.id });
      });
    });

    socket.on('disconnect', () => {
      leaveRoom(socket);
      removeGlobalSocket(uid, socket.id);
      const gone = !userSockets.has(uid);
      if (gone) io.emit(EV.PRESENCE_OFFLINE, { userId: uid });
    });
  });

return io;
}

module.exports = { attach, get io() { return io; } };
