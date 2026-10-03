'use strict';
const dbm = require('./db');
const crypto = require('crypto');
const { sqlNow } = require('./helpers');

const COOKIE = 'bm';
const SESSION_COLS = ['id', 'full_name', 'username', 'email', 'phone', 'display_name',
  'is_manager', 'is_limited', 'rank', 'avatar_color', 'avatar', 'last_activity'];

function newSid() {
  return crypto.randomBytes(24).toString('hex');
}

function parseCookies(req) {
  const out = {};
  const h = req.headers && req.headers.cookie;
  if (!h) return out;
  const parts = h.split(';');
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k !== '' && v !== '') out[k] = decodeURIComponent(v);
  }
  return out;
}

function loadSession(req) {
  const sid = parseCookies(req)[COOKIE] || '';
  if (!sid) return null;
  const row = dbm.get('SELECT data, updated_at FROM bm_sessions WHERE sid=?', [sid]);
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch (e) {}
  return { sid, data };
}

function setCookie(req, res, sid) {
  const secure = isSecure(req);
  res.cookie(COOKIE, sid, {
    httpOnly: true, sameSite: 'Lax', secure, path: '/',
  });
}

function isSecure(req) {
  const xfp = req.headers && req.headers['x-forwarded-proto'];
  if (xfp && String(xfp).split(',')[0].trim() === 'https') return true;
  const h = req.headers && req.headers.host || '';
  const host = String(h).split(':')[0];
  return req.secure === true || (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && String(req.headers.host || '').split(':')[1] === '443');
}

function save(req) {
  if (!req.session) return;
  dbm.run(
    'UPDATE bm_sessions SET data=?, updated_at=? WHERE sid=?',
    [JSON.stringify(req.session.data), sqlNow(), req.session.sid]
  );
}

function createSession(req, res) {
  const sid = newSid();
  dbm.run(
    'INSERT INTO bm_sessions (sid, data, created_at, updated_at) VALUES (?,?,?,?)',
    [sid, '{}', sqlNow(), sqlNow()]
  );
  setCookie(req, res, sid);
  return { sid, data: {} };
}

function touch(req, res) {
  if (!req.session) req.session = createSession(req, res);
  return req.session;
}

function csrfToken(req, res) {
  touch(req, res);
  if (!req.session.data.csrf) {
    req.session.data.csrf = crypto.randomBytes(32).toString('hex');
    save(req);
  }
  return req.session.data.csrf;
}

function csrfValid(req, token) {
  if (!req.session || !req.session.data.csrf) return false;
  const a = Buffer.from(String(req.session.data.csrf));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function establishLoginSession(req, res, userId) {
  if (!req.session) req.session = createSession(req, res);
  const old = req.session;
  const sid = newSid();
  dbm.run(
    'INSERT INTO bm_sessions (sid, data, created_at, updated_at) VALUES (?,?,?,?)',
    [sid, '{}', sqlNow(), sqlNow()]
  );
  dbm.run('DELETE FROM bm_sessions WHERE sid=?', [old.sid]);
  setCookie(req, res, sid);
  req.session = { sid, data: { user_id: Number(userId) } };
  if (req.session.data.csrf === undefined) {
    req.session.data.csrf = crypto.randomBytes(32).toString('hex');
  }
  save(req);
  req._user = null;
  return req.session;
}

function currentUser(req) {
  if (!req.session || !req.session.data || !req.session.data.user_id) return null;
  if (req._user !== undefined) return req._user || null;
  const row = dbm.get(
    'SELECT ' + SESSION_COLS.join(',') + ' FROM users WHERE id=?',
    [req.session.data.user_id]
  );
  req._user = row || null;
  return req._user;
}

function invalidate(req, res) {
  if (req.session && req.session.sid) {
    dbm.run('DELETE FROM bm_sessions WHERE sid=?', [req.session.sid]);
  }
  req.session = null;
  req._user = null;
  res.clearCookie(COOKIE, { path: '/' });
}

function requireLogin(req, res, base) {
  if (currentUser(req) === null) {
    res.redirect(base + '/login');
    return false;
  }
  return true;
}

module.exports = {
  loadSession, touch, csrfToken, csrfValid, establishLoginSession,
  currentUser, invalidate, requireLogin, save,
};