'use strict';
const fs = require('fs');
const path = require('path');
const dbm = require('./db');

let cache = null;

function appConfig() {
  if (cache) return cache;
  const raw = fs.readFileSync(path.join(dbm.rootDir, 'config.json'), 'utf8');
  cache = JSON.parse(raw);
  return cache;
}

function broadcastSecret() {
  const env = process.env.BM_BROADCAST_SECRET;
  if (env && env !== '') return env;
  return appConfig().broadcast_secret || '';
}

module.exports = { appConfig, broadcastSecret };