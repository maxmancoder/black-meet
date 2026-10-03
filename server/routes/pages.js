'use strict';
const express = require('express');
const dbm = require('./../lib/db');
const {
  baseUrl, publicUrl, assetUrl, avatarUrl, e, initials, timeAgo, turnConfig, makeSocketToken, sqlNowMinus,
} = require('./../lib/helpers');
const sessions = require('./../lib/sessions');
const themesLib = require('./../lib/themes');
const ranks = require('./../lib/ranks');
const settings = require('./../lib/settings');
const { toFaDigits } = require('./../lib/helpers');

function pageLocals(req, res, extra) {
  const base = baseUrl(req);
  const locals = {
    title: 'Black Meet',
    base,
    public: publicUrl(req),
    me: sessions.currentUser(req),
    csrf: sessions.csrfToken(req, res),
    asset(p) { return assetUrl(p, req); },
    url(p) { return base + '/' + p.replace(/^\/+/, ''); },
    // inline SVG icon from icons/sprite.svg — icon(name, cls, fill, extraAttrs)
    icon(name, cls, fill, extra) {
      const c = cls ? ' ' + String(cls).trim() : '';
      return `<svg class="bm-ico${c}"${extra ? ' ' + extra : ''} aria-hidden="true" focusable="false">` +
        `<use href="${assetUrl('icons/sprite.svg', req)}#ic-${name}${fill ? '-fill' : ''}"></use></svg>`;
    },
    esc: e,
    json(v) { return JSON.stringify(v); },
    initials,
    timeAgo,
    toFaDigits,
    avatarUrl(a) { return avatarUrl(a, req); },
  };
  if (extra) Object.assign(locals, extra);
  return locals;
}

function requireLogin(req, res) {
  return sessions.requireLogin(req, res, baseUrl(req));
}

function requireManager(req, res) {
  if (!requireLogin(req, res)) return false;
  const me = sessions.currentUser(req);
  if (!me.is_manager) {
    res.redirect(baseUrl(req) + '/home');
    return false;
  }
  return true;
}

// members page: manager + ادمین پریمیوم see "نمایش اعضا",
// manager + ادمین + ادمین پریمیوم see "درخواست ایجاد حساب"
function requireMembersAccess(req, res) {
  if (!requireLogin(req, res)) return false;
  const me = sessions.currentUser(req);
  if (!ranks.canViewMembers(me) && !ranks.canViewRequests(me)) {
    res.redirect(baseUrl(req) + '/home');
    return false;
  }
  return true;
}

const router = express.Router();

// active theme CSS: :root palette overrides from دیزاین بلک میت/<id>.css (cookie bm_theme)
router.get('/theme.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  return res.send(themesLib.readTheme(themesLib.currentTheme(req)));
});

router.get(['/', '/login'], (req, res) => {
  if (sessions.currentUser(req) !== null) {
    return res.redirect(baseUrl(req) + '/home');
  }
  res.render('index', pageLocals(req, res, { title: 'ورود / ثبت‌نام - Black Meet' }));
});

router.get('/home', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  const limited = !!me.is_limited;

  const recent = dbm.all(
    `SELECT m.id, m.room_id, m.title, m.created_at, m.active,
            (SELECT COUNT(*) FROM meeting_participants p WHERE p.meeting_id=m.id AND p.status<>'removed') AS members
     FROM meetings m WHERE m.creator_id=? ORDER BY m.created_at DESC LIMIT 6`,
    [me.id]
  );

  const quota = ranks.dailyQuota(me);

  res.render('home', pageLocals(req, res, {
    title: 'خانه - Black Meet',
    me,
    limited,
    recent,
    isManager: !!me.is_manager,
    rankLabel: ranks.rankLabel(me),
    canMembers: ranks.canViewMembers(me),
    canRequests: ranks.canViewRequests(me),
    canMessages: ranks.canUseMessages(me),
    quota,
    quotaText: quota.limit === 0 ? null : (toFaDigits(quota.used) + ' از ' + toFaDigits(quota.limit)),
    firstName: String(me.display_name || '').split(/\s+/)[0] || '',
    initials: initials(me.display_name),
  }));
});

router.get('/create', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  const quota = ranks.dailyQuota(me);
  const quotaFull = quota.limit !== 0 && quota.used >= quota.limit;
  res.render('create', pageLocals(req, res, {
    title: 'ایجاد تماس - Black Meet',
    limited: !!me.is_limited,
    quota,
    quotaFull,
    quotaText: quota.limit === 0 ? null : (toFaDigits(quota.used) + ' از ' + toFaDigits(quota.limit)),
  }));
});

router.get('/profile', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  res.render('profile', pageLocals(req, res, {
    title: 'پروفایل - Black Meet',
    av: avatarUrl(me.avatar, req),
    rankLabel: ranks.rankLabel(me),
    canMembers: ranks.canViewMembers(me),
    canRequests: ranks.canViewRequests(me),
    initials: initials(me.display_name),
  }));
});

router.get('/forgot-password', (req, res) => {
  res.render('forgot_password', pageLocals(req, res, { title: 'بازیابی رمز عبور - Black Meet' }));
});

router.get('/messages', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  if (!ranks.canUseMessages(me)) {
    res.redirect(baseUrl(req) + '/home');
    return;
  }
  res.render('messages', pageLocals(req, res, {
    title: 'پیام‌ها - Black Meet',
    isManager: !!me.is_manager,
  }));
});

router.get('/members', (req, res) => {
  if (!requireMembersAccess(req, res)) return;
  const me = sessions.currentUser(req);
  const canMembers = ranks.canViewMembers(me);
  const canRequests = ranks.canViewRequests(me);
  const canDecide = ranks.canDecideRequests(me);

  let users = [];
  if (canMembers) {
    users = dbm.all(
      'SELECT id, full_name, username, display_name, email, phone, is_manager, is_limited, rank, avatar_color, avatar, created_at, password_hash FROM users ORDER BY id'
    );
    if (!me.is_manager) {
      // the main manager's info is visible only to himself
      users = users.map((u) => (u.is_manager
        ? {
          id: u.id, display_name: u.display_name, avatar: u.avatar, avatar_color: u.avatar_color,
          is_manager: 1, is_limited: 0, rank: 'user', created_at: u.created_at, info_hidden: true,
        }
        : u));
    }
  }

  const requests = dbm.all(
    "SELECT * FROM signup_requests WHERE status='pending' OR decided_at >= ? ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END, id DESC",
    [sqlNowMinus(30)]
  ).map((r) => Object.assign({}, r, {
    messages: dbm.all(
      'SELECT id, body, from_manager, created_at FROM signup_request_messages WHERE request_id=? ORDER BY id ASC',
      [r.id]
    ),
  }));

  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  res.render('admin_members', pageLocals(req, res, {
    title: 'مدیریت اعضا - Black Meet',
    me,
    users,
    requests,
    pendingCount,
    signupMode: settings.signupMode(),
    canMembers,
    canRequests,
    canDecide,
    canChangeMode: ranks.canChangeSignupMode(me),
    rankLabel: ranks.rankLabel(me),
  }));
});

router.get('/meeting', (req, res) => {
  if (!requireLogin(req, res)) return;
  const room = String(req.query.room || '').trim();
  if (room === '') return res.redirect(baseUrl(req) + '/home');

  const meeting = dbm.get('SELECT * FROM meetings WHERE room_id=? AND active=1', [room]);
  if (!meeting) return res.redirect(baseUrl(req) + '/home?err=nomeeting');

  const me = sessions.currentUser(req);

  const blocked = dbm.get('SELECT 1 AS b FROM meeting_blocks WHERE meeting_id=? AND user_id=?', [meeting.id, me.id]);
  if (blocked) return res.redirect(baseUrl(req) + '/home?err=blocked');

  let part = dbm.get('SELECT * FROM meeting_participants WHERE meeting_id=? AND user_id=?', [meeting.id, me.id]);
  if (!part) {
    const r = dbm.run(
      'INSERT INTO meeting_participants (meeting_id, user_id, display_name, username, status, role, joined_at) VALUES (?,?,?,?,?,?,?)',
      [meeting.id, me.id, me.display_name, me.username, 'pending', 'member', now64()]
    );
    part = { id: r.lastInsertRowid, status: 'pending', role: 'member' };
  } else if (part.status === 'removed') {
    dbm.run('UPDATE meeting_participants SET status=? WHERE id=?', ['pending', part.id]);
    part = { ...part, status: 'pending' };
  }
  const isAdmin = part.role === 'admin';
  const myStatus = part.status;

  const participants = dbm.all(
    `SELECT p.id, p.user_id, p.display_name, p.username, p.status, p.role, p.muted, p.cam_on, p.sharing,
            u.avatar_color, u.avatar, u.full_name, u.email, u.phone, u.is_manager
     FROM meeting_participants p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.meeting_id=? AND p.status<>? ORDER BY p.id`,
    [meeting.id, 'removed']
  );

  const messages = dbm.all(
    'SELECT user_id, display_name, body, created_at FROM messages WHERE meeting_id=? ORDER BY id DESC LIMIT 50',
    [meeting.id]
  ).reverse();

  const emojis = dbm.all(
    'SELECT user_id, display_name, emoji FROM emoji_events WHERE meeting_id=? ORDER BY id DESC LIMIT 12',
    [meeting.id]
  );

  const init = {
    meeting: { id: Number(meeting.id), room: meeting.room_id, title: meeting.title, default_media: Number(meeting.default_media) !== 0 },
    me: {
      id: Number(me.id), name: me.display_name, username: me.username,
      avatar_color: me.avatar_color, avatar: String(me.avatar || ''), is_admin: isAdmin, status: myStatus,
    },
    token: makeSocketToken(me.id, meeting.id),
    socketUrl: '',
    iceServers: turnConfig(),
    base: baseUrl(req),
    participants,
    messages,
    emojis,
    csrf: sessions.csrfToken(req, res),
    publicUrl: publicUrl(req) + '/meeting?room=' + meeting.room_id,
  };

  res.render('call', pageLocals(req, res, {
    title: 'تماس - Black Meet',
    meeting,
    isAdmin,
    init,
    me,
    participants,
    initials: initials(me.display_name),
    isManager: !!me.is_manager,
  }));
});

function now64() {
  return require('./../lib/helpers').sqlNow();
}

module.exports = router;