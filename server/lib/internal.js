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
  return {
    ok: true,
    meeting: { id: Number(m.id), room: m.room_id, title: m.title },
    you: p ? { status: p.status, role: p.role } : null,
  };
}

function closeMeeting(roomId) {
  dbm.run('UPDATE meetings SET active=0 WHERE room_id=? AND active=1', [String(roomId)]);
  return { ok: true };
}

module.exports = {
  meetingByRoom, participant, userById, isMeetingAdmin,
  approve, kick, block, leave, chatPersist, pvPersist, pvUnread, meetingState, closeMeeting,
};