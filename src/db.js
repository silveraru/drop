import { DatabaseSync } from 'node:sqlite';

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS drops (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL CHECK (kind IN ('note', 'photo', 'voice')),
      lat         REAL NOT NULL,
      lng         REAL NOT NULL,
      hint        TEXT,
      body        TEXT,
      media_file  TEXT,
      media_type  TEXT,
      created_at  INTEGER NOT NULL,
      open_count  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS drops_lat_lng ON drops (lat, lng);
  `);
  return db;
}
