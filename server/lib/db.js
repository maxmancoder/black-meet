'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const rootDir = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.BM_DB_PATH || path.join(rootDir, 'black_meet.db');

let _db = null;

function db() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL;');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);
  // lightweight idempotent migrations for DBs created before a column existed
  const cols = _db.prepare('PRAGMA table_info(users)').all().map((r) => r.name);
  if (cols.indexOf('rank') === -1) {
    _db.exec("ALTER TABLE users ADD COLUMN rank TEXT NOT NULL DEFAULT 'user'");
  }
  return _db;
}

function rowToPlain(row) {
  if (row === undefined || row === null) return null;
  return Object.assign({}, row);
}

function get(sql, params) {
  const s = db().prepare(sql);
  const r = params ? s.get(...params) : s.get();
  return rowToPlain(r);
}

function all(sql, params) {
  const s = db().prepare(sql);
  const rows = params ? s.all(...params) : s.all();
  return rows.map(rowToPlain);
}

function run(sql, params) {
  const s = db().prepare(sql);
  const r = params ? s.run(...params) : s.run();
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

function lastId() {
  return Number(db().prepare('SELECT last_insert_rowid() AS id').get().id);
}

module.exports = { db, get, all, run, lastId, rootDir, DB_PATH };