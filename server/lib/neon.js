'use strict';
// server/lib/neon.js — OPTIONAL Neon (Postgres) mirror of the users archive.
//
// The app is SQLite end to end. Render's free plan has an ephemeral disk, so the live
// database disappears on every deploy. `usersdb.js` already mirrors every account into
// `users_archive.db` on the same (also ephemeral) disk — this module keeps the SAME mirror
// in Neon/Postgres, which is durable, so accounts survive a redeploy.
//
// It is completely inert unless NEON_DATABASE_URL (or BM_NEON_DATABASE_URL) is set:
//   * no env var  -> every function here is a no-op, nothing is required, nothing breaks;
//   * with a URL  -> the archive is pushed on every change and pulled back on boot when the
//     live database is empty.
//
// Like the SQLite archive it mirrors the password HASH only, never a plain password, and it
// is never exposed by any HTTP endpoint — only the manager's archive endpoints read it, and
// those keep reading the SQLite copy.
const COLUMNS = [
  'id', 'full_name', 'username', 'email', 'phone', 'display_name',
  'password_hash', 'is_manager', 'is_limited', 'rank',
  'avatar_color', 'avatar', 'created_at',
];

const DSN = process.env.NEON_DATABASE_URL || process.env.BM_NEON_DATABASE_URL || '';
const QUERY_TIMEOUT = Number(process.env.NEON_TIMEOUT_MS || 15000);

let _pool = null;
let _poolError = null;
let _schemaReady = null;

function enabled() { return !!DSN; }

// `pg` is only required when a URL is configured, so an install without it still runs.
function pool() {
  if (_pool) return _pool;
  if (_poolError) throw _poolError;
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (e) {
    _poolError = new Error('the "pg" package is not installed (npm i pg)');
    throw _poolError;
  }
  // pg's own DSN parser warns about libpq-style `sslmode` and does not implement
  // `channel_binding`; the TLS options are set explicitly below instead, which is what
  // Neon's node-postgres guide does. The rest of the connection string is kept as given.
  const cleanDsn = DSN.replace(/[?&](sslmode|channel_binding)=[^&]*/g, '').replace(/[?&]$/, '');
  _pool = new Pool({
    connectionString: cleanDsn,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: QUERY_TIMEOUT,
  });
  if (_pool.on) _pool.on('error', (e) => console.warn('[neon] pool error: ' + e.message));
  return _pool;
}

// every call is wrapped: a slow/unreachable database must never delay or break a request
async function withClient(fn) {
  if (!enabled()) return null;
  try {
    const c = await pool().connect();
    try {
      return await withTimeout(fn(c), QUERY_TIMEOUT);
    } finally { c.release(); }
  } catch (e) {
    console.warn('[neon] ' + (e && e.message ? e.message : e));
    return null;
  }
}

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('timeout after ' + ms + 'ms')), ms);
    if (t.unref) t.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function ensureSchema() {
  if (!enabled()) return false;
  if (_schemaReady) return _schemaReady;
  _schemaReady = withClient(async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS bm_users (
      id            BIGINT PRIMARY KEY,
      full_name     TEXT, username TEXT, email TEXT, phone TEXT, display_name TEXT,
      password_hash TEXT, is_manager INTEGER DEFAULT 0, is_limited INTEGER DEFAULT 0,
      rank          TEXT DEFAULT 'user', avatar_color TEXT, avatar TEXT,
      created_at    TEXT, updated_at TEXT DEFAULT to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD HH24:MI:SS'),
      neon_synced_at TIMESTAMPTZ DEFAULT now()
    )`);
    await c.query('CREATE INDEX IF NOT EXISTS idx_bm_users_username ON bm_users(username)');
    await c.query(`CREATE TABLE IF NOT EXISTS bm_users_sync (
      id     BIGSERIAL PRIMARY KEY,
      at     TIMESTAMPTZ DEFAULT now(),
      action TEXT, detail TEXT
    )`);
    return true;
  });
  return _schemaReady;
}

// push the whole archive into Neon; rows missing from the source are deleted so Neon stays
// an exact mirror (skipped entirely when the source is empty — never wipe a remote copy)
async function pushAll(rows) {
  if (!enabled()) return null;
  if (!Array.isArray(rows) || !rows.length) return { upserted: 0, deleted: 0, skipped: 'empty source' };
  const ok = await ensureSchema();
  if (!ok) return null;
  const cols = COLUMNS;
  const res = await withClient(async (c) => {
    await c.query('BEGIN');
    try {
      for (const r of rows) {
        const vals = cols.map((k) => (r[k] === undefined ? null : r[k]));
        const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
        await c.query(
          'INSERT INTO bm_users (' + cols.join(',') + ') VALUES (' + ph + ')' +
          ' ON CONFLICT(id) DO UPDATE SET ' + cols.slice(1).map((k) => k + '=EXCLUDED.' + k).join(',') +
          ', neon_synced_at = now()',
          vals
        );
      }
      await c.query('DELETE FROM bm_users WHERE NOT (id = ANY($1::bigint[]))', [rows.map((r) => Number(r.id))]);
      await c.query('INSERT INTO bm_users_sync (action, detail) VALUES ($1,$2)',
        ['push', rows.length + ' account(s)']);
      await c.query('COMMIT');
      return { upserted: rows.length, deleted: true };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (e2) {}
      throw e;
    }
  });
  if (res) console.log('[neon] pushed ' + rows.length + ' account(s)');
  return res;
}

// read the mirror back (used when both the live DB and the local archive are empty)
async function pullAll() {
  if (!enabled()) return [];
  const ok = await ensureSchema();
  if (!ok) return [];
  const res = await withClient(async (c) => {
    const q = await c.query('SELECT ' + colsJoin() + ' FROM bm_users ORDER BY id');
    return q.rows;
  });
  return Array.isArray(res) ? res : [];
}

// remove one account from the mirror (called when a user is deleted)
async function removeUser(id) {
  if (!enabled()) return false;
  const ok = await ensureSchema();
  if (!ok) return false;
  return !!(await withClient(async (c) => {
    await c.query('DELETE FROM bm_users WHERE id=$1', [Number(id)]);
    await c.query('INSERT INTO bm_users_sync (action, detail) VALUES ($1,$2)', ['delete', String(id)]);
    return true;
  }));
}

function colsJoin() { return COLUMNS.join(','); }

function info() {
  const host = (() => { try { return new URL(DSN).host; } catch (e) { return ''; } })();
  return {
    enabled: enabled(),
    host: host || null,
    database: (() => { try { const u = new URL(DSN); return u.pathname.replace(/^\//, '') || null; } catch (e) { return null; } })(),
    // the connection string itself is never logged
    package: _poolError ? 'missing (npm i pg)' : (_pool ? 'pg' : 'not loaded'),
    error: _poolError ? _poolError.message : null,
  };
}

module.exports = { enabled, ensureSchema, pushAll, pullAll, removeUser, info, COLUMNS, DSN };