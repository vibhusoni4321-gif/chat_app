# Pulse Chat

A real-time chat app built on WebSockets (Socket.IO) with private rooms, live presence, file sharing and saved history (PostgreSQL).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end test of rooms, presence, files, history, reactions, edit/delete
```

Without `DATABASE_URL` the app stores everything in memory (lost on restart). To save history locally, set `DATABASE_URL` to a Postgres connection string before `npm start`:

```powershell
$env:DATABASE_URL = "postgresql://user:password@host/dbname?sslmode=require"
npm start
```

Tables are created (and upgraded from older versions) automatically on startup. The console prints `Storage: postgres` when the database is in use.

## Features

**Rooms and presence**
- Everyone starts in `#lobby`. Create rooms; add a password to make one private (🔒). Passwords are hashed with scrypt. Rooms persist across restarts.
- Live member list per room with online / away / busy; status switches to *away* automatically when the tab is hidden.

**Messaging**
- Reply to messages (quoted preview, click to jump to the original).
- Edit and delete your own messages. The room's creator can delete any message in their room.
- Emoji reactions (8 quick reactions, toggle on/off) and an emoji picker in the composer.
- Links are clickable, `@name` mentions are highlighted, and a mention plays a sound / toast.
- Search messages in the current room. Typing indicators, date separators, grouped messages.
- Multi-line messages (Shift+Enter).

**Files**
- Click 📎, drag and drop, or paste an image (max 10 MB, up to 5 at once) with a progress bar. Images preview inline and open in a lightbox. Only room members can upload to or download from a room.

**Experience**
- Modern dark and light themes (remembered), colour avatars, mobile-friendly layout with slide-in panels.
- Unread count in the tab title and optional sound when the tab is in the background.
- Auto-reconnect: if the connection drops, it logs back in and rejoins your room without a reload.
- Flood control (10 chat actions per 5 seconds per connection).

## Deploy (Render + Neon Postgres)

1. Push this repo to GitHub (`node_modules` is ignored by `.gitignore`).
2. Create a Postgres database (e.g. at neon.tech) and copy its connection string.
3. On render.com: **New + → Web Service**, select the repo, Runtime `Node`, Build Command `npm install`, Start Command `npm start`.
4. Add the environment variable `DATABASE_URL` = your connection string, then create the service.
5. Open the `https://….onrender.com` URL from any device. Secure WebSockets work automatically.

`/healthz` returns `ok` and can be used as the host's health check. Free tiers may sleep when idle (first load is then slow); history stays in the database.

## Structure

```
server.js        Express + Socket.IO server
store.js         Storage layer: PostgreSQL (DATABASE_URL) or in-memory fallback
public/          index.html, style.css, app.js (vanilla JS client, no build step)
test.js          End-to-end test using socket.io-client
```

## Socket.IO events

| Event | Direction | Purpose |
|---|---|---|
| `login` | client → server | Claim a display name |
| `room:create`, `room:join`, `room:leave` | client → server | Room lifecycle (join takes optional password) |
| `message` | both | Send `{room, text, replyTo?}`; server broadcasts the saved message |
| `message:edit`, `message:delete`, `message:react` | client → server | Change a message |
| `message:update` | server → client | A message was edited, deleted or reacted to |
| `typing`, `status` | client → server | Typing state, presence status |
| `typing`, `room:members`, `rooms:list`, `toast` | server → client | Broadcasts and notices |
| `POST /upload` | HTTP | Multipart upload; server then broadcasts a `file` message to the room |

## Limitations and next steps

- Display names are not accounts: anyone can use a free name, and could edit or delete old messages under a name whose owner has left. Add real sign-up/login before opening it to the public.
- Files are stored in the database, fine for small scale. For heavy use, move them to object storage (S3 / Cloudflare R2).
- Single server process. To scale out, add the Socket.IO Redis adapter.
- Possible additions: direct messages, message pinning, link previews, push notifications.
