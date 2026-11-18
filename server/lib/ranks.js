'use strict';
const dbm = require('./db');
const { sqlNow } = require('./helpers');
const restrictions = require('./restrictions');

// rank levels for normal users (is_manager is the super "main manager", above all ranks)
// user    -> regular member
// admin   -> ادمین
// premium -> ادمین پریمیوم
const RANKS = {
  user:    { label: 'کاربر عادی',    dailyLimit: 2 },
  admin:   { label: 'ادمین',         dailyLimit: 5 },
  premium: { label: 'ادمین پریمیوم', dailyLimit: 15 },
  manager: { label: 'مدیر اصلی',     dailyLimit: 0 }, // 0 = unlimited
};

function normalizeRank(r) {
  return Object.prototype.hasOwnProperty.call(RANKS, r) && r !== 'manager' ? r : 'user';
}

function rankOf(u) {
  if (!u) return 'user';
  if (u.is_manager) return 'manager';
  return normalizeRank(u.rank);
}

function rankLabel(u) {
  return RANKS[rankOf(u)].label;
}

// number of meetings a user may create per day (0 = the restriction is OFF = unlimited).
// Editable per rank from «مدیریت اعضا» → «محدودیت کاربران».
function dailyLimitOf(u) {
  return restrictions.limit(u, 'daily_meetings');
}

// How many meetings this user already created TODAY. Counted from the durable ledger, not
// from `meetings`: deleting a finished meeting from «جلسات اخیر» must NOT free the quota.
function meetingsCreatedToday(userId) {
  const today = sqlNow().slice(0, 10); // 'YYYY-MM-DD' local
  const row = dbm.get(
    'SELECT COUNT(*) AS c FROM meeting_creates WHERE user_id=? AND substr(created_at,1,10)=?',
    [Number(userId), today]
  );
  return Number(row && row.c || 0);
}

// { limit, used, left } — limit 0 = unlimited (left stays Infinity for callers to format)
function dailyQuota(u) {
  const limit = dailyLimitOf(u);
  const used = meetingsCreatedToday(u.id);
  return { limit, used, left: limit === 0 ? 0 : Math.max(0, limit - used) };
}

// can see the member list and edit user info
function canViewMembers(u) {
  return restrictions.allowed(u, 'can_view_members');
}

// can see the "account creation requests" section
function canViewRequests(u) {
  return restrictions.allowed(u, 'can_view_requests');
}

// can approve/reject requests and reply to applicants
function canDecideRequests(u) {
  return restrictions.allowed(u, 'can_decide_requests');
}

// can change the signup mode setting
function canChangeSignupMode(u) {
  return restrictions.allowed(u, 'can_change_signup_mode');
}

// can edit another user's info / rank
function canManageUsers(u) {
  return restrictions.allowed(u, 'can_manage_users');
}

// can open the /messages console (manager sees all threads, admin/premium only their admin chat)
function canUseMessages(u) {
  return restrictions.allowed(u, 'can_use_messages');
}

// site-wide meeting creation policy (settings.meetingCreateMode):
//   all     -> everyone, subject to their normal account limits/quotas
//   premium -> only premium subscribers (rank premium) + manager
//   admin   -> only admins and premium admins (ranks admin, premium) + manager
// Manager is never restricted by this mode.
function canCreateForMeetingMode(u, mode) {
  if (!u) return { ok: false, msg: 'دسترسی ندارید' };
  if (u.is_manager) return { ok: true };
  if (mode === 'all' || !mode) return { ok: true };
  const r = rankOf(u);
  if (mode === 'premium') {
    if (r === 'premium') return { ok: true };
    return { ok: false, msg: 'در حال حاظر ایجاد تماس برای کاربران رایگان در دسترس نیست.' };
  }
  if (mode === 'admin') {
    if (r === 'admin' || r === 'premium') return { ok: true };
    return { ok: false, msg: 'در حال حاضر ایجاد تماس فقط برای ادمین‌ها در دسترس است.' };
  }
  return { ok: true };
}

module.exports = {
  RANKS, rankOf, rankLabel, dailyLimitOf, meetingsCreatedToday, dailyQuota,
  canViewMembers, canViewRequests, canDecideRequests, canChangeSignupMode, canManageUsers,
  canUseMessages, normalizeRank, canCreateForMeetingMode, restrictions,
};
