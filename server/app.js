'use strict';
const express = require('express');
const path = require('path');
const { appConfig } = require('./lib/config');
const sessions = require('./lib/sessions');
const pages = require('./routes/pages');
const api = require('./routes/api');
const { handleSiteProxy } = require('./lib/siteproxy');

const rootDir = path.resolve(__dirname, '..');

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
  app.use('/black-meet/uploads', express.static(path.join(rootDir, 'uploads')));

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