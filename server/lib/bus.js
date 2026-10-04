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

// push an incoming private message to every manager console (live append)
function pvToManagers(data) {
  allSockets().forEach((s) => {
    if (s.data.isManager) s.emit(EV.PV_NEW_MESSAGE, data);
  });
}

function roomEvent(room, event, data) {
  ioRef.to('bm:' + room).emit(EV.BM_EVENT, { room, event, data: data || {} });
}

module.exports = { setIo, notifyNew, pvNew, pvConversationUpdated, pvToManagers, roomEvent };