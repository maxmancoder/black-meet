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

    // per-user round-trip latency (shown on each tile)
    CALL_PING: 'call:ping',
    CALL_PONG: 'call:pong',
    PING_STATS: 'ping:stats',

    // shared web surface: a proxied website or a synced video inside the call
    CALL_WEB_OPEN: 'call:web-open',
    CALL_WEB_CLOSE: 'call:web-close',
    CALL_WEB_FOLLOW: 'call:web-follow',
    CALL_WEB_RIGHTS: 'call:web-rights',
    CALL_WEB_SYNC: 'call:web-sync',
    WEB_STATE: 'web:state',
    WEB_SYNC: 'web:sync',
    WEB_ERR: 'web:err',
    WEB_DOWNLOAD: 'web:download', // a member downloaded the shared file (live count badge)

    // shared whiteboard (canvas inside the call)
    WB_OPEN: 'wb:open',        // admin opens the whiteboard for the room
    WB_CLOSE: 'wb:close',      // admin closes the whiteboard for the room
    WB_DRAW: 'wb:draw',        // a granted member sends a stroke segment
    WB_CLEAR: 'wb:clear',      // admin clears the entire canvas
    WB_GRANT: 'wb:grant',      // admin grants draw permission to a user
    WB_REVOKE: 'wb:revoke',    // admin revokes draw permission from a user
    WB_STATE: 'wb:state',      // server -> all: current whiteboard state + granted list

    // member lifecycle
    CALL_APPROVE: 'call:approve',
    CALL_REJECT: 'call:reject',
    CALL_KICK: 'call:kick',
    CALL_BLOCK: 'call:block',
    CALL_ALERT_ADMIN: 'call:alert-admin',
    CALL_SET_OPEN_JOIN: 'call:set-open-join', // admin: "join without approval"
    OPEN_JOIN_CHANGED: 'call:open-join-changed',
    CALL_SET_BOX_VISIBILITY: 'call:set-box-visibility', // admin: show/hide stage boxes
    BOX_VISIBILITY_CHANGED: 'call:box-visibility-changed',
    ADMIN_CHANGED: 'admin-changed',
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
    // the call ended because nobody else joined within the time limit
    CALL_SOLO_ENDED: 'call:alone-ended',
    CALL_SOLO_ENDED: 'call:alone-ended',
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

    // ---- meetings index (list page realtime) ----
    MEETING_CREATED: 'meeting:created',
    MEETING_ENDED: 'meeting:ended',
    MEETING_DELETED: 'meeting:deleted',

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
