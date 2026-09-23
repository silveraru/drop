import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { HERE, north, startServer } from './helpers.js';

let srv, alice, bob;
before(async () => {
  srv = await startServer();
  alice = srv.device();
  bob = srv.device();
});
after(() => srv.close());

test('note drop: hidden from afar, opens when standing on it', async () => {
  const created = await alice.drop({ body: 'Hello from the bridge', hint: 'By the lamp' });
  assert.equal(created.status, 201);
  const { id } = created.data;

  const nearby = await bob.get(`/api/drops/nearby?lat=${north(HERE, 111).lat}&lng=${HERE.lng}`);
  const listed = nearby.data.drops.find((d) => d.id === id);
  assert.ok(listed, 'drop is listed nearby');
  assert.equal(listed.hint, 'By the lamp');
  assert.equal(listed.body, undefined, 'content is not leaked in the listing');
  assert.ok(listed.distanceM > 100 && listed.distanceM < 120);

  const far = await bob.open(id, north(HERE, 111));
  assert.equal(far.status, 403);
  assert.equal(far.data.body, undefined);
  assert.ok(far.data.distanceM > 100);

  const close = await bob.open(id, north(HERE, 11));
  assert.equal(close.status, 200);
  assert.equal(close.data.body, 'Hello from the bridge');
  assert.equal(close.data.mediaUrl, null);
  assert.equal(close.data.openCount, 1);
});

test('each device counts once, and the dropper never counts', async () => {
  const { data } = await alice.drop({});
  await alice.open(data.id);
  await bob.open(data.id);
  const again = await bob.open(data.id);
  assert.equal(again.data.openCount, 1);
});

test('identity is required to drop or open', async () => {
  const anon = srv.device(null);
  assert.equal((await anon.drop({})).status, 401);
  const { data } = await alice.drop({});
  assert.equal((await anon.open(data.id)).status, 401);
  // Browsing stays anonymous.
  assert.equal((await anon.get(`/api/drops/nearby?lat=${HERE.lat}&lng=${HERE.lng}`)).status, 200);
});

test('photo drop: media only reachable via signed URL after opening', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const created = await alice.drop({ kind: 'photo', body: undefined }, { data: png, type: 'image/png', name: 'a.png' });
  assert.equal(created.status, 201);
  const { id } = created.data;

  assert.equal((await bob.get(`/api/media/${id}`)).status, 403);

  const opened = await bob.open(id);
  assert.match(opened.data.mediaUrl, /^\/api\/media\//);
  const media = await fetch(srv.base + opened.data.mediaUrl);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);

  const other = (await alice.drop({})).data;
  assert.equal((await fetch(srv.base + opened.data.mediaUrl.replace(id, other.id))).status, 403, 'signature is per drop');
  assert.equal((await fetch(srv.base + opened.data.mediaUrl.replace(/exp=\d+/, 'exp=1'))).status, 403, 'expired');
});

test('voice drop accepts audio with codec parameters', async () => {
  const res = await alice.drop({ kind: 'voice', body: undefined }, { data: Buffer.from('webm'), type: 'audio/webm;codecs=opus', name: 'v.webm' });
  assert.equal(res.status, 201);
});

test('rejects imprecise locations for dropping and opening', async () => {
  assert.equal((await alice.drop({ accuracy: 500 })).status, 422);
  const { data } = await alice.drop({});
  assert.equal((await bob.open(data.id, { ...HERE, accuracy: 500 })).status, 422);
});

test('rejects invalid drops and cleans up uploads', async () => {
  const mediaDir = path.join(srv.dataDir, 'media');
  const count = fs.readdirSync(mediaDir).length;

  assert.equal((await alice.drop({ body: '' })).status, 400);
  assert.equal((await alice.drop({ kind: 'video' })).status, 400);
  assert.equal((await alice.drop({ lat: undefined })).status, 400);
  assert.equal((await alice.drop({ visibility: 'secret' })).status, 400);
  assert.equal((await alice.drop({ maxOpens: 0 })).status, 400);
  const wrong = await alice.drop({ kind: 'photo' }, { data: Buffer.from('x'), type: 'audio/webm', name: 'a.webm' });
  assert.equal(wrong.status, 415);
  const svg = await alice.drop({ kind: 'photo' }, { data: Buffer.from('<svg/>'), type: 'image/svg+xml', name: 'a.svg' });
  assert.equal(svg.status, 415, 'SVG is never accepted (script-capable)');
  const badVis = await alice.drop({ kind: 'photo', visibility: 'nope' }, { data: Buffer.from('x'), type: 'image/png', name: 'a.png' });
  assert.equal(badVis.status, 400);

  assert.equal(fs.readdirSync(mediaDir).length, count, 'rejected uploads are deleted');
});

test('owners can delete their drops, others cannot', async () => {
  const { data } = await alice.drop({});
  assert.equal((await bob.del(`/api/drops/${data.id}`)).status, 404);
  assert.equal((await alice.del(`/api/drops/${data.id}`)).status, 204);
  assert.equal((await bob.get(`/api/drops/${data.id}`)).status, 404);
});

test('/api/me lists only my drops', async () => {
  const carol = srv.device();
  await carol.drop({ body: 'mine' });
  const me = await carol.get('/api/me');
  assert.equal(me.data.drops.length, 1);
  assert.equal(me.data.drops[0].mine, true);
});

test('unknown drop and bad nearby query', async () => {
  assert.equal((await bob.open('does-not-exist')).status, 404);
  assert.equal((await bob.get('/api/drops/nearby?lat=abc&lng=0')).status, 400);
});
