'use strict';
// Single business-logic path for realtime actions (formerly ported from an old internal.php endpoint).
// Sockets call these directly; no HTTP hop needed in the merged process.
const dbm = require('./db');
const { sqlNow } = require('./helpers');

function meetingByRoom(roomId) {
  return dbm.get('SELECT id, room_id, title, creator_id, active FROM meetings WHERE room_id=?', [String(roomId)]);
}

function participant(meetingId, userId) {
  return dbm.get('SELECT * FROM meeting_participants WHERE meeting_id=? AND user_id=?', [Number(meetingId), Number(userId)]);
}

function userById(userId) {
  return dbm.get(
    'SELECT id, display_name, username, avatar_color, avatar, is_manager FROM users WHERE id=?',
    [Number(userId)]
  );
}

function isMeetingAdmin(meetingId, userId) {
  const p = participant(meetingId, userId);
  if (p && p.role === 'admin') return true;
  const m = dbm.get('SELECT creator_id FROM meetings WHERE id=?', [Number(meetingId)]);
  return m && Number(m.creator_id) === Number(userId);
}

function approve(roomId, actorId, targetId) {
  const m = meetingByRoom(roomId);
  if (!m) return { ok: false, error: 'MEETING_NOT_FOUND' };
  if (!isMeetingAdmin(m.id, actorId)) return { ok: false, error: 'NOT_AUTHORIZED' };
  const p = participant(m.id, targetId);
  if (!p) return { ok: false, error: 'PARTICIPANT_NOT_FOUND' };
  dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['approved', p.id]);
  const u = userById(targetId);
  return {
    ok: true,
    member: {
      userId: Number(targetId),
      name: u ? u.display_name : String(p.display_name),
      username: u ? u.username : String(p.username),
      avatar_color: u ? u.avatar_color : '#4f46e5',
      avatar: u ? String(u.avatar || '') : '',
      is_admin: (p.role === 'admin'),
      status: 'approved',
    },
  };
}

function kick(roomId, actorId, targetId) {
  const m = meetingByRoom(roomId);
  if (!m) return { ok: false, error: 'MEETING_NOT_FOUND' };
  if (!isMeetingAdmin(m.id, actorId)) return { ok: false, error: 'NOT_AUTHORIZED' };
  const p = participant(m.id, targetId);
  if (!p) return { ok: false, error: 'PARTICIPANT_NOT_FOUND' };
  dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['removed', p.id]);
  return { ok: true, user_id: Number(targetId) };
}

function block(roomId, actorId, targetId) {
  const m = meetingByRoom(roomId);
  if (!m) return { ok: false, error: 'MEETING_NOT_FOUND' };
  if (!isMeetingAdmin(m.id, actorId)) return { ok: false, error: 'NOT_AUTHORIZED' };
  dbm.run('INSERT OR IGNORE INTO meeting_blocks (meeting_id, user_id) VALUES (?, ?)', [Number(m.id), Number(targetId)]);
  const p = participant(m.id, targetId);
  if (p) dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['removed', p.id]);
  return { ok: true, user_id: targetId };
}

function leave(roomId, actorId) {
  const m = meetingByRoom(roomId);
  if (!m) return { ok: false, error: 'MEETING_NOT_FOUND' };
  dbm.run(
    'UPDATE meeting_participants SET status=? WHERE meeting_id=? AND user_id=? AND status<>?',
    ['removed', Number(m.id), Number(actorId), 'removed']
  );
  return { ok: true };
}

function chatPersist(roomId, userId, body, clientMsgId) {
  body = String(body || '').trim();
  clientMsgId = String(clientMsgId || '').slice(0, 64);
  if (body === '' || clientMsgId === '') return { ok: false, error: 'BAD_REQUEST' };
  const m = meetingByRoom(roomId);
  if (!m) return { ok: false, error: 'MEETING_NOT_FOUND' };
  const p = participant(m.id, userId);
  if (!p || p.status === 'removed') return { ok: false, error: 'NOT_A_MEMBER' };
  const u = userById(userId);
  const name = u ? u.display_name : String(p.display_name);
  const existing = dbm.get(
    'SELECT id FROM messages WHERE meeting_id=? AND user_id=? AND client_msg_id=?',
    [Number(m.id), userId, clientMsgId]
  );
  if (existing) {
    return { ok: true, id: Number(existing.id), dedup: true, name };
  }
  const r = dbm.run(
    'INSERT INTO messages (meeting_id, user_id, display_name, body, client_msg_id, created_at) VALUES (?,?,?,?,?,?)',
    [Number(m.id), userId, name, body, clientMsgId, sqlNow()]
  );
  return { ok: true, id: r.lastInsertRowid, name };
}

function pvPersist(toUserId, fromManager, fromUserId, body, clientMsgId) {
  clientMsgId = String(clientMsgId || '').slice(0, 64);
  body = String(body || '').trim();
  if (!toUserId || body === '' || clientMsgId === '') return { ok: false, error: 'BAD_REQUEST' };
  if (!fromManager) {
    const u = userById(fromUserId);
    if (!u || !u.is_manager) return { ok: false, error: 'NOT_AUTHORIZED' };
  }
  const f = fromManager ? 1 : 0;
  const existing = dbm.get(
    'SELECT id FROM pv_messages WHERE user_id=? AND from_manager=? AND client_msg_id=?',
    [toUserId, f, clientMsgId]
  );
  if (existing) return { ok: true, id: Number(existing.id), dedup: true };
  let id = null;
  try {
    const r = dbm.run(
      'INSERT INTO pv_messages (user_id, from_manager, body, client_msg_id, created_at) VALUES (?,?,?,?,?)',
      [toUserId, f, body, clientMsgId, sqlNow()]
    );
    id = r.lastInsertRowid;
  } catch (e) {
    const again = dbm.get(
      'SELECT id FROM pv_messages WHERE user_id=? AND from_manager=? AND client_msg_id=?',
      [toUserId, f, clientMsgId]
    );
    if (again) id = Number(again.id);
    else return { ok: false, error: 'DB_ERROR' };
  }
  const from = fromManager ? userById(fromUserId) : null;
  return {
    ok: true, id,
    from_name: from ? from.display_name : 'کاربر',
    ts: sqlNow(),
  };
}

function pvUnread(userId) {
  const r = dbm.get(
    'SELECT COUNT(*) AS c FROM pv_messages WHERE user_id=? AND from_manager=0 AND seen=0',
    [Number(userId)]
  );
  return { ok: true, unread: Number(r.c) };
}

function meetingState(roomId, userId) {
  const m = meetingByRoom(roomId);
  if (!m || !m.active) return { ok: false, error: 'MEETING_NOT_FOUND' };
  const blocked = dbm.get('SELECT 1 AS b FROM meeting_blocks WHERE meeting_id=? AND user_id=?', [Number(m.id), Number(userId)]);
  if (blocked) return { ok: false, error: 'BLOCKED' };
  const p = participant(m.id, userId);
  // `isAdmin` is the SAME test used everywhere else (host OR role=admin). It used to be
  // derived from the role alone, so a meeting's creator whose row said role='member' could
  // approve people but never received their join alerts -> "the admin is not notified".
  const isAdmin = isMeetingAdmin(m.id, userId);
  return {
    ok: true,
    meeting: { id: Number(m.id), room: m.room_id, title: m.title, creatorId: Number(m.creator_id) },
    you: p ? { status: p.status, role: isAdmin ? 'admin' : p.role, isAdmin } : { isAdmin },
    isAdmin,
  };
}

function isOpenJoin(meetingId) {
  const m = dbm.get('SELECT open_join FROM meetings WHERE id=?', [Number(meetingId)]);
  return !!(m && Number(m.open_join) === 1);
}
function setOpenJoin(meetingId, on) {
  dbm.run('UPDATE meetings SET open_join=? WHERE id=?', [on ? 1 : 0, Number(meetingId)]);
  return { ok: true, open_join: on ? 1 : 0 };
}

// The host leaving must not leave the room without an admin: the most talkative member
// takes over; if nobody has said anything yet, one of them is picked at random.
function promoteNewAdmin(meetingId) {
  const id = Number(meetingId);
  const m = dbm.get('SELECT creator_id FROM meetings WHERE id=?', [id]);
  if (!m) return null;
  // still-connected admins first: if another admin stayed, nothing to do
  const others = dbm.all(
    "SELECT p.user_id FROM meeting_participants p WHERE p.meeting_id=? AND p.status='approved' AND p.role='admin' AND p.user_id<>?",
    [id, Number(m.creator_id)]
  );
  if (others.length) return null;

  const members = dbm.all(
    "SELECT user_id FROM meeting_participants WHERE meeting_id=? AND status='approved' AND user_id<>?",
    [id, Number(m.creator_id)]
  );
  if (!members.length) return null;

  // most chat messages wins; random among equals; nobody chatted -> random of all
  const counts = dbm.all(
    'SELECT user_id, COUNT(*) AS c FROM messages WHERE meeting_id=? AND user_id IS NOT NULL GROUP BY user_id',
    [id]
  );
  const map = {};
  counts.forEach((r) => { map[Number(r.user_id)] = Number(r.c); });
  let best = null, bestCount = 0;
  members.forEach((mem) => {
    const c = map[Number(mem.user_id)] || 0;
    if (c > bestCount) { bestCount = c; best = mem.user_id; }
  });
  let chosen;
  if (best && bestCount > 0) chosen = best;
  else chosen = members[Math.floor(Math.random() * members.length)].user_id;

  dbm.run("UPDATE meeting_participants SET role='member' WHERE meeting_id=? AND role='admin'", [id]);
  dbm.run("UPDATE meeting_participants SET role='admin' WHERE meeting_id=? AND user_id=?", [id, chosen]);
  const u = userById(chosen);
  return { userId: Number(chosen), name: u ? u.display_name : '', messages: bestCount };
}

function closeMeeting(roomId) {
  dbm.run('UPDATE meetings SET active=0 WHERE room_id=? AND active=1', [String(roomId)]);
  // a shared call file lives only as long as the session: the room is gone, so are its files
  try { require('./callfiles').purgeRoom(roomId); } catch (e) { /* never block the teardown */ }
  return { ok: true };
}

module.exports = {
  meetingByRoom, participant, userById, isMeetingAdmin, isOpenJoin, setOpenJoin, promoteNewAdmin,
  approve, kick, block, leave, chatPersist, pvPersist, pvUnread, meetingState, closeMeeting,
};