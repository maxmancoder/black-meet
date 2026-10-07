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
        const role = st.you ? st.you.role : 'member';
        const approvedBefore = !!(st.you && st.you.status === 'approved');

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
              const target = io.of('/').sockets.get(sid);
              if (target) target.emit(EV.YOU_REMOVED, { ok: true, reason: 'replaced' });
            }
          });
        }

        const info = {
          userId: uid, name: String(user.name || ''), username: String(user.username || ''),
          avatar_color: String(user.avatar_color || '#4f46e5'), avatar: String(user.avatar || ''),
          is_admin: role === 'admin', muted: false, cam: false, sharing: false,
          approved: approvedBefore || role === 'admin',
        };
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
        socket.emit(EV.CALL_WELCOME, { meeting: st.meeting, you, members, blocked: Array.from(r.blocked), web: publicWeb(r) });
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
        ownerId: w.ownerId, ownerName: w.ownerName || '',
        controlAll: w.controlAll !== false,
        controllers: Array.from(w.controllers || []),
        viewersAll: w.viewersAll !== false,
        viewers: Array.from(w.viewers || []),
        scroll: w.scroll || null,
        video: w.video || null,
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
    // normalize + validate an incoming web target (server-side, both kinds)
    function normalizeWebTarget(kind, rawUrl) {
      const u = String(rawUrl || '').trim();
      if (u.length > 2000) return { ok: false, error: 'BAD_URL' };
      let abs;
      try {
        abs = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
      } catch (e) {
        return { ok: false, error: 'BAD_URL' };
      }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return { ok: false, error: 'BAD_URL' };
      const host = abs.hostname.toLowerCase();
      if (!host) return { ok: false, error: 'BAD_URL' };
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
      const kind = msg.kind === 'video' ? 'video' : 'site';
      const norm = normalizeWebTarget(kind, msg.url);
      if (!norm.ok) {
        socket.emit(EV.WEB_ERR, { msg: 'لینک وارد شده معتبر نیست' });
        if (typeof cb === 'function') cb({ ok: false, error: norm.error });
        return;
      }
      const keepRights = (r.web && r.web.kind === kind) ? {
        controlAll: r.web.controlAll, controllers: r.web.controllers,
        viewersAll: r.web.viewersAll, viewers: r.web.viewers,
      } : { controlAll: true, controllers: new Set(), viewersAll: true, viewers: new Set() };
      r.web = Object.assign({
        kind, url: norm.url, src: norm.src, host: norm.host,
        ownerId: uid, ownerName: s.name || '', scroll: null, video: null,
      }, keepRights);
      io.to(socket.data.room).emit(EV.WEB_STATE, { web: publicWeb(r) });
      if (typeof cb === 'function') cb({ ok: true, web: publicWeb(r) });
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
      } else if (kind === 'video') {
        const cmd = ['play', 'pause', 'seek'].indexOf(msg.cmd) !== -1 ? msg.cmd : 'play';
        const t = Math.max(0, Math.min(86400, Number(msg.t) || 0));
        payload.cmd = cmd; payload.t = t;
        r.web.video = { cmd, t, at: Date.now(), playing: cmd === 'play' };
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
        }
      }
      if (r.sockets.size === 0) {
        rooms.delete(room);
        scheduleCloseMeeting(room);
      }
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
