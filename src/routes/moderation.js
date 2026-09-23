import express from 'express';
import { HttpError, rateLimiter, requireDevice, safeEqual, text } from '../util.js';

export const REPORT_REASONS = ['spam', 'offensive', 'dangerous', 'personal-info', 'other'];

export function moderationRoutes({ db, config, service }) {
  const router = express.Router();

  const targetTable = (type) => ({ drop: 'drops', reply: 'replies' })[type];

  function loadTarget(type, id) {
    const table = targetTable(type);
    if (!table) throw new HttpError(400, 'targetType must be drop or reply');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Not found');
    return { table, row };
  }

  // Anyone can report. Enough distinct reporters hides the item until an admin reviews it.
  router.post(
    '/reports',
    requireDevice,
    rateLimiter({ limit: config.reportsPerHour, windowMs: 3600_000, key: (req) => req.device }),
    (req, res) => {
      const { targetType, targetId } = req.body || {};
      const reason = req.body?.reason;
      if (!REPORT_REASONS.includes(reason)) throw new HttpError(400, `reason must be one of: ${REPORT_REASONS.join(', ')}`);
      const note = text(req.body?.note, 280, 'Note');
      const { table } = loadTarget(targetType, String(targetId || ''));

      db.prepare(
        `INSERT OR IGNORE INTO reports (target_type, target_id, reporter_hash, reason, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(targetType, targetId, req.device, reason, note || null, service.now());
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM reports WHERE target_type = ? AND target_id = ?')
        .get(targetType, targetId);
      if (n >= config.reportHideThreshold) db.prepare(`UPDATE ${table} SET hidden = 1 WHERE id = ?`).run(targetId);
      res.status(201).json({ ok: true });
    },
  );

  // ----- admin: disabled (404) unless ADMIN_TOKEN is set -----

  function requireAdmin(req, _res, next) {
    const token = (req.get('authorization') || '').replace(/^Bearer /, '');
    if (!config.adminToken) return next(new HttpError(404, 'Not found'));
    if (!safeEqual(token, config.adminToken)) return next(new HttpError(401, 'Bad admin token'));
    next();
  }

  router.get('/admin/reports', requireAdmin, (_req, res) => {
    const groups = db
      .prepare(
        `SELECT target_type, target_id, COUNT(*) AS count, MAX(created_at) AS last_at,
                GROUP_CONCAT(reason) AS reasons
         FROM reports GROUP BY target_type, target_id ORDER BY count DESC, last_at DESC LIMIT 200`,
      )
      .all();
    const notesFor = db.prepare(
      'SELECT reason, note, created_at FROM reports WHERE target_type = ? AND target_id = ? AND note IS NOT NULL ORDER BY created_at DESC LIMIT 10',
    );

    const items = groups.map((g) => {
      const table = targetTable(g.target_type);
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(g.target_id);
      const item = {
        targetType: g.target_type,
        targetId: g.target_id,
        count: g.count,
        lastReportedAt: g.last_at,
        reasons: g.reasons.split(','),
        notes: notesFor.all(g.target_type, g.target_id),
        missing: !row,
      };
      if (!row) return item;
      item.hidden = Boolean(row.hidden);
      if (g.target_type === 'drop') {
        Object.assign(item, {
          kind: row.kind, hint: row.hint, lat: row.lat, lng: row.lng, huntId: row.hunt_id,
          destroyed: service.isGone(row), ...service.contentView(row),
        });
      } else {
        Object.assign(item, { body: row.body, dropId: row.drop_id });
      }
      return item;
    });
    res.json({ items });
  });

  // Keep it: unhide and clear its reports.
  router.post('/admin/:type/:id/restore', requireAdmin, (req, res) => {
    const { table, row } = loadTarget(req.params.type, req.params.id);
    db.prepare(`UPDATE ${table} SET hidden = 0 WHERE id = ?`).run(row.id);
    db.prepare('DELETE FROM reports WHERE target_type = ? AND target_id = ?').run(req.params.type, row.id);
    res.status(204).end();
  });

  // Take it down. Removing a hunt step removes the whole hunt, since it can't be finished anymore.
  router.delete('/admin/:type/:id', requireAdmin, (req, res) => {
    const { row } = loadTarget(req.params.type, req.params.id);
    if (req.params.type === 'reply') {
      db.prepare(`DELETE FROM reports WHERE target_type = 'reply' AND target_id = ?`).run(row.id);
      db.prepare('DELETE FROM replies WHERE id = ?').run(row.id);
    } else if (row.hunt_id) {
      service.deleteHunt(row.hunt_id);
    } else {
      service.deleteDrop(row.id);
    }
    res.status(204).end();
  });

  return router;
}
