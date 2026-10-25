const socket = io();
const $ = (id) => document.getElementById(id);

let me = null;            // { name, id }
let current = null;       // active room name
let roomsCache = [];
let pendingRoom = null;   // room awaiting password
const typingUsers = new Map(); // user -> timeout
let typingSent = false, typingTimer = null;

// ---------- helpers ----------
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------- login ----------
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  socket.emit('login', $('nameInput').value, (res) => {
    if (res.error) { $('loginErr').textContent = res.error; return; }
    me = { name: res.name, id: res.id };
    $('meName').textContent = me.name;
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    roomsCache = res.rooms;
    renderRooms();
    joinRoom('lobby');
  });
});

// ---------- rooms ----------
function renderRooms() {
  const ul = $('roomList');
  ul.innerHTML = '';
  roomsCache.forEach((r) => {
    const li = el('li', r.name === current ? 'active' : '');
    li.appendChild(el('span', '', (r.private ? '🔒 ' : '# ') + r.name));
    li.appendChild(el('span', 'badge', r.count + ' online'));
    li.onclick = () => (r.name === current ? null : r.private ? askPassword(r.name) : joinRoom(r.name));
    ul.appendChild(li);
  });
}

function askPassword(room) {
  pendingRoom = room;
  $('pwTitle').textContent = `🔒 ${room}`;
  $('pwInput').value = '';
  $('pwErr').textContent = '';
  $('pwModal').classList.remove('hidden');
  $('pwInput').focus();
}
$('pwCancel').onclick = () => $('pwModal').classList.add('hidden');
$('pwForm').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom(pendingRoom, $('pwInput').value, (err) => {
    if (err) $('pwErr').textContent = err;
    else $('pwModal').classList.add('hidden');
  });
});

function joinRoom(room, password, done) {
  socket.emit('room:join', { room, password }, (res) => {
    if (res.error) { if (done) done(res.error); return; }
    // Leave the previous room so you only receive one room's traffic at a time
    if (current && current !== room) socket.emit('room:leave', current);
    current = room;
    const meta = roomsCache.find((r) => r.name === room);
    $('roomTitle').textContent = room;
    $('roomLock').textContent = meta && meta.private ? ' 🔒 private' : '';
    $('leaveBtn').classList.toggle('hidden', room === 'lobby');
    $('msgForm').classList.remove('hidden');
    $('messages').innerHTML = '';
    typingUsers.clear(); renderTyping();
    res.history.forEach(addMessage);
    renderMembers(res.members);
    renderRooms();
    $('msgInput').focus();
    if (done) done();
  });
}

$('leaveBtn').onclick = () => {
  socket.emit('room:leave', current);
  current = null;
  $('roomTitle').textContent = 'Select a room';
  $('roomLock').textContent = '';
  $('messages').innerHTML = '';
  $('msgForm').classList.add('hidden');
  $('leaveBtn').classList.add('hidden');
  renderMembers([]);
  renderRooms();
  joinRoom('lobby');
};

$('createForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const room = $('newRoom').value, password = $('newPw').value;
  socket.emit('room:create', { room, password }, (res) => {
    if (res.error) { $('createErr').textContent = res.error; return; }
    $('createErr').textContent = '';
    $('newRoom').value = ''; $('newPw').value = '';
    // Creator joins immediately with the password they just set
    setTimeout(() => joinRoom(res.room, password), 50);
  });
});

socket.on('rooms:list', (list) => { roomsCache = list; renderRooms(); });

// ---------- members / presence ----------
function renderMembers(members) {
  const ul = $('memberList');
  ul.innerHTML = '';
  members.forEach((m) => {
    const li = el('li');
    const left = el('span');
    left.appendChild(el('span', 'dot ' + m.status));
    left.appendChild(document.createTextNode(m.name + (m.name === (me && me.name) ? ' (you)' : '')));
    li.appendChild(left);
    li.appendChild(el('span', 'badge', m.status));
    ul.appendChild(li);
  });
}
socket.on('room:members', ({ room, members }) => { if (room === current) renderMembers(members); });
$('statusSel').onchange = (e) => socket.emit('status', e.target.value);

// Auto "away" when the tab is hidden, restore when visible
document.addEventListener('visibilitychange', () => {
  if (!me) return;
  const sel = $('statusSel');
  if (document.hidden && sel.value === 'online') { sel.dataset.auto = '1'; sel.value = 'away'; socket.emit('status', 'away'); }
  else if (!document.hidden && sel.dataset.auto) { delete sel.dataset.auto; sel.value = 'online'; socket.emit('status', 'online'); }
});

// ---------- messages ----------
function addMessage(m) {
  if (m.room !== current) return;
  const box = $('messages');
  const wrap = el('div', 'msg ' + (m.type === 'system' ? 'system' : m.user === me.name ? 'mine' : ''));
  if (m.type === 'system') {
    wrap.textContent = m.text;
  } else {
    wrap.appendChild(el('div', 'meta', `${m.user} · ${fmtTime(m.ts)}`));
    if (m.type === 'text') {
      wrap.appendChild(el('div', '', m.text)); // textContent => XSS-safe
    } else {
      const f = m.file;
      const url = `/files/${encodeURIComponent(f.key)}?socketId=${encodeURIComponent(me.id)}&room=${encodeURIComponent(m.room)}`;
      const box2 = el('div', 'file');
      const a = el('a', '', `📄 ${f.name}`);
      a.href = url;
      a.download = f.name;
      box2.appendChild(a);
      box2.appendChild(el('span', 'badge', ' · ' + fmtSize(f.size)));
      wrap.appendChild(box2);
      if (f.mime.startsWith('image/') && /^image\/(png|jpe?g|gif|webp)$/.test(f.mime)) {
        const img = el('img'); img.src = url; img.alt = f.name; wrap.appendChild(img);
      }
    }
  }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.appendChild(wrap);
  if (nearBottom || m.user === (me && me.name)) box.scrollTop = box.scrollHeight;
}
socket.on('message', addMessage);

$('msgForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if (!text || !current) return;
  socket.emit('message', { room: current, text });
  $('msgInput').value = '';
  stopTyping();
});

// ---------- typing indicator ----------
function stopTyping() {
  if (typingSent) socket.emit('typing', { room: current, typing: false });
  typingSent = false; clearTimeout(typingTimer);
}
$('msgInput').addEventListener('input', () => {
  if (!current) return;
  if (!typingSent) { socket.emit('typing', { room: current, typing: true }); typingSent = true; }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 1500);
});
function renderTyping() {
  const names = [...typingUsers.keys()];
  $('typing').textContent = names.length ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…` : '';
}
socket.on('typing', ({ room, user, typing }) => {
  if (room !== current) return;
  clearTimeout(typingUsers.get(user));
  if (typing) typingUsers.set(user, setTimeout(() => { typingUsers.delete(user); renderTyping(); }, 4000));
  else typingUsers.delete(user);
  renderTyping();
});

// ---------- file sharing ----------
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !current) return;
  if (file.size > 10 * 1024 * 1024) return alert('File too large (max 10 MB)');
  const fd = new FormData();
  fd.append('socketId', me.id);
  fd.append('room', current);
  fd.append('file', file);
  try {
    const res = await fetch('/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) alert(data.error || 'Upload failed');
  } catch { alert('Upload failed'); }
});

// Drag & drop upload
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && current) {
    const dt = new DataTransfer(); dt.items.add(f);
    $('fileInput').files = dt.files;
    $('fileInput').dispatchEvent(new Event('change'));
  }
});

socket.on('disconnect', () => { $('typing').textContent = 'Disconnected — reconnecting…'; });
socket.on('connect', () => { if (me) location.reload(); }); // session state is per-socket; start fresh
