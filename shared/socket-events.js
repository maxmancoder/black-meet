// shared/socket-events.js — single source of truth for Socket.IO event names.
// Loaded by Node (require) and by the browser (window.BMEv via script tag).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BMEv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var E = {
    // ---- connection / presence ----
    AUTH_HELLO: 'auth:hello',
    PRESENCE_PING: 'presence:ping',
    PRESENCE_ONLINE: 'presence:online',
    PRESENCE_OFFLINE: 'presence:offline',
    CONN_STATE: 'conn:state',

    // ---- meeting room (call page) ----
    CALL_JOIN: 'call:join',
    CALL_WELCOME: 'call:welcome',
    CALL_SIGNAL: 'call:signal',
    CALL_CHAT_SEND: 'chat:send',
    CHAT_NEW_MESSAGE: 'chat:new-message',
    CHAT_ACK: 'chat:ack',
    CALL_EMOJI: 'call:emoji',
    EMOJI: 'emoji',
    CALL_STATUS: 'call:status',
    MEMBER_UPDATED: 'member:updated',

    // member lifecycle
    CALL_APPROVE: 'call:approve',
    CALL_REJECT: 'call:reject',
    CALL_KICK: 'call:kick',
    CALL_BLOCK: 'call:block',
    CALL_ALERT_ADMIN: 'call:alert-admin',
    CALL_LEAVE: 'call:leave',
    CALL_DISABLE: 'call:disable',          // admin force-disable mic/cam/screen
    FORCE_DISABLE: 'force-disable',
    MEMBER_JOINED: 'member:joined',
    MEMBER_LEFT: 'member:left',
    MEMBER_APPROVED: 'member:approved',
    MEMBER_PENDING: 'member:pending',
    MEMBER_BLOCKED: 'member:blocked',
    MEMBER_KICKED: 'member:kicked',
    YOU_APPROVED: 'you-approved',
    YOU_REJECTED: 'you-rejected',
    YOU_REMOVED: 'you-removed',
    YOU_BLOCKED: 'you-blocked',
    JOIN_ALERT: 'join-alert',

    // ---- 1:1 call request ----
    CALLREQ_SEND: 'callreq:send',
    CALLREQ_INCOMING: 'callreq:incoming',
    CALLREQ_ACCEPT: 'callreq:accept',
    CALLREQ_REJECT: 'callreq:reject',
    CALLREQ_CANCEL: 'callreq:cancel',
    CALLREQ_ACCEPTED: 'callreq:accepted',
    CALLREQ_REJECTED: 'callreq:rejected',
    CALLREQ_CANCELLED: 'callreq:cancelled',
    CALLREQ_BUSY: 'callreq:busy',
    CALLREQ_ENDED: 'callreq:ended',

    // ---- private messages ----
    PV_SEND: 'pv:send',
    PV_NEW_MESSAGE: 'pv:new-message',
    PV_ACK: 'pv:ack',
    PV_CONVERSATION_UPDATED: 'pv:conversation-updated',

    // ---- notifications ----
    NOTIF_NEW: 'notif:new',

    // ---- signup requests (approval-mode chat with the manager) ----
    SR_NEW_MESSAGE: 'sr:new-message',
    SR_NEW_REQUEST: 'sr:new-request',

    // ---- announcements broadcast channel (from PHP) ----
    BM_SUBSCRIBE: 'bm:subscribe',
    BM_EVENT: 'bm:event',

    // ---- errors ----
    ERR: 'err'
  };
  E.ALL = Object.keys(E).map(function (k) { return E[k]; });
  return E;
});
