import path from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dataDir = path.resolve(process.env.DATA_DIR || 'data');

if (!process.env.MEDIA_SECRET) {
  console.warn('MEDIA_SECRET not set: media links will stop working after a restart.');
}

const app = createApp({
  dataDir,
  secret: process.env.MEDIA_SECRET,
  // Number of reverse proxies in front of the app, so rate limiting sees real client IPs.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : undefined,
  unlockRadiusM: Number(process.env.UNLOCK_RADIUS_M) || undefined,
  maxAccuracyM: Number(process.env.MAX_ACCURACY_M) || undefined,
  reportHideThreshold: Number(process.env.REPORT_HIDE_THRESHOLD) || undefined,
  adminToken: process.env.ADMIN_TOKEN || undefined,
});

app.listen(port, () => {
  console.log(`Drop listening on http://localhost:${port} (data in ${dataDir})`);
});
