'use strict';
// server/lib/plaintext.js — OPTIONAL owner-readable password column.
//
// The owner asked for the accounts' passwords to be readable in plain text inside the
// database. That is deliberately kept in a SEPARATE table instead of `users`, because:
//
//   * `users.password_hash` (bcrypt) stays the credential that actually authenticates a
//     login — the app never stops verifying hashes;
//   * the users archive, every API response, the members screen and the profile panel
//     keep reading from `users`, so the plain text is NEVER returned anywhere and never
//     leaves the server (the downloadable archive file does not contain it either);
//   * it can be switched off completely with BM_STORE_PLAINTEXT_PASSWORDS=false.
//
// Anyone with read access to black_meet.db (a backup, a disk snapshot, an SQL console)
// can then see those passwords — that is the accepted trade-off, not an oversight.
const dbm = require('./db');

function enabled() {
  return String(process.env.BM_STORE_PLAINTEXT_PASSWORDS || 'true').toLowerCase() !== 'false';
}

function ensureTable() {
  dbm.run('CREATE TABLE IF NOT EXISTS user_passwords (' +
    'user_id    INTEGER PRIMARY KEY,' +
    'password   TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL' +
  ')');
  // approval-mode signups: the password is remembered before the account exists
  dbm.run('CREATE TABLE IF NOT EXISTS user_passwords_pending (' +
    'request_id INTEGER PRIMARY KEY,' +
    'password   TEXT NOT NULL,' +
    'updated_at TEXT NOT NULL' +
  ')');
}

// remember the password for one account (never fails the surrounding request)
function save(userId, plain) {
  if (!enabled()) return false;
  const id = parseInt(userId, 10);
  if (!Number.isInteger(id) || typeof plain !== 'string' || plain === '') return false;
  try {
    ensureTable();
    dbm.run('INSERT OR REPLACE INTO user_passwords (user_id, password, updated_at) VALUES (?,?,?)',
      [id, plain, require('./helpers').sqlNow()]);
    return true;
  } catch (e) {
    return false;
  }
}

function remove(userId) {
  try { dbm.run('DELETE FROM user_passwords WHERE user_id=?', [parseInt(userId, 10)]); } catch (e) {}
}

// approval mode: remember it now, attach it to the account once the admin approves
function savePending(requestId, plain) {
  if (!enabled()) return false;
  const id = parseInt(requestId, 10);
  if (!Number.isInteger(id) || typeof plain !== 'string' || plain === '') return false;
  try {
    ensureTable();
    dbm.run('INSERT OR REPLACE INTO user_passwords_pending (request_id, password, updated_at) VALUES (?,?,?)',
      [id, plain, require('./helpers').sqlNow()]);
    return true;
  } catch (e) { return false; }
}

function movePending(requestId, userId) {
  if (!enabled()) return false;
  const rid = parseInt(requestId, 10);
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(rid) || !Number.isInteger(uid)) return false;
  try {
    ensureTable();
    const row = dbm.get('SELECT password FROM user_passwords_pending WHERE request_id=?', [rid]);
    if (!row) return false;
    dbm.run('INSERT OR REPLACE INTO user_passwords (user_id, password, updated_at) VALUES (?,?,?)',
      [uid, row.password, require('./helpers').sqlNow()]);
    dbm.run('DELETE FROM user_passwords_pending WHERE request_id=?', [rid]);
    return true;
  } catch (e) { return false; }
}

module.exports = { save, savePending, movePending, remove, enabled };