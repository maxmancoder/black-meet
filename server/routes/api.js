'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const dbm = require('./../lib/db');
const {
  baseUrl, publicUrl, e, generateRoomId, makeSocketToken, isDevMode, avatarUrl, sqlNow, sqlNowMinus, toFaDigits,
} = require('./../lib/helpers');
const sessions = require('./../lib/sessions');
const pwd = require('./../lib/pwd');
const usersdb = require('./../lib/usersdb');
const otp = require('./../lib/otp');
const internal = require('./../lib/internal');
const bus = require('./../lib/bus');
const EV = require('./../../shared/socket-events');
const { broadcastSecret } = require('./../lib/config');
const themesLib = require('./../lib/themes');
const ranks = require('./../lib/ranks');
const settings = require('./../lib/settings');

const PHONE_RE = /^[0-9]{10,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function out(res, data, code) {
  return res.status(code || 200).json(data);
}
function ok(res, data) {
  return out(res, data);
}
function bad(res, data, code) {
  return out(res, data, code || 400);
}
function checkMethod(req, res, method) {
  if (req.method !== method) {
    bad(res, { ok: false, msg: 'متد نامعتبر' }, 405);
    return false;
  }
  return true;
}
function checkCsrf(req, res) {
  if (!sessions.csrfValid(req, req.body && req.body.csrf)) {
    bad(res, { ok: false, msg: 'درخواست نامعتبر' }, 403);
    return false;
  }
  return true;
}
function requireLoginApi(req, res) {
  if (sessions.currentUser(req) === null) {
    bad(res, { ok: false, msg: 'احراز هویت نشده' }, 401);
    return false;
  }
  return true;
}
function timingSafeEqStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const router = express.Router();

// ------------------------------------------------------------------
// auth / OTP
// ------------------------------------------------------------------

const PENDING_SIGNUP_MSG = 'اطلاعات شما ذخیره شد ولی با توجه به مشکلات، تا اطلاع ثانوی ، ایجاد حساب فقط با تایید مدیر است';
const SIGNUP_CLOSED_MSG = 'درحال حاظر امکان ایجاد حساب ممکن نیست!';

function findPendingSignup(identifier) {
  identifier = String(identifier || '').trim();
  if (identifier === '') return null;
  if (EMAIL_RE.test(identifier)) {
    return dbm.get("SELECT * FROM signup_requests WHERE status='pending' AND email=? ORDER BY id DESC LIMIT 1", [identifier]);
  }
  return dbm.get("SELECT * FROM signup_requests WHERE status='pending' AND phone=? ORDER BY id DESC LIMIT 1", [identifier]);
}

router.post('/signup', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;
  const full = String(req.body.full_name || '').trim();
  const user = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const phone = String(req.body.phone || '').trim();
  const pass = String(req.body.password || '');

  if (full === '' || user === '' || email === '' || phone === '' || pass === '') {
    return bad(res, { ok: false, msg: 'تمام فیلدها الزامی هستند' });
  }
  if (!EMAIL_RE.test(email)) return bad(res, { ok: false, msg: 'ایمیل نامعتبر است' });
  if (!PHONE_RE.test(phone)) return bad(res, { ok: false, msg: 'شماره تلفن نامعتبر است' });
  if (pass.length < 6) return bad(res, { ok: false, msg: 'رمز عبور باید حداقل ۶ کاراکتر باشد' });

  const mode = settings.signupMode();

  // admin disabled signups entirely
  if (mode === 'closed') {
    return bad(res, { ok: false, msg: SIGNUP_CLOSED_MSG });
  }

  const dup = dbm.get('SELECT id FROM users WHERE username=? OR email=? OR phone=?', [user, email, phone]);
  if (dup) return bad(res, { ok: false, msg: 'اطلاعات وارد شده تکراری میباشد' });

  // approval mode: store the request, no account is created until an admin approves
  if (mode === 'approval') {
    const byPhone = dbm.get("SELECT id, username, email FROM signup_requests WHERE status='pending' AND phone=?", [phone]);
    if (byPhone) {
      if (byPhone.username === user && byPhone.email === email) {
        return ok(res, { ok: true, pending: true, phone, msg: PENDING_SIGNUP_MSG });
      }
      return bad(res, { ok: false, msg: 'اطلاعات وارد شده تکراری میباشد' });
    }
    const dupReq = dbm.get("SELECT id FROM signup_requests WHERE status='pending' AND (username=? OR email=?)", [user, email]);
    if (dupReq) return bad(res, { ok: false, msg: 'اطلاعات وارد شده تکراری میباشد' });

    const ins = dbm.run(
      'INSERT INTO signup_requests (full_name, username, email, phone, password, status, created_at) VALUES (?,?,?,?,?,?,?)',
      // the pending request stores the HASH, never the plain password
      [full, user, email, phone, pwd.hashPassword(pass), 'pending', sqlNow()]
    );
    bus.srToManagers(EV.SR_NEW_REQUEST, { requestId: Number(ins.lastInsertRowid), name: full, ts: sqlNow() });
    return ok(res, { ok: true, pending: true, phone, msg: PENDING_SIGNUP_MSG });
  }

  // open mode (default): create the account right away and continue with OTP
  if (!otp.otpSendAllowed(phone)) {
    return bad(res, { ok: false, msg: 'تعداد درخواست کد زیاد است. لطفاً کمی بعد دوباره تلاش کنید' });
  }

  const hash = pwd.hashPassword(pass);
  const colors = ['#4f46e5', '#00a572', '#bf0f3c', '#c3c0ff', '#4edea3', '#ffb2b7'];
  const avatarColor = colors[crypto.randomInt(0, colors.length)];

  dbm.run(
    'INSERT INTO users (full_name, username, email, phone, password_hash, display_name, avatar_color, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [full, user, email, phone, hash, full, avatarColor, sqlNow()]
  );
  // mirror the new account into the users archive right away
  try { usersdb.syncUser(Number(dbm.get('SELECT id FROM users WHERE username=?', [user]).id)); } catch (e) {}
  // if this phone had a waiting approval request, it is obsolete now
  dbm.run("DELETE FROM signup_requests WHERE status='pending' AND phone=?", [phone]);

  const code = otp.insertOtp(phone, 'signup');
  otp.devLogOtp(phone, code, 'signup');

  const response = { ok: true, phone, purpose: 'signup', msg: 'کد تأیید تولید شد' };
  if (isDevMode()) response.otp = code;
  return ok(res, response);
});

router.post('/login/phone', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;
  const phone = String(req.body.phone || '').trim();
  if (!PHONE_RE.test(phone)) return bad(res, { ok: false, msg: 'شماره تلفن نامعتبر است' });

  const u = dbm.get('SELECT id FROM users WHERE phone=?', [phone]);
  if (!u) return bad(res, { ok: false, msg: 'حساب وجود ندارد' });

  if (!otp.otpSendAllowed(phone)) {
    return bad(res, { ok: false, msg: 'تعداد درخواست کد زیاد است. لطفاً کمی بعد دوباره تلاش کنید' });
  }

  otp.otpCleanup(phone);
  const code = otp.insertOtp(phone, 'login_phone');
  otp.devLogOtp(phone, code, 'login_phone');

  const response = { ok: true, phone, purpose: 'login_phone' };
  if (isDevMode()) response.otp = code;
  return ok(res, response);
});

router.post('/login/resend', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;
  const phone = String(req.body.phone || '').trim();
  const purpose = req.body.purpose === 'signup' ? 'signup' : 'login_phone';
  if (!PHONE_RE.test(phone)) return bad(res, { ok: false, msg: 'شماره نامعتبر است' });

  if (!otp.otpSendAllowed(phone)) {
    return bad(res, { ok: false, msg: 'تعداد درخواست کد زیاد است. لطفاً کمی بعد دوباره تلاش کنید' });
  }

  otp.otpCleanup(phone);
  const code = otp.insertOtp(phone, purpose);
  otp.devLogOtp(phone, code, 'resend_' + purpose);

  const response = { ok: true, msg: 'کد جدید ارسال شد' };
  if (isDevMode()) response.otp = code;
  return ok(res, response);
});

router.post('/login/verify', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;

  const phone = String(req.body.phone || '').trim();
  const code = String(req.body.code || '').trim();
  const purpose = req.body.purpose === 'signup' ? 'signup' : 'login_phone';
  if (phone === '' || code === '') return bad(res, { ok: false, msg: 'داده ناقص' });

  if (!otp.otpVerifyAllowed(phone)) {
    return bad(res, { ok: false, msg: 'تلاش‌های ناموفق زیاد است. لطفاً ۱۵ دقیقه صبر کنید' }, 429);
  }

  const row = dbm.get(
    'SELECT code, expires_at FROM verification_codes WHERE identifier=? AND purpose=? ORDER BY id DESC LIMIT 1',
    [phone, purpose]
  );
  if (!row) {
    otp.otpRecordFailure(phone);
    return bad(res, { ok: false, msg: 'کد تاییدی برای این شماره وجود ندارد. لطفاً ابتدا کد تایید را دریافت کنید.' });
  }
  const expires = Date.parse(row.expires_at.replace(' ', 'T'));
  if (isNaN(expires) || expires <= Date.now()) {
    otp.otpRecordFailure(phone);
    return bad(res, { ok: false, msg: 'کد تأیید منقضی شده است. لطفاً کد جدید دریافت کنید.' });
  }
  if (!timingSafeEqStr(row.code, code)) {
    otp.otpRecordFailure(phone);
    return bad(res, { ok: false, msg: 'کد تایید اشتباه است.' });
  }

  dbm.run('DELETE FROM verification_codes WHERE identifier=? AND purpose=?', [phone, purpose]);

  const user = dbm.get('SELECT id FROM users WHERE phone=?', [phone]);
  if (!user) return bad(res, { ok: false, msg: 'حساب یافت نشد' });

  sessions.establishLoginSession(req, res, user.id);
  return ok(res, { ok: true, redirect: baseUrl(req) + '/home' });
});

router.post('/login/email', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!checkCsrf(req, res)) return;

  const email = String(req.body.email || '').trim();
  const pass = String(req.body.password || '');

  const user = dbm.get('SELECT id, password_hash FROM users WHERE email=?', [email]);
  if (!user) return ok(res, { ok: false, msg: 'حساب وجود ندارد' });

  const r = pwd.verifyAndUpgradePassword(pass, user.password_hash);
  if (!r.ok) return ok(res, { ok: false, msg: 'حساب وجود ندارد' });

  if (r.upgradeHash !== null) {
    try { pwd.storeUpgradedPassword(user.id, r.upgradeHash); } catch (e) {}
  }

  sessions.establishLoginSession(req, res, user.id);
  return ok(res, { ok: true, redirect: baseUrl(req) + '/home' });
});

router.post('/logout', (req, res) => {
  sessions.invalidate(req, res);
  return ok(res, { ok: true, redirect: baseUrl(req) + '/login' });
});

router.get('/socket-token', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  const token = makeSocketToken(me.id, 0);
  return ok(res, { ok: true, token, user_id: Number(me.id) });
});

// available UI themes (CSS files in the design folder) + the active one (cookie bm_theme)
router.get('/themes', (req, res) => {
  return ok(res, { ok: true, themes: themesLib.listThemes(), current: themesLib.currentTheme(req) });
});

// ------------------------------------------------------------------
// meetings
// ------------------------------------------------------------------

router.post('/meetings/create', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;

  let title = String(req.body.title || '').trim();
  if (title === '') title = 'تماس بدون عنوان';
  const me = sessions.currentUser(req);

  if (me.is_limited) {
    return bad(res, { ok: false, msg: 'حساب شما محدود شده و اجازه ایجاد تماس ندارید' }, 403);
  }

  // daily quota: 2 for regular users, 5 for admins, 15 for premium admins (0 = unlimited)
  const quota = ranks.dailyQuota(me);
  if (quota.limit !== 0 && quota.used >= quota.limit) {
    return bad(res, {
      ok: false,
      msg: 'به سقف تماس امروز خود رسیده‌اید (' + toFaDigits(quota.limit) + ' تماس در روز). فردا دوباره تلاش کنید',
    }, 403);
  }

  const roomId = generateRoomId();
  const defaultMedia = String(req.body.default_media) === '0' ? 0 : 1;
  const r = dbm.run('INSERT INTO meetings (room_id, title, creator_id, active, default_media, created_at) VALUES (?,?,?,1,?,?)',
    [roomId, title, me.id, defaultMedia, sqlNow()]);
  dbm.run(
    'INSERT INTO meeting_participants (meeting_id, user_id, display_name, username, status, role, joined_at) VALUES (?,?,?,?,?,?,?)',
    [r.lastInsertRowid, me.id, me.display_name, me.username, 'approved', 'admin', sqlNow()]
  );

  return ok(res, {
    ok: true,
    room_id: roomId,
    redirect: baseUrl(req) + '/meeting?room=' + roomId,
    share_url: publicUrl(req) + '/meeting?room=' + roomId,
    quota: ranks.dailyQuota(me),
  });
});

router.get('/meetings/info', (req, res) => {
  const room = String(req.query.room || '').trim();
  if (room === '') return bad(res, { ok: false, msg: 'لینک نامعتبر' }, 404);
  const row = dbm.get('SELECT room_id, title FROM meetings WHERE room_id=? AND active=1', [room]);
  if (!row) return bad(res, { ok: false, msg: 'تماسی با این لینک یافت نشد' }, 404);
  return ok(res, { ok: true, room_id: row.room_id, title: row.title });
});

router.post('/meetings/message', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  const body = String(req.body.body || '').trim();
  const mid = Number(req.body.meeting_id || 0);
  if (body === '' || mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const me = sessions.currentUser(req);
  const part = dbm.get(
    'SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=? AND status<>?',
    [mid, me.id, 'removed']
  );
  if (!part) return bad(res, { ok: false, msg: 'عضو نیستید' }, 403);

  dbm.run('INSERT INTO messages (meeting_id, user_id, display_name, body, created_at) VALUES (?,?,?,?,?)',
    [mid, me.id, me.display_name, body, sqlNow()]);
  return ok(res, { ok: true });
});

router.post('/meetings/emoji', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  const emoji = String(req.body.emoji || '');
  const mid = Number(req.body.meeting_id || 0);
  if (emoji === '' || mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const me = sessions.currentUser(req);
  const part = dbm.get(
    'SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=? AND status<>?',
    [mid, me.id, 'removed']
  );
  if (!part) return bad(res, { ok: false, msg: 'عضو نیستید' }, 403);

  dbm.run('INSERT INTO emoji_events (meeting_id, user_id, display_name, emoji, created_at) VALUES (?,?,?,?,?)',
    [mid, me.id, me.display_name, emoji, sqlNow()]);
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------
// member management (meeting admin; uses meetings.creator_id)
// ------------------------------------------------------------------

function memberActivity(req, res, action) {
  if (!checkMethod(req, res, 'POST')) return null;
  if (!requireLoginApi(req, res)) return null;
  if (!checkCsrf(req, res)) return null;

  const pid = Number(req.body.participant_id || 0);
  const me = sessions.currentUser(req);

  const part = dbm.get(
    'SELECT p.*, m.creator_id FROM meeting_participants p JOIN meetings m ON m.id=p.meeting_id WHERE p.id=?',
    [pid]
  );
  if (!part) { bad(res, { ok: false, msg: 'عضو یافت نشد' }); return null; }
  if (part.creator_id != me.id) { bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403); return null; }

  if (action === 'approved') {
    dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['approved', pid]);
  } else if (action === 'removed') {
    dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['removed', pid]);
  } else if (action === 'muted') {
    const muted = Number(req.body.muted != null ? req.body.muted : 1);
    dbm.run('UPDATE meeting_participants SET muted=? WHERE id=?', [muted ? 1 : 0, pid]);
    return ok(res, { ok: true, user_id: Number(part.user_id), muted: !!muted });
  }
  return ok(res, { ok: true });
}

router.post('/meetings/approve', (req, res) => {
  const r = memberActivity(req, res, 'approved');
  if (r === null) return;
  return r;
});
router.post('/meetings/reject', (req, res) => {
  const r = memberActivity(req, res, 'removed');
  if (r === null) return;
  return r;
});
router.post('/meetings/remove', (req, res) => {
  const part = resolveTarget(req, res);
  if (!part) return;
  dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['removed', part.id]);
  return ok(res, { ok: true, user_id: Number(part.user_id) });
});
router.post('/meetings/mute', (req, res) => {
  const part = resolveTarget(req, res);
  if (!part) return;
  const muted = Number(req.body.muted != null ? req.body.muted : 1);
  dbm.run('UPDATE meeting_participants SET muted=? WHERE id=?', [muted ? 1 : 0, part.id]);
  return ok(res, { ok: true, user_id: Number(part.user_id), muted: !!muted });
});

function resolveTarget(req, res) {
  if (!checkMethod(req, res, 'POST')) return null;
  if (!requireLoginApi(req, res)) return null;
  if (!checkCsrf(req, res)) return null;

  const pid = Number(req.body.participant_id || 0);
  const me = sessions.currentUser(req);

  const part = dbm.get(
    'SELECT p.*, m.creator_id FROM meeting_participants p JOIN meetings m ON m.id=p.meeting_id WHERE p.id=?',
    [pid]
  );
  if (!part) { bad(res, { ok: false, msg: 'عضو یافت نشد' }); return null; }
  if (part.creator_id != me.id) { bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403); return null; }
  return part;
}

// remove one of MY recent meetings from the home list (creator or manager only)
router.post('/meetings/delete', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const mid = Number(req.body.meeting_id || 0);
  if (mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });
  const me = sessions.currentUser(req);
  const m = dbm.get('SELECT id, creator_id, active FROM meetings WHERE id=?', [mid]);
  if (!m) return bad(res, { ok: false, msg: 'جلسه یافت نشد' });
  if (Number(m.creator_id) !== Number(me.id) && !me.is_manager) {
    return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  }
  if (m.active) {
    // close the live room first so sockets are dropped before the rows disappear
    const row = dbm.get('SELECT room_id FROM meetings WHERE id=?', [mid]);
    if (row && row.room_id) internal.closeMeeting(String(row.room_id));
  }
  dbm.run('DELETE FROM messages WHERE meeting_id=?', [mid]);
  dbm.run('DELETE FROM emoji_events WHERE meeting_id=?', [mid]);
  dbm.run('DELETE FROM meeting_participants WHERE meeting_id=?', [mid]);
  dbm.run('DELETE FROM verification_codes WHERE identifier=?', ['room:' + mid]);
  dbm.run('DELETE FROM meetings WHERE id=?', [mid]);
  return ok(res, { ok: true, id: mid });
});

router.post('/meetings/leave', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  const mid = Number(req.body.meeting_id || 0);
  if (mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const me = sessions.currentUser(req);
  const part = dbm.get(
    'SELECT id FROM meeting_participants WHERE meeting_id=? AND user_id=? AND status<>?',
    [mid, me.id, 'removed']
  );
  if (part) {
    dbm.run('UPDATE meeting_participants SET status=? WHERE meeting_id=? AND user_id=?', ['removed', mid, me.id]);
  }
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------
// profile
// ------------------------------------------------------------------

router.post('/profile/update', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;

  const me = sessions.currentUser(req);
  const display = String(req.body.display_name || '').trim();
  if (display === '') return bad(res, { ok: false, msg: 'نام نمایشی الزامی است' });

  dbm.run('UPDATE users SET display_name=? WHERE id=?', [display, me.id]);
  usersdb.syncUser(me.id);
  if (req.session) req.session.data.display_name = display;
  sessions.save(req);
  return ok(res, { ok: true, display_name: display });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

router.post('/profile/avatar', upload.single('avatar'), (req, res) => {
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;

  const me = sessions.currentUser(req);
  if (!req.file) return bad(res, { ok: false, msg: 'فایل انتخاب نشده' });

  const allowed = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  const mime = req.file.mimetype;
  if (!allowed[mime]) return bad(res, { ok: false, msg: 'فرمت تصویر پشتیبانی نمی‌شود' });
  if (req.file.size > 2 * 1024 * 1024) return bad(res, { ok: false, msg: 'حجم تصویر بیش از ۲ مگابایت است' });

  const ext = allowed[mime];
  const rel = 'uploads/avatars/' + me.id + '.' + ext;
  const abs = path.join(dbm.rootDir, rel);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (e) { /* ignore */ }
  }
  for (const other of Object.values(allowed)) {
    const p = path.join(dbm.rootDir, 'uploads/avatars', me.id + '.' + other);
    if (p !== abs && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
    }
  }
  fs.writeFileSync(abs, req.file.buffer);

  dbm.run('UPDATE users SET avatar=? WHERE id=?', [rel, me.id]);
  usersdb.syncUser(me.id);
  return ok(res, { ok: true, avatar: avatarUrl(rel, req) });
});

// ------------------------------------------------------------------
// admin (manager only)
// ------------------------------------------------------------------

// users list depending on who is asking (the main manager's info is hidden from everyone else)
function usersForViewer(me) {
  const users = dbm.all(
    'SELECT id, full_name, username, display_name, email, phone, is_manager, is_limited, rank, avatar_color, avatar, created_at, password_hash FROM users ORDER BY id'
  );
  if (me.is_manager) return users;
  return users.map((u) => {
    if (u.is_manager) {
      return {
        id: u.id, display_name: u.display_name, avatar: u.avatar, avatar_color: u.avatar_color,
        is_manager: 1, is_limited: 0, rank: 'user', created_at: u.created_at, info_hidden: true,
      };
    }
    return u;
  });
}

const VALID_RANKS = ['user', 'admin', 'premium'];

// ------------------------------------------------------------------
// Users archive (users_archive.db) — a durable copy of every account
// ------------------------------------------------------------------
router.get('/admin/users-archive', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canManageUsers(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  return ok(res, { ok: true, stats: usersdb.stats(), users: usersdb.listUsers() });
});

// download the archive file itself (manager only; it is never served publicly)
router.get('/admin/users-archive/download', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canManageUsers(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  usersdb.syncAll();
  if (!fs.existsSync(usersdb.ARCHIVE_PATH)) return bad(res, { ok: false, msg: 'فایل هنوز ساخته نشده است' });
  return res.download(usersdb.ARCHIVE_PATH, 'users_archive.db');
});

// pull the accounts back into a fresh database (e.g. a brand-new Render instance)
router.post('/admin/users-archive/restore', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canManageUsers(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  const r = usersdb.restore({ overwrite: req.body.overwrite === '1' || req.body.overwrite === true });
  return ok(res, Object.assign({ ok: true }, r));
});

router.post('/admin/users-archive/export', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canManageUsers(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  const n = usersdb.syncAll();
  const exported = usersdb.exportSnapshot();
  return ok(res, { ok: true, synced: n, exported, dir: usersdb.EXPORT_DIR || null });
});

router.all('/admin/members', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canManageUsers(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  if (req.method === 'GET') {
    return ok(res, { ok: true, users: usersForViewer(me) });
  }

  if (req.method !== 'POST') return bad(res, { ok: false }, 405);
  if (!checkCsrf(req, res)) return;

  const action = String(req.body.action || '');
  const uid = Number(req.body.user_id || 0);
  if (uid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const row = dbm.get('SELECT id, is_manager, rank, username, email, phone, password_hash FROM users WHERE id=?', [uid]);
  if (!row) return bad(res, { ok: false, msg: 'کاربر یافت نشد' });

  // the main manager's info may only be changed by himself
  if (row.is_manager && !me.is_manager) {
    return bad(res, { ok: false, msg: 'اطلاعات مدیر اصلی فقط توسط خودش قابل تغییر است' }, 403);
  }

  if (action === 'update') {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim();
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '');
    let rankVal = String(req.body.rank || row.rank || 'user');

    if (username === '' || email === '' || phone === '') return bad(res, { ok: false, msg: 'تمام فیلدها الزامی هستند' });
    if (!EMAIL_RE.test(email)) return bad(res, { ok: false, msg: 'ایمیل نامعتبر است' });
    if (!PHONE_RE.test(phone)) return bad(res, { ok: false, msg: 'شماره تلفن نامعتبر است' });
    if (password !== '' && password.length < 6) return bad(res, { ok: false, msg: 'رمز عبور باید حداقل ۶ کاراکتر باشد' });
    if (VALID_RANKS.indexOf(rankVal) === -1) return bad(res, { ok: false, msg: 'درجه نامعتبر است' });

    const dupU = dbm.get('SELECT id FROM users WHERE (username=? OR email=? OR phone=?) AND id<>?', [username, email, phone, uid]);
    if (dupU) return bad(res, { ok: false, msg: 'اطلاعات وارد شده تکراری میباشد' });
    const dupR = dbm.get(
      "SELECT id FROM signup_requests WHERE status='pending' AND (username=? OR email=? OR phone=?)",
      [username, email, phone]
    );
    if (dupR) return bad(res, { ok: false, msg: 'این اطلاعات با یک درخواست ثبت‌نام در انتظار تکراری است' });

    const sets = ['username=?', 'email=?', 'phone=?'];
    const params = [username, email, phone];
    if (password !== '') { sets.push('password_hash=?'); params.push(password); }
    if (!row.is_manager) { sets.push('rank=?'); params.push(rankVal); }
    params.push(uid);
    dbm.run('UPDATE users SET ' + sets.join(', ') + ' WHERE id=?', params);
    usersdb.syncUser(uid);

    const updated = usersForViewer(me).find((u) => Number(u.id) === uid);
    return ok(res, { ok: true, user: updated || null });
  }

  if (action === 'set_rank') {
    const nr = String(req.body.rank || '');
    if (nr !== 'admin' && nr !== 'premium') return bad(res, { ok: false, msg: 'درجه نامعتبر است' });
    if (uid === Number(me.id)) return bad(res, { ok: false, msg: 'نمی‌توانید درجه خود را تغییر دهید' });
    if (row.is_manager) return bad(res, { ok: false, msg: 'درجه مدیر اصلی قابل تغییر نیست' }, 403);
    dbm.run('UPDATE users SET rank=? WHERE id=?', [nr, uid]);
    usersdb.syncUser(uid);
    return ok(res, { ok: true, rank: nr, label: ranks.RANKS[nr].label });
  }

  if (action === 'reset_password') {
    let np = String(req.body.new_password || '').trim();
    if (np === '') {
      const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      np = '';
      for (let i = 0; i < 10; i++) np += chars[crypto.randomInt(0, chars.length)];
    }
    if (np.length < 6) return bad(res, { ok: false, msg: 'رمز عبور حداقل ۶ کاراکتر باشد' });
    // always store a hash, never the plain password
    dbm.run('UPDATE users SET password_hash=? WHERE id=?', [pwd.hashPassword(np), uid]);
    usersdb.syncUser(uid);
    return ok(res, { ok: true, generated: (String(req.body.new_password || '').trim() === '') ? np : null });
  }

  // default action: toggle "limited"
  if (uid === Number(me.id)) return bad(res, { ok: false, msg: 'نمی‌توانید حساب خود را محدود کنید' });
  if (row.is_manager) return bad(res, { ok: false, msg: 'مدیر را نمی‌توان محدود کرد' }, 403);
  dbm.run('UPDATE users SET is_limited = 1 - is_limited WHERE id=?', [uid]);
  usersdb.syncUser(uid);
  const lim = dbm.get('SELECT is_limited FROM users WHERE id=?', [uid]);
  return ok(res, { ok: true, is_limited: !!lim.is_limited });
});

// ------------------------------------------------------------------
// signup mode (open / approval / closed) + account creation requests
// ------------------------------------------------------------------

router.post('/admin/signup-mode', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canChangeSignupMode(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  const mode = String(req.body.mode || '');
  if (settings.SIGNUP_MODES.indexOf(mode) === -1) return bad(res, { ok: false, msg: 'حالت نامعتبر' });
  settings.setSetting('signup_mode', mode);
  return ok(res, { ok: true, mode });
});

function requestsWithMessages() {
  // decided requests vanish from the list 30 minutes after the decision
  const rows = dbm.all(
    "SELECT * FROM signup_requests WHERE status='pending' OR decided_at >= ? ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, id DESC",
    [sqlNowMinus(30)]
  );
  return rows.map((r) => Object.assign({}, r, {
    messages: dbm.all(
      'SELECT id, body, from_manager, created_at FROM signup_request_messages WHERE request_id=? ORDER BY id ASC',
      [r.id]
    ),
  }));
}

router.get('/admin/signup-requests', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canViewRequests(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  return ok(res, { ok: true, requests: requestsWithMessages(), can_decide: ranks.canDecideRequests(me) });
});

router.post('/admin/signup-requests', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canDecideRequests(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  const rid = Number(req.body.request_id || 0);
  const action = String(req.body.action || '');
  if (rid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });
  const reqRow = dbm.get('SELECT * FROM signup_requests WHERE id=?', [rid]);
  if (!reqRow) return bad(res, { ok: false, msg: 'درخواستی یافت نشد' });
  if (reqRow.status !== 'pending') return bad(res, { ok: false, msg: 'این درخواست قبلاً بررسی شده است' });

  if (action === 'reject') {
    dbm.run('UPDATE signup_requests SET status=?, decided_at=?, decided_by=? WHERE id=?',
      ['rejected', sqlNow(), me.id, rid]);
    return ok(res, { ok: true, status: 'rejected' });
  }

  if (action !== 'approve') return bad(res, { ok: false, msg: 'عملیات نامعتبر' });

  const dup = dbm.get('SELECT id FROM users WHERE username=? OR email=? OR phone=?',
    [reqRow.username, reqRow.email, reqRow.phone]);
  if (dup) return bad(res, { ok: false, msg: 'امکان تایید نیست؛ کاربری با این نام کاربری، ایمیل یا شماره وجود دارد' });

  const colors = ['#4f46e5', '#00a572', '#bf0f3c', '#c3c0ff', '#4edea3', '#ffb2b7'];
  const avatarColor = colors[crypto.randomInt(0, colors.length)];
  dbm.run(
    'INSERT INTO users (full_name, username, email, phone, password_hash, display_name, avatar_color, rank, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [reqRow.full_name, reqRow.username, reqRow.email, reqRow.phone, reqRow.password, reqRow.full_name, avatarColor, 'user', sqlNow()]
  );
  dbm.run('UPDATE signup_requests SET status=?, decided_at=?, decided_by=? WHERE id=?',
    ['approved', sqlNow(), me.id, rid]);

  const created = dbm.get('SELECT id, full_name, username, display_name, email, phone, is_manager, is_limited, rank, avatar_color, avatar, created_at, password_hash FROM users WHERE username=?', [reqRow.username]);
  usersdb.syncUser(Number(created.id)); // mirror into the users archive
  return ok(res, { ok: true, status: 'approved', user: created || null });
});

// manager/premium reply inside a pending signup request thread
router.post('/admin/signup-requests/message', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canDecideRequests(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  const rid = Number(req.body.request_id || 0);
  const body = String(req.body.body || '').trim();
  if (rid === 0 || body === '') return bad(res, { ok: false, msg: 'داده ناقص' });
  const reqRow = dbm.get('SELECT id FROM signup_requests WHERE id=?', [rid]);
  if (!reqRow) return bad(res, { ok: false, msg: 'درخواستی یافت نشد' });

  const r = dbm.run('INSERT INTO signup_request_messages (request_id, body, from_manager, created_at) VALUES (?,?,1,?)',
    [rid, body, sqlNow()]);
  return ok(res, { ok: true, message: { id: r.lastInsertRowid, body, from_manager: 1, created_at: sqlNow() } });
});

router.post('/admin/block', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;

  const me = sessions.currentUser(req);
  const mid = Number(req.body.meeting_id || 0);
  const uid = Number(req.body.user_id || 0);
  if (mid === 0 || uid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const role = dbm.get(
    'SELECT role FROM meeting_participants WHERE meeting_id=? AND user_id=?',
    [mid, me.id]
  );
  if ((!role || role.role !== 'admin') && !me.is_manager) {
    return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  }

  dbm.run('INSERT OR IGNORE INTO meeting_blocks (meeting_id, user_id) VALUES (?,?)', [mid, uid]);
  return ok(res, { ok: true });
});

router.all('/announcements', (req, res) => {
  if (!requireLoginApi(req, res)) return;

  if (req.method === 'GET') {
    const rows = dbm.all('SELECT id, body, created_at FROM announcements ORDER BY id DESC');
    return ok(res, { ok: true, announcements: rows });
  }

  if (req.method === 'POST') {
    const me = sessions.currentUser(req);
    if (!me.is_manager && ranks.rankOf(me) !== 'premium') return bad(res, { ok: false, msg: 'فقط مدیر یا ادمین پریمیوم' }, 403);
    if (!checkCsrf(req, res)) return;
    const body = String(req.body.body || '').trim();
    if (body === '') return bad(res, { ok: false, msg: 'متن خالی است' });

    const r = dbm.run('INSERT INTO announcements (body, created_at) VALUES (?,?)', [body, sqlNow()]);
    // fromUserId lets the sender's own tabs skip the echo (no double bubble)
    const notif = { id: r.lastInsertRowid, body, created_at: sqlNow(), fromUserId: Number(me.id) };
    bus.notifyNew(notif);
    return ok(res, { ok: true });
  }

  return bad(res, { ok: false, msg: 'متد نامعتبر' }, 405);
});

// ------------------------------------------------------------------
// private messages
// ------------------------------------------------------------------

function findUserByIdentifier(identifier) {
  identifier = String(identifier || '').trim();
  if (identifier === '') return null;
  if (EMAIL_RE.test(identifier)) {
    return dbm.get('SELECT id, username, display_name, avatar FROM users WHERE email=?', [identifier]);
  }
  return dbm.get('SELECT id, username, display_name, avatar FROM users WHERE phone=?', [identifier]);
}

router.all('/messages/user', (req, res) => {
  if (req.method === 'GET') {
    const identifier = String(req.query.identifier || '').trim();
    const u = findUserByIdentifier(identifier);
    if (!u) {
      // a pending signup applicant chats through the same screen
      const pending = findPendingSignup(identifier);
      if (!pending) return ok(res, { ok: false, msg: 'کاربری با این مشخصات یافت نشد' });
      const messages = dbm.all(
        'SELECT id, from_manager, body, created_at FROM signup_request_messages WHERE request_id=? ORDER BY id ASC',
        [pending.id]
      );
      return ok(res, {
        ok: true,
        pending: true,
        user: { id: 0, username: pending.username, display_name: pending.full_name, avatar: null },
        messages,
      });
    }
    const messages = dbm.all(
      'SELECT id, from_manager, body, created_at FROM pv_messages WHERE user_id=? ORDER BY id ASC',
      [u.id]
    );
    return ok(res, { ok: true, user: u, messages });
  }

  if (req.method !== 'POST') return bad(res, { ok: false }, 405);
  const identifier = String(req.body.identifier || '').trim();
  const body = String(req.body.body || '').trim();
  if (body === '') return bad(res, { ok: false, msg: 'متن پیام خالی است' });

  const u = findUserByIdentifier(identifier);
  if (!u) {
    const pending = findPendingSignup(identifier);
    if (!pending) return ok(res, { ok: false, msg: 'کاربری با این مشخصات یافت نشد' });
    const ins = dbm.run('INSERT INTO signup_request_messages (request_id, body, from_manager, created_at) VALUES (?,?,0,?)',
      [pending.id, body, sqlNow()]);
    bus.srToManagers(EV.SR_NEW_MESSAGE, {
      requestId: Number(pending.id),
      message: { id: Number(ins.lastInsertRowid), from_manager: 0, body, created_at: sqlNow() },
    });
    return ok(res, { ok: true, pending: true });
  }

  dbm.run('INSERT INTO pv_messages (user_id, from_manager, body, created_at) VALUES (?,0,?,?)', [u.id, body, sqlNow()]);
  dbm.run('UPDATE users SET last_activity=? WHERE id=?', [sqlNow(), u.id]);
  bus.pvConversationUpdated({ userId: Number(u.id), lastBody: body, fromManager: 0, ts: sqlNow() });
  bus.pvToManagers({ id: null, fromUserId: Number(u.id), fromName: u.display_name, body, fromManager: 0, ts: sqlNow() });
  return ok(res, { ok: true });
});

router.all('/messages/conversations', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  const isMgr = !!me.is_manager;
  if (!isMgr && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  if (req.method === 'GET') {
    const uid = Number(req.query.user_id || 0);

    if (!isMgr) {
      // premium: exactly one thread — the chat with the main manager
      const mgr = dbm.get(
        'SELECT id, username, display_name, avatar, avatar_color, email, last_activity FROM users WHERE is_manager=1 ORDER BY id LIMIT 1'
      );
      if (uid === 0) {
        const unread = dbm.get(
          'SELECT COUNT(*) AS c FROM pv_messages WHERE user_id=? AND from_manager=1 AND seen=0',
          [me.id]
        );
        const conversations = mgr ? [{
          user_id: Number(mgr.id), username: mgr.username, display_name: mgr.display_name,
          avatar: mgr.avatar, avatar_color: mgr.avatar_color, email: mgr.email,
          last_activity: mgr.last_activity, unread: Number(unread && unread.c || 0), admin_chat: 1,
        }] : [];
        return ok(res, { ok: true, conversations, admin_chat: true });
      }
      const messages = dbm.all(
        'SELECT id, from_manager, body, created_at FROM pv_messages WHERE user_id=? ORDER BY id ASC',
        [me.id]
      );
      dbm.run('UPDATE pv_messages SET seen=1 WHERE user_id=? AND from_manager=1', [me.id]);
      return ok(res, { ok: true, messages, admin_chat: true });
    }

    if (uid === 0) {
      const conversations = dbm.all(
        `SELECT DISTINCT m.user_id AS user_id, u.username, u.display_name, u.avatar, u.email, u.last_activity,
                (SELECT COUNT(*) FROM pv_messages p WHERE p.user_id=m.user_id AND p.from_manager=0 AND p.seen=0) AS unread
         FROM pv_messages m JOIN users u ON u.id=m.user_id ORDER BY m.user_id`
      );
      return ok(res, { ok: true, conversations });
    }
    const messages = dbm.all(
      'SELECT id, from_manager, body, created_at FROM pv_messages WHERE user_id=? ORDER BY id ASC',
      [uid]
    );
    dbm.run('UPDATE pv_messages SET seen=1 WHERE user_id=? AND from_manager=0', [uid]);
    return ok(res, { ok: true, messages });
  }

  if (!checkCsrf(req, res)) return;
  const uid = Number(req.body.user_id || 0);
  const body = String(req.body.body || '').trim();
  if (uid === 0 || body === '') return bad(res, { ok: false, msg: 'داده ناقص' });

  if (!isMgr) {
    // premium replies inside his own thread (stored under his user_id)
    const r = dbm.run('INSERT INTO pv_messages (user_id, from_manager, body, created_at) VALUES (?,0,?,?)',
      [me.id, body, sqlNow()]);
    const payload = { id: r.lastInsertRowid, fromUserId: Number(me.id), fromName: me.display_name, body, fromManager: 0, ts: sqlNow() };
    bus.pvToManagers(payload);
    bus.pvConversationUpdated({ userId: Number(me.id), lastBody: body, fromManager: 0, ts: payload.ts });
    return ok(res, { ok: true, id: payload.id });
  }

  const ts = sqlNow();
  const r2 = dbm.run('INSERT INTO pv_messages (user_id, from_manager, body, created_at) VALUES (?,1,?,?)', [uid, body, ts]);
  // push live to the recipient (HTTP fallback path; socket PV_SEND does the same)
  bus.pvNew(uid, { id: r2.lastInsertRowid, fromUserId: Number(me.id), fromName: me.display_name, body, fromManager: 1, ts });
  bus.pvConversationUpdated({ userId: uid, lastBody: body, fromManager: 1, ts });
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------
// home sidebar unread badge (seen flags live in pv_messages)
// ------------------------------------------------------------------
function unreadCountFor(me) {
  if (me.is_manager) {
    const row = dbm.get('SELECT COUNT(*) AS c FROM pv_messages WHERE from_manager=0 AND seen=0');
    return Number((row && row.c) || 0);
  }
  const row = dbm.get('SELECT COUNT(*) AS c FROM pv_messages WHERE user_id=? AND from_manager=1 AND seen=0', [me.id]);
  return Number((row && row.c) || 0);
}

router.get('/messages/unread', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  return ok(res, { ok: true, count: unreadCountFor(me) });
});

router.post('/messages/read-all', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  if (!checkCsrf(req, res)) return;
  if (me.is_manager) dbm.run('UPDATE pv_messages SET seen=1 WHERE from_manager=0');
  else dbm.run('UPDATE pv_messages SET seen=1 WHERE user_id=? AND from_manager=1', [me.id]);
  return ok(res, { ok: true, count: 0 });
});

// ------------------------------------------------------------------
// compatibility endpoint: old signaling -> php-internal bridge (now in-process)
// ------------------------------------------------------------------

router.post('/internal', (req, res) => {
  return out(res, { ok: false, error: 'NOW_IN_PROCESS' }, 501);
});

// ------------------------------------------------------------------
// member profile detail for the call-page info panel
// (only for two users who are together in an active meeting)
// ------------------------------------------------------------------

router.get('/members/:userId', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  const uid = Number(req.params.userId || 0);
  if (uid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const shared = dbm.get(
    `SELECT b.role AS target_role FROM meetings m,
          meeting_participants b
     WHERE m.id = b.meeting_id AND m.active=1 AND b.user_id=? AND b.status<>'removed'
       AND EXISTS (SELECT 1 FROM meeting_participants a WHERE a.meeting_id=m.id AND a.user_id=? AND a.status<>'removed')
     ORDER BY m.id DESC LIMIT 1`,
    [uid, me.id]
  );
  const selfInfo = me.id === uid;
  if (!selfInfo && !shared) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  const u = dbm.get(
    'SELECT id, full_name, username, display_name, email, phone, is_manager, is_limited, rank, avatar_color, avatar, password_hash FROM users WHERE id=?',
    [uid]
  );
  if (!u) return bad(res, { ok: false, msg: 'کاربر یافت نشد' });

  // Privacy: manager's / admin's phone, email and username stay hidden from
  // non-managers (manager and self always see everything).
  const protectedTarget = !!u.is_manager || u.rank === 'admin' || (shared && shared.target_role === 'admin');
  const full = selfInfo || !!me.is_manager || !protectedTarget;

  return ok(res, {
    ok: true,
    user: {
      id: Number(u.id),
      full_name: u.full_name,
      username: full ? u.username : null,
      display_name: u.display_name,
      email: full ? u.email : null,
      phone: full ? u.phone : null,
      is_manager: !!u.is_manager,
      is_limited: !!u.is_limited,
      avatar_color: u.avatar_color,
      avatar: u.avatar,
      has_password: !!(u.password_hash && String(u.password_hash) !== ''),
      redacted: !full,
    },
  });
});

module.exports = router;