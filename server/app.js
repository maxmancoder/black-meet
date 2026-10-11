'use strict';
const express = require('express');
const path = require('path');
const { appConfig } = require('./lib/config');
const sessions = require('./lib/sessions');
const dbm = require('./lib/db');
const pages = require('./routes/pages');
const api = require('./routes/api');
const { handleSiteProxy } = require('./lib/siteproxy');
const callfiles = require('./lib/callfiles');

const rootDir = path.resolve(__dirname, '..');
// small helpers for the call-file route (app.js must not require internal.js at the top:
// it pulls in the socket bus)
function callMeetingByRoom(roomId) {
  try { return dbm.get('SELECT id, room_id, active FROM meetings WHERE room_id=?', [String(roomId)]); } catch (e) { return null; }
}
function callIsMember(meetingId, userId) {
  try {
    return !!dbm.get('SELECT 1 AS ok FROM meeting_participants WHERE meeting_id=? AND user_id=?',
      [Number(meetingId), Number(userId)]);
  } catch (e) { return false; }
}

function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // static assets (before session middleware: no DB hit for asset fetches)
  app.use('/black-meet/assets', express.static(path.join(rootDir, 'assets')));
  app.use('/black-meet/fonts', express.static(path.join(rootDir, 'fonts')));
  app.use('/black-meet/shared', express.static(path.join(rootDir, 'shared')));
  app.use('/black-meet/icons', express.static(path.join(rootDir, 'icons')));
  // ONLY avatars are public. `uploads/call/` holds the files shared inside a call and must
  // never be served statically — it is only reachable through the login-gated route below
  // (mounting all of uploads/ used to expose every shared file to anyone with the URL).
  app.use('/black-meet/uploads/avatars', express.static(path.join(rootDir, 'uploads/avatars')));

  // load session + user for everything else
  app.use('/black-meet', (req, res, next) => {
    req.session = sessions.loadSession(req);
    next();
  });

  app.use('/black-meet/api', api);
  // same-origin proxy behind the call page's shared-website box (login required)
  app.get('/black-meet/site-proxy', (req, res, next) => {
    if (!req.session || !req.session.data || !req.session.data.user_id) {
      return res.status(403).type('text').send('auth required');
    }
    handleSiteProxy(req, res).catch(next);
  });
  // a file shared in a call: only the members of that room may read it
  app.get('/black-meet/call-file/:id', (req, res) => {
    if (!req.session || !req.session.data || !req.session.data.user_id) {
      return res.status(403).type('text').send('auth required');
    }
    const room = String(req.query.room || '');
    const userId = Number(req.session.data.user_id);
    const meeting = room ? callMeetingByRoom(room) : null;
    if (!meeting || !meeting.active || !callIsMember(meeting.id, userId)) {
      return res.status(403).type('text').send('not a member of this session');
    }
    const meta = callfiles.meta(room, req.params.id);
    const abs = callfiles.filePath(room, req.params.id);
    if (!meta || !abs) return res.status(404).type('text').send('not found');
    // inline only for viewable types, otherwise force a download — never let the browser
    // execute something (html/svg) in our origin
    const disp = meta.viewable ? 'inline' : 'attachment';
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Content-Disposition',
      disp + '; filename="' + meta.name.replace(/["\\\r\n]/g, '_') + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (req.query.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="' + meta.name.replace(/["\\\r\n]/g, '_') + '"');
    res.sendFile(abs);
  });
  app.use('/black-meet', pages);

  app.get(['/black-meet', '/black-meet/'], (req, res) => res.redirect(307, '/black-meet/login'));
  app.get('/', (req, res) => res.redirect(301, '/black-meet/'));

  app.use((req, res) => {
    res.status(404).type('text').send('404 not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
      return res.status(400).json({ ok: false, msg: 'بارگذاری فایل نامعتبر است' });
    }
    console.error(err && (err.stack || err.message));
    if (res.headersSent) return next(err);
    res.status(500).json({ ok: false, msg: 'خطای داخلی سرور' });
  });

  return app;
}

module.exports = { createApp };