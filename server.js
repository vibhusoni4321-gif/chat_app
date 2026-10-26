const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = 10;
const PAGE = 100;       // messages sent when joining a room
const OLDER_PAGE = 50;  // messages per "load earlier" request

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// ---------- state ----------
// Live connections are in memory; rooms, messages and files are persisted via ./store
const users = new Map(); // socket.id -> { name, status }
const rooms = new Map(); // roomName -> { passwordHash, salt, owner, members:Set<socket.id> }

const STATUSES = ['online', 'away', 'busy'];
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const clean = (s, max = 30) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const now = () => Date.now();
const logErr = (what) => (e) => console.error(`[store] ${what} failed:`, e.message);
const blank = (o) => ({ replyTo: null, edited: false, deleted: false, reactions: {}, ...o });
const snippet = (m) =>
  m.deleted ? 'Message deleted' : m.type === 'file' ? `📎 ${(m.file && m.file.name) || 'file'}` : String(m.text || '').slice(0, 100);

function roomInfo(name) {
  const r = rooms.get(name);
  return { name, private: !!r.passwordHash, count: r.members.size, owner: r.owner };
}
function publicRoomList() {
  return [...rooms.keys()].map(roomInfo);
}
function memberList(name) {
  const r = rooms.get(name);
  if (!r) return [];
  return [...r.members]
    .map((id) => users.get(id))
    .filter(Boolean)
    .map((u) => ({ name: u.name, status: u.status }));
}
function broadcastMembers(name) {
  io.to(name).emit('room:members', { room: name, members: memberList(name) });
}
function broadcastRooms() {
  io.emit('rooms:list', publicRoomList());
}
function pushMessage(roomName, msg) {
  if (!rooms.has(roomName)) return;
  const m = blank(msg);
  io.to(roomName).emit('message', m);
  store.saveMessage(m).catch(logErr('saveMessage'));
}
// Join/leave notices are shown live but not saved to history
function systemMsg(room, text) {
  io.to(room).emit('message', { id: crypto.randomUUID(), type: 'system', room, text, ts: now() });
}
function leaveRoom(socket, roomName) {
  const r = rooms.get(roomName);
  const u = users.get(socket.id);
  if (!r || !r.members.has(socket.id)) return;
  r.members.delete(socket.id);
  socket.leave(roomName);
  if (u) systemMsg(roomName, `${u.name} left`);
  broadcastMembers(roomName);
  broadcastRooms();
}
async function createRoom(name, password, owner) {
  const salt = crypto.randomBytes(8).toString('hex');
  const rec = { name, passwordHash: password ? hash(password, salt) : null, salt, owner };
  await store.saveRoom(rec);
  rooms.set(name, { passwordHash: rec.passwordHash, salt, owner, members: new Set() });
}

// Load persisted rooms, make sure the lobby exists
const ready = (async () => {
  await store.init();
  for (const r of await store.loadRooms()) {
    rooms.set(r.name, { passwordHash: r.passwordHash, salt: r.salt, owner: r.owner, members: new Set() });
  }
  if (!rooms.has('lobby')) await createRoom('lobby', '', 'system');
  console.log(`Storage: ${store.kind}, ${rooms.size} room(s) loaded`);
})();

// ---------- file upload (HTTP), delivered over the socket ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      await ready;
      const { socketId, room } = req.body || {};
      const user = users.get(socketId);
      const r = rooms.get(room);
      if (!req.file) return res.status(400).json({ error: 'No file' });
      // Only members of a room may share files in it
      if (!user || !r || !r.members.has(socketId)) {
        return res.status(403).json({ error: 'Not a member of this room' });
      }
      const key = crypto.randomBytes(12).toString('hex') + path.extname(req.file.originalname).slice(0, 10);
      await store.saveFile(key, req.file.buffer, req.file.mimetype);
      pushMessage(room, {
        id: crypto.randomUUID(),
        type: 'file',
        room,
        user: user.name,
        ts: now(),
        file: { name: clean(req.file.originalname, 120), size: req.file.size, mime: req.file.mimetype, key },
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('upload failed:', e.message);
      res.status(500).json({ error: 'Upload failed' });
    }
  });
});

// Files are served only with an unguessable key AND valid membership of the room they were shared in
app.get('/files/:key', async (req, res) => {
  try {
    await ready;
    const key = path.basename(req.params.key);
    const { socketId, room } = req.query;
    const r = rooms.get(room);
    if (!r || !r.members.has(socketId)) return res.status(403).send('Forbidden');
    const meta = await store.fileInRoom(key, room);
    if (!meta) return res.status(403).send('Forbidden');
    const file = await store.getFile(key);
    if (!file) return res.status(404).send('Not found');
    res.set({
      'Content-Type': file.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    });
    res.send(file.data);
  } catch (e) {
    console.error('download failed:', e.message);
    res.status(500).send('Error');
  }
});

// ---------- sockets ----------
io.on('connection', (socket) => {
  // Simple flood control: at most 10 chat actions per 5 seconds per connection
  const hits = [];
  const allow = () => {
    const t = Date.now();
    while (hits.length && t - hits[0] > 5000) hits.shift();
    if (hits.length >= 10) return false;
    hits.push(t);
    return true;
  };
  // Resolves the acting user + room if the socket is a member, else null
  const ctx = (room) => {
    const u = users.get(socket.id);
    const r = rooms.get(room);
    return u && r && r.members.has(socket.id) ? { u, r } : null;
  };

  socket.on('login', async (rawName, cb) => {
    await ready;
    const name = clean(rawName, 20);
    if (!name) return cb({ error: 'Enter a name' });
    const taken = [...users.entries()].some(([id, u]) => id !== socket.id && u.name.toLowerCase() === name.toLowerCase());
    if (taken) return cb({ error: 'That name is already in use' });
    users.set(socket.id, { name, status: 'online' });
    cb({ ok: true, name, id: socket.id, rooms: publicRoomList(), statuses: STATUSES, reactions: REACTIONS });
  });

  socket.on('room:create', async ({ room, password }, cb) => {
    try {
      const name = clean(room);
      if (!users.has(socket.id)) return cb({ error: 'Not logged in' });
      if (!name) return cb({ error: 'Room name required' });
      if (rooms.has(name)) return cb({ error: 'Room already exists' });
      await createRoom(name, String(password || '').slice(0, 64), users.get(socket.id).name);
      broadcastRooms();
      cb({ ok: true, room: name });
    } catch (e) {
      console.error('room:create failed:', e.message);
      cb({ error: 'Could not create room' });
    }
  });

  socket.on('room:join', async ({ room, password }, cb) => {
    try {
      const u = users.get(socket.id);
      const r = rooms.get(room);
      if (!u) return cb({ error: 'Not logged in' });
      if (!r) return cb({ error: 'Room not found' });
      if (r.members.has(socket.id)) {
        const h = await store.history(room, undefined, PAGE);
        return cb({ ok: true, history: h, more: h.length === PAGE, members: memberList(room) });
      }
      if (r.passwordHash) {
        const given = hash(String(password || ''), r.salt);
        const ok = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(r.passwordHash));
        if (!ok) return cb({ error: 'Wrong password' });
      }
      const history = await store.history(room, undefined, PAGE); // load before joining so the new user sees no duplicates
      r.members.add(socket.id);
      socket.join(room);
      systemMsg(room, `${u.name} joined`);
      broadcastMembers(room);
      broadcastRooms();
      cb({ ok: true, history, more: history.length === PAGE, members: memberList(room) });
    } catch (e) {
      console.error('room:join failed:', e.message);
      cb({ error: 'Could not join room' });
    }
  });

  socket.on('room:leave', (room) => leaveRoom(socket, room));

  // Older messages for the "Load earlier messages" button (members only)
  socket.on('history:more', async ({ room, before }, cb) => {
    if (typeof cb !== 'function') return;
    try {
      if (!ctx(room)) return cb({ messages: [], more: false });
      const messages = await store.history(room, Number(before) || Date.now(), OLDER_PAGE);
      cb({ ok: true, messages, more: messages.length === OLDER_PAGE });
    } catch (e) {
      logErr('history:more')(e);
      cb({ messages: [], more: false });
    }
  });

  socket.on('message', async ({ room, text, replyTo }) => {
    try {
      const c = ctx(room);
      const body = String(text || '').slice(0, 2000).trim();
      if (!c || !body) return;
      if (!allow()) return socket.emit('toast', 'You are sending messages too fast');
      let reply = null;
      if (replyTo) {
        const o = await store.getMessage(String(replyTo));
        if (o && o.room === room && !o.deleted) reply = { id: o.id, user: o.user, text: snippet(o) };
      }
      pushMessage(room, { id: crypto.randomUUID(), type: 'text', room, user: c.u.name, text: body, ts: now(), replyTo: reply });
    } catch (e) { logErr('message')(e); }
  });

  socket.on('message:edit', async ({ room, id, text }) => {
    try {
      const c = ctx(room);
      const body = String(text || '').slice(0, 2000).trim();
      if (!c || !body || !allow()) return;
      const m = await store.getMessage(String(id));
      if (!m || m.room !== room || m.user !== c.u.name || m.type !== 'text' || m.deleted) return;
      const upd = await store.updateMessage(m.id, { text: body, edited: true });
      if (upd) io.to(room).emit('message:update', upd);
    } catch (e) { logErr('edit')(e); }
  });

  // Authors can delete their own messages; the room owner can delete any message in their room
  socket.on('message:delete', async ({ room, id }) => {
    try {
      const c = ctx(room);
      if (!c || !allow()) return;
      const m = await store.getMessage(String(id));
      if (!m || m.room !== room || m.deleted) return;
      if (m.user !== c.u.name && c.r.owner !== c.u.name) return;
      const key = m.file && m.file.key;
      const upd = await store.updateMessage(m.id, { deleted: true });
      if (key) store.deleteFile(key).catch(logErr('deleteFile'));
      if (upd) io.to(room).emit('message:update', upd);
    } catch (e) { logErr('delete')(e); }
  });

  socket.on('message:react', async ({ room, id, emoji }) => {
    try {
      const c = ctx(room);
      if (!c || !REACTIONS.includes(emoji) || !allow()) return;
      const m = await store.getMessage(String(id));
      if (!m || m.room !== room || m.deleted) return;
      const reactions = { ...(m.reactions || {}) };
      const set = new Set(reactions[emoji] || []);
      if (set.has(c.u.name)) set.delete(c.u.name); else set.add(c.u.name);
      if (set.size) reactions[emoji] = [...set]; else delete reactions[emoji];
      const upd = await store.updateMessage(m.id, { reactions });
      if (upd) io.to(room).emit('message:update', upd);
    } catch (e) { logErr('react')(e); }
  });

  socket.on('typing', ({ room, typing }) => {
    const c = ctx(room);
    if (!c) return;
    socket.to(room).emit('typing', { room, user: c.u.name, typing: !!typing });
  });

  socket.on('status', (status) => {
    const u = users.get(socket.id);
    if (!u || !STATUSES.includes(status)) return;
    u.status = status;
    for (const [name, r] of rooms) if (r.members.has(socket.id)) broadcastMembers(name);
  });

  socket.on('disconnect', () => {
    for (const name of [...rooms.keys()]) leaveRoom(socket, name);
    users.delete(socket.id);
  });
});

if (require.main === module) {
  ready
    .then(() => server.listen(PORT, () => console.log(`Chat running on port ${PORT}`)))
    .catch((e) => { console.error('Startup failed:', e); process.exit(1); });
}
module.exports = { server, io, ready };
