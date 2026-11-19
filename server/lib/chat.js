'use strict';
// server/lib/chat.js — one place for every durable chat write.
//
// The messages page writes PVs and public announcements from three different paths
// (REST, the live socket, and internal.pvPersist). Keeping the INSERT here means every
// row carries the SAME durable attribution — sender AND recipient ids/usernames — and
// every write schedules the optional Neon mirror, so no path can silently lose a message
// or forget who it belonged to after a restart/redeploy.
const dbm = require('./db');
const { sqlNow } = require('./helpers');
const neon = require('./neon');

const PV_CHAT_COLS = [
  'id', 'user_id', 'from_manager', 'body', 'seen', 'client_msg_id',
  'sender_username', 'sender_email', 'sender_id', 'sender_display_name',
  'recipient_id', 'recipient_username', 'recipient_display_name', 'peer_id',
  'reply_to', 'forwarded_from', 'deleted', 'deleted_at', 'created_at',
];
const ANN_COLS = [
  'id', 'body', 'sender_id', 'sender_username', 'sender_email', 'sender_display_name',
  'reply_to', 'forwarded_from', 'deleted', 'deleted_at', 'created_at',
];

function user(id) {
  return dbm.get('SELECT id, username, email, display_name FROM users WHERE id=?', [Number(id || 0)]);
}

function manager() {
  return dbm.get('SELECT id, username, email, display_name FROM users WHERE is_manager=1 ORDER BY id LIMIT 1');
}

// Insert a private message. `userId` is the thread owner (the non-manager side), `peerId`
// is the privileged peer (manager / premium admin). Both ends are resolved from the users
// table when the caller does not supply them, so even old call sites stay correct.
function insertPv(o) {
  o = o || {};
  const body = String(o.body || '').trim().slice(0, 4000);
  if (!body) return { ok: false, error: 'EMPTY' };
  const userId = Number(o.userId || 0);
  if (!userId) return { ok: false, error: 'BAD_REQUEST' };
  const clientMsgId = String(o.clientMsgId || '').slice(0, 64);
  const fromManager = o.fromManager ? 1 : 0;
  if (clientMsgId) {
    const existing = dbm.get(
      'SELECT id FROM pv_messages WHERE user_id=? AND from_manager=? AND client_msg_id=?',
      [userId, fromManager, clientMsgId]
    );
    if (existing) return { ok: true, id: Number(existing.id), dedup: true };
  }
  const mgr = manager();
  const senderId = Number(o.senderId || 0);
  const senderRow = user(senderId);
  const recipientId = Number(o.recipientId || 0);
  const recipientRow = user(recipientId);
  const peerId = Number(o.peerId || (mgr && mgr.id) || 0);
  const ts = sqlNow();
  const r = dbm.run(
    `INSERT INTO pv_messages
      (user_id, from_manager, body, seen, client_msg_id, sender_username, sender_email,
       sender_id, sender_display_name, recipient_id, recipient_username, recipient_display_name,
       peer_id, reply_to, forwarded_from, deleted, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    [
      userId, fromManager, body, 0, clientMsgId || null,
      String(o.senderUsername || (senderRow && senderRow.username) || ''),
      String(o.senderEmail || (senderRow && senderRow.email) || ''),
      senderId,
      String(o.senderDisplay || (senderRow && senderRow.display_name) || ''),
      recipientId,
      String(o.recipientUsername || (recipientRow && recipientRow.username) || ''),
      String(o.recipientDisplay || (recipientRow && recipientRow.display_name) || ''),
      peerId,
      o.replyTo ? Number(o.replyTo) : null,
      String(o.forwardedFrom || ''),
      ts,
    ]
  );
  neon.scheduleChat();
  return { ok: true, id: Number(r.lastInsertRowid), ts, from_name: (senderRow && senderRow.display_name) || '' };
}

function insertAnnouncement(o) {
  o = o || {};
  const body = String(o.body || '').trim().slice(0, 4000);
  if (!body) return { ok: false, error: 'EMPTY' };
  const sender = user(o.senderId) || {};
  const ts = sqlNow();
  const r = dbm.run(
    `INSERT INTO announcements
      (body, sender_id, sender_username, sender_email, sender_display_name,
       reply_to, forwarded_from, deleted, created_at)
     VALUES (?,?,?,?,?,?,?,0,?)`,
    [body, Number(sender.id || 0), String(sender.username || ''), String(sender.email || ''),
      String(sender.display_name || ''), o.replyTo ? Number(o.replyTo) : null,
      String(o.forwardedFrom || ''), ts]
  );
  neon.scheduleChat();
  return { ok: true, id: Number(r.lastInsertRowid), ts };
}

// Soft delete keeps the durable copy (and the Neon mirror) consistent with what the user
// sees. Any signed-in member may delete any message (owner request), so there is no author
// restriction here — only the EDIT path stays author-only.
function remove(kind, id, actor) {
  const table = kind === 'public' ? 'announcements' : 'pv_messages';
  const row = dbm.get('SELECT * FROM ' + table + ' WHERE id=?', [Number(id || 0)]);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  dbm.run('UPDATE ' + table + ' SET deleted=1, deleted_at=? WHERE id=?', [sqlNow(), row.id]);
  neon.scheduleChat();
  return { ok: true, id: Number(row.id), kind };
}

function find(kind, id) {
  const table = kind === 'public' ? 'announcements' : 'pv_messages';
  const row = dbm.get('SELECT * FROM ' + table + ' WHERE id=? AND deleted=0', [Number(id || 0)]);
  return row || null;
}

// Only the author may edit his own message (including public announcements). A manager
// cannot rewrite somebody else's words; he can still delete abuse via remove().
function edit(kind, id, actor, rawBody) {
  const table = kind === 'public' ? 'announcements' : 'pv_messages';
  // announcements has no user_id/from_manager columns — select only the shared fields
  const row = dbm.get('SELECT id, body, sender_id FROM ' + table + ' WHERE id=? AND deleted=0', [Number(id || 0)]);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (Number(row.sender_id || 0) !== Number(actor.id)) return { ok: false, error: 'NOT_AUTHORIZED' };
  const body = String(rawBody || '').trim().slice(0, 4000);
  if (!body) return { ok: false, error: 'EMPTY' };
  if (body === String(row.body || '')) return { ok: true, id: Number(row.id), body, unchanged: true, kind };
  dbm.run('UPDATE ' + table + ' SET body=? WHERE id=?', [body, row.id]);
  neon.scheduleChat();
  return { ok: true, id: Number(row.id), body, kind };
}

// Restore the durable mirror into an empty local chat (fresh Render instance).
async function boot() {
  if (!neon.enabled()) return { enabled: false, restored: 0 };
  const localPv = Number((dbm.get('SELECT COUNT(*) AS c FROM pv_messages') || {}).c || 0);
  const localAnn = Number((dbm.get('SELECT COUNT(*) AS c FROM announcements') || {}).c || 0);
  if (localPv || localAnn) return { enabled: true, restored: 0, reason: 'local chat not empty' };
  const mirror = await neon.pullChat();
  if (!mirror) return { enabled: true, restored: 0, reason: 'neon unavailable' };
  let n = 0;
  try {
    (mirror.pv || []).forEach((r) => {
      dbm.run(
        `INSERT OR IGNORE INTO pv_messages
          (id, user_id, from_manager, body, seen, client_msg_id, sender_username, sender_email,
           sender_id, sender_display_name, recipient_id, recipient_username, recipient_display_name,
           peer_id, reply_to, forwarded_from, deleted, deleted_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        PV_CHAT_COLS.map((k) => (r[k] === undefined ? null : r[k]))
      );
      n++;
    });
    (mirror.announcements || []).forEach((r) => {
      dbm.run(
        `INSERT OR IGNORE INTO announcements
          (id, body, sender_id, sender_username, sender_email, sender_display_name,
           reply_to, forwarded_from, deleted, deleted_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ANN_COLS.map((k) => (r[k] === undefined ? null : r[k]))
      );
      n++;
    });
  } catch (e) {
    console.warn('[chat] mirror restore failed: ' + e.message);
  }
  if (n) console.log('[chat] restored ' + n + ' message(s) from Neon');
  return { enabled: true, restored: n };
}

module.exports = { insertPv, insertAnnouncement, remove, edit, find, boot, PV_CHAT_COLS, ANN_COLS };
