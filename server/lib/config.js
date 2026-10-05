'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dbm = require('./db');

let cache = null;

function appConfig() {
  if (cache) return cache;

  // config.json is gitignored — a fresh clone (e.g. Render) boots from env + defaults
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(dbm.rootDir, 'config.json'), 'utf8'));
  } catch (e) {
    file = {};
  }

  const cfg = Object.assign({
    secret: '',
    broadcast_secret: '',
    DEV_MODE: false,
    socket_port: 3000,
    base_url: '',
    turn: null,
    admin: null,
  }, file);

  // environment overrides (production deployments)
  if (process.env.BM_SECRET) cfg.secret = process.env.BM_SECRET;
  if (process.env.BM_BASE_URL) cfg.base_url = process.env.BM_BASE_URL;
  if (process.env.BM_DEV_MODE !== undefined && process.env.BM_DEV_MODE !== '') {
    cfg.DEV_MODE = process.env.BM_DEV_MODE === '1' || process.env.BM_DEV_MODE.toLowerCase() === 'true';
  }

  if (!cfg.secret) {
    cfg.secret = crypto.randomBytes(32).toString('hex');
    console.warn('[config] no secret configured (config.json / BM_SECRET) — using a random per-boot secret, sessions reset on restart');
  }

  cache = cfg;
  return cache;
}

function broadcastSecret() {
  const env = process.env.BM_BROADCAST_SECRET;
  if (env && env !== '') return env;
  return appConfig().broadcast_secret || '';
}

module.exports = { appConfig, broadcastSecret };
