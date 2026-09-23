import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { openDb } from './db.js';
import { boundingBox, distanceMeters, parsePosition } from './geo.js';

const MEDIA_TYPES = {
  photo: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']),
  voice: new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-m4a']),
};
const ALL_MEDIA_TYPES = new Set([...MEDIA_TYPES.photo, ...MEDIA_TYPES.voice]);
const baseMime = (mime) => String(mime || '').split(';')[0].trim().toLowerCase();

export const DEFAULTS = {
  unlockRadiusM: 25, // how close you must stand to open a drop
  maxAccuracyM: 40, // reject fixes vaguer than this, for both dropping and opening
  maxNearbyRadiusM: 5000,
  maxUploadBytes: 10 * 1024 * 1024,
  mediaTokenTtlS: 300,
  openAttemptsPerMinute: 20,
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    if (!entry || now - entry.start > windowMs) {
      hits.set(req.ip, { start: now, count: 1 });
      if (hits.size > 10000) {
        for (const [ip, e] of hits) if (now - e.start > windowMs) hits.delete(ip);
      }
      return next();
    }
    if (++entry.count > limit) return next(new HttpError(429, 'Too many attempts, slow down.'));
    next();
  };
}

export function createApp(options = {}) {
  const config = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options)) if (v !== undefined) config[k] = v;
  const { dataDir } = config;
  if (!dataDir) throw new Error('dataDir is required');
  const secret = config.secret || crypto.randomBytes(32).toString('hex');
  const uploadDir = path.join(dataDir, 'media');
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = config.db || openDb(path.join(dataDir, 'drop.db'));

  const signMedia = (id, exp) => crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
  const mediaUrl = (id) => {
    const exp = Math.floor(Date.now() / 1000) + config.mediaTokenTtlS;
    return `/api/media/${id}?exp=${exp}&sig=${signMedia(id, exp)}`;
  };

  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
    }),
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 },
    fileFilter: (_req, file, cb) => {
      if (ALL_MEDIA_TYPES.has(baseMime(file.mimetype))) cb(null, true);
      else cb(new HttpError(415, `Unsupported media type: ${file.mimetype}`));
    },
  });

  const app = express();
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/config', (_req, res) => {
    res.json({ unlockRadiusM: config.unlockRadiusM, maxAccuracyM: config.maxAccuracyM });
  });

  // Create a drop at the caller's current position.
  app.post('/api/drops', upload.single('media'), (req, res, next) => {
    const cleanup = () => req.file && fs.rmSync(req.file.path, { force: true });
    try {
      const kind = req.body.kind;
      if (!['note', 'photo', 'voice'].includes(kind)) throw new HttpError(400, 'kind must be note, photo or voice');

      const pos = parsePosition(req.body);
      if (!pos) throw new HttpError(400, 'A valid lat, lng and accuracy are required');
      if (pos.accuracy > config.maxAccuracyM) {
        throw new HttpError(422, `Location too imprecise (±${Math.round(pos.accuracy)} m). Wait for a better GPS fix.`);
      }

      const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
      const hint = typeof req.body.hint === 'string' ? req.body.hint.trim() : '';
      if (body.length > 2000) throw new HttpError(400, 'Message is too long (max 2000 characters)');
      if (hint.length > 140) throw new HttpError(400, 'Hint is too long (max 140 characters)');

      let mediaType = null;
      if (kind === 'note') {
        if (!body) throw new HttpError(400, 'A note needs some text');
        if (req.file) throw new HttpError(400, 'Notes cannot carry media');
      } else {
        if (!req.file) throw new HttpError(400, `A ${kind} drop needs a file`);
        mediaType = baseMime(req.file.mimetype);
        if (!MEDIA_TYPES[kind].has(mediaType)) throw new HttpError(415, `${mediaType} is not valid for a ${kind} drop`);
      }

      const id = crypto.randomUUID();
      const createdAt = Date.now();
      db.prepare(
        `INSERT INTO drops (id, kind, lat, lng, hint, body, media_file, media_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, kind, pos.lat, pos.lng, hint || null, body || null, req.file?.filename ?? null, mediaType, createdAt);

      res.status(201).json({ id, kind, lat: pos.lat, lng: pos.lng, hint: hint || null, createdAt });
    } catch (err) {
      cleanup();
      next(err);
    }
  });

  // List drops around a point. Contents stay locked; only where and what kind.
  app.get('/api/drops/nearby', (req, res, next) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const pos = parsePosition({ lat, lng, accuracy: 0 });
    if (!pos) return next(new HttpError(400, 'Valid lat and lng are required'));
    const radius = Math.min(Number(req.query.radius) || 1000, config.maxNearbyRadiusM);

    const box = boundingBox(pos, radius);
    const rows = db
      .prepare(
        `SELECT id, kind, lat, lng, hint, created_at, open_count FROM drops
         WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
      )
      .all(box.minLat, box.maxLat, box.minLng, box.maxLng);

    const drops = rows
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        lat: r.lat,
        lng: r.lng,
        hint: r.hint,
        createdAt: r.created_at,
        openCount: r.open_count,
        distanceM: Math.round(distanceMeters(pos, r)),
      }))
      .filter((d) => d.distanceM <= radius)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 200);

    res.json({ unlockRadiusM: config.unlockRadiusM, drops });
  });

  // Open a drop. The server does the distance check; content never leaves otherwise.
  app.post(
    '/api/drops/:id/open',
    rateLimiter({ limit: config.openAttemptsPerMinute, windowMs: 60_000 }),
    (req, res, next) => {
      const drop = db.prepare('SELECT * FROM drops WHERE id = ?').get(req.params.id);
      if (!drop) return next(new HttpError(404, 'Drop not found'));

      const pos = parsePosition(req.body);
      if (!pos) return next(new HttpError(400, 'A valid lat, lng and accuracy are required'));
      if (pos.accuracy > config.maxAccuracyM) {
        return next(new HttpError(422, `Location too imprecise (±${Math.round(pos.accuracy)} m). Wait for a better GPS fix.`));
      }

      const distanceM = Math.round(distanceMeters(pos, drop));
      if (distanceM > config.unlockRadiusM) {
        return res.status(403).json({
          error: `You're ${distanceM} m away. Get within ${config.unlockRadiusM} m to open it.`,
          distanceM,
        });
      }

      db.prepare('UPDATE drops SET open_count = open_count + 1 WHERE id = ?').run(drop.id);
      res.json({
        id: drop.id,
        kind: drop.kind,
        hint: drop.hint,
        body: drop.body,
        createdAt: drop.created_at,
        mediaUrl: drop.media_file ? mediaUrl(drop.id) : null,
        mediaType: drop.media_type,
        distanceM,
      });
    },
  );

  // Media is only reachable through a short-lived URL handed out by /open.
  app.get('/api/media/:id', (req, res, next) => {
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig || '');
    const expected = signMedia(req.params.id, exp);
    const valid =
      Number.isInteger(exp) &&
      exp >= Date.now() / 1000 &&
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!valid) return next(new HttpError(403, 'Media link is invalid or expired'));

    const drop = db.prepare('SELECT media_file, media_type FROM drops WHERE id = ?').get(req.params.id);
    if (!drop?.media_file) return next(new HttpError(404, 'No media'));

    res.set({
      'Content-Type': drop.media_type,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    res.sendFile(path.join(uploadDir, drop.media_file), (err) => err && next(err));
  });

  app.use(express.static(new URL('../public', import.meta.url).pathname));
  app.use('/vendor/leaflet', express.static(new URL('../node_modules/leaflet/dist', import.meta.url).pathname));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    let status = err.status || 500;
    let message = err.message;
    if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    } else if (status >= 500) {
      console.error(err);
      message = 'Something went wrong';
    }
    res.status(status).json({ error: message });
  });

  app.locals.db = db;
  return app;
}
