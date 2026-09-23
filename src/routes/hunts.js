import crypto from 'node:crypto';
import express from 'express';
import { HttpError, rateLimiter, requireDevice, text } from '../util.js';

export function huntRoutes({ db, config, service }) {
  const router = express.Router();

  function loadOwnHunt(req) {
    const hunt = service.getHunt(req.params.id);
    if (!hunt || hunt.owner_hash !== req.device) throw new HttpError(404, 'Hunt not found');
    return hunt;
  }

  // Start building a hunt. Steps are added by creating drops with huntId, then it's published.
  router.post(
    '/hunts',
    requireDevice,
    rateLimiter({ limit: config.huntsPerDay, windowMs: 24 * 3600_000, key: (req) => req.device }),
    (req, res) => {
      const title = text(req.body?.title, 80, 'Title');
      const description = text(req.body?.description, 500, 'Description');
      const visibility = req.body?.visibility || 'public';
      if (!title) throw new HttpError(400, 'Give your hunt a title');
      if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'visibility must be public or private');
      const id = crypto.randomUUID();
      db.prepare(
        'INSERT INTO hunts (id, title, description, visibility, owner_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, title, description || null, visibility, req.device, service.now());
      res.status(201).json(huntView(service.getHunt(id), req.device));
    },
  );

  function huntView(hunt, device) {
    const mine = hunt.owner_hash === device;
    const steps = db.prepare('SELECT * FROM drops WHERE hunt_id = ? ORDER BY hunt_step').all(hunt.id);
    const last = steps.at(-1);
    const view = {
      ...service.huntSummary(hunt),
      description: hunt.description,
      visibility: hunt.visibility,
      createdAt: hunt.created_at,
      mine,
      progress: device ? steps.filter((s) => service.hasOpened(s.id, device)).length : 0,
      finishers: last
        ? db.prepare('SELECT COUNT(*) AS n FROM opens WHERE drop_id = ? AND opener_hash != ?').get(last.id, hunt.owner_hash).n
        : 0,
      start: steps[0] && !steps[0].hidden ? service.lockedView(steps[0], device) : null,
    };
    // The builder sees the whole route; players only ever see the start and the clues they've earned.
    if (mine) view.steps = steps.map((s) => ({ ...service.lockedView(s, device), hidden: Boolean(s.hidden) }));
    return view;
  }

  router.get('/hunts/:id', (req, res) => {
    const hunt = service.getHunt(req.params.id);
    if (!hunt || (!hunt.published_at && hunt.owner_hash !== req.device)) throw new HttpError(404, 'Hunt not found');
    res.json(huntView(hunt, req.device));
  });

  router.post('/hunts/:id/publish', requireDevice, (req, res) => {
    const hunt = loadOwnHunt(req);
    if (!hunt.published_at) {
      if (service.huntStepCount(hunt.id) < 2) throw new HttpError(400, 'A hunt needs at least 2 steps');
      db.prepare('UPDATE hunts SET published_at = ? WHERE id = ?').run(service.now(), hunt.id);
    }
    res.json(huntView(service.getHunt(hunt.id), req.device));
  });

  router.delete('/hunts/:id', requireDevice, (req, res) => {
    const hunt = loadOwnHunt(req);
    service.deleteHunt(hunt.id);
    res.status(204).end();
  });

  return { router, huntView };
}
