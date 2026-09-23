import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { HERE, north, startServer } from './helpers.js';

let srv, alice, bob, carol, dave;
before(async () => {
  srv = await startServer({ adminToken: 'admin-secret', reportHideThreshold: 2 });
  [alice, bob, carol, dave] = [srv.device(), srv.device(), srv.device(), srv.device()];
});
after(() => srv.close());

const nearbyIds = async (who, pos = HERE) =>
  (await who.get(`/api/drops/nearby?lat=${pos.lat}&lng=${pos.lng}`)).data.drops.map((d) => d.id);

describe('private drops', () => {
  test('never listed, but open for anyone with the link who stands there', async () => {
    const { data } = await alice.drop({ visibility: 'private', body: 'for you' });
    assert.equal(data.visibility, 'private');
    assert.ok(!(await nearbyIds(bob)).includes(data.id));

    const viaLink = await bob.get(`/api/drops/${data.id}`);
    assert.equal(viaLink.status, 200);
    assert.equal(viaLink.data.body, undefined, 'link shows the pin, not the content');
    assert.equal((await bob.open(data.id)).data.body, 'for you');
  });
});

describe('self-destructing drops', () => {
  test('gone after max opens; the last opener still gets it', async () => {
    const { data } = await alice.drop({ body: 'burn after reading', maxOpens: 2 });
    assert.equal(data.opensLeft, 2);

    const first = await bob.open(data.id);
    assert.equal(first.data.body, 'burn after reading');
    assert.equal(first.data.selfDestructed, false);
    assert.equal(first.data.opensLeft, 1);
    assert.equal((await bob.open(data.id)).data.opensLeft, 1, 'reopening by the same device is free');

    const last = await carol.open(data.id);
    assert.equal(last.data.body, 'burn after reading');
    assert.equal(last.data.selfDestructed, true);

    assert.equal((await dave.open(data.id)).status, 410);
    assert.equal((await bob.open(data.id)).status, 410, 'even earlier openers lose it');
    assert.ok(!(await nearbyIds(dave)).includes(data.id));
  });

  test('media survives just long enough for the last opener, then the sweep deletes it', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const { data } = await alice.drop({ kind: 'photo', body: undefined, maxOpens: 1 }, { data: png, type: 'image/png', name: 'p.png' });
    const opened = await bob.open(data.id);
    assert.equal(opened.data.selfDestructed, true);
    assert.equal((await fetch(srv.base + opened.data.mediaUrl)).status, 200);

    const { db, service } = srv.app.locals;
    db.prepare('UPDATE drops SET destroyed_at = 1 WHERE id = ?').run(data.id);
    service.sweep();
    assert.equal((await fetch(srv.base + opened.data.mediaUrl)).status, 404);
  });

  test('expires after its time is up', async () => {
    const { data } = await alice.drop({ expiresInHours: 1 });
    assert.ok(data.expiresAt > Date.now());
    assert.equal((await bob.get(`/api/drops/${data.id}`)).status, 200);

    srv.app.locals.db.prepare('UPDATE drops SET expires_at = ? WHERE id = ?').run(Date.now() - 1, data.id);
    assert.equal((await bob.open(data.id)).status, 410);
    assert.ok(!(await nearbyIds(bob)).includes(data.id));
    srv.app.locals.service.sweep();
    assert.ok(srv.app.locals.service.getDrop(data.id).destroyed_at);
  });
});

describe('replies', () => {
  test('only people who opened the drop can read and write them', async () => {
    const { data } = await alice.drop({ body: 'sign the guestbook' });
    assert.equal((await bob.get(`/api/drops/${data.id}/replies`)).status, 403);
    assert.equal((await bob.post(`/api/drops/${data.id}/replies`, { body: 'sneaky' })).status, 403);

    await bob.open(data.id);
    const posted = await bob.post(`/api/drops/${data.id}/replies`, { body: 'Found it!' });
    assert.equal(posted.status, 201);
    assert.equal(posted.data.mine, true);

    const ownerReply = await alice.post(`/api/drops/${data.id}/replies`, { body: 'Nice one' });
    assert.equal(ownerReply.data.byDropper, true, 'dropper can reply without opening');

    const opened = await carol.open(data.id);
    assert.deepEqual(opened.data.replies.map((r) => r.body), ['Found it!', 'Nice one']);
    assert.equal(opened.data.replies[0].mine, false);

    assert.equal((await bob.post(`/api/drops/${data.id}/replies`, { body: ' ' })).status, 400);
    assert.equal((await bob.post(`/api/drops/${data.id}/replies`, { body: 'x'.repeat(501) })).status, 400);
  });

  test('authors and the dropper can delete replies; others cannot', async () => {
    const { data } = await alice.drop({});
    await bob.open(data.id);
    const r1 = (await bob.post(`/api/drops/${data.id}/replies`, { body: 'one' })).data;
    const r2 = (await bob.post(`/api/drops/${data.id}/replies`, { body: 'two' })).data;
    await carol.open(data.id);
    assert.equal((await carol.del(`/api/replies/${r1.id}`)).status, 404);
    assert.equal((await bob.del(`/api/replies/${r1.id}`)).status, 204);
    assert.equal((await alice.del(`/api/replies/${r2.id}`)).status, 204);
    assert.equal((await carol.get(`/api/drops/${data.id}/replies`)).data.replies.length, 0);
  });

  test('self-destruct wipes replies', async () => {
    const { data } = await alice.drop({ maxOpens: 2 });
    await bob.open(data.id);
    await bob.post(`/api/drops/${data.id}/replies`, { body: 'bye' });
    await carol.open(data.id);
    assert.equal(srv.app.locals.db.prepare('SELECT COUNT(*) AS n FROM replies WHERE drop_id = ?').get(data.id).n, 0);
  });
});

describe('reporting', () => {
  const admin = { authorization: 'Bearer admin-secret' };

  test('enough distinct reports hide a drop until an admin restores it', async () => {
    const { data } = await alice.drop({ hint: 'rude hint' });
    const report = (who) => who.post('/api/reports', { targetType: 'drop', targetId: data.id, reason: 'offensive', note: 'bad' });

    assert.equal((await report(bob)).status, 201);
    assert.equal((await report(bob)).status, 201, 'duplicate report is accepted but not counted');
    assert.ok((await nearbyIds(dave)).includes(data.id), 'one reporter is not enough');

    await report(carol);
    assert.ok(!(await nearbyIds(dave)).includes(data.id));
    assert.equal((await dave.get(`/api/drops/${data.id}`)).status, 404);
    const own = await alice.get(`/api/drops/${data.id}`);
    assert.equal(own.data.hidden, true, 'the owner can see it was hidden');

    const queue = await dave.get('/api/admin/reports', admin);
    const item = queue.data.items.find((i) => i.targetId === data.id);
    assert.equal(item.count, 2);
    assert.equal(item.hidden, true);
    assert.equal(item.hint, 'rude hint');

    assert.equal((await dave.post(`/api/admin/drop/${data.id}/restore`, undefined, admin)).status, 204);
    assert.ok((await nearbyIds(dave)).includes(data.id));
  });

  test('admin can take down drops and replies', async () => {
    const { data } = await alice.drop({});
    await bob.open(data.id);
    const reply = (await bob.post(`/api/drops/${data.id}/replies`, { body: 'spam spam' })).data;
    await carol.post('/api/reports', { targetType: 'reply', targetId: reply.id, reason: 'spam' });

    assert.equal((await dave.del(`/api/admin/reply/${reply.id}`, admin)).status, 204);
    assert.equal((await dave.del(`/api/admin/drop/${data.id}`, admin)).status, 204);
    assert.equal((await dave.get(`/api/drops/${data.id}`)).status, 404);
  });

  test('reported replies disappear for readers', async () => {
    const { data } = await alice.drop({});
    await bob.open(data.id);
    const reply = (await bob.post(`/api/drops/${data.id}/replies`, { body: 'nasty' })).data;
    for (const who of [carol, dave]) await who.post('/api/reports', { targetType: 'reply', targetId: reply.id, reason: 'offensive' });
    assert.equal((await alice.get(`/api/drops/${data.id}/replies`)).data.replies.length, 0);
  });

  test('validates input and protects admin endpoints', async () => {
    const { data } = await alice.drop({});
    assert.equal((await bob.post('/api/reports', { targetType: 'drop', targetId: data.id, reason: 'meh' })).status, 400);
    assert.equal((await bob.post('/api/reports', { targetType: 'hunt', targetId: data.id, reason: 'spam' })).status, 400);
    assert.equal((await bob.post('/api/reports', { targetType: 'drop', targetId: 'nope', reason: 'spam' })).status, 404);
    assert.equal((await bob.get('/api/admin/reports')).status, 401);
    assert.equal((await bob.get('/api/admin/reports', { authorization: 'Bearer wrong' })).status, 401);
  });

  test('admin endpoints do not exist without ADMIN_TOKEN', async () => {
    const other = await startServer();
    const res = await other.device().get('/api/admin/reports', { authorization: 'Bearer ' });
    other.close();
    assert.equal(res.status, 404);
  });
});

describe('treasure hunts', () => {
  async function buildHunt(owner, { visibility = 'public', steps = 3 } = {}) {
    const hunt = (await owner.post('/api/hunts', { title: 'Riverside run', description: 'Follow the clues', visibility })).data;
    const stepIds = [];
    for (let i = 0; i < steps; i++) {
      const res = await owner.drop({ huntId: hunt.id, body: `clue ${i + 1}`, hint: `hint ${i + 1}`, ...north(HERE, i * 200) });
      assert.equal(res.status, 201);
      assert.equal(res.data.hunt.step, i + 1);
      stepIds.push(res.data.id);
    }
    return { hunt, stepIds };
  }

  test('play through: each step reveals the next, in order', async () => {
    const { hunt, stepIds } = await buildHunt(alice);
    const [s1, s2, s3] = stepIds;

    assert.ok(!(await nearbyIds(bob)).includes(s1), 'unpublished hunts are invisible');
    assert.equal((await bob.get(`/api/hunts/${hunt.id}`)).status, 404);
    assert.equal((await alice.post(`/api/hunts/${hunt.id}/publish`)).status, 200);

    const ids = await nearbyIds(bob, north(HERE, 200));
    assert.ok(ids.includes(s1), 'step 1 is on the public map');
    assert.ok(!ids.includes(s2), 'later steps are not');

    const info = (await bob.get(`/api/hunts/${hunt.id}`)).data;
    assert.equal(info.stepCount, 3);
    assert.equal(info.start.id, s1);
    assert.equal(info.steps, undefined, 'players cannot see the route');

    const skip = await bob.open(s2, north(HERE, 200));
    assert.equal(skip.status, 403);
    assert.match(skip.data.error, /Find step 1 first/);

    const o1 = await bob.open(s1);
    assert.equal(o1.data.body, 'clue 1');
    assert.equal(o1.data.next.id, s2);
    assert.equal(o1.data.next.hint, 'hint 2');
    assert.equal(o1.data.next.body, undefined, 'next clue location only, not content');
    assert.equal(o1.data.huntComplete, false);

    const o2 = await bob.open(s2, north(HERE, 200));
    assert.equal(o2.data.next.id, s3);
    const o3 = await bob.open(s3, north(HERE, 400));
    assert.equal(o3.data.next, null);
    assert.equal(o3.data.huntComplete, true);

    const after = (await bob.get(`/api/hunts/${hunt.id}`)).data;
    assert.equal(after.progress, 3);
    assert.equal(after.finishers, 1);
  });

  test('private hunts are link-only', async () => {
    const { hunt, stepIds } = await buildHunt(alice, { visibility: 'private', steps: 2 });
    await alice.post(`/api/hunts/${hunt.id}/publish`);
    assert.ok(!(await nearbyIds(bob)).includes(stepIds[0]));
    const viaLink = await bob.get(`/api/hunts/${hunt.id}`);
    assert.equal(viaLink.status, 200);
    assert.equal((await bob.open(viaLink.data.start.id)).data.body, 'clue 1');
  });

  test('building rules', async () => {
    const hunt = (await alice.post('/api/hunts', { title: 'Tiny' })).data;
    assert.equal((await bob.drop({ huntId: hunt.id })).status, 404, "can't add to someone else's hunt");
    assert.equal((await alice.drop({ huntId: hunt.id, maxOpens: 1 })).status, 400, "steps can't self-destruct");
    await alice.drop({ huntId: hunt.id });
    assert.equal((await alice.post(`/api/hunts/${hunt.id}/publish`)).status, 400, 'needs 2+ steps');
    await alice.drop({ huntId: hunt.id });
    assert.equal((await alice.post(`/api/hunts/${hunt.id}/publish`)).status, 200);
    assert.equal((await alice.drop({ huntId: hunt.id })).status, 409, 'frozen once published');
    assert.equal((await alice.post('/api/hunts', { title: '' })).status, 400);

    const step = (await alice.get('/api/me')).data.hunts.find((h) => h.id === hunt.id).steps[0];
    assert.equal((await alice.del(`/api/drops/${step.id}`)).status, 409, 'delete the hunt, not a step');
    assert.equal((await bob.del(`/api/hunts/${hunt.id}`)).status, 404);
    assert.equal((await alice.del(`/api/hunts/${hunt.id}`)).status, 204);
    assert.equal((await bob.get(`/api/drops/${step.id}`)).status, 404);
  });

  test('owner sees the full route in /api/me', async () => {
    const eve = srv.device();
    const { hunt } = await buildHunt(eve, { steps: 2 });
    const me = (await eve.get('/api/me')).data;
    const mine = me.hunts.find((h) => h.id === hunt.id);
    assert.equal(mine.steps.length, 2);
    assert.equal(mine.published, false);
    assert.equal(me.drops.length, 0, 'hunt steps are not listed as standalone drops');
  });
});
