import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundingBox, distanceMeters, parsePosition } from '../src/geo.js';

test('distanceMeters matches known distances', () => {
  // ~111.2 km per degree of latitude
  assert.ok(Math.abs(distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111195) < 5);
  // London -> Paris, ~343.5 km
  const d = distanceMeters({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
  assert.ok(Math.abs(d - 343_500) < 1000, `got ${d}`);
  assert.equal(distanceMeters({ lat: 10, lng: 20 }, { lat: 10, lng: 20 }), 0);
});

test('boundingBox contains points within the radius', () => {
  const center = { lat: 60, lng: 10 };
  const box = boundingBox(center, 1000);
  const east = { lat: 60, lng: 10 + 0.0179 }; // ~995 m east at 60°N
  assert.ok(distanceMeters(center, east) < 1000);
  assert.ok(east.lng <= box.maxLng && east.lng >= box.minLng);
});

test('parsePosition rejects bad input', () => {
  assert.deepEqual(parsePosition({ lat: '1.5', lng: '2', accuracy: '10' }), { lat: 1.5, lng: 2, accuracy: 10 });
  assert.equal(parsePosition({ lat: 91, lng: 0, accuracy: 5 }), null);
  assert.equal(parsePosition({ lat: 0, lng: 181, accuracy: 5 }), null);
  assert.equal(parsePosition({ lat: 0, lng: 0 }), null);
  assert.equal(parsePosition({ lat: 'x', lng: 0, accuracy: 5 }), null);
  assert.equal(parsePosition(null), null);
});
