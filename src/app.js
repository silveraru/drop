import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { openDb } from './db.js';
import { dropRoutes } from './routes/drops.js';
import { huntRoutes } from './routes/hunts.js';
import { moderationRoutes, REPORT_REASONS } from './routes/moderation.js';
import { createService } from './service.js';
import { deviceIdentity, HttpError, requireDevice, safeEqual } from './util.js';

export const DEFAULTS = {
  unlockRadiusM: 25, // how close you must stand to open a drop
  maxAccuracyM: 40, // reject fixes vaguer than this, for both dropping and opening
  maxNearbyRadiusM: 5000,
  maxUploadBytes: 10 * 1024 * 1024,
  mediaTokenTtlS: 300,
  openAttemptsPerMinute: 20,
  createsPerHour: 30,
  repliesPerHour: 60,
  reportsPerHour: 30,
  huntsPerDay: 10,
  maxHuntSteps: 30,
  reportHideThreshold: 3, // distinct reporters before something is hidden pending review
  sweepIntervalMs: 60_000,
  adminToken: null,
};

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

  const service = createService({ db, config, uploadDir, mediaUrl });
  const ctx = { db, config, service, uploadDir };
  const hunts = huntRoutes(ctx);

  const app = express();
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', deviceIdentity);

  app.get('/api/config', (_req, res) => {
    res.json({
      unlockRadiusM: config.unlockRadiusM,
      maxAccuracyM: config.maxAccuracyM,
      maxHuntSteps: config.maxHuntSteps,
      reportReasons: REPORT_REASONS,
    });
  });

  app.use('/api', dropRoutes(ctx));
  app.use('/api', hunts.router);
  app.use('/api', moderationRoutes(ctx));

  // Everything this device made: standalone drops and hunts (with their steps).
  app.get('/api/me', requireDevice, (req, res) => {
    const drops = db
      .prepare('SELECT * FROM drops WHERE owner_hash = ? AND hunt_id IS NULL ORDER BY created_at DESC LIMIT 200')
      .all(req.device)
      .map((row) => ({ ...service.lockedView(row, req.device), hidden: Boolean(row.hidden), gone: service.isGone(row) }));
    const huntList = db
      .prepare('SELECT * FROM hunts WHERE owner_hash = ? ORDER BY created_at DESC LIMIT 50')
      .all(req.device)
      .map((h) => hunts.huntView(h, req.device));
    res.json({ drops, hunts: huntList });
  });

  // Media is only reachable through a short-lived URL handed out by /open.
  app.get('/api/media/:id', (req, res, next) => {
    const exp = Number(req.query.exp);
    const valid = Number.isInteger(exp) && exp >= Date.now() / 1000 && safeEqual(req.query.sig || '', signMedia(req.params.id, exp));
    if (!valid) throw new HttpError(403, 'Media link is invalid or expired');

    const drop = db.prepare('SELECT media_file, media_type FROM drops WHERE id = ?').get(req.params.id);
    if (!drop?.media_file) throw new HttpError(404, 'No media');

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
    } else if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      status = err.status;
    } else if (status >= 500) {
      console.error(err);
      message = 'Something went wrong';
    }
    res.status(status).json({ error: message, ...err.extra });
  });

  // Expire timed drops and clean up media from self-destructed ones.
  service.sweep();
  const timer = setInterval(() => {
    try {
      service.sweep();
    } catch (err) {
      console.error('sweep failed', err);
    }
  }, config.sweepIntervalMs);
  timer.unref();

  app.locals.db = db;
  app.locals.service = service;
  return app;
}
