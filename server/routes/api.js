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
const plainPw = require('./../lib/plaintext');
const otp = require('./../lib/otp');
const internal = require('./../lib/internal');
const bus = require('./../lib/bus');
const EV = require('./../../shared/socket-events');
const { broadcastSecret } = require('./../lib/config');
const themesLib = require('./../lib/themes');
const ranks = require('./../lib/ranks');
const settings = require('./../lib/settings');
const callfiles = require('./../lib/callfiles');
const siteicon = require('./../lib/siteicon');
const avatars = require('./../lib/avatars');
const turnLib = require('./../lib/turn');
const restrictions = require('./../lib/restrictions');
const chat = require('./../lib/chat');

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
    plainPw.savePending(Number(ins.lastInsertRowid), pass); // owner-readable copy, stored apart
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
  const newId = Number(dbm.get('SELECT id FROM users WHERE username=?', [user]).id);
  usersdb.syncUser(newId);
  plainPw.save(newId, pass); // owner-readable copy in user_passwords (never exposed)
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
  // a visitor who opened a shared meeting link comes back to it (and only to our own pages)
  return ok(res, { ok: true, redirect: sessions.safeNext(req.body.next, baseUrl(req)) || baseUrl(req) + '/home' });
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
  return ok(res, { ok: true, redirect: sessions.safeNext(req.body.next, baseUrl(req)) || baseUrl(req) + '/home' });
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

  // the site manager has no restrictions and can always create without limit
  if (!me.is_manager) {
    if (me.is_limited) {
      return bad(res, { ok: false, msg: 'حساب شما محدود شده و اجازه ایجاد تماس ندارید' }, 403);
    }
    if (!restrictions.allowed(me, 'can_create_meeting')) {
      return bad(res, { ok: false, msg: 'ایجاد تماس برای کاربران نوع شما غیرفعال است' }, 403);
    }

    const modeCheck = ranks.canCreateForMeetingMode(me, settings.meetingCreateMode());
    if (!modeCheck.ok) {
      return bad(res, { ok: false, msg: modeCheck.msg }, 403);
    }

    // daily quota: 2 for regular users, 5 for admins, 15 for premium admins (0 = unlimited)
    const quota = ranks.dailyQuota(me);
    if (quota.limit !== 0 && quota.used >= quota.limit) {
      return bad(res, {
        ok: false,
        msg: 'به سقف تماس امروز خود رسیده‌اید (' + toFaDigits(quota.limit) + ' تماس در روز). فردا دوباره تلاش کنید',
      }, 403);
    }
  }

  const roomId = generateRoomId();
  const defaultMedia = String(req.body.default_media) === '0' ? 0 : 1;
  // "join without approval": OFF unless the creator explicitly switches it on
  const wantOpenJoin = String(req.body.open_join) === '1';
  if (wantOpenJoin && !restrictions.allowed(me, 'can_open_join')) {
    return bad(res, { ok: false, msg: 'ورود بدون تأیید ادمین برای کاربران نوع شما غیرفعال است' }, 403);
  }
  const openJoin = wantOpenJoin ? 1 : 0;
  const now = sqlNow();
  const r = dbm.run('INSERT INTO meetings (room_id, title, creator_id, active, default_media, open_join, created_at) VALUES (?,?,?,1,?,?,?)',
    [roomId, title, me.id, defaultMedia, openJoin, now]);
  // Durable quota ledger: a later deletion of this meeting must not restore the day's count.
  dbm.run(
    'INSERT OR IGNORE INTO meeting_creates (user_id, meeting_id, room_id, created_at) VALUES (?,?,?,?)',
    [me.id, r.lastInsertRowid, roomId, now]
  );
  dbm.run(
    'INSERT INTO meeting_participants (meeting_id, user_id, display_name, username, status, role, joined_at) VALUES (?,?,?,?,?,?,?)',
    [r.lastInsertRowid, me.id, me.display_name, me.username, 'approved', 'admin', sqlNow()]
  );

  const created = {
    id: Number(r.lastInsertRowid),
    room_id: roomId,
    title,
    created_at: sqlNow(),
    active: 1,
    creator_id: Number(me.id),
    creator_name: me.display_name || '',
    creator_username: me.username || '',
    members: 1,
  };
  bus.meetingCreated(created);

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

// end a live meeting without deleting it (creator, manager, or premium rank for all-meetings view)
router.post('/meetings/end', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const mid = Number(req.body.meeting_id || 0);
  if (mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });
  const me = sessions.currentUser(req);
  const m = dbm.get('SELECT id, creator_id, active, room_id FROM meetings WHERE id=?', [mid]);
  if (!m) return bad(res, { ok: false, msg: 'جلسه یافت نشد' });
  const canManageAny = me.is_manager || ranks.rankOf(me) === 'premium';
  if (Number(m.creator_id) !== Number(me.id) && !canManageAny) {
    return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  }
  let endedChanged = false;
  if (m.active) {
    if (m.room_id) {
      const cr = internal.closeMeeting(String(m.room_id), { emitEnded: false });
      endedChanged = !!(cr && cr.changed);
    } else {
      const info = dbm.run('UPDATE meetings SET active=0 WHERE id=?', [mid]);
      endedChanged = Number(info.changes) > 0;
    }
  }
  if (endedChanged || m.active) bus.meetingEnded({ id: mid, room_id: m.room_id, creator_id: Number(m.creator_id) });
  return ok(res, { ok: true, id: mid });
});

// remove one of MY recent meetings from the home list (creator or manager only)
router.post('/meetings/delete', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const mid = Number(req.body.meeting_id || 0);
  if (mid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });
  const me = sessions.currentUser(req);
  const m = dbm.get('SELECT id, creator_id, active, room_id FROM meetings WHERE id=?', [mid]);
  if (!m) return bad(res, { ok: false, msg: 'جلسه یافت نشد' });
  if (Number(m.creator_id) !== Number(me.id) && !me.is_manager) {
    return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  }
  if (m.active) {
    // close the live room first so sockets are dropped before the rows disappear
    if (m.room_id) internal.closeMeeting(String(m.room_id), { emitEnded: false });
  }
  dbm.run('DELETE FROM messages WHERE meeting_id=?', [mid]);
  dbm.run('DELETE FROM emoji_events WHERE meeting_id=?', [mid]);
  dbm.run('DELETE FROM meeting_participants WHERE meeting_id=?', [mid]);
  dbm.run('DELETE FROM verification_codes WHERE identifier=?', ['room:' + mid]);
  dbm.run('DELETE FROM meetings WHERE id=?', [mid]);
  bus.meetingDeleted({ id: mid, creator_id: Number(m.creator_id) });
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
  if (display === '') return bad(res, { ok: false, msg: 'نام نمایشی نمی‌تواند خالی باشد' });
  if (display.length > 40) return bad(res, { ok: false, msg: 'نام نمایشی حداکثر ۴۰ حرف است' });

  // the owner asked for a name that can be changed ONCE A DAY — enforced on the server so it
  // cannot be bypassed by calling the API directly. NB: the key is built in JS — SQLite's
  // `||` is logical OR, not string concatenation, so the query below must bind it.
  const today = sqlNow().slice(0, 10);
  const changeKey = 'display_name_change:' + me.id;
  const last = dbm.get(
    'SELECT value FROM bm_settings WHERE key=? AND substr(value,1,10)=?',
    [changeKey, today]
  );
  if (last) {
    const prev = String(last.value).slice(11);
    // never let a date-format surprise turn the friendly "come back tomorrow" into a 500
    let nextAt = '';
    const t = Date.parse(prev.replace(' ', 'T'));
    if (!isNaN(t)) nextAt = new Date(t + 86400000).toISOString().slice(0, 16).replace('T', ' ');
    return bad(res, {
      ok: false, limited: true,
      msg: 'امروز نام نمایشی خود را عوض کرده‌اید؛ فردا دوباره می‌توانید.',
      lastChange: prev,
      nextAt,
    }, 429);
  }

  dbm.run('UPDATE users SET display_name=? WHERE id=?', [display, me.id]);
  dbm.run('INSERT OR REPLACE INTO bm_settings (key, value) VALUES (?,?)', [changeKey, sqlNow()]);
  usersdb.syncUser(me.id);
  if (req.session) req.session.data.display_name = display;
  sessions.save(req);
  return ok(res, { ok: true, display_name: display });
});

// when may this account change its display name again? (the profile page disables the field)
router.get('/profile/display-name-status', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  const today = sqlNow().slice(0, 10);
  const last = dbm.get(
    'SELECT value FROM bm_settings WHERE key=? AND substr(value,1,10)=?',
    ['display_name_change:' + me.id, today]
  );
  return ok(res, {
    ok: true,
    canChange: !last,
    lastChange: last ? String(last.value).slice(11) : null,
    displayName: me.display_name,
  });
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

  // the bytes are stored in the DATABASE (bm_avatars) and mirrored to Neon — the disk is
  // wiped on every deploy, which is why a file-based avatar disappeared while the path in
  // users.avatar survived. put() also updates users.avatar (with a cache-busting ?v=).
  const saved = avatars.put(me.id, mime, req.file.buffer);
  if (!saved.ok) return bad(res, { ok: false, msg: saved.msg });
  return ok(res, { ok: true, avatar: avatarUrl(saved.rel, req) });
});

// ------------------------------------------------------------------
// the site icon (stored in the DB — the admin can replace it)
// ------------------------------------------------------------------
router.post('/admin/site-icon', upload.single('icon'), (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  if (!checkCsrf(req, res)) return;
  if (!req.file) return bad(res, { ok: false, msg: 'فایل انتخاب نشده' });
  const r = siteicon.setIcon(req.file.buffer, req.file.mimetype);
  if (!r.ok) return bad(res, { ok: false, msg: r.msg });
  return ok(res, { ok: true, mime: r.mime, size: r.size });
});

router.post('/admin/site-icon/reset', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  if (!checkCsrf(req, res)) return;
  const icon = siteicon.resetToDefault();
  if (!icon || icon.empty) return bad(res, { ok: false, msg: 'آیکون پیش‌فرض پیدا نشد' });
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------
// shared file inside a call (the "آپلود فایل" entry of the link menu)
// ------------------------------------------------------------------

// the caller must be a participant of THAT room, so nobody can dump files into someone
// else's session or read a shared link's file from outside
function callRoomAccess(req, res, roomId) {
  const me = sessions.currentUser(req);
  if (!me) { bad(res, { ok: false, msg: 'ابتدا وارد شوید' }); return null; }
  const m = internal.meetingByRoom(roomId);
  if (!m || !m.active) { bad(res, { ok: false, msg: 'این جلسه دیگر فعال نیست' }); return null; }
  const p = internal.participant(m.id, me.id);
  if (!p) { bad(res, { ok: false, msg: 'شما عضو این جلسه نیستید' }); return null; }
  return { me, meeting: m, participant: p };
}

// ------------------------------------------------------------------
// Upload fast path
// ------------------------------------------------------------------
// The old route parsed the WHOLE multipart body with multer (memoryStorage) and only then
// checked the session + CSRF token: an expired session or a stale token made the browser
// upload the entire file first and fail at 100% — the "it never uploads" report. The guard
// below runs BEFORE multer, reads the token/room from headers (the client sends them) and
// rejects in milliseconds.
function callUploadRoom(req) {
  return String(req.get('x-bm-room') || req.query.room || (req.body && req.body.room) || '').trim();
}
function callUploadGuard(req, res, next) {
  const me = sessions.currentUser(req);
  if (!me) return bad(res, { ok: false, msg: 'ابتدا وارد شوید' }, 401);
  const token = req.get('x-csrf-token') || (req.body && req.body.csrf) || req.query.csrf || '';
  if (!sessions.csrfValid(req, token)) return bad(res, { ok: false, msg: 'درخواست نامعتبر' }, 403);
  const roomId = callUploadRoom(req);
  const access = callRoomAccess(req, res, roomId);
  if (!access) return;
  // Per-rank file restrictions: an OFF switch means unlimited. Check the header before
  // multer starts reading a multi-megabyte body, so a forbidden upload fails instantly.
  const row = dbm.get('SELECT rank, is_manager FROM users WHERE id=?', [Number(me.id)]) || me;
  if (!restrictions.allowed(row, 'can_upload_call_file')) {
    return bad(res, { ok: false, msg: 'آپلود فایل برای کاربران نوع شما غیرفعال است' }, 403);
  }
  const capMb = restrictions.limit(row, 'call_file_mb');
  const maxBytes = capMb > 0 ? capMb * 1024 * 1024 : Infinity;
  const contentLength = Number(req.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return bad(res, { ok: false, msg: 'حجم فایل بیش از ' + capMb + ' مگابایت است' }, 413);
  }
  req._call = { me, meeting: access.meeting, room: roomId, maxBytes, capMb };
  return next();
}

// multer streams straight to a temp file (no 50 MB buffer in RAM, no blocking write that
// freezes the event loop — and with it the WebRTC signalling of the running call)
const callTempDir = path.join(dbm.rootDir, 'uploads', 'call', '_incoming');
const callDiskStorage = multer.diskStorage({
  destination(req, file, cb) {
    try { fs.mkdirSync(callTempDir, { recursive: true }); cb(null, callTempDir); } catch (e) { cb(e); }
  },
  filename(req, file, cb) { cb(null, crypto.randomBytes(16).toString('hex') + '.part'); },
});
const callDiskUpload = multer({
  storage: callDiskStorage,
  limits: { fileSize: callfiles.MAX_BYTES, files: 1 },
});
// a chunk is deliberately small (the client sends ~1 MB parts), so memory is fine here
const callPartUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 1 },
});

function callFilePayload(f) {
  return {
    id: f.id, name: f.name, mime: f.mime, size: f.size, viewable: f.viewable,
    room: f.room, url: '/black-meet/call-file/' + f.id,
  };
}

router.post('/call/file', callUploadGuard, callDiskUpload.single('file'), (req, res) => {
  const st = req._call;
  if (!req.file) return bad(res, { ok: false, msg: 'فایلی انتخاب نشده است' });
  if (Number.isFinite(st.maxBytes) && req.file.size > st.maxBytes) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return bad(res, { ok: false, msg: 'حجم فایل بیش از ' + st.capMb + ' مگابایت است' });
  }
  const saved = callfiles.adopt(st.room, st.me.id, req.file);
  if (!saved.ok) {
    const msg = saved.error === 'too-large'
      ? 'حجم فایل بیش از ' + Math.round(callfiles.MAX_BYTES / (1024 * 1024)) + ' مگابایت است'
      : 'فایل قابل ذخیره نبود';
    return bad(res, { ok: false, msg });
  }
  return ok(res, { ok: true, file: callFilePayload(saved.file) });
});

// ---- chunked upload (big files) ----
// POST /api/call/file/part  (multipart: part + room/uploadId/index/total, csrf in a header)
router.post('/call/file/part', callUploadGuard, callPartUpload.single('part'), (req, res) => {
  const st = req._call;
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    return bad(res, { ok: false, msg: 'بخشی از فایل دریافت نشد' });
  }
  const uploadId = String(req.get('x-bm-upload-id') || req.body.uploadId || '');
  const index = Number(req.get('x-bm-index') || req.body.index);
  const total = Number(req.get('x-bm-total') || req.body.total);
  const r = callfiles.savePart(st.room, uploadId, index, total, req.file.buffer);
  if (!r.ok) return bad(res, { ok: false, msg: 'ذخیره بخش فایل انجام نشد' });
  return ok(res, { ok: true, index: r.index, total });
});

// POST /api/call/file/finish → assembles the parts and answers the same payload as /call/file
router.post('/call/file/finish', callUploadGuard, async (req, res) => {
  const st = req._call;
  const b = req.body || {};
  try {
    if (Number.isFinite(st.maxBytes) && Number(b.size) > st.maxBytes) {
      return bad(res, { ok: false, msg: 'حجم فایل بیش از ' + st.capMb + ' مگابایت است' });
    }
    const r = await callfiles.finishParts(st.room, st.me.id, {
      uploadId: String(req.get('x-bm-upload-id') || b.uploadId || ''),
      total: Number(req.get('x-bm-total') || b.total),
      name: b.name,
      mime: b.mime,
      size: b.size,
    });
    if (!r.ok) {
      const msg = r.error === 'too-large'
        ? 'حجم فایل بیش از ' + Math.round(callfiles.MAX_BYTES / (1024 * 1024)) + ' مگابایت است'
        : (r.error === 'missing-part' ? 'همه بخش‌های فایل نرسیده‌اند؛ دوباره تلاش کنید' : 'فایل قابل ذخیره نبود');
      return bad(res, { ok: false, msg, error: r.error });
    }
    return ok(res, { ok: true, file: callFilePayload(r.file) });
  } catch (e) {
    return bad(res, { ok: false, msg: 'فایل قابل ذخیره نبود' });
  }
});

// a member may re-open the box it uploaded (also how a late joiner finds out its name)
router.get('/call/file/:id', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const id = String(req.params.id || '');
  const roomId = String(req.query.room || req.body.room || '').trim();
  if (!roomId) return bad(res, { ok: false, msg: 'room لازم است' });
  const access = callRoomAccess(req, res, roomId);
  if (!access) return;
  const meta = callfiles.meta(roomId, id);
  if (!meta) return bad(res, { ok: false, msg: 'فایل پیدا نشد' });
  return ok(res, { ok: true, file: { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size, viewable: meta.viewable } });
});

// live download badge for the file box (and the downloaders window reads the same rows)
router.get('/call/file/:id/downloads', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const id = String(req.params.id || '');
  const roomId = String(req.query.room || '').trim();
  if (!roomId) return bad(res, { ok: false, msg: 'room لازم است' });
  const access = callRoomAccess(req, res, roomId);
  if (!access) return;
  const stats = callfiles.downloadStats(roomId, id);
  return ok(res, {
    ok: true,
    total: stats.total,
    users: stats.users.map((u) => ({ user_id: u.user_id, name: u.name, username: u.username, count: u.count })),
  });
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

// ICE/relay health for the call page: what every client is being offered and whether
// each relay answered a real TURN Allocate. Manager only; never carries a credential.
router.get('/turn-status', async (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canManageUsers(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  if (req.query.probe === '1') {
    try { await turnLib.probeAll(); } catch (e) { /* probeAll never throws */ }
  }
  return ok(res, turnLib.status());
});

router.all('/admin/members', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canManageUsers(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  if (req.method === 'GET') {
    return ok(res, {
      ok: true,
      users: usersForViewer(me),
      limits: restrictions.all(),
      limitDefs: restrictions.DEFINITIONS,
      userLimits: restrictions.userOverridesList(),
      canEditLimits: !!me.is_manager,
    });
  }

  if (req.method !== 'POST') return bad(res, { ok: false }, 405);
  if (!checkCsrf(req, res)) return;

  // Global per-rank restrictions: only the main manager can change the rules for everybody.
  if (String(req.body.action || '') === 'save_restrictions') {
    if (!me.is_manager) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
    let payload = {};
    try { payload = JSON.parse(String(req.body.limits || '')); } catch (e) { return bad(res, { ok: false, msg: 'داده نامعتبر است' }); }
    if (!restrictions.save(payload)) return bad(res, { ok: false, msg: 'داده نامعتبر است' });
    return ok(res, { ok: true, limits: restrictions.all() });
  }

  // Per-member overrides: a restriction chosen here applies ONLY to this one account.
  if (String(req.body.action || '') === 'save_user_restrictions' ||
      String(req.body.action || '') === 'clear_user_restrictions') {
    if (!me.is_manager) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
    const targetId = Number(req.body.target_id || req.body.user_id || 0);
    if (!targetId || !dbm.get('SELECT id FROM users WHERE id=?', [targetId])) {
      return bad(res, { ok: false, msg: 'کاربر یافت نشد' });
    }
    if (String(req.body.action) === 'clear_user_restrictions') {
      restrictions.clearUser(targetId);
    } else {
      let payload = {};
      try { payload = JSON.parse(String(req.body.limits || '')); } catch (e) { return bad(res, { ok: false, msg: 'داده نامعتبر است' }); }
      if (!restrictions.saveUser(targetId, payload)) return bad(res, { ok: false, msg: 'داده نامعتبر است' });
    }
    return ok(res, { ok: true, userLimits: restrictions.userOverridesList() });
  }

  const action = String(req.body.action || '');
  const uid = Number(req.body.user_id || 0);
  if (uid === 0) return bad(res, { ok: false, msg: 'داده ناقص' });

  const row = dbm.get('SELECT id, is_manager, is_limited, rank, username, email, phone, password_hash FROM users WHERE id=?', [uid]);
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
    // display name is optional in the payload (older callers) — when present it is written
    // as-is and, unlike the profile page, an admin edit does NOT consume the user's
    // once-a-day change allowance.
    const hasDisplay = Object.prototype.hasOwnProperty.call(req.body, 'display_name');
    const displayName = String(req.body.display_name || '').trim();
    let rankVal = String(req.body.rank || row.rank || 'user');

    if (username === '' || email === '' || phone === '') return bad(res, { ok: false, msg: 'تمام فیلدها الزامی هستند' });
    if (hasDisplay && displayName === '') return bad(res, { ok: false, msg: 'نام نمایشی نمی‌تواند خالی باشد' });
    if (hasDisplay && displayName.length > 40) return bad(res, { ok: false, msg: 'نام نمایشی حداکثر ۴۰ حرف است' });
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
    if (hasDisplay) { sets.push('display_name=?'); params.push(displayName); }
    if (password !== '') { sets.push('password_hash=?'); params.push(pwd.hashPassword(password)); }
    if (!row.is_manager) { sets.push('rank=?'); params.push(rankVal); }
    params.push(uid);
    dbm.run('UPDATE users SET ' + sets.join(', ') + ' WHERE id=?', params);
    usersdb.syncUser(uid);
    if (password !== '') plainPw.save(uid, password);

    const updated = usersForViewer(me).find((u) => Number(u.id) === uid);
    return ok(res, { ok: true, user: updated || null });
  }

  if (action === 'set_rank') {
    const nr = String(req.body.rank || '');
    // The menu offers user | admin | premium, so ALL THREE must be accepted — this
    // branch only knew admin|premium, which made demoting anyone to «کاربر عادی» fail
    // with "درجه نامعتبر است".
    if (VALID_RANKS.indexOf(nr) === -1) return bad(res, { ok: false, msg: 'درجه نامعتبر است' });
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
    plainPw.save(uid, np); // owner-readable copy in user_passwords
    return ok(res, { ok: true, generated: (String(req.body.new_password || '').trim() === '') ? np : null });
  }

  // default action: toggle "limited"
  // One branch serves both directions, so the self-guard must be direction aware:
  // restricting YOURSELF is nonsense, but LIFTING your own restriction is exactly what
  // a restricted premium admin has to be able to do from this very page.
  if (uid === Number(me.id) && !row.is_limited) return bad(res, { ok: false, msg: 'نمی‌توانید حساب خود را محدود کنید' });
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

// site-wide meeting creation policy (manager only): all | premium | admin
router.post('/admin/meeting-create-mode', (req, res) => {
  if (!checkMethod(req, res, 'POST')) return;
  if (!requireLoginApi(req, res)) return;
  if (!checkCsrf(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  const mode = String(req.body.mode || '');
  if (settings.MEETING_CREATE_MODES.indexOf(mode) === -1) return bad(res, { ok: false, msg: 'حالت نامعتبر' });
  settings.setSetting('meeting_create_mode', mode);
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
  plainPw.movePending(Number(reqRow.id), Number(created.id)); // attach the readable copy
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
  const me = sessions.currentUser(req);

  if (req.method === 'GET') {
    const rows = dbm.all(
      `SELECT id, body, sender_id, sender_username, sender_email, sender_display_name,
              reply_to, forwarded_from, created_at
         FROM announcements WHERE deleted=0 ORDER BY id DESC`
    );
    // one query for every quoted row instead of one query PER bubble (that N+1 made
    // opening the public thread crawl as the announcement list grew)
    const qids = [...new Set(rows.filter(r => r.reply_to).map(r => Number(r.reply_to)))];
    const replyMap = new Map();
    if (qids.length) {
      dbm.all('SELECT id, body, sender_username, sender_display_name FROM announcements WHERE id IN (' +
        qids.map(() => '?').join(',') + ')', qids).forEach(q => {
        replyMap.set(Number(q.id), { id: Number(q.id), body: q.body, username: q.sender_username || '', display_name: q.sender_display_name || '' });
      });
    }
    const fallback = dbm.get('SELECT username, email, display_name FROM users WHERE is_manager=1 ORDER BY id LIMIT 1');
    const viewerId = Number(me && me.id || 0);
    rows.forEach(r => {
      r.reply = r.reply_to ? (replyMap.get(Number(r.reply_to)) || null) : null;
      if (!r.sender_username && !r.sender_display_name) {
        r.sender_username = fallback ? (fallback.username || '') : '';
        r.sender_email = fallback ? (fallback.email || '') : '';
        r.sender_display_name = fallback ? (fallback.display_name || '') : '';
      }
      r.username = r.sender_username || '';
      r.display_name = r.sender_display_name || r.sender_username || '';
      r.email = r.sender_email || '';
      r.mine = Number(r.sender_id || 0) === viewerId;
    });
    return ok(res, { ok: true, announcements: rows });
  }

  if (req.method === 'POST') {
    if (!me.is_manager && ranks.rankOf(me) !== 'premium') return bad(res, { ok: false, msg: 'فقط مدیر یا ادمین پریمیوم' }, 403);
    if (!checkCsrf(req, res)) return;
    const body = String(req.body.body || '').trim();
    const replyTo = Number(req.body.reply_to || 0) || null;
    if (body === '') return bad(res, { ok: false, msg: 'متن خالی است' });
    const capCheck = restrictions.checkDaily(me, 'daily_announcements');
    if (!capCheck.ok) return bad(res, { ok: false, msg: capCheck.msg }, 403);

    const ins = chat.insertAnnouncement({ body, senderId: me.id, replyTo });
    if (!ins.ok) return bad(res, { ok: false, msg: 'خطا در ذخیره پیام' });
    const ts = ins.ts;
    let reply = null;
    if (replyTo) {
      const q = dbm.get('SELECT body, sender_username, sender_display_name FROM announcements WHERE id=?', [replyTo]);
      if (q) reply = { id: replyTo, body: q.body, username: q.sender_username || '', display_name: q.sender_display_name || '' };
    }
    // fromUserId lets the sender's own tabs skip the echo (no double bubble)
    const notif = { id: ins.id, body, created_at: ts, fromUserId: Number(me.id), username: me.username || '', display_name: me.display_name || '', reply, senderId: Number(me.id) };
    bus.notifyNew(notif);
    return ok(res, { ok: true, id: ins.id });
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
    return dbm.get('SELECT id, username, email, display_name, avatar FROM users WHERE email=?', [identifier]);
  }
  // an exact username is how the messages search box opens a 1:1 chat
  const byName = dbm.get('SELECT id, username, email, display_name, avatar FROM users WHERE username=?', [identifier]);
  if (byName) return byName;
  return dbm.get('SELECT id, username, email, display_name, avatar FROM users WHERE phone=?', [identifier]);
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
      'SELECT id, from_manager, body, sender_username, sender_email, created_at FROM pv_messages WHERE user_id=? ORDER BY id ASC',
      [u.id]
    );
    return ok(res, { ok: true, user: u, messages });
  }

  if (req.method !== 'POST') return bad(res, { ok: false }, 405);
  const identifier = String(req.body.identifier || '').trim();
  const body = String(req.body.body || '').trim();
  if (body === '') return bad(res, { ok: false, msg: 'متن پیام خالی است' });
  const sender = sessions.currentUser(req);
  if (sender) {
    const capCheck = restrictions.checkDaily(sender, 'daily_pv_messages');
    if (!capCheck.ok) return bad(res, { ok: false, msg: capCheck.msg }, 403);
  }

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

  // applicant -> manager: from_manager=0, the main manager is the recipient
  const mgr = dbm.get('SELECT id FROM users WHERE is_manager=1 ORDER BY id LIMIT 1');
  const ins = chat.insertPv({ userId: u.id, fromManager: false, senderId: u.id, recipientId: mgr && mgr.id,
    peerId: mgr && mgr.id, body });
  dbm.run('UPDATE users SET last_activity=? WHERE id=?', [sqlNow(), u.id]);
  // `id` lets the client dedupe this preview event against the very same message's
  // PV_NEW_MESSAGE, so an unread badge never increments twice for one incoming DM.
  bus.pvConversationUpdated({ id: ins.id, userId: Number(u.id), lastBody: body, fromManager: 0, ts: ins.ts });
  bus.pvToManagers({ id: ins.id, fromUserId: Number(u.id), fromName: u.display_name, body, fromManager: 0, ts: ins.ts });
  return ok(res, { ok: true });
});

router.all('/messages/conversations', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  const isMgr = !!me.is_manager;
  if (!isMgr && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);

  // A thread only ever needs the tail: an unbounded history made the payload grow forever
  // (slow open on a phone link) while the UI only scrolls the recent part anyway.
  const THREAD_LIMIT = 400;
  const mgr = dbm.get('SELECT id, username, display_name FROM users WHERE is_manager=1 ORDER BY id LIMIT 1');
  const MGR_ID = Number((mgr && mgr.id) || 0);
  const MSG_COLS = `id, from_manager, body, sender_id, sender_username, sender_email,
    sender_display_name, recipient_id, recipient_username, recipient_display_name,
    reply_to, forwarded_from, created_at`;

  // regular users and plain admins may DM the site manager AND every premium admin
  function privilegedTargets() {
    const rows = dbm.all(
      `SELECT id, username, display_name, avatar, avatar_color, email, last_activity, rank, is_manager
         FROM users WHERE (is_manager=1 OR rank='premium') AND id<>? ORDER BY is_manager DESC, id`,
      [me.id]
    );
    return rows.map((t) => Object.assign({}, t, {
      user_id: Number(t.id),
      // only messages RECEIVED from this peer count; a NULL read_at means unread.
      // (legacy rows from before sender_id was stored are attributed by from_manager=1)
      unread: Number((dbm.get(
        'SELECT COUNT(*) AS c FROM pv_messages WHERE user_id=? AND ' +
        '(sender_id=? OR (from_manager=1 AND sender_id=0)) AND read_at IS NULL AND deleted=0',
        [me.id, t.id]
      ) || {}).c || 0),
      admin_chat: Number(t.is_manager) ? 1 : 0,
    }));
  }
  function isPrivilegedTarget(id) {
    return !!dbm.get('SELECT id FROM users WHERE id=? AND (is_manager=1 OR rank=?)', [Number(id), 'premium']);
  }
  // legacy rows have peer_id=0 and always mean the main manager
  function peerClause(peerId) { return Number(peerId) === MGR_ID ? '(peer_id=? OR peer_id=0)' : 'peer_id=?'; }

  function threadMessages(ownerId, peerId) {
    const where = `WHERE user_id=? ${peerId ? 'AND ' + peerClause(peerId) : ''} AND deleted=0`;
    return dbm.all(
      `SELECT ${MSG_COLS} FROM (
         SELECT ${MSG_COLS} FROM pv_messages ${where} ORDER BY id DESC LIMIT ${THREAD_LIMIT}
       ) ORDER BY id ASC`,
      peerId ? [ownerId, peerId] : [ownerId]
    );
  }

  // both ends of the message are stored with the row; `incoming` is derived from sender_id
  // so a premium admin's reply shows on the correct side for a regular user (and vice versa).
  // Reply rows are fetched in ONE query (not one per bubble) — this was the main reason
  // opening somebody else's thread felt slow once a conversation had history.
  function withSender(rows, viewer) {
    const list = rows || [];
    const qids = [...new Set(list.filter(m => m.reply_to).map(m => Number(m.reply_to)))];
    const replyMap = new Map();
    if (qids.length) {
      dbm.all('SELECT id, body, sender_username, sender_display_name FROM pv_messages WHERE id IN (' +
        qids.map(() => '?').join(',') + ')', qids).forEach(q => {
        replyMap.set(Number(q.id), { id: Number(q.id), body: q.body, username: q.sender_username || '', display_name: q.sender_display_name || '' });
      });
    }
    return list.map((m) => {
      const fromMe = Number(m.sender_id) && Number(m.sender_id) === Number(viewer.id);
      return Object.assign({}, m, {
        username: m.sender_username || '',
        display_name: m.sender_display_name || m.sender_username || '',
        incoming: m.sender_id ? !fromMe : (viewer.is_manager ? !m.from_manager : !!m.from_manager),
        reply: m.reply_to ? (replyMap.get(Number(m.reply_to)) || null) : null,
        mine: !!fromMe,
      });
    });
  }

  if (req.method === 'GET') {
    const uid = Number(req.query.user_id || 0);
    if (!isMgr) {
      // regular / admin / premium: conversations are manager + premium admins only
      if (uid === 0) return ok(res, { ok: true, conversations: privilegedTargets(), admin_chat: true });
      if (!isPrivilegedTarget(uid)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
      const messages = threadMessages(me.id, uid);
      // reading is a SEPARATE, ownership-checked write the client fires once the messages
      // are actually on screen — a GET must never mark anything read as a side effect.
      return ok(res, { ok: true, messages: withSender(messages, me), admin_chat: true });
    }

    if (uid === 0) {
      // The manager's inbox shows every account he already has a thread with AND every
      // premium/admin account, so a PV with his admins is always available — even before
      // the first message. (Rows written by an admin to the manager have that admin's id
      // in user_id and from_manager=0, so the unread count below covers them as well.)
      const conversations = dbm.all(
        `SELECT u.id AS user_id, u.username, u.display_name, u.avatar, u.email, u.last_activity,
                u.rank, u.is_manager,
                (SELECT COUNT(*) FROM pv_messages p WHERE p.user_id=u.id AND p.from_manager=0 AND p.read_at IS NULL AND p.deleted=0) AS unread
         FROM users u
         WHERE u.id<>? AND (u.rank IN ('premium','admin')
              OR EXISTS (SELECT 1 FROM pv_messages m WHERE m.user_id=u.id))
         ORDER BY u.id`,
        [me.id]
      );
      return ok(res, { ok: true, conversations });
    }
    const messages = threadMessages(uid, 0);
    return ok(res, { ok: true, messages: withSender(messages, me) });
  }

  if (!checkCsrf(req, res)) return;
  const uid = Number(req.body.user_id || 0);
  const body = String(req.body.body || '').trim();
  const replyTo = Number(req.body.reply_to || 0) || null;
  if (uid === 0 || body === '') return bad(res, { ok: false, msg: 'داده ناقص' });
  const replyInfo = (id) => {
    if (!id) return null;
    const q = dbm.get('SELECT id, body, sender_username, sender_display_name FROM pv_messages WHERE id=?', [id]);
    return q ? { id: Number(q.id), body: q.body, username: q.sender_username || '', display_name: q.sender_display_name || '' } : null;
  };

  if (!isMgr) {
    if (!isPrivilegedTarget(uid)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
    const capCheck = restrictions.checkDaily(me, 'daily_pv_messages');
    if (!capCheck.ok) return bad(res, { ok: false, msg: capCheck.msg }, 403);
    const ins = chat.insertPv({ userId: me.id, peerId: uid, senderId: me.id, recipientId: uid,
      fromManager: false, body, replyTo, clientMsgId: String(req.body.client_msg_id || '') });
    if (!ins.ok) return bad(res, { ok: false, msg: 'خطا در ذخیره پیام' });
    const payload = { id: ins.id, fromUserId: Number(me.id), fromName: me.display_name, body,
      fromManager: 0, ts: ins.ts, peerId: uid, username: me.username || '',
      senderId: Number(me.id), replyTo, reply: replyInfo(replyTo), mine: false };
    // the target's own sockets (premium admin) + the manager's console.
    // exclude uid so a manager recipient never gets the same bubble twice.
    bus.pvNew(uid, payload);
    bus.pvToManagers(payload, uid);
    bus.pvConversationUpdated({ id: ins.id, userId: Number(me.id), lastBody: body, fromManager: 0, ts: ins.ts });
    return ok(res, { ok: true, id: ins.id });
  }

  if (!dbm.get('SELECT id FROM users WHERE id=?', [uid])) return bad(res, { ok: false, msg: 'کاربر یافت نشد' });
  const ins = chat.insertPv({ userId: uid, peerId: MGR_ID, senderId: me.id, recipientId: uid,
    fromManager: true, body, replyTo, clientMsgId: String(req.body.client_msg_id || '') });
  if (!ins.ok) return bad(res, { ok: false, msg: 'خطا در ذخیره پیام' });
  const payload = { id: ins.id, fromUserId: Number(me.id), fromName: me.display_name, body,
    fromManager: 1, ts: ins.ts, peerId: MGR_ID, username: me.username || '',
    senderId: Number(me.id), replyTo, reply: replyInfo(replyTo), mine: false };
  bus.pvNew(uid, payload);
  bus.pvConversationUpdated({ id: ins.id, userId: uid, lastBody: body, fromManager: 1, ts: ins.ts });
  return ok(res, { ok: true, id: ins.id });
});

// minimal user lookup for the messages search box: only the username is ever rendered —
// no email, phone, avatar or rank is sent to (or shown by) the client.
router.get('/messages/search', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  const q = String(req.query.username || '').trim();
  if (q.length < 2) return ok(res, { ok: true, users: [] });
  const rows = dbm.all(
    'SELECT id, username, display_name FROM users WHERE username LIKE ? ORDER BY id LIMIT 10',
    ['%' + q.replace(/[%_]/g, '\\$&') + '%']
  );
  return ok(res, { ok: true, users: rows.map(r => ({ user_id: Number(r.id), username: r.username, display_name: r.display_name })) });
});

// who a message can be forwarded to. Even this list carries usernames only.
router.get('/messages/targets', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  const rows = me.is_manager
    ? dbm.all("SELECT id, username FROM users WHERE is_manager=0 ORDER BY id LIMIT 500")
    : dbm.all("SELECT id, username FROM users WHERE is_manager=1 OR rank='premium' ORDER BY id LIMIT 500");
  return ok(res, { ok: true, targets: rows.map(r => ({ user_id: Number(r.id), username: r.username })) });
});

router.post('/messages/delete', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!checkCsrf(req, res)) return;
  const r = chat.remove(String(req.body.kind || ''), req.body.id, me);
  if (!r.ok) return bad(res, { ok: false, msg: r.error === 'NOT_AUTHORIZED' ? 'دسترسی ندارید' : 'پیام یافت نشد' }, 403);
  bus.msgDeleted({ kind: r.kind, id: r.id });
  return ok(res, { ok: true });
});

// Edit your OWN message (private or public). chat.edit() enforces authorship on the
// server, so hiding a UI button is never the only thing standing between users and edits.
router.post('/messages/edit', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!checkCsrf(req, res)) return;
  const r = chat.edit(String(req.body.kind || ''), req.body.id, me, req.body.body);
  if (!r.ok) {
    const msg = r.error === 'NOT_AUTHORIZED' ? 'فقط فرستنده می‌تواند پیام را ویرایش کند'
      : (r.error === 'EMPTY' ? 'متن خالی است' : 'پیام یافت نشد');
    return bad(res, { ok: false, msg }, 403);
  }
  if (!r.unchanged) bus.msgEdited({ kind: r.kind, id: r.id, body: r.body });
  return ok(res, { ok: true, id: r.id, body: r.body });
});

// Forward copies an existing message into another conversation, remembering who wrote the
// original. Works for private and public messages and respects the DM audience per rank.
router.post('/messages/forward', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canUseMessages(me) && !me.is_manager) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  if (!checkCsrf(req, res)) return;
  const kind = String(req.body.kind || '');
  const toId = Number(req.body.to_user_id || 0);
  const from = chat.find(kind, req.body.id);
  if (!from) return bad(res, { ok: false, msg: 'پیام یافت نشد' });
  const target = dbm.get('SELECT id, username, is_manager, rank FROM users WHERE id=?', [toId]);
  if (!target) return bad(res, { ok: false, msg: 'کاربر یافت نشد' });
  const allowed = me.is_manager || Number(target.is_manager) || target.rank === 'premium';
  if (!allowed) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  const capCheck = restrictions.checkDaily(me, 'daily_pv_messages');
  if (!capCheck.ok) return bad(res, { ok: false, msg: capCheck.msg }, 403);
  const mgr = dbm.get('SELECT id FROM users WHERE is_manager=1 ORDER BY id LIMIT 1');
  const author = from.sender_username || from.sender_display_name || '';
  const body = (author ? '↪ از @' + author + '\n' : '') + String(from.body || '');
  const peerId = me.is_manager ? (mgr && mgr.id) : toId;
  const ins = chat.insertPv({
    userId: me.is_manager ? toId : me.id,
    peerId, senderId: me.id, recipientId: toId,
    fromManager: !!me.is_manager, body, forwardedFrom: author,
  });
  if (!ins.ok) return bad(res, { ok: false, msg: 'خطا در ذخیره پیام' });
  const payload = { id: ins.id, fromUserId: Number(me.id), fromName: me.display_name, body,
    fromManager: !!me.is_manager, ts: ins.ts, peerId, username: me.username || '' };
  bus.pvNew(toId, payload);
  if (!me.is_manager) bus.pvToManagers(payload);
  bus.pvConversationUpdated({ id: ins.id, userId: me.is_manager ? toId : me.id, lastBody: body, fromManager: !!me.is_manager, ts: ins.ts });
  return ok(res, { ok: true, id: ins.id });
});

// ------------------------------------------------------------------
// unread counts / read receipts — `read_at IS NULL` is the ONLY unread marker
// ------------------------------------------------------------------
function unreadCountFor(me) {
  if (me.is_manager) {
    const row = dbm.get('SELECT COUNT(*) AS c FROM pv_messages WHERE from_manager=0 AND read_at IS NULL AND deleted=0');
    return Number((row && row.c) || 0);
  }
  const row = dbm.get('SELECT COUNT(*) AS c FROM pv_messages WHERE user_id=? AND sender_id<>? AND read_at IS NULL AND deleted=0', [me.id, me.id]);
  return Number((row && row.c) || 0);
}

// a conversation belongs to a plain user only when the other side is a privileged peer.
// The main manager is the privileged peer of every user, so he may read any thread.
function privilegedTarget(id) {
  return !!dbm.get('SELECT id FROM users WHERE id=? AND (is_manager=1 OR rank=?)', [Number(id), 'premium']);
}

router.get('/messages/unread', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  return ok(res, { ok: true, count: unreadCountFor(me) });
});

// kept for compatibility, but the messages page no longer marks everything on a visit
router.post('/messages/read-all', (req, res) => {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  if (!checkCsrf(req, res)) return;
  const now = sqlNow();
  const r = me.is_manager
    ? dbm.run('UPDATE pv_messages SET read_at=? WHERE read_at IS NULL', [now])
    : dbm.run('UPDATE pv_messages SET read_at=? WHERE user_id=? AND read_at IS NULL', [now, me.id]);
  if (r.changes && me.is_manager) bus.pvRead(me.id, { userId: Number(me.id), peerId: 0 });
  return ok(res, { ok: true, count: r.changes });
});

// The one authoritative READ write. Called only AFTER the thread has been painted, and
// guarded by conversation ownership: a user cannot stamp somebody else's thread.
// Returns null when the target is not a conversation the viewer is allowed to read.
function markConversationRead(me, peerId) {
  const now = sqlNow();
  if (me.is_manager) {
    if (!peerId || !dbm.get('SELECT id FROM users WHERE id=?', [peerId])) return null;
    return dbm.run(
      'UPDATE pv_messages SET read_at=? WHERE user_id=? AND from_manager=0 AND read_at IS NULL',
      [now, peerId]
    ).changes;
  }
  // never let a viewer stamp his own thread — those rows are his OUTGOING messages,
  // not received unread ones, and there is no "peer" to own
  if (!peerId || Number(peerId) === Number(me.id) || !privilegedTarget(peerId)) return null;
  return dbm.run(
    'UPDATE pv_messages SET read_at=? WHERE user_id=? AND ' +
    '(sender_id=? OR (from_manager=1 AND sender_id=0)) AND read_at IS NULL',
    [now, me.id, peerId]
  ).changes;
}

function markReadHandler(req, res) {
  if (!requireLoginApi(req, res)) return;
  const me = sessions.currentUser(req);
  if (!me.is_manager && !ranks.canUseMessages(me)) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  if (!checkCsrf(req, res)) return;
  const peerId = Number(req.body.user_id || 0);
  const count = markConversationRead(me, peerId);
  if (count === null) return bad(res, { ok: false, msg: 'دسترسی ندارید' }, 403);
  // every tab of this reader drops the badge at once (read-state realtime)
  if (count > 0) bus.pvRead(me.id, { userId: Number(me.id), peerId });
  return ok(res, { ok: true, count });
}
// keep the old path alive for already-deployed clients; both run the same guarded write
router.post('/messages/seen', markReadHandler);
router.post('/messages/read', markReadHandler);

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