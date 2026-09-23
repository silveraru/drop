/* global L */
const $ = (sel) => document.querySelector(sel);
const KIND = {
  note: { icon: '📝', label: 'Note' },
  photo: { icon: '📷', label: 'Photo' },
  voice: { icon: '🎙️', label: 'Voice clip' },
};
const REFRESH_MOVE_M = 50;
const REFRESH_INTERVAL_MS = 30_000;
const MAX_RECORD_S = 60;

const state = {
  config: { unlockRadiusM: 25, maxAccuracyM: 40 },
  pos: null, // { lat, lng, accuracy }
  lastFetchPos: null,
  drops: new Map(), // id -> { drop, marker, circle }
  openDropId: null,
  compose: { kind: 'note', blob: null, recorder: null },
};

// ---------- helpers ----------

function distanceM(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  for (const [unit, secs] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${unit}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data, status: res.status });
  return data;
}

const gpsGood = () => state.pos && state.pos.accuracy <= state.config.maxAccuracyM;

// ---------- map ----------

const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([20, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const me = {
  dot: L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }),
  accuracy: L.circle([0, 0], { radius: 0, color: '#2563eb', weight: 1, fillOpacity: 0.1 }),
};
let centered = false;

function dropIcon(drop, inRange) {
  return L.divIcon({
    className: '',
    html: `<div class="drop-marker${inRange ? ' in-range' : ''}">${inRange ? KIND[drop.kind].icon : '📍'}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
  });
}

function renderDrops() {
  for (const entry of state.drops.values()) {
    const inRange = state.pos && distanceM(state.pos, entry.drop) <= state.config.unlockRadiusM;
    if (entry.inRange !== inRange) {
      entry.inRange = inRange;
      entry.marker.setIcon(dropIcon(entry.drop, inRange));
    }
  }
  if (state.openDropId) updateViewerDistance();
}

async function refreshNearby() {
  if (!state.pos) return;
  state.lastFetchPos = { ...state.pos };
  try {
    const { drops } = await api(`/api/drops/nearby?lat=${state.pos.lat}&lng=${state.pos.lng}&radius=2000`);
    const seen = new Set();
    for (const drop of drops) {
      seen.add(drop.id);
      if (state.drops.has(drop.id)) continue;
      const marker = L.marker([drop.lat, drop.lng], { icon: dropIcon(drop, false) })
        .on('click', () => showViewer(drop.id))
        .addTo(map);
      const circle = L.circle([drop.lat, drop.lng], {
        radius: state.config.unlockRadiusM, color: '#f59e0b', weight: 1, fillOpacity: 0.08, interactive: false,
      }).addTo(map);
      state.drops.set(drop.id, { drop, marker, circle, inRange: false });
    }
    for (const [id, entry] of state.drops) {
      if (!seen.has(id) && id !== state.openDropId) {
        entry.marker.remove();
        entry.circle.remove();
        state.drops.delete(id);
      }
    }
    renderDrops();
  } catch (err) {
    console.warn('nearby failed', err);
  }
}

// ---------- geolocation ----------

function updateStatus() {
  const el = $('#status');
  if (!state.pos) return;
  const acc = Math.round(state.pos.accuracy);
  const inRange = [...state.drops.values()].filter((e) => e.inRange).length;
  const near = state.drops.size;
  const gps = gpsGood() ? `GPS ±${acc} m` : `Weak GPS (±${acc} m)`;
  el.textContent = inRange
    ? `${gps} · ${inRange} drop${inRange > 1 ? 's' : ''} right here!`
    : `${gps} · ${near} drop${near === 1 ? '' : 's'} nearby`;
  $('#drop-btn').disabled = !gpsGood();
}

function onPosition(p) {
  state.pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
  const ll = [state.pos.lat, state.pos.lng];
  me.dot.setLatLng(ll).addTo(map);
  me.accuracy.setLatLng(ll).setRadius(state.pos.accuracy).addTo(map);
  if (!centered) {
    map.setView(ll, 17);
    centered = true;
  }
  if (!state.lastFetchPos || distanceM(state.lastFetchPos, state.pos) > REFRESH_MOVE_M) refreshNearby();
  renderDrops();
  updateStatus();
}

function onPositionError(err) {
  const msg = {
    1: 'Location permission denied. Drop needs your location to work.',
    2: 'Location unavailable. Try moving outside.',
    3: 'Still looking for GPS…',
  }[err.code] || err.message;
  $('#status').textContent = msg;
}

// ---------- viewer ----------

function showViewer(id) {
  const entry = state.drops.get(id);
  if (!entry) return;
  const { drop } = entry;
  state.openDropId = id;
  closeSheet('#compose');
  $('#viewer-title').textContent = `${KIND[drop.kind].icon} ${KIND[drop.kind].label}`;
  $('#viewer-hint').textContent = drop.hint ? `“${drop.hint}”` : '';
  renderViewerMeta(drop);
  $('#viewer-locked').hidden = false;
  $('#viewer-content').hidden = true;
  $('#viewer-content').replaceChildren();
  $('#viewer-error').textContent = '';
  $('#viewer').hidden = false;
  updateViewerDistance();
}

function renderViewerMeta(drop) {
  $('#viewer-meta').textContent =
    `Dropped ${timeAgo(drop.createdAt)} · opened ${drop.openCount} time${drop.openCount === 1 ? '' : 's'}`;
}

function updateViewerDistance() {
  const entry = state.drops.get(state.openDropId);
  if (!entry || !state.pos) return;
  const d = distanceM(state.pos, entry.drop);
  const r = state.config.unlockRadiusM;
  $('#viewer-distance').textContent = d <= r ? "You're here." : `${formatDistance(d)} away. Get within ${r} m.`;
  $('#open-btn').disabled = d > r || !gpsGood();
}

async function openDrop() {
  const id = state.openDropId;
  $('#viewer-error').textContent = '';
  $('#open-btn').disabled = true;
  try {
    const data = await api(`/api/drops/${id}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.pos),
    });
    const content = $('#viewer-content');
    if (data.mediaUrl && data.kind === 'photo') {
      const img = document.createElement('img');
      img.src = data.mediaUrl;
      img.alt = 'Dropped photo';
      content.append(img);
    } else if (data.mediaUrl && data.kind === 'voice') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = data.mediaUrl;
      content.append(audio);
    }
    if (data.body) {
      const p = document.createElement('p');
      p.textContent = data.body;
      content.append(p);
    }
    $('#viewer-locked').hidden = true;
    content.hidden = false;
    const entry = state.drops.get(id);
    if (entry) {
      entry.drop.openCount += 1;
      renderViewerMeta(entry.drop);
    }
  } catch (err) {
    $('#viewer-error').textContent = err.message;
    updateViewerDistance();
  }
}

// ---------- compose ----------

function setKind(kind) {
  state.compose.kind = kind;
  for (const tab of document.querySelectorAll('[data-kind]')) tab.setAttribute('aria-selected', tab.dataset.kind === kind);
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== kind;
  $('#body-input').placeholder = kind === 'note'
    ? 'Write a message only someone standing here can read…'
    : 'Add a caption (optional)';
  resetMedia();
}

function resetMedia() {
  stopRecording();
  state.compose.blob = null;
  $('#photo-input').value = '';
  $('#photo-preview').hidden = true;
  $('#voice-preview').hidden = true;
  $('#record-time').textContent = `0:00 / ${Math.floor(MAX_RECORD_S / 60)}:${String(MAX_RECORD_S % 60).padStart(2, '0')}`;
}

// Re-encode photos: shrinks uploads and strips EXIF metadata (device, original GPS, etc).
async function preparePhoto(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.85));
  } catch {
    return file; // e.g. HEIC on browsers that can't decode it; server still validates the type
  }
}

async function onPhotoChosen(e) {
  const file = e.target.files[0];
  if (!file) return;
  state.compose.blob = await preparePhoto(file);
  const preview = $('#photo-preview');
  preview.src = URL.createObjectURL(state.compose.blob);
  preview.hidden = false;
}

async function toggleRecording() {
  if (state.compose.recorder) return stopRecording();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    $('#compose-error').textContent = 'Microphone access was denied.';
    return;
  }
  const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  const started = Date.now();
  const btn = $('#record-btn');
  recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recorder.timer);
    btn.textContent = '● Re-record';
    btn.classList.remove('recording');
    state.compose.recorder = null;
    if (!chunks.length) return;
    state.compose.blob = new Blob(chunks, { type: recorder.mimeType });
    const preview = $('#voice-preview');
    preview.src = URL.createObjectURL(state.compose.blob);
    preview.hidden = false;
  };
  recorder.timer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $('#record-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} / 1:00`;
    if (s >= MAX_RECORD_S) stopRecording();
  }, 250);
  state.compose.blob = null;
  $('#voice-preview').hidden = true;
  recorder.start();
  state.compose.recorder = recorder;
  btn.textContent = '■ Stop';
  btn.classList.add('recording');
}

function stopRecording() {
  const r = state.compose.recorder;
  if (r && r.state !== 'inactive') r.stop();
}

async function submitDrop() {
  const { kind, blob } = state.compose;
  const err = $('#compose-error');
  err.textContent = '';
  if (!gpsGood()) return (err.textContent = 'Waiting for a precise GPS fix…');
  const body = $('#body-input').value.trim();
  if (kind === 'note' && !body) return (err.textContent = 'Write something first.');
  if (kind !== 'note' && !blob) return (err.textContent = kind === 'photo' ? 'Add a photo first.' : 'Record something first.');

  const fd = new FormData();
  fd.append('kind', kind);
  fd.append('lat', state.pos.lat);
  fd.append('lng', state.pos.lng);
  fd.append('accuracy', state.pos.accuracy);
  fd.append('body', body);
  fd.append('hint', $('#hint-input').value.trim());
  if (blob) {
    const ext = blob.type.includes('jpeg') ? 'jpg' : (blob.type.split('/')[1] || 'bin').split(';')[0];
    fd.append('media', blob, `${kind}.${ext}`);
  }

  const btn = $('#submit-btn');
  btn.disabled = true;
  btn.textContent = 'Dropping…';
  try {
    await api('/api/drops', { method: 'POST', body: fd });
    closeSheet('#compose');
    $('#body-input').value = '';
    $('#hint-input').value = '';
    resetMedia();
    toast('Dropped! It stays here for whoever finds it.');
    await refreshNearby();
    updateStatus();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Drop it';
  }
}

// ---------- sheets ----------

function closeSheet(sel) {
  const el = $(sel);
  el.hidden = true;
  if (sel === '#viewer') state.openDropId = null;
  if (sel === '#compose') stopRecording();
}

// ---------- boot ----------

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch { /* keep defaults */ }
  for (const el of document.querySelectorAll('.radius')) el.textContent = state.config.unlockRadiusM;

  for (const tab of document.querySelectorAll('[data-kind]')) tab.addEventListener('click', () => setKind(tab.dataset.kind));
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => closeSheet(`#${btn.closest('.sheet').id}`));
  }
  $('#drop-btn').addEventListener('click', () => {
    closeSheet('#viewer');
    $('#compose-error').textContent = '';
    $('#compose').hidden = false;
  });
  $('#photo-input').addEventListener('change', onPhotoChosen);
  $('#record-btn').addEventListener('click', toggleRecording);
  $('#submit-btn').addEventListener('click', submitDrop);
  $('#open-btn').addEventListener('click', openDrop);
  if (!window.MediaRecorder) document.querySelector('[data-kind="voice"]').hidden = true;

  if (!('geolocation' in navigator)) {
    $('#status').textContent = 'This browser has no location support.';
    return;
  }
  if (!window.isSecureContext) {
    $('#status').textContent = 'Location needs HTTPS (or localhost).';
    return;
  }
  navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 20000,
  });
  setInterval(() => { refreshNearby().then(updateStatus); }, REFRESH_INTERVAL_MS);
}

boot();
