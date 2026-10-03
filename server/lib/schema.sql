-- Black Meet - SQLite schema (port of MySQL sql/schema.sql + migrations 001/002)
-- Everything is idempotent. created_at/expires_at values are written by the
-- Node app in LOCAL time (sqlNow()), so no CURRENT_TIMESTAMP defaults are used.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT    NOT NULL,
  username      TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  phone         TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  is_manager    INTEGER NOT NULL DEFAULT 0,
  is_limited    INTEGER NOT NULL DEFAULT 0,
  rank          TEXT    NOT NULL DEFAULT 'user',
  avatar_color  TEXT    NOT NULL DEFAULT '#4f46e5',
  avatar        TEXT,
  last_activity TEXT,
  created_at    TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users (username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email    ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone    ON users (phone);

-- key/value settings (signup_mode: open | approval | closed)
CREATE TABLE IF NOT EXISTS bm_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- pending signups waiting for admin approval (signup_mode = approval)
CREATE TABLE IF NOT EXISTS signup_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT    NOT NULL,
  username    TEXT    NOT NULL,
  email       TEXT    NOT NULL,
  phone       TEXT    NOT NULL,
  password    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  TEXT    NOT NULL,
  decided_at  TEXT,
  decided_by  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_signup_requests_status ON signup_requests (status);

-- chat between a pending signup applicant and the manager
CREATE TABLE IF NOT EXISTS signup_request_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   INTEGER NOT NULL,
  body         TEXT    NOT NULL,
  from_manager INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signup_req_msg ON signup_request_messages (request_id);

CREATE TABLE IF NOT EXISTS verification_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,
  code       TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vc_identifier ON verification_codes (identifier);
CREATE INDEX IF NOT EXISTS idx_vc_ident_purpose ON verification_codes (identifier, purpose);

CREATE TABLE IF NOT EXISTS meetings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  creator_id     INTEGER NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  default_media  INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_meetings_room_id ON meetings (room_id);
CREATE INDEX IF NOT EXISTS idx_meetings_creator ON meetings (creator_id);

CREATE TABLE IF NOT EXISTS meeting_participants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id   INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  display_name TEXT    NOT NULL,
  username     TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  role         TEXT    NOT NULL DEFAULT 'member',
  muted        INTEGER NOT NULL DEFAULT 0,
  cam_on       INTEGER NOT NULL DEFAULT 0,
  sharing      INTEGER NOT NULL DEFAULT 0,
  joined_at    TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_participants_meeting_user ON meeting_participants (meeting_id, user_id);
CREATE INDEX IF NOT EXISTS idx_participants_meeting ON meeting_participants (meeting_id);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id    INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  display_name  TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  client_msg_id TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_meeting ON messages (meeting_id);
CREATE INDEX IF NOT EXISTS idx_messages_meeting_id ON messages (meeting_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_client ON messages (meeting_id, user_id, client_msg_id);

CREATE TABLE IF NOT EXISTS emoji_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id   INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  display_name TEXT    NOT NULL,
  emoji        TEXT    NOT NULL,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emoji_meeting ON emoji_events (meeting_id);
CREATE INDEX IF NOT EXISTS idx_emoji_meeting_id ON emoji_events (meeting_id, id);

CREATE TABLE IF NOT EXISTS meeting_blocks (
  meeting_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_user ON meeting_blocks (user_id);

CREATE TABLE IF NOT EXISTS pv_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  from_manager  INTEGER NOT NULL DEFAULT 0,
  body          TEXT    NOT NULL,
  seen          INTEGER NOT NULL DEFAULT 0,
  client_msg_id TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pv_user ON pv_messages (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pv_client ON pv_messages (user_id, from_manager, client_msg_id);

CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_migrations_name ON migrations (name);

CREATE TABLE IF NOT EXISTS bm_sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO migrations (name, applied_at) VALUES ('001_phase0_schema', '2026-01-01 00:00:00');
INSERT OR IGNORE INTO migrations (name, applied_at) VALUES ('002_phase1_realtime', '2026-01-01 00:00:00');