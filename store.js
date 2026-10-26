// Storage layer. Uses PostgreSQL when DATABASE_URL is set (history persists across
// restarts and deploys); otherwise falls back to in-memory storage (handy for local
// development and tests, but everything is lost when the server stops).

const HISTORY_LIMIT = 100;

// ---------- in-memory implementation ----------
function memoryStore() {
  const rooms = new Map();    // name -> room record
  const messages = new Map(); // room -> [message]
  const files = new Map();    // key -> { data, mime }

  const find = (id) => {
    for (const list of messages.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    return null;
  };

  return {
    kind: 'memory',
    async init() {},
    async loadRooms() { return [...rooms.values()]; },
    async saveRoom(r) { rooms.set(r.name, r); },
    async saveMessage(m) {
      if (!messages.has(m.room)) messages.set(m.room, []);
      const list = messages.get(m.room);
      list.push(m);
      if (list.length > 1000) list.shift();
    },
    async history(room) { return (messages.get(room) || []).slice(-HISTORY_LIMIT); },
    async getMessage(id) { return find(id); },
    // patch may contain: text, edited, reactions, deleted
    async updateMessage(id, patch) {
      const m = find(id);
      if (!m) return null;
      Object.assign(m, patch);
      if (patch.deleted) { m.text = ''; m.file = null; m.replyTo = null; }
      return m;
    },
    async saveFile(key, data, mime) { files.set(key, { data, mime }); },
    async getFile(key) { return files.get(key) || null; },
    async deleteFile(key) { files.delete(key); },
    // Returns { name, mime } if a (non-deleted) file message with this key exists in the room
    async fileInRoom(key, room) {
      const m = (messages.get(room) || []).find((x) => x.type === 'file' && x.file && x.file.key === key);
      return m ? { name: m.file.name, mime: m.file.mime } : null;
    },
  };
}

// ---------- PostgreSQL implementation ----------
function pgStore(connectionString) {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false }, // hosted DBs (Neon, Render, Supabase) need SSL
    max: 5,
  });

  const rowToMessage = (r) => {
    const base = {
      id: r.id, room: r.room, user: r.username, ts: Number(r.ts), type: r.type,
      replyTo: r.reply_to || null, edited: !!r.edited, deleted: !!r.deleted, reactions: r.reactions || {},
    };
    if (r.deleted) return { ...base, text: '', file: null, replyTo: null };
    if (r.type === 'file') {
      return { ...base, file: { name: r.file_name, size: Number(r.file_size), mime: r.file_mime, key: r.file_key } };
    }
    return { ...base, text: r.text };
  };

  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS rooms (
          name          TEXT PRIMARY KEY,
          password_hash TEXT,
          salt          TEXT NOT NULL,
          owner         TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS messages (
          id        TEXT PRIMARY KEY,
          room      TEXT NOT NULL REFERENCES rooms(name) ON DELETE CASCADE,
          type      TEXT NOT NULL,
          username  TEXT NOT NULL,
          text      TEXT,
          file_name TEXT,
          file_size BIGINT,
          file_mime TEXT,
          file_key  TEXT,
          ts        BIGINT NOT NULL
        );
        -- v3 columns (safe to run on a v2 database)
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to  JSONB;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited    BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted   BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'::jsonb;
        CREATE INDEX IF NOT EXISTS messages_room_ts ON messages (room, ts);
        CREATE INDEX IF NOT EXISTS messages_file_key ON messages (file_key) WHERE file_key IS NOT NULL;
        CREATE TABLE IF NOT EXISTS files (
          key  TEXT PRIMARY KEY,
          mime TEXT,
          data BYTEA NOT NULL
        );
      `);
    },
    async loadRooms() {
      const { rows } = await pool.query('SELECT name, password_hash, salt, owner FROM rooms');
      return rows.map((r) => ({ name: r.name, passwordHash: r.password_hash, salt: r.salt, owner: r.owner }));
    },
    async saveRoom(r) {
      await pool.query(
        'INSERT INTO rooms (name, password_hash, salt, owner) VALUES ($1,$2,$3,$4) ON CONFLICT (name) DO NOTHING',
        [r.name, r.passwordHash, r.salt, r.owner]
      );
    },
    async saveMessage(m) {
      const f = m.file || {};
      await pool.query(
        `INSERT INTO messages (id, room, type, username, text, file_name, file_size, file_mime, file_key, ts,
                               reply_to, edited, deleted, reactions)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb)`,
        [
          m.id, m.room, m.type, m.user, m.text || null, f.name || null, f.size || null, f.mime || null,
          f.key || null, m.ts, m.replyTo ? JSON.stringify(m.replyTo) : null, !!m.edited, !!m.deleted,
          JSON.stringify(m.reactions || {}),
        ]
      );
    },
    async history(room) {
      const { rows } = await pool.query(
        'SELECT * FROM messages WHERE room = $1 ORDER BY ts DESC LIMIT $2',
        [room, HISTORY_LIMIT]
      );
      return rows.reverse().map(rowToMessage);
    },
    async getMessage(id) {
      const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
      return rows[0] ? rowToMessage(rows[0]) : null;
    },
    async updateMessage(id, patch) {
      const sets = [];
      const vals = [id];
      const add = (sql, v) => { vals.push(v); sets.push(sql.replace('?', '$' + vals.length)); };
      if ('text' in patch) add('text = ?', patch.text);
      if ('edited' in patch) add('edited = ?', !!patch.edited);
      if ('reactions' in patch) add('reactions = ?::jsonb', JSON.stringify(patch.reactions || {}));
      if (patch.deleted) sets.push('deleted = true', 'text = NULL', 'file_key = NULL', 'file_name = NULL', 'reply_to = NULL');
      if (!sets.length) return this.getMessage(id);
      const { rows } = await pool.query(`UPDATE messages SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
      return rows[0] ? rowToMessage(rows[0]) : null;
    },
    async saveFile(key, data, mime) {
      await pool.query('INSERT INTO files (key, mime, data) VALUES ($1,$2,$3)', [key, mime, data]);
    },
    async getFile(key) {
      const { rows } = await pool.query('SELECT data, mime FROM files WHERE key = $1', [key]);
      return rows[0] ? { data: rows[0].data, mime: rows[0].mime } : null;
    },
    async deleteFile(key) {
      await pool.query('DELETE FROM files WHERE key = $1', [key]);
    },
    async fileInRoom(key, room) {
      const { rows } = await pool.query(
        'SELECT file_name, file_mime FROM messages WHERE room = $1 AND file_key = $2 AND NOT deleted LIMIT 1',
        [room, key]
      );
      return rows[0] ? { name: rows[0].file_name, mime: rows[0].file_mime } : null;
    },
  };
}

module.exports = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL) : memoryStore();
