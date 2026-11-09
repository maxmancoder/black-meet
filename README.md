# Black Meet - Technical Reference (for AI-assisted development)

## 1. Project Overview

**Black Meet** is a Persian-language group audio/video calling web application (similar to Google Meet). It runs as a single Node.js process serving EJS templates, REST APIs, and Socket.IO real-time communication, backed by SQLite.

### Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node.js >= 24 < 25 | Required for `node:sqlite` |
| Web Framework | Express.js | Serves pages under `/black-meet/*` prefix (except `/socket.io/`) |
| Real-time | Socket.IO | WebRTC signaling, presence, chat, call state |
| Templating | EJS | Server-rendered views in `server/views/` |
| Database | SQLite via `node:sqlite` (`DatabaseSync`) | WAL mode, schema in `server/lib/schema.sql` |
| Auth | Session-based (SQLite-backed `bm_sessions`) + HMAC socket tokens (24h TTL) + CSRF tokens | `bm` cookie, HttpOnly, SameSite=Lax |
| Styling | Tailwind CSS (self-hosted) + custom CSS (`assets/css/styles.css`, `dashboard.css`) | CSS variables with `--bm-*` theme tokens |
| WebRTC | Native RTCPeerConnection | Perfect negotiation, ICE restart recovery, TURN relay support |
| Fonts | Vazirmatn, Digi Ghaf Bold, Entezar (local) | No CDN fonts |

### Architecture Summary
- **Single process**: `server/index.js` creates HTTP server, attaches Socket.IO via `server/sockets.js`, mounts Express app from `server/app.js`.
- **Route split**: Page routes in `server/routes/pages.js` render EJS views. API routes in `server/routes/api.js` handle REST endpoints under `/black-meet/api`.
- **Shared events**: All Socket.IO event names defined once in `shared/socket-events.js` as `BMEv` (UMD module, available as `window.BMEv` in browser and `require()` in Node).
- **In-memory state**: Call rooms tracked in `server/lib/state.js` (`rooms`, `userSockets` Maps). Sockets wrapped to make `internal` calls async-safe.
- **TURN/ICE**: Configured dynamically by `server/lib/turn.js` with fallback chain (owner servers → credentials endpoint → local → free public `turn.jami.net`).

---

## 2. Project Structure

```
black-meet/
├── server/
│   ├── index.js              # Entry point - creates HTTP server, attaches Socket.IO, starts app
│   ├── app.js                # Express app factory: middleware, static serving, route mounting
│   ├── sockets.js            # Socket.IO server logic - all call/presence/PM events
│   ├── routes/
│   │   ├── pages.js          # Page routes rendering EJS views, pageLocals helpers
│   │   └── api.js            # REST API endpoints under /black-meet/api
│   ├── lib/                  # Core utilities and services
│   │   ├── db.js             # SQLite connection, migrations, backup/restore
│   │   ├── schema.sql        # Database schema (idempotent)
│   │   ├── config.js         # App configuration loader
│   │   ├── helpers.js        # URL helpers, tokens, formatting, turnConfig
│   │   ├── sessions.js       # Session management (bm_sessions table)
│   │   ├── ranks.js          # Role/rank system and permissions
│   │   ├── settings.js       # Key-value settings (signup_mode, etc.)
│   │   ├── pwd.js            # Password hashing (bcryptjs) with legacy plaintext upgrade
│   │   ├── otp.js            # OTP generation and verification
│   │   ├── state.js          # In-memory rooms/userSockets Maps
│   │   ├── internal.js       # Internal business logic used by sockets (async)
│   │   ├── bus.js            # Event bus for cross-component notifications
│   │   ├── turn.js           # ICE/TURN configuration and health probing
│   │   ├── themes.js         # Theme CSS loading from design folder
│   │   ├── siteicon.js       # Site icon stored in DB (bm_assets)
│   │   ├── avatars.js        # User avatars stored in DB (bm_avatars)
│   │   ├── callfiles.js      # Shared files in calls (temp storage)
│   │   ├── siteproxy.js      # Same-origin proxy for shared website with SSRF protection
│   │   ├── usersdb.js        # Users archive (separate SQLite + Neon sync)
│   │   ├── neon.js           # Postgres mirror for users/avatars
│   │   └── plaintext.js      # Owner-readable password storage (optional)
│   └── views/                # EJS templates
│       ├── head.ejs          # Common head partial (meta, CSS, scripts, globals)
│       ├── index.ejs         # Login/Signup/OTP views
│       ├── home.ejs          # Dashboard home
│       ├── create.ejs        # Create meeting
│       ├── call.ejs          # Video call room
│       ├── messages.ejs      # Messaging
│       ├── profile.ejs       # User profile
│       ├── admin_members.ejs # Member management
│       ├── forgot_password.ejs # Password recovery/chat
│       ├── meetings.ejs      # All meetings list
│       ├── dash_*.ejs        # Dashboard partials (sidebar, bottomnav, etc.)
│       └── login-form.ejs    # Login form partial
├── shared/
│   └── socket-events.js      # BMEv constants - single source of truth
├── assets/
│   ├── css/
│   │   ├── styles.css       # Custom styles, CSS variables (--bm-*), fonts
│   │   ├── dashboard.css    # Dashboard skin styles
│   │   └── tailwind.css     # Compiled Tailwind (committed)
│   └── js/                  # Frontend modules (see section 9)
├── icons/                    # SVG sprite and site icons
├── fonts/                    # Local font files
├── bin/
│   ├── tunnel.ps1           # Tunnel chain script
│   └── cloudflared.exe      # Cloudflare tunnel binary
├── tools/
│   └── gen-icons.js         # Generate sprite from Material Symbols
├── start.bat                # Launch all services
└── package.json             # Dependencies and scripts
```

---

## 3. Database Schema

All tables defined in `server/lib/schema.sql`. Timestamps are stored as local time strings written by the app (via `sqlNow()`).

### Core Tables

#### `users`
Primary user accounts.
| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | - | User ID |
| `full_name` | TEXT NOT NULL | - | Full name |
| `username` | TEXT NOT NULL | - | Unique username |
| `email` | TEXT NOT NULL | - | Unique email |
| `phone` | TEXT NOT NULL | - | Unique phone |
| `password_hash` | TEXT NOT NULL | - | bcrypt hash |
| `display_name` | TEXT NOT NULL | - | Display name shown in UI |
| `is_manager` | INTEGER NOT NULL | 0 | 1 if main manager (super admin) |
| `is_limited` | INTEGER NOT NULL | 0 | 1 if account is restricted |
| `rank` | TEXT NOT NULL | 'user' | `user` \| `admin` \| `premium` (ignored if `is_manager=1`) |
| `avatar_color` | TEXT NOT NULL | '#4f46e5' | Avatar background color |
| `avatar` | TEXT | NULL | Avatar URL/path with cache-buster |
| `last_activity` | TEXT | NULL | Last activity timestamp |
| `created_at` | TEXT NOT NULL | - | Account creation time |

**Indexes:** `uq_users_username`, `uq_users_email`, `uq_users_phone`

#### `bm_settings`
Key-value configuration.
| Column | Type | Purpose |
|---|---|---|
| `key` | TEXT PRIMARY KEY | Setting name |
| `value` | TEXT NOT NULL | Setting value |

Common keys: `signup_mode` (`open`/`approval`/`closed`), `display_name_change:<userId>` (timestamp of last change).

#### `signup_requests`
Pending signups in approval mode.
| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | - | Request ID |
| `full_name` | TEXT NOT NULL | - | Applicant name |
| `username` | TEXT NOT NULL | - | Requested username |
| `email` | TEXT NOT NULL | - | Email |
| `phone` | TEXT NOT NULL | - | Phone |
| `password` | TEXT NOT NULL | - | **Hashed** password |
| `status` | TEXT NOT NULL | 'pending' | `pending` \| `approved` \| `rejected` |
| `created_at` | TEXT NOT NULL | - | Request time |
| `decided_at` | TEXT | NULL | Decision time |
| `decided_by` | INTEGER | NULL | Admin user ID who decided |

**Index:** `idx_signup_requests_status`

#### `signup_request_messages`
Chat thread between applicant and manager for pending requests.
| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | - | Message ID |
| `request_id` | INTEGER NOT NULL | - | FK to `signup_requests.id` |
| `body` | TEXT NOT NULL | - | Message content |
| `from_manager` | INTEGER NOT NULL | 0 | 1 if sent by manager |
| `created_at` | TEXT NOT NULL | - | Timestamp |

**Index:** `idx_signup_req_msg`

#### `verification_codes`
OTP codes for signup/login.
| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | ID |
| `identifier` | TEXT NOT NULL | Phone/email |
| `code` | TEXT NOT NULL | OTP code |
| `purpose` | TEXT NOT NULL | `signup` \| `login_phone` |
| `expires_at` | TEXT NOT NULL | Expiration time |
| `created_at` | TEXT NOT NULL | Creation time |

**Indexes:** `idx_vc_identifier`, `idx_vc_ident_purpose`

#### `meetings`
Meeting rooms.
| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | - | Meeting ID |
| `room_id` | TEXT NOT NULL | - | Public room identifier (unique) |
| `title` | TEXT NOT NULL | - | Meeting title |
| `creator_id` | INTEGER NOT NULL | - | Creator user ID |
| `active` | INTEGER NOT NULL | 1 | 1 if active |
| `default_media` | INTEGER NOT NULL | 1 | Default media state |
| `open_join` | INTEGER NOT NULL | 0 | 1 if join without approval enabled |
| `created_at` | TEXT NOT NULL | - | Creation time |

**Indexes:** `uq_meetings_room_id`, `idx_meetings_creator`

#### `meeting_participants`
Participants in meetings.
| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | - | Participant record ID |
| `meeting_id` | INTEGER NOT NULL | - | FK to `meetings.id` |
| `user_id` | INTEGER NOT NULL | - | FK to `users.id` |
| `display_name` | TEXT NOT NULL | - | Display name at join time |
| `username` | TEXT NOT NULL | - | Username at join time |
| `status` | TEXT NOT NULL | 'pending' | `pending` \| `approved` \| `removed` |
| `role` | TEXT NOT NULL | 'member' | `admin` \| `member` |
| `muted` | INTEGER NOT NULL | 0 | Mute state |
| `cam_on` | INTEGER NOT NULL | 0 | Camera state |
| `sharing` | INTEGER NOT NULL | 0 | Screen share state |
| `joined_at` | TEXT NOT NULL | - | Join time |

**Indexes:** `uq_participants_meeting_user`, `idx_participants_meeting`

#### `messages`
In-call chat messages.
| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | - | Message ID |
| `meeting_id` | INTEGER NOT NULL | - | FK to `meetings.id` |
| `user_id` | INTEGER NOT NULL | - | Sender user ID |
| `display_name` | TEXT NOT NULL | - | Sender name |
| `body` | TEXT NOT NULL | - | Message content |
| `client_msg_id` | TEXT | NULL | Client-generated message ID for deduplication |
| `created_at` | TEXT NOT NULL | - | Timestamp |

**Indexes:** `idx_messages_meeting`, `idx_messages_meeting_id`, `uq_messages_client`

#### `emoji_events`
Emoji reactions in calls.
| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | ID |
| `meeting_id` | INTEGER NOT NULL | Meeting ID |
| `user_id` | INTEGER NOT NULL | User ID |
| `display_name` | TEXT NOT NULL | Display name |
| `emoji` | TEXT NOT NULL | Emoji character |
| `created_at` | TEXT NOT NULL | Timestamp |

**Indexes:** `idx_emoji_meeting`, `idx_emoji_meeting_id`

#### `meeting_blocks`
Blocked users per meeting.
| Column | Type | Purpose |
|---|---|---|
| `meeting_id` | INTEGER NOT NULL | Meeting ID (composite PK) |
| `user_id` | INTEGER NOT NULL | Blocked user ID |

**Index:** `idx_blocks_user`

#### `pv_messages`
Private messages between users and manager.
| Column | Type | Default | Purpose |
|---|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | - | Message ID |
| `user_id` | INTEGER NOT NULL | - | Thread owner (the user) |
| `from_manager` | INTEGER NOT NULL | 0 | 1 if from manager |
| `body` | TEXT NOT NULL | - | Message content |
| `seen` | INTEGER NOT NULL | 0 | Read status |
| `client_msg_id` | TEXT | NULL | Client message ID |
| `created_at` | TEXT NOT NULL | - | Timestamp |

**Indexes:** `idx_pv_user`, `uq_pv_client`

#### `announcements`
Public announcements.
| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | ID |
| `body` | TEXT NOT NULL | Announcement content |
| `created_at` | TEXT NOT NULL | Timestamp |

#### `bm_sessions`
Server-side sessions.
| Column | Type | Default | Purpose |
|---|---|---|---|
| `sid` | TEXT PRIMARY KEY | - | Session ID |
| `data` | TEXT NOT NULL | '{}' | JSON session data |
| `created_at` | TEXT NOT NULL | - | Creation time |
| `updated_at` | TEXT NOT NULL | - | Last update |

#### `bm_assets`
Site assets (e.g., site icon) stored in DB.
| Column | Type | Purpose |
|---|---|---|
| `name` | TEXT PRIMARY KEY | Asset name |
| `mime` | TEXT NOT NULL | MIME type |
| `data` | BLOB NOT NULL | Asset bytes |
| `updated_at` | TEXT NOT NULL | Update time |

#### `bm_avatars`
User profile pictures stored in DB (mirrored to Neon).
| Column | Type | Purpose |
|---|---|---|
| `user_id` | INTEGER PRIMARY KEY | User ID |
| `mime` | TEXT NOT NULL | MIME type |
| `ext` | TEXT NOT NULL | File extension |
| `data` | BLOB NOT NULL | Image bytes |
| `updated_at` | INTEGER NOT NULL | Unix timestamp in ms |

#### `migrations`
Migration tracking.
| Column | Type | Purpose |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | ID |
| `name` | TEXT NOT NULL | Migration name (unique) |
| `applied_at` | TEXT NOT NULL | Application time |

**Migrations applied:** `001_phase0_schema`, `002_phase1_realtime`

---

## 4. Socket Events (BMEv)

Defined in `shared/socket-events.js`. All events are available as `window.BMEv` in browser and `require('../shared/socket-events')` in Node. `BMEv.ALL` contains all string values.

### Connection / Presence
| Constant | String Value | Direction | Payload | Description |
|---|---|---|---|---|
| `AUTH_HELLO` | `auth:hello` | client→server | `{name?, username?}` | Send user info after auth |
| `PRESENCE_PING` | `presence:ping` | client→server | `{}` | Heartbeat ping |
| `PRESENCE_ONLINE` | `presence:online` | server→client | `{userId}` | User came online |
| `PRESENCE_OFFLINE` | `presence:offline` | server→client | `{userId}` | User went offline |
| `CONN_STATE` | `conn:state` | server→client | `{state: 'connected'/'disconnected'/'reconnecting', userId?}` | Connection state update |

### Meeting Room (Call Page)
| Constant | String Value | Direction | Payload | Description |
|---|---|---|---|---|
| `CALL_JOIN` | `call:join` | client→server | `{room, user, token, sessionKey}` | Join a call room |
| `CALL_WELCOME` | `call:welcome` | server→client | `{meeting, you, members, blocked, web, openJoin}` | Room state on join |
| `CALL_SIGNAL` | `call:signal` | both | `{to, data: {type:'desc'|'ice', ...}}` or `{from, data}` | WebRTC signaling |
| `CALL_CHAT_SEND` | `chat:send` | client→server | `{body, clientMsgId}` | Send in-call chat message |
| `CHAT_NEW_MESSAGE` | `chat:new-message` | server→client | `{id, userId, name, body, clientMsgId, ts}` | New in-call message |
| `CHAT_ACK` | `chat:ack` | server→client | `{ok, clientMsgId, id?, error?}` | Message send acknowledgment |
| `CALL_EMOJI` | `call:emoji` | client→server | `{emoji}` | Send emoji reaction |
| `EMOJI` | `emoji` | server→client | `{userId, name, emoji}` | Emoji received |
| `CALL_STATUS` | `call:status` | client→server | `{muted?, cam?, sharing?, shareAudio?}` | Update media status |
| `MEMBER_UPDATED` | `member:updated` | server→client | `{userId, muted?, cam?, sharing?, shareAudio?, is_admin?, locks?}` | Member status changed |
| `CALL_PING` | `call:ping` | client→server | `{t}` | Latency ping |
| `CALL_PONG` | `call:pong` | server→client | `{t}` | Latency pong response |
| `PING_STATS` | `ping:stats` | server→client | `{pings: {userId: rtt}}` | Latency stats broadcast (every 3s) |

### Shared Web Surface
| Constant | String Value | Direction | Payload | Description |
|---|---|---|---|---|
| `CALL_WEB_OPEN` | `call:web-open` | client→server | `{kind:'site'|'video'|'audio'|'file', url, mode?, follow?}` | Open shared web/audio/video/file box |
| `CALL_WEB_CLOSE` | `call:web-close` | client→server | `{}` | Close shared box (admin only) |
| `CALL_WEB_FOLLOW` | `call:web-follow` | client→server | `{on: boolean}` | Toggle simultaneous access |
| `CALL_WEB_RIGHTS` | `call:web-rights` | client→server | `{control?, view?}` | Set control/view permissions (admin only) |
| `CALL_WEB_SYNC` | `call:web-sync` | client→server | `{kind:'scroll'|'click'|'navigate'|'video'|'audio'|'fscroll', ...}` | Sync actions from controller |
| `WEB_STATE` | `web:state` | server→client | `{web: {...}|null, openJoin?}` | Shared box state update |
| `WEB_SYNC` | `web:sync` | server→client | `{kind, userId, ...}` | Synced action for others |
| `WEB_ERR` | `web:err` | server→client | `{msg}` | Web box error |

### Member Lifecycle
| Constant | String Value | Direction | Payload | Description |
|---|---|---|---|---|
| `CALL_APPROVE` | `call:approve` | client→server | `{userId}` | Approve pending member (admin) |
| `CALL_REJECT` | `call:reject` | client→server | `{userId}` | Reject pending member (admin) |
| `CALL_KICK` | `call:kick` | client→server | `{userId}` | Kick member (admin) |
| `CALL_BLOCK` | `call:block` | client→server | `{userId}` | Block member (admin) |
| `CALL_ALERT_ADMIN` | `call:alert-admin` | client→server | `{}` | Alert admins of join request |
| `CALL_SET_OPEN_JOIN` | `call:set-open-join` | client→server | `{on: boolean}` | Toggle join without approval (admin) |
| `OPEN_JOIN_CHANGED` | `call:open-join-changed` | server→client | `{openJoin: boolean}` | Open-join setting changed |
| `ADMIN_CHANGED` | `admin-changed` | server→client | `{userId, name, reason, toast}` | Admin handed over |
| `CALL_LEAVE` | `call:leave` | client→server | `{}` | Leave call room |
| `CALL_DISABLE` | `call:disable` | client→server | `{userId, kind:'audio'|'video'|'screen', off: boolean}` | Force disable/lock or unlock (admin) |
| `FORCE_DISABLE` | `force-disable` | server→client | `{kind, off}` | Force control state on user |
| `MEMBER_JOINED` | `member:joined` | server→client | `{member}` | Member joined (approved) |
| `MEMBER_LEFT` | `member:left` | server→client | `{userId}` | Member left |
| `MEMBER_APPROVED` | `member:approved` | server→client | `{member}` | Member approved |
| `MEMBER_PENDING` | `member:pending` | server→client | `{member}` | Member pending approval |
| `MEMBER_BLOCKED` | `member:blocked` | server→client | `{userId}` | Member blocked |
| `MEMBER_KICKED` | `member:kicked` | server→client | `{userId, reason}` | Member kicked |
| `YOU_APPROVED` | `you-approved` | server→client | `{ok, via?}` | Current user approved |
| `YOU_REJECTED` | `you-rejected` | server→client | `{ok, reason?}` | Current user rejected |
| `YOU_REMOVED` | `you-removed` | server→client | `{ok, reason}` | Current user removed |
| `CALL_SOLO_ENDED` | `call:alone-ended` | server→client | `{minutes}` | Solo call time limit ended |
| `YOU_BLOCKED` | `you-blocked` | server→client | `{ok}` | Current user blocked |
| `JOIN_ALERT` | `join-alert` | server→client | `{userId, name}` | Alert for pending join request |

### 1:1 Call Requests
| Constant | String Value | Direction | Payload | Description |
|---|---|---|---|---|
| `CALLREQ_SEND` | `callreq:send` | client→server | `{toUserId, roomId?}` | Send call request |
| `CALLREQ_INCOMING` | `callreq:incoming` | server→client | `{requestId, fromUserId, fromName}` | Incoming call request |
| `CALLREQ_ACCEPT` | `callreq:accept` | client→server | `{requestId}` | Accept request |
| `CALLREQ_REJECT` | `callreq:reject` | client→server | `{requestId}` | Reject request |
| `CALLREQ_CANCEL` | `callreq:cancel` | client→server | `{requestId}` | Cancel request |
| `CALLREQ_ACCEPTED` | `callreq:accepted` | server→client | `{requestId, fromUserId, roomId}` | Request accepted |
| `CALLREQ_REJECTED` | `callreq:rejected` | server→client | `{requestId, fromUserId}` | Request rejected |
| `CALLREQ_CANCELLED` | `callreq:cancelled` | server→client | `{requestId, reason}` | Request cancelled |
| `CALLREQ_BUSY` | `callreq:busy` | server→client | `{requestId, fromUserId}` | Recipient busy |
| `CALLREQ_ENDED` | `callreq:ended` | server→client | `{requestId, byUserId}` | Call request ended |

### Private Messages
| Constant | String Value | Direction | Payload | Description |
|---|---|---|---|---|
| `PV_SEND` | `pv:send` | client→server | `{toUserId, body, clientMsgId}` | Send PM (manager only) |
| `PV_NEW_MESSAGE` | `pv:new-message` | server→client | `{id, fromUserId, fromName, body, clientMsgId, fromManager, ts}` | New PM |
| `PV_ACK` | `pv:ack` | server→client | `{ok, clientMsgId, id?, error?}` | PM send ack |
| `PV_CONVERSATION_UPDATED` | `pv:conversation-updated` | server→client | `{userId, lastBody, fromManager, ts}` | Conversation list update |

### Notifications & Misc
| Constant | String Value | Direction | Payload | Description |
|---|---|---|---|---|
| `NOTIF_NEW` | `notif:new` | server→client | `{id, body, created_at, fromUserId?}` | New notification/announcement |
| `SR_NEW_MESSAGE` | `sr:new-message` | server→client | `{requestId, message}` | New message in signup request thread |
| `SR_NEW_REQUEST` | `sr:new-request` | server→client | `{requestId, name, ts}` | New signup request |
| `BM_SUBSCRIBE` | `bm:subscribe` | client→server | `{room}` | Subscribe to broadcast room |
| `BM_EVENT` | `bm:event` | server→client | `{event, data}` | Broadcast event envelope |
| `ERR` | `err` | server→client | `{ok:false, error/msg}` | Error event |

---

## 5. Socket Room Logic

### Room Structure (`server/lib/state.js`)
```javascript
{ rooms: new Map(), userSockets: new Map() }
```
- `rooms`: `roomId` → `{ meetingId, sockets: Map<socketId, socketInfo>, userSockets: Map<userId, Set<socketId>>, pending: Set<userId>, blocked: Set<userId>, web: {...}|null, locks: {...}|null, openJoin: boolean }`
- `userSockets`: `userId` → `Set<socketId>` (global presence across all sockets)

### Socket Info Per Connection
Stored in `rooms.get(roomId).sockets.get(socketId)`:
```javascript
{
  userId, name, username, avatar_color, avatar,
  is_admin, muted, cam, sharing, approved, status,
  sessionKey  // per page load for reconnect detection
}
```

Socket-level data: `socket.data.userId`, `socket.data.meetingId`, `socket.data.isManager` (DB-derived, **never from client**), `socket.data.room`, `socket.data.is_admin`, `socket.data.name`, `socket.data.username`.

### Join Flow (`CALL_JOIN`)
1. Validate token, check `room` exists, verify user matches token
2. Call `internal.meetingState(room, uid)` to get meeting state, check blocks
3. Determine role: `isAdmin` from `meetingState` or role from DB; `approvedBefore = (you.status === 'approved') || isAdmin`
4. Create room if not exists, handle reconnection (same `sessionKey` = silent drop of old socket; different = send `YOU_REMOVED`)
5. Build socket info, check `internalRaw.isOpenJoin(meetingId)` if not approved (approve directly, set `openJoin: true`)
6. Join socket room, store in `rooms.sockets` and `rooms.userSockets`
7. Send `CALL_WELCOME` with `you` (with locks), `members` (excluding self, with locks), `blocked`, `web`, `openJoin`
8. Replay admin locks via `FORCE_DISABLE` if any
9. If approved → emit `YOU_APPROVED`, `MEMBER_JOINED`; else add to `pending`, emit `MEMBER_PENDING`
10. Call `updateSoloTimer(room)` - if solo, start 15min timer

### Call Admin/Host Identification
- **In call room**: Determined by `part.role === 'admin'` in `meeting_participants` table. Set at join from `meetingState()`. Tracked per-socket as `s.is_admin`. Admin status can be transferred via `scheduleAdminHandover()` if the last admin leaves (picks most chat-active member or random, after 2.5s delay with reload detection). Handed over member gets `ADMIN_CHANGED` and admin panel without reload.
- **Meeting creator**: `meetings.creator_id` is the original creator. Used for API checks (`/meetings/remove`, `/meetings/delete` by creator). Room admin in socket is separate from meeting creator.
- **Main manager**: `users.is_manager = 1` is the super admin across the entire app (above ranks). Set only via env/config seeding.

### Leave/Disconnect
- `leaveRoom(sock)`: Remove from `rooms.sockets`, remove from user's socket set in room; if user's last socket in room → remove from `userSockets`, delete from `pending`, emit `MEMBER_LEFT`, schedule admin handover if they were admin. If room empty → delete room, cancel solo timer, schedule meeting close (5s delay).
- On `disconnect`: call `leaveRoom`, remove from global `userSockets`, emit `PRESENCE_OFFLINE` if last socket for user.

### Permissions in Socket Handlers
- `requireRoomAdmin()`: Returns room if current socket is admin in room, else `null`
- `canControlWeb(r, s)`: If `web.controlAll !== false` return true, else check if in `controllers` set
- `canViewWeb(r, s)`: If `web.viewersAll !== false` return true, else check if in `viewers` set
- `socket.data.isManager`: DB-derived at connection, gates `PV_SEND`, `pvToManagers`, etc. Never trusted from client.

---

## 6. REST API Reference

All endpoints under `/black-meet/api` (mounted in `app.js` line ~58). CSRF required on POST. Auth checked via `sessions.currentUser()` / `requireLoginApi()`.

### Auth / OTP
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| POST | `/api/signup` | No | Yes | `{full_name, username, email, phone, password}` | `open`: `{ok:true, phone, purpose:'signup', otp?}`. `approval`: `{ok:true, pending:true, phone, msg}`. `closed`: `{ok:false, msg}` |
| POST | `/api/login/phone` | No | Yes | `{phone}` | `{ok:true, phone, purpose:'login_phone', otp?}` |
| POST | `/api/login/resend` | No | Yes | `{phone, purpose?}` | `{ok:true, msg, otp?}` |
| POST | `/api/login/verify` | No | Yes | `{phone, code, purpose, next?}` | `{ok:true, redirect}` |
| POST | `/api/login/email` | No | Yes | `{email, password, next?}` | `{ok:true, redirect}` or `{ok:false, msg}` |
| POST | `/api/logout` | Yes | No* | `{}` | `{ok:true, redirect}` |
| GET | `/api/socket-token` | Yes | No | - | `{ok:true, token, user_id}` |

### Meetings
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| POST | `/api/meetings/create` | Yes | Yes | `{title?, default_media?, open_join?}` | `{ok:true, room_id, redirect, share_url, quota}`. Checks `is_limited`, daily quota by rank |
| GET | `/api/meetings/info` | No | No | `?room=` | `{ok:true, room_id, title}` |
| POST | `/api/meetings/message` | Yes | Yes | `{meeting_id, body}` | `{ok:true}` |
| POST | `/api/meetings/emoji` | Yes | Yes | `{meeting_id, emoji}` | `{ok:true}` |
| POST | `/api/meetings/approve` | Yes (creator) | Yes | `{participant_id}` | `{ok:true}` |
| POST | `/api/meetings/reject` | Yes (creator) | Yes | `{participant_id}` | `{ok:true}` |
| POST | `/api/meetings/remove` | Yes (creator) | Yes | `{participant_id}` | `{ok:true, user_id}` |
| POST | `/api/meetings/mute` | Yes (creator) | Yes | `{participant_id, muted?}` | `{ok:true, user_id, muted}` |
| POST | `/api/meetings/delete` | Yes (creator or manager) | Yes | `{meeting_id}` | `{ok:true, id}`. Closes room if active |
| POST | `/api/meetings/leave` | Yes | Yes | `{meeting_id}` | `{ok:true}` |

### Profile
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| POST | `/api/profile/update` | Yes | Yes | `{display_name}` | `{ok:true, display_name}`. Once per day limit |
| GET | `/api/profile/display-name-status` | Yes | No | - | `{ok:true, canChange, lastChange, displayName}` |
| POST | `/api/profile/avatar` | Yes | Yes | multipart `avatar` (jpg/png/gif/webp, max 2MB) | `{ok:true, avatar}` (stored in DB) |

### Site Icon (Admin)
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| POST | `/api/admin/site-icon` | Yes (manager) | Yes | multipart `icon` (max 2MB) | `{ok:true, mime, size}` |
| POST | `/api/admin/site-icon/reset` | Yes (manager) | Yes | `{}` | `{ok:true}` |

### Call Files
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| POST | `/api/call/file` | Yes (room member) | Yes | multipart `file`, form `room` | `{ok:true, file:{id,name,mime,size,viewable,room,url}}` |
| GET | `/api/call/file/:id` | Yes (room member) | No | `?room=` | `{ok:true, file:{...}}` |

### Admin - Members & Users
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| ALL | `/api/admin/members` GET/POST | Yes (canManageUsers) | Yes for POST | GET: -; POST: `action` (`update`/`set_rank`/`reset_password`/toggle limited) + params | GET: `{ok:true, users}`. POST varies by action |
| GET | `/api/admin/users-archive` | Yes (canManageUsers) | No | - | `{ok:true, stats, users}` |
| GET | `/api/admin/users-archive/download` | Yes (canManageUsers) | No | - | File download `users_archive.db` |
| POST | `/api/admin/users-archive/restore` | Yes (canManageUsers) | Yes | `{overwrite?}` | `{ok:true, ...}` |
| POST | `/api/admin/users-archive/export` | Yes (canManageUsers) | Yes | `{}` | `{ok:true, synced, exported, dir}` |
| GET | `/api/turn-status` | Yes (canManageUsers) | No | `?probe=1` | `{ok:true, provider, publicFallback, turnCount, iceServers, probe}` |

### Admin - Signup Requests & Mode
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| POST | `/api/admin/signup-mode` | Yes (canChangeSignupMode) | Yes | `{mode:'open'|'approval'|'closed'}` | `{ok:true, mode}` |
| GET | `/api/admin/signup-requests` | Yes (canViewRequests) | No | - | `{ok:true, requests:[...with messages...], can_decide}` |
| POST | `/api/admin/signup-requests` | Yes (canDecideRequests) | Yes | `{request_id, action:'approve'|'reject'}` | `{ok:true, status, user?}` |
| POST | `/api/admin/signup-requests/message` | Yes (canDecideRequests) | Yes | `{request_id, body}` | `{ok:true, message}` |
| POST | `/api/admin/block` | Yes (meeting admin or manager) | Yes | `{meeting_id, user_id}` | `{ok:true}` |

### Announcements
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| ALL | `/api/announcements` GET/POST | Yes | Yes for POST | GET: -; POST: `{body}` (manager or premium only) | GET: `{ok:true, announcements}`; POST: `{ok:true}`. Broadcasts via `NOTIF_NEW` |

### Messages
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| ALL | `/api/messages/user` GET/POST | No* | No | GET: `?identifier=`; POST: `{identifier, body}` | Public endpoint for manager chat (including pending applicants). GET returns user/pending + messages; POST sends message and broadcasts to managers |
| ALL | `/api/messages/conversations` GET/POST | Yes | No | GET: `?user_id=` (manager sees all, premium sees only manager thread). POST not implemented | Manager: all conversations or thread. Premium: only admin chat thread. Stamps sender names, marks as seen |

### Other
| Method | Path | Auth | CSRF | Body/Params | Response |
|---|---|---|---|---|---|
| GET | `/api/themes` | No | No | - | `{ok:true, themes, current}` |
| GET | `/api/members/:userId` | Yes | No | - | Member info for 2 users sharing active meeting or self. Redacts manager/admin info for non-managers |

*Note: Some endpoints have no explicit auth check in the handler but may require session context.*

---

## 7. Page Routes

All routes defined in `server/routes/pages.js`, mounted at `/black-meet` in `app.js`. Views rendered from `server/views/`.

| Path | Method | Auth Required | EJS View | Description | Key Template Variables |
|---|---|---|---|---|---|
| `/`, `/login` | GET | No (redirects if logged in) | `index.ejs` | Login/Signup/OTP page | `title`, `base`, `csrf`, `asset()`, `url()`, `icon()`, `json()`, `siteIconUrl()`, `brandMark()` |
| `/home` | GET | Yes | `home.ejs` | Dashboard with recent meetings, stats, notifications | `me`, `recent`, `stats`, `memberSince`, `isManager`, `rankLabel`, `canMembers`, `canRequests`, `canMessages`, `quota`, `quotaText`, `firstName`, `initials`, `limited` |
| `/create` | GET | Yes | `create.ejs` | Create meeting page | `me`, `limited`, `quota`, `quotaFull`, `quotaText`, `isManager`, `rankLabel`, `canMessages`, `canMembers`, `canRequests`, `canCreate`, `createBlockMsg`, `initials` |
| `/profile` | GET | Yes | `profile.ejs` | User profile, avatar, display name, site icon (manager) | `me`, `av`, `rankLabel`, `isManager`, `canMessages`, `canMembers`, `canRequests`, `canCreate`, `createBlockMsg`, `initials` |
| `/meetings` | GET | Yes | `meetings.ejs` | All user's meetings list | `meetings`, `activeCount`, `endedCount`, `totalCount`, `limited`, `isManager`, `rankLabel`, `canMessages`, `canMembers`, `canRequests`, `canCreate`, `createBlockMsg`, `initials` |
| `/messages` | GET | Yes (canUseMessages) | `messages.ejs` | Messaging page | `isManager`, `rankLabel`, `canMessages`, `canMembers`, `canRequests`, `initials` |
| `/members` | GET | Yes (canViewMembers or canViewRequests) | `admin_members.ejs` | Member/request management | `me`, `users`, `requests`, `pendingCount`, `signupMode`, `isManager`, `canMessages`, `canCreate`, `createBlockMsg`, `canMembers`, `canRequests`, `canDecide`, `canChangeMode`, `rankLabel`, `initials` |
| `/forgot-password` | GET | No | `forgot_password.ejs` | Password recovery / applicant chat with manager | `title`, page locals |
| `/meeting?room=...` | GET | Yes (preserves `next` URL) | `call.ejs` | Video call room | `meeting`, `isAdmin`, `init` (with `meeting`, `me`, `token`, `iceServers`, `participants`, `messages`, `emojis`, `csrf`, `publicUrl`), `me`, `participants`, `initials`, `isManager` |
| `/theme.css` | GET | No | (dynamic) | Theme CSS from `bm_theme` cookie | - |
| `/site-icon` | GET | No | (dynamic) | Site icon from DB | - |
| `/site-proxy?u=...` | GET | Yes | (proxy) | Same-origin proxy for shared website | - |
| `/call-file/:id?room=...` | GET | Yes (room member) | (file serve) | Shared call file download/view | - |

---

## 8. EJS Views Reference

All views in `server/views/`. All use `head.ejs` partial which injects globals: `window.BASE`, `window.__BM_LIVE_URL`, `BM_SPRITE`, favicon from `siteIconUrl()`, loads `icons.js`, and includes `theme.css`.

| File | Page | Template Vars Received | Major UI Sections/IDs/Classes |
|---|---|---|---|
| `head.ejs` | Partial (included by all) | `base`, `title`, `asset()`, `siteIconUrl()` | Meta tags, Vazirmatn/Digi Ghaf Bold fonts, `styles.css`, `tailwind.css`, `theme.css`, `BM_SPRITE`, `icons.js`, sets `window.BASE`, `window.__BM_LIVE_URL` |
| `index.ejs` | Login/Signup | pageLocals | Body class `bm-auth font-body-md`. `.auth-shell` with `.auth-aside` (brand panel, >=900px) and `.auth-card`. Views toggled: `view-login-options`, `view-login-email`, `view-login-phone`, `view-otp`, `view-signup`, `view-signup-pending`. OTP uses 6 `.otp-cell` inputs. Buttons use `dash-btn-*` classes. |
| `forgot_password.ejs` | Password recovery / applicant chat | pageLocals | Body class `bm-auth font-body-md`. Auth shell with card. `#identify-box` for lookup, `#thread-box` with `#pv-messages` chat thread. Uses `.auth-bubble-row`, `.auth-bubble`. |
| `home.ejs` | Dashboard home | `me`, `recent`, `stats`, `memberSince`, `isManager`, `rankLabel`, `canMessages`, `canMembers`, `canRequests`, `quota`, `quotaText`, `firstName`, `initials` | Body class `bm-dash font-body-md`. Includes `dash_sidebar` (desktop + drawer), `dash_usermenu`, `dash_confirm`, `dash_toast`, `dash_bottomnav`. Hero section, stats grid, recent meetings `#recent-grid`, notifications bell `#bell-btn`/`#notif-popup`, join form `#join-form`/`#join-input`. |
| `create.ejs` | Create meeting | `limited`, `quota`, `quotaFull`, `quotaText`, `isManager`, `rankLabel`, `canMessages`, `canMembers`, `canRequests`, `canCreate`, `createBlockMsg`, `initials` | Body class `bm-dash font-body-md`. Dashboard shell. Form with `#meeting-title`, `#create-btn`. Themed switches for `#default-media` and `#open-join` (hidden native inputs). Hints `#media-hint`, `#openjoin-hint`. |
| `profile.ejs` | User profile | `av`, `rankLabel`, `isManager`, `canMessages`, `canMembers`, `canRequests`, `canCreate`, `createBlockMsg`, `initials` | Body class `bm-dash font-body-md`. Dashboard shell. Avatar `#ph-avatar`, name `#ph-name`, display name editor `#btn-edit-name`/`#dn-panel`, site icon card (manager only), access keys row. |
| `messages.ejs` | Messaging | `isManager`, `rankLabel`, `canMessages`, `canMembers`, `canRequests`, `initials` | Body class `bm-dash font-body-md msg-page`. **No bottom nav**. Layout: `.msg-main` with `.conv-panel` sidebar `#conv-list`/`#conv-search` and chat area `#chat-area` with `#chat-header`, `#chat-messages`, `#msg-input`/`.msg-send`. Mobile uses `#chat-back`. |
| `meetings.ejs` | All meetings | `meetings`, `activeCount`, `endedCount`, `totalCount`, `limited`, `isManager`, `rankLabel`, `canMessages`, `canMembers`, `canRequests`, `canCreate`, `createBlockMsg`, `initials` | Body class `bm-dash font-body-md`. Dashboard shell. Filter chips, `#recent-search`, `#recent-grid` with cards, delete via `deleteRecent()`. |
| `admin_members.ejs` | Member management | `me`, `users`, `requests`, `pendingCount`, `signupMode`, `isManager`, `canMessages`, `canCreate`, `createBlockMsg`, `canMembers`, `canRequests`, `canDecide`, `canChangeMode`, `rankLabel`, `initials` | Body class `bm-dash font-body-md`. Dashboard shell. Section switchers `#nav-members`/`#nav-requests` (dash-chip). User cards `#user-cards`, requests `#request-list`. Edit modal, rank menu, page size menu, signup mode dropdown `#mode-btn`. |
| `call.ejs` | Video call room | `meeting`, `isAdmin`, `init` (JSON), `me`, `participants`, `initials`, `isManager` | Body class `bm-call font-body-md`. Full-screen layout. `#video-grid` (call stage), `#control-bar` with media/share/chat/web buttons, sidebar `#call-sidebar` with tabs (members/chat/admin), web box `#web-box`, maximize overlay `#max-overlay`, net banner `#net-banner`, chat toast `#chat-toast`, emoji picker. |
| `dash_sidebar.ejs` | Sidebar partial | `activePage`, `drawer?` | Desktop sidebar + mobile drawer. Nav items for home/create/meetings/messages/members/profile. Logout button calls `logout()`. |
| `dash_bottomnav.ejs` | Bottom nav partial | `activePage` | Mobile bottom navigation (not included on messages page). |
| `dash_usermenu.ejs` | User menu partial | - | Dropdown menu with profile, notifications access, logout. |
| `dash_confirm.ejs` | Confirm dialog partial | - | `#bm-confirm` modal with title/body/yes/no buttons. |
| `dash_toast.ejs` | Toast partial | - | `#bm-toast` notification element. |
| `login-form.ejs` | Login form partial | - | Email/password login form used in index.ejs. |

---

## 9. Frontend JS Modules

### Core Modules
| File | Purpose | Key Functions/Features | Socket Events |
|---|---|---|---|
| `assets/js/call.js` | Main call room logic (~1130+ lines) | WebRTC perfect negotiation, ICE restart, media capture (separate mic/cam), silent keepalive audio track, noise suppression, tiles/grid layout, maximize overlay, admin controls, locks, ping, shared web box integration, chat toast | Listens: `CALL_WELCOME`, `MEMBER_JOINED/LEFT/UPDATED/PENDING/APPROVED/KICKED/BLOCKED`, `YOU_APPROVED/REJECTED/REMOVED/BLOCKED`, `CALL_SIGNAL`, `CHAT_NEW_MESSAGE/ACK`, `EMOJI`, `FORCE_DISABLE`, `JOIN_ALERT`, `ADMIN_CHANGED`, `OPEN_JOIN_CHANGED`, `CALL_SOLO_ENDED`, `CALL_PONG`, `PING_STATS`, `WEB_STATE/SYNC/ERR`. Emits: `CALL_JOIN`, `CALL_SIGNAL`, `CALL_CHAT_SEND`, `CALL_EMOJI`, `CALL_STATUS`, `CALL_PING`, `CALL_APPROVE/REJECT/KICK/BLOCK/ALERT_ADMIN/SET_OPEN_JOIN/LEAVE/DISABLE` |
| `assets/js/live.js` | Shared authenticated socket connection for non-call pages | Auto-connects with token from `/api/socket-token`, heartbeat every 25s, auto-reconnect with fresh token on auth failure, watchdog for wedged connections, event subscription system | Uses all `BMEv.ALL` events, subscribes to `bm:subscribe` rooms |
| `assets/js/icons.js` | SVG icon helpers | `bmIcon(name, cls, fill, extra)` returns SVG string; `setBMIcon(el, name, fill)` swaps `<use>` href. Uses `window.BM_SPRITE` | - |
| `assets/js/dashboard.js` | Dashboard UI chrome | Toast system (`bmToast`/`bmToastHide`), drawer, user menu, confirm dialog (`bmConfirm` returning Promise), notifications UI helpers, search with Persian normalization, keyboard shortcuts (⌘/Ctrl+K, Escape), focus trap, copy to clipboard (`copyMeetLink`) | - |

### Page-Specific Modules
| File | Purpose | Key Functions/Features |
|---|---|---|
| `assets/js/home.js` | Home dashboard logic | Recent meetings, notifications panel, join form validation, delete meeting, search/filter |
| `assets/js/messages.js` | Messaging page | Conversation list, chat thread, send messages, admin chat, unread counts, marks read on load |
| `assets/js/profile.js` | Profile page | Avatar upload, display name change (once per day), site icon management (manager), logout |
| `assets/js/admin_members.js` | Member management | User list, rank changes, limit toggle, password reset, signup requests with chat, approve/reject, signup mode toggle |
| `assets/js/create.js` | Create meeting page | Form submission, switches for default media/open join, quota display |
| `assets/js/auth.js` | Login/signup page | View switching, phone/email login, OTP input (6 cells), signup form, validation |
| `assets/js/forgot_password.js` | Password recovery | Find user/request thread, send messages |
| `assets/js/call-web.js` | Shared web surface logic | Web box rendering, site proxy iframe, scroll/click sync, video/audio player sync, file display |
| `assets/js/emoji-sfx.js` | Emoji sound effects | Web Audio synthesized sounds per emoji |
| `assets/js/interactions.js` | UI interactions | Button press effects, etc. |
| `assets/js/logout-confirm.js` | Logout confirmation | Uses `bmConfirm` if available, falls back to legacy modal |

---

## 10. CSS & Theming System

### CSS Files
| File | Purpose |
|---|---|
| `assets/css/styles.css` | Base styles, CSS variables, fonts (@font-face), custom utilities, scrollbars, call styles |
| `assets/css/dashboard.css` | Dashboard skin styles (`.bm-dash`, `.bm-auth`, `.bm-call` classes) |
| `assets/css/tailwind.css` | Compiled Tailwind CSS (committed, rebuild with `npm run tailwind:build`) |

### CSS Variable System (`--bm-*` tokens)
Defined in `:root` of `styles.css`. All colors use RGB triplet format for alpha transparency support: `rgb(var(--bm-*) / <alpha-value>)`.

Key variables include: `--bm-primary`, `--bm-on-primary`, `--bm-primary-container`, `--bm-secondary`, `--bm-surface`, `--bm-surface-container`, `--bm-surface-container-highest`, `--bm-on-surface`, `--bm-on-surface-variant`, `--bm-outline`, `--bm-error`, etc.

### Dashboard Tokens (`--d-*`)
Defined on `.bm-dash`, `.bm-auth` elements in `dashboard.css`:
`--d-bg`, `--d-surface`, `--d-accent`, `--d-text`, `--d-text-mute`, `--d-line`, `--d-line-strong`, etc.

### Theming System
- **Theme files**: Stored in `دیزاین بلک میت/` directory as CSS files (e.g., `obsidian_flux.css`)
- **Cookie**: `bm_theme` selects active theme
- **Route**: `GET /black-meet/theme.css` serves merged CSS (base + theme overrides) with `Cache-Control: no-cache`
- **API**: `GET /black-meet/api/themes` returns available themes and current theme
- **Loading**: `theme.css` is loaded in `head.ejs` after `tailwind.css`

### Body Classes
| Class | Usage | Notes |
|---|---|---|
| `bm-dash` | Home, profile, messages, meetings, members, create | Has `.hidden{display:none!important}` and icon size resets. Document layout props only apply here. |
| `bm-auth` | Login/signup/forgot password | Uses auth shell layout, has `.hidden` override considerations |
| `bm-call` | Call page | No `.hidden` override, preserves `h-screen` invariants |

### Tailwind Integration
- Config: `tailwind.config.js`
- Colors mapped to `rgb(var(--bm-*) / <alpha-value>)`
- JIT scans: `server/views/**/*.ejs`, `assets/js/**/*.js`, `shared/**/*.js`
- Rebuild after adding new utilities: `npm run tailwind:build`

---

## 11. Role & Permission System

Defined in `server/lib/ranks.js`. `is_manager` (from `users.is_manager`) is the super admin, above all ranks.

### Ranks
| Rank | Label | Daily Meeting Limit | Description |
|---|---|---|---|
| `user` | کاربر عادی | 2 | Regular member |
| `admin` | ادمین | 5 | Can view members and requests |
| `premium` | ادمین پریمیوم | 15 | Can view/edit members, approve/reject requests, use messages |
| `manager` | مدیر اصلی | 0 (unlimited) | All permissions, cannot be limited/edited by others, info hidden from non-managers |

### Permissions Matrix
| Permission | Function | `user` | `admin` | `premium` | `manager` |
|---|---|---|---|---|---|
| View members list | `canViewMembers()` | No | No | Yes | Yes |
| View signup requests | `canViewRequests()` | No | Yes | Yes | Yes |
| Approve/reject requests, reply | `canDecideRequests()` | No | No | Yes | Yes |
| Change signup mode | `canChangeSignupMode()` | No | No | Yes | Yes |
| Manage users (edit/rank/reset) | `canManageUsers()` | No | No | Yes | Yes |
| Use messages console | `canUseMessages()` | No | No | Yes | Yes |
| Create meetings | Limited by `dailyLimitOf()` | 2/day | 5/day | 15/day | Unlimited |
| Delete any meeting | API check | No | No | No | Yes (or creator) |

### Enforcement
- **Daily quota**: Enforced server-side in `POST /api/meetings/create` by counting meetings created today (`substr(created_at,1,10)` = local date). Error message includes `سقف تماس امروز`.
- **API protection**: Endpoints check permissions via rank functions.
- **Socket protection**: Room admin checked via `requireRoomAdmin()`. Manager flag is DB-derived at socket connection.
- **UI gating**: Pages/routes check permissions and redirect or hide elements.

### Signup Modes (`server/lib/settings.js`)
| Mode | Value | Behavior |
|---|---|---|
| Open | `open` (default) | Anyone can register, account created immediately, proceeds to OTP |
| Approval | `approval` | Registration saved to `signup_requests`, user sees pending message, can chat with manager via `/forgot-password?id=<phone>`, account created only on approval |
| Closed | `closed` | Registration disabled, returns `SIGNUP_CLOSED_MSG` |

Managed via `POST /api/admin/signup-mode` (requires `canChangeSignupMode`). Requests managed via admin endpoints.

---

## 12. Icon System

### Server-side (EJS)
In `pageLocals` (`server/routes/pages.js`), the `icon()` helper is available:
```javascript
icon(name, cls, fill, extraAttrs)
// Returns: <svg class="bm-ico <cls>" <extraAttrs> aria-hidden="true" focusable="false">
//            <use href="<assetUrl('icons/sprite.svg')>#ic-<name><'-fill' if fill>"></use>
//          </svg>
```
Usage in templates: `<%- icon('mic', 'text-[20px]', true) %>`

### Client-side (JavaScript)
From `assets/js/icons.js`:
```javascript
window.bmIcon(name, cls, fill, extra) // returns HTML string
window.setBMIcon(el, name, fill)      // swaps <use> href in existing icon element
```
Sprite path from `window.BM_SPRITE` or defaults to `/black-meet/icons/sprite.svg`.

### Icon Sprite
- Located at `icons/sprite.svg`
- Generated from `fonts/material-symbols.woff2` using `tools/gen-icons.js`
- Regenerate: `npm i --no-save fontkit wawoff2 && node tools/gen-icons.js`
- Icons referenced as `#ic-<name>` or `#ic-<name>-fill` for filled variants
- Always use `<svg class="bm-ico">` with `<use>` - never icon fonts

---

## 13. Adding New Features — Developer Guide

### Adding New BMEv Constants
1. Edit `shared/socket-events.js` - add constant to `E` object with unique string value
2. Add to both directions documentation as needed
3. Use the constant everywhere (`EV.NEW_EVENT`), never hardcode strings

### Adding New Socket Handlers
1. Add handler in `server/sockets.js` inside `io.on('connection', ...)`
2. Follow patterns: validate auth/token, check room membership/admin status, use `internal.*` for business logic (note: `internal` wraps calls in Promise, use `internalRaw` for direct boolean checks)
3. Emit events using `io.to(room).emit()`, `socket.emit()`, or `socket.to(room).emit()`
4. For admin actions use `requireRoomAdmin()` helper
5. Update in-memory `rooms` state as needed

### Adding New REST Endpoints
1. Add route in `server/routes/api.js`
2. Follow patterns: `checkMethod()`, `checkCsrf()` for POST, `requireLoginApi()` for auth-required
3. Use `dbm.get/all/run()`, `sessions.currentUser()`, permission checks via `ranks.*`
4. Return via `ok()`, `bad()`, `out()` helpers
5. Mount is automatic (router mounted at `/black-meet/api` in `app.js`)

### Adding New EJS Views or Modifying Existing
1. Create/modify in `server/views/`
2. Add route in `server/routes/pages.js` with `pageLocals()` and auth checks
3. Include `head.ejs` partial, use appropriate body class (`bm-dash`/`bm-auth`/`bm-call`)
4. Preserve existing element IDs/classes that JS depends on
5. Use `icon()` helper for icons, `asset()` for assets
6. Follow RTL layout conventions

### Adding New Frontend JS Logic
1. Add file to `assets/js/` and include script in relevant view or `head.ejs`
2. For call features, add to `assets/js/call.js` following existing patterns
3. For non-call real-time features, use `window.BMLive.on()` and `window.BMLive.subscribe()`
4. For dashboard features, follow `dashboard.js` patterns
5. Always use `window.BMEv` constants for socket events

### Adding New DB Columns or Tables (Migration Pattern)
This project uses **idempotent schema** approach (no migration framework):
1. Add table/column definitions to `server/lib/schema.sql` using `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
2. For adding columns to existing tables, add idempotent `ALTER TABLE ... ADD COLUMN` in `server/lib/db.js` after schema load (check `PRAGMA table_info()` first)
3. Never use `CURRENT_TIMESTAMP` defaults - timestamps written by app via `sqlNow()` from `helpers.js`
4. Test with fresh DB and existing DB
5. Consider backup/restore implications

### CSS/Tailwind Conventions
- Use CSS variables (`--bm-*`, `--d-*`) for colors
- Colors in RGB triplet format for alpha support
- Dashboard styles go in `assets/css/dashboard.css` scoped to body classes
- Tailwind utilities are available but dashboard uses custom classes
- After adding Tailwind classes, run `npm run tailwind:build`
- Preserve `hidden`/responsive class behavior - be careful with `!important` overrides
- Use logical properties for RTL support where possible
- Follow existing spacing/typography patterns

---

## Development Notes

- **Local server port**: 3000 (configurable via `PORT` env)
- **Start script**: `start.bat` launches all services (app, TURN, tunnel)
- **Git**: Branch workflow - create backup branch first, push to backup, then update `main` (Render deploys from `main`)
- **No tests/linter/build step**: Except Tailwind CSS compilation
- **Avatar storage**: Stored in DB (`bm_avatars`) not filesystem (disk ephemeral on Render)
- **Site icon storage**: Stored in DB (`bm_assets`)
- **TURN**: Free public relay `turn.jami.net` works out of box for cross-network calls
- **Session**: Cookie `bm`, SQLite-backed, CSRF protected on all POST
