import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

const HERE = { lat: 51.5007, lng: -0.1246, accuracy: 8 };
// ~111 m north
const NEARBY = { lat: HERE.lat + 0.001, lng: HERE.lng, accuracy: 8 };
// ~11 m north
const CLOSE = { lat: HERE.lat + 0.0001, lng: HERE.lng, accuracy: 8 };

let server, base, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'));
  const app = createApp({ dataDir, secret: 'test-secret', openAttemptsPerMinute: 1000 });
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function form(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  if (file) fd.append('media', new Blob([file.data], { type: file.type }), file.name);
  return fd;
}

const post = (url, body) =>
  fetch(base + url, body instanceof FormData
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('note drop: hidden from afar, opens when standing on it', async () => {
  const created = await post('/api/drops', form({ kind: 'note', body: 'Hello from the bridge', hint: 'By the lamp', ...HERE }));
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const nearby = await (await fetch(`${base}/api/drops/nearby?lat=${NEARBY.lat}&lng=${NEARBY.lng}`)).json();
  const listed = nearby.drops.find((d) => d.id === id);
  assert.ok(listed, 'drop is listed nearby');
  assert.equal(listed.hint, 'By the lamp');
  assert.equal(listed.body, undefined, 'content is not leaked in the listing');
  assert.ok(listed.distanceM > 100 && listed.distanceM < 120);

  const far = await post(`/api/drops/${id}/open`, NEARBY);
  assert.equal(far.status, 403);
  const farBody = await far.json();
  assert.equal(farBody.body, undefined);
  assert.ok(farBody.distanceM > 100);

  const close = await post(`/api/drops/${id}/open`, CLOSE);
  assert.equal(close.status, 200);
  const opened = await close.json();
  assert.equal(opened.body, 'Hello from the bridge');
  assert.equal(opened.mediaUrl, null);
});

test('photo drop: media only reachable via signed URL after opening', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const created = await post('/api/drops', form({ kind: 'photo', ...HERE }, { data: png, type: 'image/png', name: 'a.png' }));
  assert.equal(created.status, 201);
  const { id } = await created.json();

  assert.equal((await fetch(`${base}/api/media/${id}`)).status, 403);

  const opened = await (await post(`/api/drops/${id}/open`, HERE)).json();
  assert.match(opened.mediaUrl, /^\/api\/media\//);
  const media = await fetch(base + opened.mediaUrl);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);

  // A signature for one drop doesn't unlock another.
  const other = await (await post('/api/drops', form({ kind: 'note', body: 'x', ...HERE }))).json();
  const forged = opened.mediaUrl.replace(id, other.id);
  assert.equal((await fetch(base + forged)).status, 403);

  // Expired links are rejected.
  const expired = opened.mediaUrl.replace(/exp=\d+/, 'exp=1');
  assert.equal((await fetch(base + expired)).status, 403);
});

test('voice drop accepts audio with codec parameters', async () => {
  const res = await post('/api/drops', form({ kind: 'voice', ...HERE }, { data: Buffer.from('webm'), type: 'audio/webm;codecs=opus', name: 'v.webm' }));
  assert.equal(res.status, 201);
});

test('rejects imprecise locations for dropping and opening', async () => {
  const res = await post('/api/drops', form({ kind: 'note', body: 'x', ...HERE, accuracy: 500 }));
  assert.equal(res.status, 422);

  const { id } = await (await post('/api/drops', form({ kind: 'note', body: 'x', ...HERE }))).json();
  const open = await post(`/api/drops/${id}/open`, { ...HERE, accuracy: 500 });
  assert.equal(open.status, 422);
});

test('rejects invalid drops and cleans up uploads', async () => {
  const mediaDir = path.join(dataDir, 'media');
  const before = fs.readdirSync(mediaDir).length;

  assert.equal((await post('/api/drops', form({ kind: 'note', ...HERE }))).status, 400);
  assert.equal((await post('/api/drops', form({ kind: 'video', body: 'x', ...HERE }))).status, 400);
  assert.equal((await post('/api/drops', form({ kind: 'note', body: 'x' }))).status, 400);
  // Photo kind with an audio file.
  const wrong = await post('/api/drops', form({ kind: 'photo', ...HERE }, { data: Buffer.from('x'), type: 'audio/webm', name: 'a.webm' }));
  assert.equal(wrong.status, 415);
  // SVG is never accepted (script-capable).
  const svg = await post('/api/drops', form({ kind: 'photo', ...HERE }, { data: Buffer.from('<svg/>'), type: 'image/svg+xml', name: 'a.svg' }));
  assert.equal(svg.status, 415);

  assert.equal(fs.readdirSync(mediaDir).length, before, 'rejected uploads are deleted');
});

test('open attempts are rate limited', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-rl-'));
  const app = createApp({ dataDir: dir, openAttemptsPerMinute: 3 });
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/drops/nope/open`;
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(HERE) });
    statuses.push(r.status);
  }
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(statuses, [404, 404, 404, 429]);
});

test('unknown drop and bad nearby query', async () => {
  assert.equal((await post('/api/drops/does-not-exist/open', HERE)).status, 404);
  assert.equal((await fetch(`${base}/api/drops/nearby?lat=abc&lng=0`)).status, 400);
});
