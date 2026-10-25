const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_FILE_MB = 10;
const HISTORY_LIMIT = 100;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// ---------- in-memory state ----------
const users = new Map(); // socket.id -> { name, status }
const rooms = new Map(); // roomName -> { passwordHash, salt, owner, members:Set<socket.id>, history:[] }

const STATUSES = ['online', 'away', 'busy'];

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const clean = (s, max = 30) => String(s || '').replace(/[<>]/g, '').trim().slice(0, max);
const now = () => Date.now();

function roomInfo(name) {
  const r = rooms.get(name);
  return { name, private: !!r.passwordHash, count: r.members.size };
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
  const r = rooms.get(roomName);
  if (!r) return;
  r.history.push(msg);
  if (r.history.length > HISTORY_LIMIT) r.history.shift();
  io.to(roomName).emit('message', msg);
}
function systemMsg(room, text) {
  pushMessage(room, { id: crypto.randomUUID(), type: 'system', room, text, ts: now() });
}
function leaveRoom(socket, roomName) {
  const r = rooms.get(roomName);
  const u = users.get(socket.id);
  if (!r || !r.members.has(socket.id)) return;
  r.members.delete(socket.id);
  socket.leave(roomName);
  if (u) systemMsg(roomName, `${u.name} left`);
  broadcastMembers(roomName);
  // Remove empty rooms except the default lobby
  if (r.members.size === 0 && roomName !== 'lobby') rooms.delete(roomName);
  broadcastRooms();
}
function createRoom(name, password, owner) {
  const salt = crypto.randomBytes(8).toString('hex');
  rooms.set(name, {
    passwordHash: password ? hash(password, salt) : null,
    salt,
    owner,
    members: new Set(),
    history: [],
  });
}
createRoom('lobby', '', 'system');

// ---------- file upload (HTTP), delivered over the socket ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).slice(0, 10)),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const { socketId, room } = req.body || {};
    const user = users.get(socketId);
    const r = rooms.get(room);
    if (!req.file) return res.status(400).json({ error: 'No file' });
    // Only members of a room may share files in it
    if (!user || !r || !r.members.has(socketId)) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: 'Not a member of this room' });
    }
    const f = {
      id: crypto.randomUUID(),
      type: 'file',
      room,
      user: user.name,
      ts: now(),
      file: {
        name: clean(req.file.originalname, 120),
        size: req.file.size,
        mime: req.file.mimetype,
        key: req.file.filename,
      },
    };
    pushMessage(room, f);
    res.json({ ok: true });
  });
});

// Files are served only with an unguessable key AND a valid room membership token
app.get('/files/:key', (req, res) => {
  const key = path.basename(req.params.key);
  const { socketId, room, name } = req.query;
  const r = rooms.get(room);
  const allowed =
    r &&
    r.members.has(socketId) &&
    r.history.some((m) => m.type === 'file' && m.file.key === key);
  if (!allowed) return res.status(403).send('Forbidden');
  const meta = r.history.find((m) => m.type === 'file' && m.file.key === key);
  res.download(path.join(UPLOAD_DIR, key), meta.file.name);
});

// ---------- sockets ----------
io.on('connection', (socket) => {
  socket.on('login', (rawName, cb) => {
    const name = clean(rawName, 20);
    if (!name) return cb({ error: 'Enter a name' });
    const taken = [...users.values()].some((u) => u.name.toLowerCase() === name.toLowerCase());
    if (taken) return cb({ error: 'That name is already in use' });
    users.set(socket.id, { name, status: 'online' });
    cb({ ok: true, name, id: socket.id, rooms: publicRoomList(), statuses: STATUSES });
  });

  socket.on('room:create', ({ room, password }, cb) => {
    const name = clean(room);
    if (!users.has(socket.id)) return cb({ error: 'Not logged in' });
    if (!name) return cb({ error: 'Room name required' });
    if (rooms.has(name)) return cb({ error: 'Room already exists' });
    createRoom(name, String(password || '').slice(0, 64), users.get(socket.id).name);
    broadcastRooms();
    cb({ ok: true, room: name });
  });

  socket.on('room:join', ({ room, password }, cb) => {
    const u = users.get(socket.id);
    const r = rooms.get(room);
    if (!u) return cb({ error: 'Not logged in' });
    if (!r) return cb({ error: 'Room not found' });
    if (r.members.has(socket.id)) return cb({ ok: true, history: r.history, members: memberList(room) });
    if (r.passwordHash) {
      const given = hash(String(password || ''), r.salt);
      const ok = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(r.passwordHash));
      if (!ok) return cb({ error: 'Wrong password' });
    }
    r.members.add(socket.id);
    socket.join(room);
    systemMsg(room, `${u.name} joined`);
    broadcastMembers(room);
    broadcastRooms();
    cb({ ok: true, history: r.history, members: memberList(room) });
  });

  socket.on('room:leave', (room) => leaveRoom(socket, room));

  socket.on('message', ({ room, text }) => {
    const u = users.get(socket.id);
    const r = rooms.get(room);
    const body = String(text || '').slice(0, 2000).trim();
    if (!u || !r || !r.members.has(socket.id) || !body) return;
    pushMessage(room, { id: crypto.randomUUID(), type: 'text', room, user: u.name, text: body, ts: now() });
  });

  socket.on('typing', ({ room, typing }) => {
    const u = users.get(socket.id);
    const r = rooms.get(room);
    if (!u || !r || !r.members.has(socket.id)) return;
    socket.to(room).emit('typing', { room, user: u.name, typing: !!typing });
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
  server.listen(PORT, () => console.log(`Chat running at http://localhost:${PORT}`));
}
module.exports = { server, io };
