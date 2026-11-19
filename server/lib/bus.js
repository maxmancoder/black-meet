'use strict';
const EV = require('../../shared/socket-events');
const state = require('./state');

let ioRef = null;

function setIo(io) {
  ioRef = io;
}

function allSockets() {
  return ioRef ? ioRef.of('/').sockets : new Map();
}

function notifyNew(data) {
  allSockets().forEach((s) => { if (s.data.userId) s.emit(EV.NOTIF_NEW, data || {}); });
}

function pvNew(toUserId, data) {
  if (!ioRef) return;
  const targets = state.userSockets.get(toUserId);
  if (!targets) return;
  targets.forEach((sid) => ioRef.to(sid).emit(EV.PV_NEW_MESSAGE, data));
}

function pvConversationUpdated(data) {
  allSockets().forEach((s) => {
    if (s.data.isManager && s.data.userId !== data.userId) s.emit(EV.PV_CONVERSATION_UPDATED, data);
  });
}

// a soft-deleted message disappears from every open thread at once
function msgDeleted(data) {
  allSockets().forEach((s) => s.emit(EV.MSG_DELETED, data || {}));
}

// push an incoming private message to every manager console (live append).
// `excludeUserId` avoids a duplicate bubble when the named recipient IS a manager:
// bus.pvNew() already delivers that socket's copy.
function pvToManagers(data, excludeUserId) {
  const skip = Number(excludeUserId || 0);
  allSockets().forEach((s) => {
    if (s.data.isManager && Number(s.data.userId) !== skip) s.emit(EV.PV_NEW_MESSAGE, data);
  });
}

// an edited message is repainted in every open thread at once
function msgEdited(data) {
  allSockets().forEach((s) => s.emit(EV.MSG_EDITED, data || {}));
}

function roomEvent(room, event, data) {
  ioRef.to('bm:' + room).emit(EV.BM_EVENT, { room, event, data: data || {} });
}

// push approval-mode signup activity (new request / applicant reply) to manager consoles
function srToManagers(event, data) {
  allSockets().forEach((s) => { if (s.data.isManager) s.emit(event, data || {}); });
}

// meetings index realtime: broadcast to all authenticated sockets; clients filter by view
function meetingCreated(data) {
  allSockets().forEach((s) => { if (s.data.userId) s.emit(EV.MEETING_CREATED, data || {}); });
}
function meetingEnded(data) {
  allSockets().forEach((s) => { if (s.data.userId) s.emit(EV.MEETING_ENDED, data || {}); });
}
function meetingDeleted(data) {
  allSockets().forEach((s) => { if (s.data.userId) s.emit(EV.MEETING_DELETED, data || {}); });
}

module.exports = {
  setIo, notifyNew, pvNew, pvConversationUpdated, pvToManagers, msgDeleted, msgEdited, srToManagers, roomEvent,
  meetingCreated, meetingEnded, meetingDeleted,
};