import { DatabaseSync } from 'node:sqlite';

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE drops (
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
  CREATE INDEX drops_lat_lng ON drops (lat, lng);
  `,
  `
  ALTER TABLE drops ADD COLUMN owner_hash TEXT;
  ALTER TABLE drops ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
  ALTER TABLE drops ADD COLUMN max_opens INTEGER;
  ALTER TABLE drops ADD COLUMN expires_at INTEGER;
  ALTER TABLE drops ADD COLUMN destroyed_at INTEGER;
  ALTER TABLE drops ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE drops ADD COLUMN hunt_id TEXT REFERENCES hunts (id);
  ALTER TABLE drops ADD COLUMN hunt_step INTEGER;
  CREATE UNIQUE INDEX drops_hunt_step ON drops (hunt_id, hunt_step) WHERE hunt_id IS NOT NULL;
  CREATE INDEX drops_owner ON drops (owner_hash);
  CREATE INDEX drops_expires ON drops (expires_at) WHERE expires_at IS NOT NULL AND destroyed_at IS NULL;

  -- One row per device that opened a drop. Drives self-destruct counts, reply access and hunt order.
  CREATE TABLE opens (
    drop_id     TEXT NOT NULL,
    opener_hash TEXT NOT NULL,
    opened_at   INTEGER NOT NULL,
    PRIMARY KEY (drop_id, opener_hash)
  );

  CREATE TABLE hunts (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    description  TEXT,
    visibility   TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
    owner_hash   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    published_at INTEGER
  );
  CREATE INDEX hunts_owner ON hunts (owner_hash);

  CREATE TABLE replies (
    id          TEXT PRIMARY KEY,
    drop_id     TEXT NOT NULL,
    body        TEXT NOT NULL,
    author_hash TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    hidden      INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX replies_drop ON replies (drop_id, created_at);

  CREATE TABLE reports (
    target_type   TEXT NOT NULL CHECK (target_type IN ('drop', 'reply')),
    target_id     TEXT NOT NULL,
    reporter_hash TEXT NOT NULL,
    reason        TEXT NOT NULL,
    note          TEXT,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (target_type, target_id, reporter_hash)
  );
  `,
];

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  // Databases created before migrations existed already have the v1 table.
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0 && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'drops'").get()) version = 1;
  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
