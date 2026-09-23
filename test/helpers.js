import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

export const HERE = { lat: 51.5007, lng: -0.1246, accuracy: 8 };
/** Offset `m` metres north of a point. */
export const north = (p, m) => ({ ...p, lat: p.lat + m / 111_195 });

export async function startServer(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'));
  const app = createApp({ dataDir, secret: 'test-secret', openAttemptsPerMinute: 1000, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    base,
    dataDir,
    device: (key = crypto.randomBytes(24).toString('base64url')) => client(base, key),
    close() {
      server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A fake phone: every request carries the same device key. */
export function client(base, key) {
  async function request(method, url, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (key) init.headers['x-device-key'] = key;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, init);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, res };
  }
  return {
    key,
    get: (url, headers) => request('GET', url, undefined, headers),
    post: (url, body, headers) => request('POST', url, body, headers),
    del: (url, headers) => request('DELETE', url, undefined, headers),
    drop(fields, file) {
      return request('POST', '/api/drops', form({ kind: 'note', body: 'hi', ...HERE, ...fields }, file));
    },
    open: (id, pos = HERE) => request('POST', `/api/drops/${id}/open`, pos),
  };
}

export function form(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.append(k, String(v));
  if (file) fd.append('media', new Blob([file.data], { type: file.type }), file.name);
  return fd;
}
