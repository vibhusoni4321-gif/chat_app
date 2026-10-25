// End-to-end test: starts the server and drives it with socket.io clients.
const assert = require('assert');
const { io: Client } = require('socket.io-client');
const { server, ready } = require('./server');

const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const once = (s, ev, pred = () => true) =>
  new Promise((res) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); });
const connect = (url) => new Promise((res) => { const s = Client(url); s.on('connect', () => res(s)); });

(async () => {
  await ready;
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const a = await connect(url), b = await connect(url), c = await connect(url);

  // login + duplicate name
  const la = await emit(a, 'login', 'alice');
  assert(la.ok, 'alice logs in');
  assert((await emit(b, 'login', 'Alice')).error, 'duplicate name rejected');
  const lb = await emit(b, 'login', 'bob');
  const lc = await emit(c, 'login', 'carol');
  console.log('✔ login & unique names');

  // private room
  assert((await emit(a, 'room:create', { room: 'secret', password: 'pw123' })).ok);
  assert((await emit(a, 'room:join', { room: 'secret', password: 'pw123' })).ok);
  assert.strictEqual((await emit(b, 'room:join', { room: 'secret', password: 'nope' })).error, 'Wrong password');
  assert((await emit(b, 'room:join', { room: 'secret', password: 'pw123' })).ok);
  console.log('✔ private room password enforcement');

  // message delivery only to members
  let leaked = false;
  c.on('message', (m) => { if (m.room === 'secret') leaked = true; });
  const got = once(b, 'message', (m) => m.type === 'text');
  a.emit('message', { room: 'secret', text: 'hello bob' });
  const m = await got;
  assert.strictEqual(m.text, 'hello bob'); assert.strictEqual(m.user, 'alice');
  c.emit('message', { room: 'secret', text: 'intruder' }); // non-member send ignored
  await new Promise((r) => setTimeout(r, 200));
  assert(!leaked, 'non-member receives nothing');
  console.log('✔ messaging & room isolation');

  // presence
  const pres = once(a, 'room:members', (d) => d.members.some((x) => x.name === 'bob' && x.status === 'busy'));
  b.emit('status', 'busy');
  await pres;
  console.log('✔ presence status updates');

  // typing
  const typ = once(a, 'typing', (d) => d.user === 'bob' && d.typing);
  b.emit('typing', { room: 'secret', typing: true });
  await typ;
  console.log('✔ typing indicator');

  // file upload + download authorisation
  const fileMsg = once(b, 'message', (m) => m.type === 'file');
  const fd = new FormData();
  fd.append('socketId', a.id); fd.append('room', 'secret');
  fd.append('file', new Blob(['hello file'], { type: 'text/plain' }), 'note.txt');
  const up = await fetch(url + '/upload', { method: 'POST', body: fd });
  assert.strictEqual(up.status, 200);
  const fm = await fileMsg;
  assert.strictEqual(fm.file.name, 'note.txt');
  const dl = await fetch(`${url}/files/${fm.file.key}?socketId=${b.id}&room=secret`);
  assert.strictEqual(await dl.text(), 'hello file');
  const bad = await fetch(`${url}/files/${fm.file.key}?socketId=${c.id}&room=secret`);
  assert.strictEqual(bad.status, 403);
  const fd2 = new FormData();
  fd2.append('socketId', c.id); fd2.append('room', 'secret');
  fd2.append('file', new Blob(['x']), 'x.txt');
  assert.strictEqual((await fetch(url + '/upload', { method: 'POST', body: fd2 })).status, 403);
  console.log('✔ file upload, download, and access control');

  // disconnect cleans up
  const left = once(a, 'room:members', (d) => d.members.length === 1);
  b.close();
  await left;
  console.log('✔ disconnect removes user from room');

  // history: a newcomer sees earlier messages and files
  const d = await connect(url);
  await emit(d, 'login', 'dave');
  const joined = await emit(d, 'room:join', { room: 'secret', password: 'pw123' });
  assert(joined.history.some((x) => x.type === 'text' && x.text === 'hello bob'), 'text in history');
  assert(joined.history.some((x) => x.type === 'file' && x.file.name === 'note.txt'), 'file in history');
  assert(!joined.history.some((x) => x.type === 'system'), 'system notices are not saved');
  console.log('✔ message history is stored and replayed');

  console.log('\nAll tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
