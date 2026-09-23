import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.js';

test('upgrades a database created by the first release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-db-'));
  const file = path.join(dir, 'drop.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE drops (id TEXT PRIMARY KEY, kind TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, hint TEXT,
      body TEXT, media_file TEXT, media_type TEXT, created_at INTEGER NOT NULL, open_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX drops_lat_lng ON drops (lat, lng);
    INSERT INTO drops (id, kind, lat, lng, body, created_at) VALUES ('old', 'note', 1, 2, 'still here', 0);
  `);
  old.close();

  const db = openDb(file);
  const row = db.prepare('SELECT * FROM drops WHERE id = ?').get('old');
  assert.equal(row.body, 'still here');
  assert.equal(row.visibility, 'public');
  assert.equal(row.hidden, 0);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  db.close();

  openDb(file).close(); // reopening is a no-op
  fs.rmSync(dir, { recursive: true, force: true });
});
