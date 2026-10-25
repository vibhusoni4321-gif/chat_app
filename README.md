# Realtime Chat

A real-time chat app built on WebSockets (Socket.IO) with private rooms, live presence and file sharing.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # end-to-end test of rooms, presence, files
```

Open it in two browser tabs with different names to try it out. Set `PORT` to change the port.

## Features

- **Rooms**: everyone starts in `#lobby`. Create new rooms; add a password to make one private (🔒). Passwords are hashed with scrypt and never sent back to clients.
- **Active user status**: a live member list per room with online / away / busy. Status switches to *away* automatically when the tab is hidden, and users are removed instantly on disconnect.
- **File sharing**: click 📎 or drag and drop a file (max 10 MB). Images preview inline. Only members of a room can upload to it or download its files.
- **Extras**: typing indicators, message history (last 100 per room), join/leave notices, unique display names.

## Structure

```
server.js        Express + Socket.IO server (state is in memory)
public/          index.html, style.css, app.js (vanilla JS client)
test.js          End-to-end test using socket.io-client
uploads/         Created at runtime for shared files
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

State lives in memory, so restarting the server clears rooms and history, and one server process only. For production, add a database (e.g. PostgreSQL or Redis), the Socket.IO Redis adapter for scaling out, real user accounts, and HTTPS.
