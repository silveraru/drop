const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two lat/lng points (haversine). */
export function distanceMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Bounding box around a point, used to pre-filter rows in SQL before the exact
 * distance check. Slightly generous; callers must still check distanceMeters.
 */
export function boundingBox({ lat, lng }, radiusM) {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cosLat = Math.max(Math.cos(toRad(lat)), 1e-6);
  const dLng = Math.min(180, dLat / cosLat);
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

/** Parse and validate a position from untrusted input. Returns null if invalid. */
export function parsePosition(input) {
  if (!input) return null;
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  const accuracy = input.accuracy === undefined || input.accuracy === '' ? NaN : Number(input.accuracy);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (!Number.isFinite(accuracy) || accuracy < 0) return null;
  return { lat, lng, accuracy };
}
