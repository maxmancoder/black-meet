'use strict';
const dbm = require('./db');
const { sqlNow } = require('./helpers');

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

// number of meetings a user may create per day (0 = unlimited)
function dailyLimitOf(u) {
  return RANKS[rankOf(u)].dailyLimit;
}

// how many meetings this user already created TODAY (local calendar day, resets at midnight)
function meetingsCreatedToday(userId) {
  const today = sqlNow().slice(0, 10); // 'YYYY-MM-DD' local
  const row = dbm.get(
    'SELECT COUNT(*) AS c FROM meetings WHERE creator_id=? AND substr(created_at,1,10)=?',
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
  const r = rankOf(u);
  return r === 'manager' || r === 'premium';
}

// can see the "account creation requests" section
function canViewRequests(u) {
  const r = rankOf(u);
  return r === 'manager' || r === 'admin' || r === 'premium';
}

// can approve/reject requests and reply to applicants
function canDecideRequests(u) {
  const r = rankOf(u);
  return r === 'manager' || r === 'premium';
}

// can change the signup mode setting
function canChangeSignupMode(u) {
  const r = rankOf(u);
  return r === 'manager' || r === 'premium';
}

// can edit another user's info / rank
function canManageUsers(u) {
  return canViewMembers(u);
}

// can open the /messages console (manager sees all threads, premium only his admin chat)
function canUseMessages(u) {
  const r = rankOf(u);
  return r === 'manager' || r === 'premium';
}

module.exports = {
  RANKS, rankOf, rankLabel, dailyLimitOf, meetingsCreatedToday, dailyQuota,
  canViewMembers, canViewRequests, canDecideRequests, canChangeSignupMode, canManageUsers,
  canUseMessages, normalizeRank,
};
