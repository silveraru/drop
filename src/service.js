import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';

/** Data access and rules shared by the route modules. */
export function createService({ db, config, uploadDir, mediaUrl }) {
  const now = () => Date.now();
  const q = (sql) => db.prepare(sql);

  const removeFile = (file) => file && fs.rmSync(path.join(uploadDir, file), { force: true });

  const isGone = (row) => Boolean(row.destroyed_at) || (row.expires_at !== null && row.expires_at <= now());

  const getDrop = (id) => q('SELECT * FROM drops WHERE id = ?').get(id);
  const getHunt = (id) => q('SELECT * FROM hunts WHERE id = ?').get(id);
  const huntStepCount = (huntId) => q('SELECT COUNT(*) AS n FROM drops WHERE hunt_id = ?').get(huntId).n;
  const hasOpened = (dropId, device) =>
    Boolean(device && q('SELECT 1 FROM opens WHERE drop_id = ? AND opener_hash = ?').get(dropId, device));

  /**
   * Self-destruct: wipe text and replies now. The media file is kept for one media-link
   * lifetime so whoever triggered the destruction can still load it; the sweep removes it.
   */
  function destroyDrop(id) {
    const t = now();
    db.exec('BEGIN');
    try {
      q(`DELETE FROM reports WHERE target_type = 'reply' AND target_id IN (SELECT id FROM replies WHERE drop_id = ?)`).run(id);
      q('DELETE FROM replies WHERE drop_id = ?').run(id);
      q('UPDATE drops SET body = NULL, destroyed_at = COALESCE(destroyed_at, ?) WHERE id = ?').run(t, id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Remove a drop and everything attached to it. */
  function deleteDrop(id) {
    const row = getDrop(id);
    if (!row) return;
    db.exec('BEGIN');
    try {
      q(`DELETE FROM reports WHERE target_type = 'reply' AND target_id IN (SELECT id FROM replies WHERE drop_id = ?)`).run(id);
      q('DELETE FROM replies WHERE drop_id = ?').run(id);
      q(`DELETE FROM reports WHERE target_type = 'drop' AND target_id = ?`).run(id);
      q('DELETE FROM opens WHERE drop_id = ?').run(id);
      q('DELETE FROM drops WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    removeFile(row.media_file);
  }

  function deleteHunt(id) {
    for (const { id: dropId } of q('SELECT id FROM drops WHERE hunt_id = ?').all(id)) deleteDrop(dropId);
    q('DELETE FROM hunts WHERE id = ?').run(id);
  }

  /** Expire timed drops and delete media of destroyed ones once their links have lapsed. */
  function sweep() {
    const t = now();
    for (const { id } of q('SELECT id FROM drops WHERE expires_at <= ? AND destroyed_at IS NULL').all(t)) destroyDrop(id);
    const cutoff = t - config.mediaTokenTtlS * 1000;
    for (const row of q('SELECT id, media_file FROM drops WHERE destroyed_at <= ? AND media_file IS NOT NULL').all(cutoff)) {
      q('UPDATE drops SET media_file = NULL, media_type = NULL WHERE id = ?').run(row.id);
      removeFile(row.media_file);
    }
  }

  function huntSummary(hunt) {
    return { id: hunt.id, title: hunt.title, stepCount: huntStepCount(hunt.id), published: Boolean(hunt.published_at) };
  }

  /** What anyone who knows about a drop may see without opening it. */
  function lockedView(row, device) {
    const hunt = row.hunt_id ? getHunt(row.hunt_id) : null;
    return {
      id: row.id,
      kind: row.kind,
      lat: row.lat,
      lng: row.lng,
      hint: row.hint,
      createdAt: row.created_at,
      openCount: row.open_count,
      visibility: row.visibility,
      mine: Boolean(device && row.owner_hash === device),
      opened: hasOpened(row.id, device),
      maxOpens: row.max_opens,
      opensLeft: row.max_opens === null ? null : Math.max(0, row.max_opens - row.open_count),
      expiresAt: row.expires_at,
      hunt: hunt ? { ...huntSummary(hunt), step: row.hunt_step } : null,
    };
  }

  /**
   * Load a drop the caller may know about, or throw the right error.
   * Hidden (reported) and unpublished-hunt drops only exist for their owner.
   */
  function loadVisibleDrop(id, device) {
    const row = getDrop(id);
    const mine = row && device && row.owner_hash === device;
    if (!row || (row.hidden && !mine)) throw new HttpError(404, 'Drop not found');
    if (row.hunt_id && !mine && !getHunt(row.hunt_id)?.published_at) throw new HttpError(404, 'Drop not found');
    if (isGone(row)) throw new HttpError(410, 'This drop has self-destructed.');
    return row;
  }

  function replyView(reply, drop, device) {
    return {
      id: reply.id,
      body: reply.body,
      createdAt: reply.created_at,
      mine: Boolean(device && reply.author_hash === device),
      byDropper: reply.author_hash === drop.owner_hash,
    };
  }

  const listReplies = (drop, device) =>
    q('SELECT * FROM replies WHERE drop_id = ? AND hidden = 0 ORDER BY created_at').all(drop.id).map((r) => replyView(r, drop, device));

  const contentView = (row) => ({
    body: row.body,
    mediaUrl: row.media_file ? mediaUrl(row.id) : null,
    mediaType: row.media_type,
  });

  return {
    now,
    getDrop,
    getHunt,
    huntStepCount,
    hasOpened,
    isGone,
    destroyDrop,
    deleteDrop,
    deleteHunt,
    sweep,
    huntSummary,
    lockedView,
    loadVisibleDrop,
    replyView,
    listReplies,
    contentView,
  };
}
