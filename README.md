# Realtime Chat

A real-time chat app built on WebSockets (Socket.IO) with private rooms, live presence, file sharing and saved history (PostgreSQL).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end test of rooms, presence, files, history
```

Without `DATABASE_URL` the app stores everything in memory (lost on restart). To save history locally, set `DATABASE_URL` to a Postgres connection string before `npm start`:

```powershell
$env:DATABASE_URL = "postgresql://user:password@host/dbname?sslmode=require"
npm start
```

On startup the app creates its tables automatically (`rooms`, `messages`, `files`). The console prints `Storage: postgres` when it is using the database.

## Features

- **Rooms**: everyone starts in `#lobby`. Create rooms; add a password to make one private (🔒). Passwords are hashed with scrypt. Rooms persist across restarts.
- **Active user status**: live member list per room with online / away / busy. Status switches to *away* automatically when the tab is hidden, and users are removed instantly on disconnect.
- **File sharing**: click 📎 or drag and drop (max 10 MB). Images preview inline. Files are stored in the database; only members of a room can upload to it or download its files.
- **History**: the last 100 messages and files of a room are shown when you join. Join/leave notices are not saved.
- **Extras**: typing indicators, unique display names.

## Deploy (Render + Neon Postgres)

1. Push this repo to GitHub (`node_modules` is ignored by `.gitignore`).
2. Create a Postgres database (e.g. at neon.tech) and copy its connection string.
3. On render.com: **New + → Web Service**, select the repo, Runtime `Node`, Build Command `npm install`, Start Command `npm start`.
4. Add the environment variable `DATABASE_URL` = your connection string, then create the service.
5. Open the `https://….onrender.com` URL from any device. Secure WebSockets work automatically.

Free hosting tiers may put the app to sleep when idle (first load is then slow); history stays in the database. Check each provider's current free-tier limits.

## Structure

```
server.js        Express + Socket.IO server
store.js         Storage layer: PostgreSQL (DATABASE_URL) or in-memory fallback
public/          index.html, style.css, app.js (vanilla JS client)
test.js          End-to-end test using socket.io-client
```

## Protocol (Socket.IO events)

| Event | Direction | Purpose |
|---|---|---|
| `login` | client → server | Claim a display name |
| `room:create`, `room:join`, `room:leave` | client → server | Room lifecycle (join takes optional password) |
| `message`, `typing`, `status` | client → server | Chat text, typing state, presence status |
| `message`, `typing`, `room:members`, `rooms:list` | server → client | Broadcasts |
| `POST /upload` | HTTP | Multipart upload; server then broadcasts a `file` message to the room |

## Limitations and next steps

- Display names are not accounts: anyone can pick any free name while that name is not in use. Add real sign-up/login before opening it to the public.
- Files are stored in the database, which is fine for small scale. For heavy use, move them to object storage (S3 / Cloudflare R2).
- Single server process. To scale out, add the Socket.IO Redis adapter.
- Add HTTPS (hosts like Render provide it) and rate limiting for public use.
