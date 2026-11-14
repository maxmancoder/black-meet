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
const callfiles = require('./../lib/callfiles');
const { toFaDigits } = require('./../lib/helpers');

function pageLocals(req, res, extra) {
  const base = baseUrl(req);
  const me = sessions.currentUser(req);
  const locals = {
    title: 'Black Meet',
    base,
    public: publicUrl(req),
    me,
    csrf: sessions.csrfToken(req, res),
    // the page already knows who is signed in, so the realtime token can ship inside the
    // HTML instead of costing an extra api/socket-token round trip before every connection
    socketToken: me ? makeSocketToken(me.id, 0) : '',
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
    // the app icon: it is stored in the DB and served from /site-icon, so the admin can
    // replace it and every page (favicon, header mark, login page) follows at once
    siteIconUrl() { return base + '/site-icon'; },
    brandMark(cls) {
      const c = cls ? ' ' + String(cls).trim() : '';
      return `<img src="${base}/site-icon" alt="Black Meet" class="bm-brand-mark${c}" decoding="async"/>`;
    },
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
  const quotaFull = quota.limit !== 0 && quota.used >= quota.limit;
  const createMode = settings.meetingCreateMode();
  const modeCheck = ranks.canCreateForMeetingMode(me, createMode);
  let canCreate = true;
  let createBlockMsg = '';
  if (me.is_manager) {
    canCreate = true; createBlockMsg = '';
  } else if (!modeCheck.ok) {
    canCreate = false; createBlockMsg = modeCheck.msg;
  } else if (limited) {
    canCreate = false; createBlockMsg = 'حساب شما محدود شده و امکان ایجاد تماس جدید وجود ندارد';
  } else if (quotaFull) {
    canCreate = false; createBlockMsg = 'سقف تماس امروز شما پر شده است؛ فردا دوباره تلاش کنید';
  }

  // dashboard stats: only numbers this database can actually answer (no invented analytics)
  const now = new Date();
  const monthPrefix = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const stats = dbm.get(
    `SELECT
       (SELECT COUNT(*) FROM meetings WHERE creator_id=?)                             AS total_meetings,
       (SELECT COUNT(*) FROM meetings WHERE creator_id=? AND active=1)                 AS active_meetings,
       (SELECT COUNT(*) FROM meetings WHERE creator_id=? AND substr(created_at,1,7)=?) AS month_meetings,
       (SELECT COUNT(DISTINCT p.user_id) FROM meeting_participants p
          JOIN meetings m ON m.id = p.meeting_id
         WHERE m.creator_id=? AND p.user_id<>? AND p.status<>'removed')               AS guests`,
    [me.id, me.id, me.id, monthPrefix, me.id, me.id]
  ) || {};

  res.render('home', pageLocals(req, res, {
    title: 'خانه - Black Meet',
    me,
    limited,
    recent,
    stats: {
      totalMeetings: Number(stats.total_meetings) || 0,
      activeMeetings: Number(stats.active_meetings) || 0,
      monthMeetings: Number(stats.month_meetings) || 0,
      guests: Number(stats.guests) || 0,
    },
    memberSince: String(me.created_at || '').slice(0, 4),
    isManager: !!me.is_manager,
    rankLabel: ranks.rankLabel(me),
    canMembers: ranks.canViewMembers(me),
    canRequests: ranks.canViewRequests(me),
    canMessages: ranks.canUseMessages(me),
    quota,
    quotaFull,
    canCreate,
    createBlockMsg,
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
  const limited = !!me.is_limited;
  const modeCheck = ranks.canCreateForMeetingMode(me, settings.meetingCreateMode());
  let canCreate = true;
  let createBlockMsg = '';
  if (me.is_manager) {
    canCreate = true; createBlockMsg = '';
  } else if (!modeCheck.ok) {
    canCreate = false; createBlockMsg = modeCheck.msg;
  } else if (limited) {
    canCreate = false; createBlockMsg = 'حساب شما محدود شده است';
  } else if (quotaFull) {
    canCreate = false; createBlockMsg = 'سقف تماس امروز پر شده است';
  }
  res.render('create', pageLocals(req, res, {
    title: 'ایجاد تماس - Black Meet',
    limited,
    quota,
    quotaFull,
    quotaText: quota.limit === 0 ? null : (toFaDigits(quota.used) + ' از ' + toFaDigits(quota.limit)),
    isManager: !!me.is_manager,
    rankLabel: ranks.rankLabel(me),
    canMessages: ranks.canUseMessages(me),
    canMembers: ranks.canViewMembers(me),
    canRequests: ranks.canViewRequests(me),
    canCreate,
    createBlockMsg,
    initials: initials(me.display_name),
  }));
});

router.get('/profile', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  const quota = ranks.dailyQuota(me);
  const quotaFull = quota.limit !== 0 && quota.used >= quota.limit;
  const limited = !!me.is_limited;
  const modeCheck = ranks.canCreateForMeetingMode(me, settings.meetingCreateMode());
  let canCreate = true;
  let createBlockMsg = '';
  if (me.is_manager) {
    canCreate = true; createBlockMsg = '';
  } else if (!modeCheck.ok) {
    canCreate = false; createBlockMsg = modeCheck.msg;
  } else if (limited) {
    canCreate = false; createBlockMsg = 'حساب شما محدود شده است';
  } else if (quotaFull) {
    canCreate = false; createBlockMsg = 'سقف تماس امروز پر شده است';
  }
  res.render('profile', pageLocals(req, res, {
    title: 'پروفایل - Black Meet',
    av: avatarUrl(me.avatar, req),
    rankLabel: ranks.rankLabel(me),
    isManager: !!me.is_manager,
    canMessages: ranks.canUseMessages(me),
    canMembers: ranks.canViewMembers(me),
    canRequests: ranks.canViewRequests(me),
    canCreate,
    createBlockMsg,
    initials: initials(me.display_name),
  }));
});

// index of meetings: manager and premium (ادمین پریمیوم) see ALL meetings; regular users and
// plain admins see only their own. Updates are pushed live via MEETING_* socket events.
router.get('/meetings', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  const quota = ranks.dailyQuota(me);
  const quotaFull = quota.limit !== 0 && quota.used >= quota.limit;
  const limited = !!me.is_limited;
  const meetingCreateMode = settings.meetingCreateMode();
  const modeCheck = ranks.canCreateForMeetingMode(me, meetingCreateMode);
  let canCreate = true;
  let createBlockMsg = '';
  if (me.is_manager) {
    canCreate = true; createBlockMsg = '';
  } else if (!modeCheck.ok) {
    canCreate = false; createBlockMsg = modeCheck.msg;
  } else if (limited) {
    canCreate = false; createBlockMsg = 'حساب شما محدود شده است';
  } else if (quotaFull) {
    canCreate = false; createBlockMsg = 'سقف تماس امروز پر شده است';
  }

  const canSeeAllMeetings = !!(me.is_manager || ranks.rankOf(me) === 'premium');
  const canManageAllMeetings = canSeeAllMeetings;
  const baseSql = `SELECT m.id, m.room_id, m.title, m.created_at, m.active, m.creator_id,
            u.display_name AS creator_name, u.username AS creator_username,
            (SELECT COUNT(*) FROM meeting_participants p WHERE p.meeting_id=m.id AND p.status<>'removed') AS members
     FROM meetings m LEFT JOIN users u ON u.id = m.creator_id`;
  const rows = canSeeAllMeetings
    ? dbm.all(baseSql + ' ORDER BY m.created_at DESC LIMIT 500')
    : dbm.all(baseSql + ' WHERE m.creator_id=? ORDER BY m.created_at DESC LIMIT 200', [me.id]);
  const meetings = rows.map((m) => Object.assign({}, m, {
    members: Number(m.members) || 0,
    active: Number(m.active) ? 1 : 0,
    creator_id: Number(m.creator_id) || 0,
  }));

  res.render('meetings', pageLocals(req, res, {
    title: 'همهٔ تماس‌ها - Black Meet',
    meetings,
    canSeeAllMeetings,
    canManageAllMeetings,
    activeCount: meetings.filter((m) => m.active).length,
    endedCount: meetings.filter((m) => !m.active).length,
    totalCount: meetings.length,
    limited,
    isManager: !!me.is_manager,
    rankLabel: ranks.rankLabel(me),
    canMessages: ranks.canUseMessages(me),
    canMembers: ranks.canViewMembers(me),
    canRequests: ranks.canViewRequests(me),
    canCreate,
    createBlockMsg,
    meetingCreateMode,
    canChangeMeetingMode: !!me.is_manager,
    initials: initials(me.display_name),
  }));
});

// Who downloaded a file shared inside a call. Opens in a NEW TAB from the file box header
// (the owner asked for exactly that), so it is a real page and not a modal. Only members of
// the session can read it.
router.get('/file-downloads', (req, res) => {
  if (!requireLogin(req, res)) return;
  const me = sessions.currentUser(req);
  const room = String(req.query.room || '');
  const fileId = String(req.query.id || '');
  let meeting = null;
  try {
    meeting = room ? dbm.get('SELECT id, room_id, title, active FROM meetings WHERE room_id=?', [room]) : null;
  } catch (e) { meeting = null; }
  let member = false;
  if (meeting) {
    try {
      member = !!dbm.get('SELECT 1 AS ok FROM meeting_participants WHERE meeting_id=? AND user_id=?',
        [meeting.id, me.id]);
    } catch (e) { member = false; }
  }
  if (!meeting || !member) {
    res.redirect(baseUrl(req) + '/home');
    return;
  }
  const meta = callfiles.meta(room, fileId);
  const stats = callfiles.downloadStats(room, fileId);
  res.render('file_downloads', pageLocals(req, res, {
    title: 'دانلودکنندگان فایل - Black Meet',
    fileName: (meta && meta.name) || 'فایل',
    fileSize: (meta && meta.size) || 0,
    total: stats.total,
    downloaders: stats.users,
    roomId: room,
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
  // plain admins (rank admin) must not access the public announcements thread on this page
  const canSeePublic = !!(me.is_manager || ranks.rankOf(me) === 'premium');
  res.render('messages', pageLocals(req, res, {
    title: 'پیام‌ها - Black Meet',
    isManager: !!me.is_manager,
    canSeePublic,
    rankLabel: ranks.rankLabel(me),
    canMessages: ranks.canUseMessages(me),
    canMembers: ranks.canViewMembers(me),
    canRequests: ranks.canViewRequests(me),
    initials: initials(me.display_name),
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

  const modeCheck = ranks.canCreateForMeetingMode(me, settings.meetingCreateMode());
  let canCreate = true;
  let createBlockMsg = '';
  if (me.is_manager) {
    canCreate = true; createBlockMsg = '';
  } else if (!modeCheck.ok) {
    canCreate = false; createBlockMsg = modeCheck.msg;
  } else if (me.is_limited) {
    canCreate = false; createBlockMsg = 'حساب شما محدود شده است';
  } else {
    const q = ranks.dailyQuota(me);
    if (q.limit !== 0 && q.used >= q.limit) { canCreate = false; createBlockMsg = 'سقف تماس امروز پر شده است'; }
  }

  res.render('admin_members', pageLocals(req, res, {
    title: 'مدیریت اعضا - Black Meet',
    me,
    users,
    requests,
    pendingCount,
    signupMode: settings.signupMode(),
    isManager: !!me.is_manager,
    canMessages: ranks.canUseMessages(me),
    canCreate,
    createBlockMsg,
    canMembers,
    canRequests,
    canDecide,
    canChangeMode: ranks.canChangeSignupMode(me),
    rankLabel: ranks.rankLabel(me),
    initials: initials(me.display_name),
  }));
});

router.get('/meeting', (req, res) => {
  // a visitor who is not logged in yet keeps the room link: after login they land back
  // here, which is what actually creates the join request for the meeting admin.
  // req.originalUrl already carries the /black-meet mount prefix.
  if (!requireLogin(req, res, baseUrl(req), req.originalUrl)) return;
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
            u.avatar_color, u.avatar, u.full_name, u.email, u.phone, u.is_manager, u.rank
     FROM meeting_participants p LEFT JOIN users u ON u.id = p.user_id
     WHERE p.meeting_id=? AND p.status<>? ORDER BY p.id`,
    [meeting.id, 'removed']
  );
  // Privacy: the manager's / an admin's phone, email and username are never shown to
  // non-managers on the call page (same rule as info_hidden on /members).
  const safeParticipants = participants.map((p) => {
    if (me.is_manager || p.user_id === me.id) return p;
    const protectedTarget = !!p.is_manager || p.rank === 'admin' || p.role === 'admin';
    if (!protectedTarget) return p;
    return Object.assign({}, p, { email: null, phone: null, username: null, redacted: 1 });
  });

  const messages = dbm.all(
    'SELECT user_id, display_name, body, created_at FROM messages WHERE meeting_id=? ORDER BY id DESC LIMIT 50',
    [meeting.id]
  ).reverse();

  const emojis = dbm.all(
    'SELECT user_id, display_name, emoji FROM emoji_events WHERE meeting_id=? ORDER BY id DESC LIMIT 12',
    [meeting.id]
  );

  const init = {
    meeting: {
      id: Number(meeting.id), room: meeting.room_id, title: meeting.title,
      default_media: Number(meeting.default_media) !== 0,
      open_join: Number(meeting.open_join) === 1,
    },
    me: {
      id: Number(me.id), name: me.display_name, username: me.username,
      avatar_color: me.avatar_color, avatar: String(me.avatar || ''), is_admin: isAdmin, status: myStatus,
      is_manager: !!me.is_manager,
    },
    token: makeSocketToken(me.id, meeting.id),
    socketUrl: '',
    iceServers: turnConfig(),
    base: baseUrl(req),
    participants: safeParticipants,
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
    participants: safeParticipants,
    initials: initials(me.display_name),
    isManager: !!me.is_manager,
  }));
});

function now64() {
  return require('./../lib/helpers').sqlNow();
}

module.exports = router;

