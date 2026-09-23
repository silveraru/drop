import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Fixed-window limiter. `key` picks what to count per request (IP by default). */
export function rateLimiter({ limit, windowMs, key = (req) => req.ip, message = 'Too many attempts, slow down.' }) {
  const hits = new Map();
  return (req, _res, next) => {
    const now = Date.now();
    const k = key(req);
    const entry = hits.get(k);
    if (!entry || now - entry.start > windowMs) {
      hits.set(k, { start: now, count: 1 });
      if (hits.size > 10000) {
        for (const [id, e] of hits) if (now - e.start > windowMs) hits.delete(id);
      }
      return next();
    }
    if (++entry.count > limit) return next(new HttpError(429, message));
    next();
  };
}

/** Trimmed string field, or '' when absent. Throws if longer than `max`. */
export function text(value, max, label) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length > max) throw new HttpError(400, `${label} is too long (max ${max} characters)`);
  return s;
}

/** Optional integer field within [min, max]; null when absent or empty. */
export function optionalInt(value, min, max, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const DEVICE_KEY = /^[A-Za-z0-9_-]{22,128}$/;

/**
 * Anonymous identity: each browser keeps a random secret and sends it as X-Device-Key.
 * We only store its hash. Enough to know "same person" without accounts.
 */
export function deviceIdentity(req, _res, next) {
  const key = req.get('x-device-key');
  req.device = key && DEVICE_KEY.test(key) ? sha256(key) : null;
  next();
}

export function requireDevice(req, _res, next) {
  if (!req.device) return next(new HttpError(401, 'Missing device key'));
  next();
}
