import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import multer from 'multer';
import { boundingBox, distanceMeters, parsePosition } from '../geo.js';
import { HttpError, optionalInt, rateLimiter, requireDevice, text } from '../util.js';

const MEDIA_TYPES = {
  photo: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']),
  voice: new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-m4a']),
};
const ALL_MEDIA_TYPES = new Set([...MEDIA_TYPES.photo, ...MEDIA_TYPES.voice]);
const baseMime = (mime) => String(mime || '').split(';')[0].trim().toLowerCase();
const HOUR_MS = 3600_000;

export function dropRoutes({ db, config, service, uploadDir }) {
  const router = express.Router();
  const perDevice = (limit, windowMs, message) => rateLimiter({ limit, windowMs, key: (req) => req.device || req.ip, message });

  function requirePrecise(req) {
    const pos = parsePosition(req.body);
    if (!pos) throw new HttpError(400, 'A valid lat, lng and accuracy are required');
    if (pos.accuracy > config.maxAccuracyM) {
      throw new HttpError(422, `Location too imprecise (±${Math.round(pos.accuracy)} m). Wait for a better GPS fix.`);
    }
    return pos;
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 },
    fileFilter: (_req, file, cb) => {
      if (ALL_MEDIA_TYPES.has(baseMime(file.mimetype))) cb(null, true);
      else cb(new HttpError(415, `Unsupported media type: ${file.mimetype}`));
    },
  });

  // Create a drop at the caller's current position, standalone or as the next step of a hunt.
  router.post(
    '/drops',
    requireDevice,
    perDevice(config.createsPerHour, HOUR_MS, 'You have dropped a lot recently. Try again later.'),
    upload.single('media'),
    (req, res) => {
      try {
        const kind = req.body.kind;
        if (!['note', 'photo', 'voice'].includes(kind)) throw new HttpError(400, 'kind must be note, photo or voice');
        const pos = requirePrecise(req);
        const body = text(req.body.body, 2000, 'Message');
        const hint = text(req.body.hint, 140, 'Hint');
        const maxOpens = optionalInt(req.body.maxOpens, 1, 1000, 'maxOpens');
        const expiresInHours = optionalInt(req.body.expiresInHours, 1, 24 * 365, 'expiresInHours');

        let mediaType = null;
        if (kind === 'note') {
          if (!body) throw new HttpError(400, 'A note needs some text');
          if (req.file) throw new HttpError(400, 'Notes cannot carry media');
        } else {
          if (!req.file) throw new HttpError(400, `A ${kind} drop needs a file`);
          mediaType = baseMime(req.file.mimetype);
          if (!MEDIA_TYPES[kind].has(mediaType)) throw new HttpError(415, `${mediaType} is not valid for a ${kind} drop`);
        }

        let visibility = req.body.visibility || 'public';
        let huntId = null;
        let huntStep = null;
        if (req.body.huntId) {
          const hunt = service.getHunt(req.body.huntId);
          if (!hunt || hunt.owner_hash !== req.device) throw new HttpError(404, 'Hunt not found');
          if (hunt.published_at) throw new HttpError(409, 'This hunt is already published and can no longer change');
          if (maxOpens !== null || expiresInHours !== null) throw new HttpError(400, "Hunt steps can't self-destruct");
          huntId = hunt.id;
          huntStep = service.huntStepCount(hunt.id) + 1;
          if (huntStep > config.maxHuntSteps) throw new HttpError(400, `A hunt can have at most ${config.maxHuntSteps} steps`);
          visibility = hunt.visibility;
        } else if (!['public', 'private'].includes(visibility)) {
          throw new HttpError(400, 'visibility must be public or private');
        }

        const id = crypto.randomUUID();
        const createdAt = service.now();
        const expiresAt = expiresInHours === null ? null : createdAt + expiresInHours * HOUR_MS;
        db.prepare(
          `INSERT INTO drops (id, kind, lat, lng, hint, body, media_file, media_type, created_at,
             owner_hash, visibility, max_opens, expires_at, hunt_id, hunt_step)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id, kind, pos.lat, pos.lng, hint || null, body || null, req.file?.filename ?? null, mediaType, createdAt,
          req.device, visibility, maxOpens, expiresAt, huntId, huntStep,
        );

        res.status(201).json(service.lockedView(service.getDrop(id), req.device));
      } catch (err) {
        if (req.file) fs.rmSync(req.file.path, { force: true });
        throw err;
      }
    },
  );

  // Public drops around a point. Contents stay locked; only where, what kind and the hint.
  router.get('/drops/nearby', (req, res) => {
    const pos = parsePosition({ lat: req.query.lat, lng: req.query.lng, accuracy: 0 });
    if (!pos) throw new HttpError(400, 'Valid lat and lng are required');
    const radius = Math.min(Number(req.query.radius) || 1000, config.maxNearbyRadiusM);
    const box = boundingBox(pos, radius);
    const rows = db
      .prepare(
        `SELECT d.* FROM drops d LEFT JOIN hunts h ON h.id = d.hunt_id
         WHERE d.lat BETWEEN ? AND ? AND d.lng BETWEEN ? AND ?
           AND d.visibility = 'public' AND d.hidden = 0 AND d.destroyed_at IS NULL
           AND (d.expires_at IS NULL OR d.expires_at > ?)
           AND (d.hunt_id IS NULL OR (d.hunt_step = 1 AND h.published_at IS NOT NULL))`,
      )
      .all(box.minLat, box.maxLat, box.minLng, box.maxLng, service.now());

    const drops = rows
      .map((r) => ({ row: r, distanceM: Math.round(distanceMeters(pos, r)) }))
      .filter((d) => d.distanceM <= radius)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 200)
      .map(({ row, distanceM }) => ({ ...service.lockedView(row, req.device), distanceM }));

    res.json({ unlockRadiusM: config.unlockRadiusM, drops });
  });

  // Locked details of one drop, for private links and hunt clues.
  router.get('/drops/:id', (req, res) => {
    const row = service.loadVisibleDrop(req.params.id, req.device);
    res.json({ ...service.lockedView(row, req.device), hidden: Boolean(row.hidden) });
  });

  // Open a drop. The server does the distance check; content never leaves otherwise.
  router.post(
    '/drops/:id/open',
    rateLimiter({ limit: config.openAttemptsPerMinute, windowMs: 60_000 }),
    requireDevice,
    (req, res) => {
      const row = service.loadVisibleDrop(req.params.id, req.device);
      const mine = row.owner_hash === req.device;
      const pos = requirePrecise(req);

      const distanceM = Math.round(distanceMeters(pos, row));
      if (distanceM > config.unlockRadiusM) {
        throw new HttpError(403, `You're ${distanceM} m away. Get within ${config.unlockRadiusM} m to open it.`, { distanceM });
      }

      let prev = null;
      if (row.hunt_id && row.hunt_step > 1) {
        prev = db.prepare('SELECT id FROM drops WHERE hunt_id = ? AND hunt_step = ?').get(row.hunt_id, row.hunt_step - 1);
        if (!mine && prev && !service.hasOpened(prev.id, req.device)) {
          throw new HttpError(403, `This is step ${row.hunt_step} of a hunt. Find step ${row.hunt_step - 1} first.`);
        }
      }

      // Each device counts once; the dropper opening their own drop doesn't count.
      if (!mine) {
        const inserted = db
          .prepare('INSERT OR IGNORE INTO opens (drop_id, opener_hash, opened_at) VALUES (?, ?, ?)')
          .run(row.id, req.device, service.now()).changes;
        if (inserted) db.prepare('UPDATE drops SET open_count = open_count + 1 WHERE id = ?').run(row.id);
      }

      const fresh = service.getDrop(row.id);
      const result = {
        ...service.lockedView(fresh, req.device),
        ...service.contentView(fresh),
        distanceM,
        replies: service.listReplies(fresh, req.device),
        selfDestructed: false,
      };

      if (fresh.max_opens !== null && fresh.open_count >= fresh.max_opens) {
        service.destroyDrop(fresh.id);
        result.selfDestructed = true;
        result.replies = [];
      }

      if (fresh.hunt_id) {
        const next = db.prepare('SELECT * FROM drops WHERE hunt_id = ? AND hunt_step = ?').get(fresh.hunt_id, fresh.hunt_step + 1);
        result.next = next && !next.hidden ? service.lockedView(next, req.device) : null;
        result.huntComplete = !next;
      }

      res.json(result);
    },
  );

  // Owners can take down their own standalone drops.
  router.delete('/drops/:id', requireDevice, (req, res) => {
    const row = service.getDrop(req.params.id);
    if (!row || row.owner_hash !== req.device) throw new HttpError(404, 'Drop not found');
    if (row.hunt_id) throw new HttpError(409, 'This drop is part of a hunt. Delete the whole hunt instead.');
    service.deleteDrop(row.id);
    res.status(204).end();
  });

  // Replies: a guestbook only people who opened the drop can read or sign.
  function loadForReplies(req) {
    const row = service.loadVisibleDrop(req.params.id, req.device);
    if (row.owner_hash !== req.device && !service.hasOpened(row.id, req.device)) {
      throw new HttpError(403, 'Open this drop to see its replies');
    }
    return row;
  }

  router.get('/drops/:id/replies', requireDevice, (req, res) => {
    const row = loadForReplies(req);
    res.json({ replies: service.listReplies(row, req.device) });
  });

  router.post(
    '/drops/:id/replies',
    requireDevice,
    perDevice(config.repliesPerHour, HOUR_MS, 'You have replied a lot recently. Try again later.'),
    (req, res) => {
      const row = loadForReplies(req);
      const body = text(req.body?.body, 500, 'Reply');
      if (!body) throw new HttpError(400, 'Reply is empty');
      const reply = { id: crypto.randomUUID(), drop_id: row.id, body, author_hash: req.device, created_at: service.now() };
      db.prepare('INSERT INTO replies (id, drop_id, body, author_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
        reply.id, reply.drop_id, reply.body, reply.author_hash, reply.created_at,
      );
      res.status(201).json(service.replyView(reply, row, req.device));
    },
  );

  // A reply can be removed by whoever wrote it or by the drop's owner.
  router.delete('/replies/:id', requireDevice, (req, res) => {
    const reply = db.prepare('SELECT * FROM replies WHERE id = ?').get(req.params.id);
    const drop = reply && service.getDrop(reply.drop_id);
    if (!reply || (reply.author_hash !== req.device && drop?.owner_hash !== req.device)) {
      throw new HttpError(404, 'Reply not found');
    }
    db.prepare(`DELETE FROM reports WHERE target_type = 'reply' AND target_id = ?`).run(reply.id);
    db.prepare('DELETE FROM replies WHERE id = ?').run(reply.id);
    res.status(204).end();
  });

  return router;
}
