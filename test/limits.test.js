import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HERE, startServer } from './helpers.js';

test('open attempts are rate limited per IP', async () => {
  const srv = await startServer({ openAttemptsPerMinute: 3 });
  const phone = srv.device();
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await phone.open('nope', HERE)).status);
  srv.close();
  assert.deepEqual(statuses, [404, 404, 404, 429]);
});

test('drop creation is rate limited per device', async () => {
  const srv = await startServer({ createsPerHour: 2 });
  const a = srv.device();
  const b = srv.device();
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await a.drop({})).status);
  const other = (await b.drop({})).status;
  srv.close();
  assert.deepEqual(statuses, [201, 201, 429]);
  assert.equal(other, 201, 'another device is unaffected');
});
