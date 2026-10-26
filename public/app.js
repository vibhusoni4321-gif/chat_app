(() => {
  'use strict';
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const TITLE = 'Pulse Chat';
  const MAX_UPLOAD = 10 * 1024 * 1024;
  const EMOJIS = ('😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤗 🤔 🤨 😐 😑 😶 🙄 😏 😬 😮 😯 😲 😳 🥺 😢 😭 😤 😡 🥳 😎 🤓 😴 🤒 🤕 🤝 👍 👎 👏 🙌 🙏 💪 👋 ✌️ 🤞 👌 👀 💯 🔥 ✨ 🎉 🎂 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 ☕ 🍕 🍔 🎮 🎵 ⚽ 🚀 🌈 ☀️ 🌙 ⭐ ✅ ❌ ⚠️ 💡').split(' ');

  // ---------- small helpers ----------
  const prefs = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB');
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  const dayLabel = (ts) => {
    const d = new Date(ts), t = new Date();
    if (sameDay(d, t)) return 'Today';
    if (sameDay(d, new Date(t.getTime() - 864e5))) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  };
  const hueOf = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  function avatar(name, cls = '') {
    const a = el('div', 'avatar ' + cls, (name[0] || '?').toUpperCase());
    const h = hueOf(name);
    a.style.background = `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 70% 45%))`;
    return a;
  }
  function toast(text) {
    const t = el('div', 'toast', text);
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  socket.on('toast', toast);

  // ---------- state ----------
  let me = null;               // { name, id }
  let current = null;          // active room
  let roomsCache = [];
  let REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];
  let msgs = [];               // messages of the active room
  let replyTo = null;          // { id, user, text }
  let query = '';
  let pendingRoom = null;
  const roomPw = {};           // passwords entered this session, for auto-rejoin after reconnect
  let unread = 0;
  let soundOn = prefs.get('sound') !== 'off';
  const typingUsers = new Map();
  let typingSent = false, typingTimer = null;

  // ---------- theme / sound ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = t === 'dark' ? '#0b0d17' : '#eef0fb';
  }
  applyTheme(document.documentElement.dataset.theme || 'dark');
  $('themeBtn').onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    prefs.set('theme', t); applyTheme(t);
  };
  const paintSound = () => { $('soundBtn').textContent = soundOn ? '🔔' : '🔕'; };
  paintSound();
  $('soundBtn').onclick = () => { soundOn = !soundOn; prefs.set('sound', soundOn ? 'on' : 'off'); paintSound(); toast(soundOn ? 'Sound on' : 'Sound off'); };
  let audio;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
      o.connect(g); g.connect(audio.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.start(t); o.stop(t + 0.26);
    } catch { /* audio not available */ }
  }

  // ---------- drawers (mobile) ----------
  function closeDrawers() { $('app').classList.remove('show-sidebar', 'show-members'); document.body.classList.remove('drawer'); }
  function toggleDrawer(cls) {
    const open = !$('app').classList.contains(cls);
    closeDrawers();
    if (open) { $('app').classList.add(cls); document.body.classList.add('drawer'); }
  }
  $('menuBtn').onclick = () => toggleDrawer('show-sidebar');
  $('membersBtn').onclick = () => toggleDrawer('show-members');
  $('backdrop').onclick = closeDrawers;

  // ---------- login ----------
  $('nameInput').value = prefs.get('name') || '';
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('login', $('nameInput').value, (res) => {
      if (res.error) { $('loginErr').textContent = res.error; return; }
      me = { name: res.name, id: res.id };
      if (res.reactions) REACTIONS = res.reactions;
      prefs.set('name', me.name);
      roomsCache = res.rooms;
      $('meName').textContent = me.name;
      const av = avatar(me.name, 'lg'); $('meAvatar').replaceWith(av); av.id = 'meAvatar';
      $('login').classList.add('hidden');
      $('app').classList.remove('hidden');
      renderRooms();
      joinRoom('lobby');
    });
  });

  // Auto-reconnect: log in again with the same name and rejoin the room (no page reload)
  socket.on('disconnect', () => { $('conn').classList.remove('hidden'); });
  socket.on('connect', () => {
    if (!me) return;
    const attempt = (n) => socket.emit('login', me.name, (res) => {
      if (res.error) { return n < 6 ? setTimeout(() => attempt(n + 1), 1000) : location.reload(); }
      me.id = res.id; roomsCache = res.rooms;
      $('conn').classList.add('hidden');
      const room = current || 'lobby';
      current = null;
      renderRooms();
      joinRoom(room, roomPw[room], (err) => { if (err && room !== 'lobby') joinRoom('lobby'); });
      if ($('statusSel').value !== 'online') socket.emit('status', $('statusSel').value);
    });
    attempt(0);
  });

  // ---------- rooms ----------
  const roomMeta = (name) => roomsCache.find((r) => r.name === name);
  function renderRooms() {
    const ul = $('roomList');
    ul.replaceChildren();
    roomsCache.forEach((r) => {
      const li = el('li', r.name === current ? 'active' : '');
      li.appendChild(el('span', 'ricon', r.private ? '🔒' : '#'));
      li.appendChild(el('span', 'rname', r.name));
      li.appendChild(el('span', 'pill', String(r.count)));
      li.title = r.private ? 'Private room' : 'Public room';
      li.onclick = () => {
        if (r.name === current) return closeDrawers();
        r.private && !roomPw[r.name] ? askPassword(r.name) : joinRoom(r.name, roomPw[r.name], (err) => { if (err) { delete roomPw[r.name]; r.private ? askPassword(r.name) : toast(err); } });
      };
      ul.appendChild(li);
    });
    if (current) paintHeader();
  }
  function paintHeader() {
    const meta = roomMeta(current);
    $('roomTitle').textContent = (meta && meta.private ? '' : '# ') + current;
    $('roomLock').textContent = meta && meta.private ? '🔒' : '';
    $('roomSub').textContent = meta ? `${meta.count} online` : '';
  }
  function askPassword(room) {
    pendingRoom = room;
    $('pwTitle').textContent = `🔒 ${room}`;
    $('pwInput').value = ''; $('pwErr').textContent = '';
    $('pwModal').classList.remove('hidden');
    $('pwInput').focus();
  }
  $('pwCancel').onclick = () => $('pwModal').classList.add('hidden');
  $('pwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pw = $('pwInput').value;
    joinRoom(pendingRoom, pw, (err) => {
      if (err) $('pwErr').textContent = err;
      else $('pwModal').classList.add('hidden');
    });
  });

  function joinRoom(room, password, done) {
    socket.emit('room:join', { room, password }, (res) => {
      if (res.error) { if (done) done(res.error); else toast(res.error); return; }
      if (current && current !== room) socket.emit('room:leave', current);
      current = room;
      if (password) roomPw[room] = password;
      clearReply();
      query = ''; $('search').value = '';
      typingUsers.clear(); renderTyping();
      msgs = res.history.slice();
      $('leaveBtn').classList.toggle('hidden', room === 'lobby');
      $('msgForm').classList.remove('hidden');
      renderAll();
      renderMembers(res.members);
      renderRooms();
      closeDrawers();
      if (window.innerWidth > 720) $('msgInput').focus();
      if (done) done();
    });
  }
  socket.on('rooms:list', (list) => { roomsCache = list; renderRooms(); });

  $('leaveBtn').onclick = () => {
    if (!current) return;
    socket.emit('room:leave', current);
    delete roomPw[current];
    current = null;
    joinRoom('lobby');
  };

  $('createForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const room = $('newRoom').value, password = $('newPw').value;
    socket.emit('room:create', { room, password }, (res) => {
      if (res.error) { $('createErr').textContent = res.error; return; }
      $('createErr').textContent = '';
      $('newRoom').value = ''; $('newPw').value = '';
      document.querySelector('.create').open = false;
      joinRoom(res.room, password);
    });
  });

  // ---------- members ----------
  const STATUS_TEXT = { online: 'Online', away: 'Away', busy: 'Busy' };
  function renderMembers(members) {
    const ul = $('memberList');
    ul.replaceChildren();
    $('memberCount').textContent = String(members.length);
    members.forEach((m) => {
      const li = el('li');
      const av = avatar(m.name, 'sm');
      av.appendChild(el('span', 'dot ' + m.status));
      li.appendChild(av);
      li.appendChild(el('span', 'mname', m.name + (me && m.name === me.name ? ' (you)' : '')));
      li.appendChild(el('span', 'mstatus', STATUS_TEXT[m.status] || m.status));
      ul.appendChild(li);
    });
  }
  socket.on('room:members', ({ room, members }) => { if (room === current) renderMembers(members); });
  $('statusSel').onchange = (e) => socket.emit('status', e.target.value);

  // ---------- messages: rendering ----------
  const mentionsMe = (m) => !!me && m.type === 'text' && m.user !== me.name && !m.deleted && (m.text || '').toLowerCase().includes('@' + me.name.toLowerCase());
  const matches = (m) => {
    if (m.type === 'system' || m.deleted) return false;
    const q = query.toLowerCase();
    return (m.text || '').toLowerCase().includes(q) || (m.user || '').toLowerCase().includes(q) || !!(m.file && m.file.name.toLowerCase().includes(q));
  };
  const snippetOf = (m) => (m.type === 'file' ? '📎 ' + (m.file ? m.file.name : 'file') : String(m.text || '').slice(0, 100));
  const fileUrl = (m) => `/files/${encodeURIComponent(m.file.key)}?socketId=${encodeURIComponent(me.id)}&room=${encodeURIComponent(m.room)}`;
  const isImage = (f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.mime || '');

  function richText(text) {
    const span = el('span', 'txt');
    String(text).split(/(https?:\/\/[^\s]+|@[\w.-]+)/g).forEach((part) => {
      if (!part) return;
      if (/^https?:\/\//.test(part)) {
        const a = el('a', '', part);
        a.href = part; a.target = '_blank'; a.rel = 'noopener noreferrer';
        span.appendChild(a);
      } else if (part[0] === '@' && part.length > 1) {
        span.appendChild(el('span', 'mention' + (part.slice(1).toLowerCase() === me.name.toLowerCase() ? ' me' : ''), part));
      } else {
        span.appendChild(document.createTextNode(part));
      }
    });
    return span;
  }

  function fileCard(m) {
    const f = m.file, url = fileUrl(m);
    const wrap = el('div', 'file');
    if (isImage(f)) {
      const img = el('img');
      img.src = url; img.alt = f.name; img.loading = 'lazy';
      img.onclick = () => openLightbox(url, f.name);
      // Late-loading images change the height: keep the view pinned to the bottom if the user was there
      const repin = () => { const b = $('messages'); if (b.dataset.stick === '1') b.scrollTop = b.scrollHeight; };
      img.addEventListener('load', repin); img.addEventListener('error', repin);
      wrap.appendChild(img);
    }
    const info = el('div', 'finfo');
    info.appendChild(el('div', 'ficon', isImage(f) ? '🖼️' : /pdf/.test(f.mime) ? '📕' : /zip|compressed/.test(f.mime) ? '🗜️' : /audio/.test(f.mime) ? '🎵' : /video/.test(f.mime) ? '🎬' : '📄'));
    const txt = el('div');
    const a = el('a', 'fname', f.name);
    a.href = url; a.download = f.name;
    txt.appendChild(a);
    txt.appendChild(el('span', 'fsize', fmtSize(f.size)));
    info.appendChild(txt);
    wrap.appendChild(info);
    return wrap;
  }

  function reactionsEl(m) {
    const entries = Object.entries(m.reactions || {}).filter(([, users]) => users && users.length);
    if (!entries.length) return null;
    const box = el('div', 'reactions');
    entries.forEach(([emoji, users]) => {
      const b = el('button', 'chip' + (users.includes(me.name) ? ' on' : ''), `${emoji} ${users.length}`);
      b.type = 'button'; b.title = users.join(', ');
      b.onclick = () => socket.emit('message:react', { room: current, id: m.id, emoji });
      box.appendChild(b);
    });
    return box;
  }

  function actionsEl(m, mine) {
    const bar = el('div', 'actions');
    const btn = (icon, title, fn) => {
      const b = el('button', '', icon);
      b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
      b.onclick = (e) => { e.stopPropagation(); fn(b); };
      bar.appendChild(b);
    };
    btn('😊', 'React', (b) => showReactPop(b, m));
    btn('↩️', 'Reply', () => setReply(m));
    if (mine && m.type === 'text') btn('✏️', 'Edit', () => startEdit(m));
    const meta = roomMeta(current);
    if (mine || (meta && meta.owner === me.name)) btn('🗑️', 'Delete', () => { if (confirm('Delete this message?')) socket.emit('message:delete', { room: current, id: m.id }); });
    return bar;
  }

  function buildMsg(m, prev) {
    if (m.type === 'system') { const d = el('div', 'sys', m.text); d.dataset.id = m.id; return d; }
    const mine = m.user === me.name;
    const grouped = !!prev && prev.type !== 'system' && prev.user === m.user && sameDay(prev.ts, m.ts) && m.ts - prev.ts < 5 * 60 * 1000 && !m.replyTo;
    const row = el('div', 'row' + (mine ? ' mine' : '') + (grouped ? ' grouped' : ''));
    row.dataset.id = m.id;
    row.appendChild(avatar(m.user));
    const body = el('div', 'body');
    if (!grouped) {
      const meta = el('div', 'meta');
      meta.appendChild(el('span', 'who', mine ? 'You' : m.user));
      meta.appendChild(el('span', 'time', fmtTime(m.ts)));
      body.appendChild(meta);
    }
    const bubble = el('div', 'bubble');
    if (m.deleted) {
      bubble.classList.add('deleted');
      bubble.textContent = '🚫 This message was deleted';
    } else {
      if (m.replyTo) {
        const rp = el('div', 'reply');
        rp.appendChild(el('b', '', m.replyTo.user));
        rp.appendChild(el('span', '', m.replyTo.text));
        rp.onclick = () => jumpTo(m.replyTo.id);
        bubble.appendChild(rp);
      }
      bubble.appendChild(m.type === 'file' ? fileCard(m) : richText(m.text));
      if (m.edited) bubble.appendChild(el('span', 'edited', '(edited)'));
      if (mentionsMe(m)) bubble.classList.add('hl');
    }
    body.appendChild(bubble);
    const rx = reactionsEl(m);
    if (rx) body.appendChild(rx);
    row.appendChild(body);
    if (!m.deleted) row.appendChild(actionsEl(m, mine));
    // Tap a message to show its action bar on touch devices
    row.addEventListener('click', (e) => {
      if (e.target.closest('a, button, img, input')) return;
      document.querySelectorAll('.row.active').forEach((x) => x !== row && x.classList.remove('active'));
      row.classList.toggle('active');
    });
    return row;
  }

  const sepEl = (ts) => el('div', 'sep', dayLabel(ts));
  function appendOne(m, prev) {
    const box = $('messages');
    if (!prev || !sameDay(prev.ts, m.ts)) box.appendChild(sepEl(m.ts));
    box.appendChild(buildMsg(m, prev));
  }
  function renderAll() {
    const box = $('messages');
    box.replaceChildren();
    paintHeader();
    const list = query ? msgs.filter(matches) : msgs;
    if (!list.length) {
      const e = el('div', 'empty');
      e.appendChild(el('span', 'big-emoji', query ? '🔍' : '👋'));
      e.appendChild(document.createTextNode(query ? 'No messages match your search.' : 'No messages yet. Say hello!'));
      box.appendChild(e);
      return;
    }
    let prev = null;
    list.forEach((m) => { appendOne(m, prev); prev = m; });
    box.style.scrollBehavior = 'auto';
    box.scrollTop = box.scrollHeight;
    box.dataset.stick = '1';
    box.style.scrollBehavior = '';
  }
  function replaceMsg(id) {
    if (query) return renderAll();
    const i = msgs.findIndex((x) => x.id === id);
    const row = $('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (i < 0 || !row) return;
    row.replaceWith(buildMsg(msgs[i], msgs[i - 1]));
  }
  function jumpTo(id) {
    const row = $('messages').querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return toast('Original message is not loaded');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1300);
  }

  // ---------- messages: live events ----------
  function onMessage(m) {
    if (m.room !== current) return;
    const prev = msgs[msgs.length - 1];
    msgs.push(m);
    if (msgs.length > 500) msgs.shift();
    if (query && !matches(m)) return;
    const box = $('messages');
    const empty = box.querySelector('.empty'); if (empty) empty.remove();
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    appendOne(m, query ? null : prev);
    if (nearBottom || (me && m.user === me.name)) box.scrollTop = box.scrollHeight;
    if (m.type !== 'system' && m.user !== me.name) notify(m);
  }
  socket.on('message', onMessage);
  socket.on('message:update', (m) => {
    if (m.room !== current) return;
    const i = msgs.findIndex((x) => x.id === m.id);
    if (i < 0) return;
    msgs[i] = m;
    replaceMsg(m.id);
  });

  function notify(m) {
    const mention = mentionsMe(m);
    if (document.hidden) { unread++; document.title = `(${unread}) ${TITLE}`; }
    if (soundOn && (document.hidden || mention)) beep();
    if (mention) toast(`${m.user} mentioned you`);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { unread = 0; document.title = TITLE; }
    if (!me) return;
    // Auto "away" while the tab is hidden
    const sel = $('statusSel');
    if (document.hidden && sel.value === 'online') { sel.dataset.auto = '1'; sel.value = 'away'; socket.emit('status', 'away'); }
    else if (!document.hidden && sel.dataset.auto) { delete sel.dataset.auto; sel.value = 'online'; socket.emit('status', 'online'); }
  });

  // ---------- search ----------
  $('search').addEventListener('input', (e) => { query = e.target.value.trim(); renderAll(); });

  // ---------- reply / edit ----------
  function setReply(m) {
    replyTo = { id: m.id, user: m.user, text: snippetOf(m) };
    $('replyUser').textContent = m.user;
    $('replyText').textContent = replyTo.text;
    $('replyBar').classList.remove('hidden');
    $('msgInput').focus();
  }
  function clearReply() { replyTo = null; $('replyBar').classList.add('hidden'); }
  $('replyClose').onclick = clearReply;

  function startEdit(m) {
    const row = $('messages').querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    if (!row) return;
    const bubble = row.querySelector('.bubble');
    const input = el('input', 'edit-input');
    input.value = m.text; input.maxLength = 2000;
    input.style.cssText = 'min-width:200px;width:100%;color:inherit;background:rgba(0,0,0,.2);border-color:rgba(255,255,255,.4)';
    bubble.replaceChildren(input);
    input.focus();
    let finished = false;
    const finish = (save) => {
      if (finished) return; finished = true;
      const v = input.value.trim();
      if (save && v && v !== m.text) socket.emit('message:edit', { room: current, id: m.id, text: v });
      replaceMsg(m.id);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') finish(false);
    };
    input.onblur = () => finish(false);
  }

  // ---------- popovers: reactions + emoji ----------
  function placePopover(pop, anchor) {
    pop.classList.remove('hidden');
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = r.top - h - 8;
    if (top < 8) top = r.bottom + 8;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function showReactPop(anchor, m) {
    const pop = $('reactPop');
    pop.replaceChildren();
    REACTIONS.forEach((emoji) => {
      const b = el('button', '', emoji);
      b.type = 'button';
      b.onclick = () => { socket.emit('message:react', { room: current, id: m.id, emoji }); pop.classList.add('hidden'); };
      pop.appendChild(b);
    });
    $('emojiPicker').classList.add('hidden');
    placePopover(pop, anchor);
  }
  EMOJIS.forEach((emoji) => {
    const b = el('button', '', emoji);
    b.type = 'button';
    b.onclick = () => {
      const t = $('msgInput'), s = t.selectionStart, e = t.selectionEnd;
      t.value = t.value.slice(0, s) + emoji + t.value.slice(e);
      t.selectionStart = t.selectionEnd = s + emoji.length;
      t.focus(); autosize();
    };
    $('emojiPicker').appendChild(b);
  });
  $('emojiBtn').onclick = (e) => {
    e.stopPropagation();
    const pop = $('emojiPicker');
    $('reactPop').classList.add('hidden');
    if (!pop.classList.contains('hidden')) return pop.classList.add('hidden');
    placePopover(pop, $('emojiBtn'));
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#emojiPicker, #emojiBtn')) $('emojiPicker').classList.add('hidden');
    if (!e.target.closest('#reactPop')) $('reactPop').classList.add('hidden');
  });
  $('messages').addEventListener('scroll', () => {
    $('reactPop').classList.add('hidden');
    const b = $('messages');
    b.dataset.stick = b.scrollHeight - b.scrollTop - b.clientHeight < 140 ? '1' : '0';
  }, { passive: true });

  // ---------- composer ----------
  function autosize() {
    const t = $('msgInput');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 140) + 'px';
  }
  function send() {
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text || !current) return;
    socket.emit('message', { room: current, text, replyTo: replyTo && replyTo.id });
    input.value = ''; autosize(); clearReply(); stopTyping();
  }
  $('msgForm').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') clearReply();
  });
  $('msgInput').addEventListener('input', () => {
    autosize();
    if (!current) return;
    if (!typingSent) { socket.emit('typing', { room: current, typing: true }); typingSent = true; }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1500);
  });
  function stopTyping() {
    if (typingSent && current) socket.emit('typing', { room: current, typing: false });
    typingSent = false; clearTimeout(typingTimer);
  }

  // ---------- typing indicator ----------
  function renderTyping() {
    const box = $('typing');
    box.replaceChildren();
    const names = [...typingUsers.keys()];
    if (!names.length) return;
    const dots = el('span', 'dots');
    dots.append(el('span'), el('span'), el('span'));
    box.appendChild(dots);
    box.appendChild(document.createTextNode(names.length > 2 ? 'Several people are typing…' : `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} typing…`));
  }
  socket.on('typing', ({ room, user, typing }) => {
    if (room !== current) return;
    clearTimeout(typingUsers.get(user));
    if (typing) typingUsers.set(user, setTimeout(() => { typingUsers.delete(user); renderTyping(); }, 4000));
    else typingUsers.delete(user);
    renderTyping();
  });

  // ---------- file sharing ----------
  function uploadFile(file) {
    if (!file || !current) return;
    if (file.size > MAX_UPLOAD) return toast(`"${file.name}" is too large (max 10 MB)`);
    const fd = new FormData();
    fd.append('socketId', me.id);
    fd.append('room', current);
    fd.append('file', file, file.name || 'pasted-image.png');
    const bar = $('uploadBar'), fill = bar.firstElementChild;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    bar.hidden = false; fill.style.width = '0%';
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) fill.style.width = (e.loaded / e.total * 100) + '%'; };
    xhr.onload = () => {
      bar.hidden = true;
      if (xhr.status !== 200) {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
        toast(msg);
      }
    };
    xhr.onerror = () => { bar.hidden = true; toast('Upload failed'); };
    xhr.send(fd);
  }
  const uploadMany = (files) => [...files].slice(0, 5).forEach(uploadFile);
  $('fileInput').addEventListener('change', (e) => { uploadMany(e.target.files); e.target.value = ''; });
  $('msgInput').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.length) { e.preventDefault(); uploadMany(files); }
  });
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e) && current) { dragDepth++; $('dropOverlay').classList.remove('hidden'); } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0;
    $('dropOverlay').classList.add('hidden');
    if (e.dataTransfer && e.dataTransfer.files.length) uploadMany(e.dataTransfer.files);
  });

  // ---------- lightbox ----------
  function openLightbox(url, name) { $('lightImg').src = url; $('lightImg').alt = name; $('lightbox').classList.remove('hidden'); }
  $('lightbox').onclick = () => $('lightbox').classList.add('hidden');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('lightbox').classList.add('hidden'); $('emojiPicker').classList.add('hidden'); $('reactPop').classList.add('hidden'); closeDrawers(); }
  });
})();
