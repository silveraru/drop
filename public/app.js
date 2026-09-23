/* global L */
const $ = (sel) => document.querySelector(sel);
const KIND = {
  note: { icon: '📝', label: 'Note' },
  photo: { icon: '📷', label: 'Photo' },
  voice: { icon: '🎙️', label: 'Voice clip' },
};
const REASON_LABELS = {
  spam: 'Spam',
  offensive: 'Offensive or hateful',
  dangerous: 'Leads somewhere dangerous',
  'personal-info': "Shares someone's private info",
  other: 'Something else',
};
const REFRESH_MOVE_M = 50;
const REFRESH_INTERVAL_MS = 30_000;
const MAX_RECORD_S = 60;
const MAX_KNOWN = 100;

// ---------- storage (best effort: private browsing may block it) ----------

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

function deviceKey() {
  let key = store.get('drop.deviceKey', null);
  if (!key) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (!store.set('drop.deviceKey', key)) {
      setTimeout(() => toast("Private browsing: your drops won't be remembered after you close this tab."), 1500);
    }
  }
  return key;
}

const state = {
  config: { unlockRadiusM: 25, maxAccuracyM: 40, reportReasons: Object.keys(REASON_LABELS) },
  device: deviceKey(),
  pos: null, // { lat, lng, accuracy }
  lastFetchPos: null,
  drops: new Map(), // id -> { drop, marker, circle, pinned, inRange }
  known: new Set(store.get('drop.known', [])), // private/hunt drops we have a link or clue for
  building: store.get('drop.building', null), // { id, title, steps } while laying out a hunt
  viewing: null, // id of the drop in the viewer
  reporting: null, // { targetType, targetId }
  compose: { kind: 'note', blob: null, recorder: null },
};

// ---------- helpers ----------

function distanceM(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const formatDistance = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  for (const [unit, secs] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${plural(n, unit)} ago`;
  }
  return 'just now';
}

function timeLeft(ts) {
  const s = (ts - Date.now()) / 1000;
  if (s <= 0) return 'any moment';
  for (const [unit, secs] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    const n = Math.floor(s / secs);
    if (n >= 1) return plural(n, unit);
  }
  return 'under a minute';
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, options = {}) {
  const headers = { 'x-device-key': state.device, ...options.headers };
  let body = options.body;
  if (body && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { ...options, headers, body });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data, status: res.status });
  return data;
}

async function share(url, title) {
  const full = new URL(url, location.origin).href;
  if (navigator.share) {
    try {
      await navigator.share({ title, url: full });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(full);
    toast('Link copied. Send it to whoever should find it.');
  } catch {
    prompt('Copy this link:', full);
  }
}

const dropLink = (id) => `/?drop=${id}`;
const huntLink = (id) => `/?hunt=${id}`;
const gpsGood = () => state.pos && state.pos.accuracy <= state.config.maxAccuracyM;

function remember(id) {
  state.known.add(id);
  const ids = [...state.known].slice(-MAX_KNOWN);
  state.known = new Set(ids);
  store.set('drop.known', ids);
}

function forget(id) {
  state.known.delete(id);
  store.set('drop.known', [...state.known]);
}

// ---------- map ----------

const map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const me = {
  dot: L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }),
  accuracy: L.circle([0, 0], { radius: 0, color: '#2563eb', weight: 1, fillOpacity: 0.1, interactive: false }),
};
let centered = false;

function markerGlyph(drop, inRange) {
  if (inRange) return KIND[drop.kind].icon;
  if (drop.hunt) return '🧭';
  if (drop.visibility === 'private') return '🔑';
  return '📍';
}

function dropIcon(drop, inRange) {
  return L.divIcon({
    className: '',
    html: `<div class="drop-marker${inRange ? ' in-range' : ''}${drop.mine ? ' mine' : ''}">${markerGlyph(drop, inRange)}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
  });
}

/** Add or update a drop on the map. Pinned drops survive nearby refreshes. */
function upsertDrop(drop, { pinned = false } = {}) {
  let entry = state.drops.get(drop.id);
  if (entry) {
    entry.drop = { ...entry.drop, ...drop };
    entry.pinned ||= pinned;
    entry.marker.setIcon(dropIcon(entry.drop, entry.inRange));
    return entry;
  }
  const marker = L.marker([drop.lat, drop.lng], { icon: dropIcon(drop, false) })
    .on('click', () => showViewer(drop.id))
    .addTo(map);
  const circle = L.circle([drop.lat, drop.lng], {
    radius: state.config.unlockRadiusM, color: '#f59e0b', weight: 1, fillOpacity: 0.08, interactive: false,
  }).addTo(map);
  entry = { drop, marker, circle, pinned, inRange: false };
  state.drops.set(drop.id, entry);
  return entry;
}

function removeDrop(id) {
  const entry = state.drops.get(id);
  if (!entry) return;
  entry.marker.remove();
  entry.circle.remove();
  state.drops.delete(id);
  forget(id);
  if (state.viewing === id) closeSheet('#viewer');
}

function renderDrops() {
  for (const entry of state.drops.values()) {
    const inRange = Boolean(state.pos && distanceM(state.pos, entry.drop) <= state.config.unlockRadiusM);
    if (entry.inRange !== inRange) {
      entry.inRange = inRange;
      entry.marker.setIcon(dropIcon(entry.drop, inRange));
    }
  }
  if (state.viewing) updateViewerDistance();
}

async function refreshNearby() {
  if (!state.pos) return;
  state.lastFetchPos = { ...state.pos };
  try {
    const { drops } = await api(`/api/drops/nearby?lat=${state.pos.lat}&lng=${state.pos.lng}&radius=2000`);
    const seen = new Set();
    for (const drop of drops) {
      seen.add(drop.id);
      upsertDrop(drop);
    }
    for (const [id, entry] of state.drops) {
      if (!seen.has(id) && !entry.pinned && id !== state.viewing) {
        entry.marker.remove();
        entry.circle.remove();
        state.drops.delete(id);
      }
    }
    renderDrops();
    updateStatus();
  } catch (err) {
    console.warn('nearby failed', err);
  }
}

/** Put our own drops, hunt steps and remembered links on the map. */
async function loadPinned() {
  try {
    const mine = await api('/api/me');
    for (const d of mine.drops) if (!d.gone) upsertDrop(d, { pinned: true });
    for (const h of mine.hunts) for (const s of h.steps || []) upsertDrop(s, { pinned: true });
    renderMine(mine);
  } catch (err) {
    console.warn('me failed', err);
  }
  await Promise.all([...state.known].map(async (id) => {
    if (state.drops.has(id)) return;
    try {
      upsertDrop(await api(`/api/drops/${id}`), { pinned: true });
    } catch (err) {
      if (err.status === 404 || err.status === 410) forget(id);
    }
  }));
  renderDrops();
}

// ---------- geolocation ----------

function updateStatus() {
  const status = $('#status');
  if (!state.pos) return;
  const acc = Math.round(state.pos.accuracy);
  const inRange = [...state.drops.values()].filter((e) => e.inRange && !e.drop.mine).length;
  const gps = gpsGood() ? `GPS ±${acc} m` : `Weak GPS (±${acc} m)`;
  status.textContent = inRange
    ? `${gps} · ${plural(inRange, 'drop')} right here!`
    : `${gps} · ${plural(state.drops.size, 'drop')} nearby`;
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
  $('#status').textContent = {
    1: 'Location permission denied. Drop needs your location to work.',
    2: 'Location unavailable. Try moving outside.',
    3: 'Still looking for GPS…',
  }[err.code] || err.message;
}

// ---------- sheets ----------

const SHEETS = ['#compose', '#viewer', '#mine', '#report'];

function openSheet(sel) {
  for (const s of SHEETS) if (s !== sel && s !== '#report') closeSheet(s);
  $(sel).hidden = false;
}

function closeSheet(sel) {
  $(sel).hidden = true;
  if (sel === '#viewer') state.viewing = null;
  if (sel === '#compose') stopRecording();
}

// ---------- viewer ----------

function describeDrop(drop) {
  const bits = [`Dropped ${timeAgo(drop.createdAt)}`, `found by ${drop.openCount === 1 ? '1 person' : `${drop.openCount} people`}`];
  if (drop.opensLeft !== null && drop.opensLeft !== undefined) bits.push(`💣 vanishes after ${plural(drop.opensLeft, 'more finder')}`);
  if (drop.expiresAt) bits.push(`⏳ expires in ${timeLeft(drop.expiresAt)}`);
  if (drop.visibility === 'private' && !drop.hunt) bits.push('🔑 link only');
  if (drop.hidden) bits.push('🚩 hidden after reports');
  return bits.join(' · ');
}

function showViewer(id) {
  const entry = state.drops.get(id);
  if (!entry) return;
  const { drop } = entry;
  state.viewing = id;
  openSheet('#viewer');
  $('#viewer-title').textContent = `${KIND[drop.kind].icon} ${KIND[drop.kind].label}${drop.mine ? ' (yours)' : ''}`;
  const hunt = $('#viewer-hunt');
  hunt.hidden = !drop.hunt;
  if (drop.hunt) hunt.textContent = `🧭 ${drop.hunt.title} · step ${drop.hunt.step} of ${drop.hunt.stepCount}`;
  $('#viewer-hint').textContent = drop.hint ? `“${drop.hint}”` : '';
  $('#viewer-meta').textContent = describeDrop(drop);
  $('#viewer-locked').hidden = false;
  $('#viewer-content').hidden = true;
  $('#viewer-error').textContent = '';
  $('#share-btn').hidden = !(drop.visibility === 'private' || drop.hunt) && !drop.mine;
  $('#delete-btn').hidden = !drop.mine || Boolean(drop.hunt);
  $('#report-btn').hidden = drop.mine;
  updateViewerDistance();
}

function updateViewerDistance() {
  const entry = state.drops.get(state.viewing);
  if (!entry || !state.pos) return;
  const d = distanceM(state.pos, entry.drop);
  const r = state.config.unlockRadiusM;
  $('#viewer-distance').textContent = d <= r ? "You're here." : `${formatDistance(d)} away. Get within ${r} m.`;
  $('#open-btn').disabled = d > r || !gpsGood();
}

async function openDrop() {
  const id = state.viewing;
  $('#viewer-error').textContent = '';
  $('#open-btn').disabled = true;
  try {
    const data = await api(`/api/drops/${id}/open`, { method: 'POST', body: state.pos });
    const entry = upsertDrop(data);
    $('#viewer-meta').textContent = describeDrop(entry.drop);

    const body = $('#viewer-body');
    body.replaceChildren();
    if (data.mediaUrl && data.kind === 'photo') body.append(el('img', { src: data.mediaUrl, alt: 'Dropped photo' }));
    if (data.mediaUrl && data.kind === 'voice') body.append(el('audio', { src: data.mediaUrl, controls: true }));
    if (data.body) body.append(el('p', { class: 'body' }, data.body));

    $('#viewer-destructed').hidden = !data.selfDestructed;
    renderNext(data);
    $('#replies').hidden = data.selfDestructed;
    if (!data.selfDestructed) renderReplies(data.replies, entry.drop);

    $('#viewer-locked').hidden = true;
    $('#viewer-content').hidden = false;
    if (data.selfDestructed) {
      entry.marker.remove();
      entry.circle.remove();
      state.drops.delete(id);
      forget(id);
    }
  } catch (err) {
    $('#viewer-error').textContent = err.message;
    if (err.status === 404 || err.status === 410) removeDrop(id);
    else updateViewerDistance();
  }
}

function renderNext(data) {
  const box = $('#viewer-next');
  box.replaceChildren();
  box.hidden = !data.hunt;
  if (!data.hunt) return;
  if (data.huntComplete) {
    box.append(el('p', { class: 'notice' }, `🏆 You finished “${data.hunt.title}”!`));
  } else if (data.next) {
    remember(data.next.id);
    upsertDrop(data.next, { pinned: true });
    const where = state.pos ? ` · ${formatDistance(distanceM(state.pos, data.next))} away` : '';
    box.append(
      el('p', { class: 'notice' }, `Next up: step ${data.next.hunt.step}${data.next.hint ? ` — “${data.next.hint}”` : ''}${where}`),
      el('button', {
        class: 'primary',
        onclick: () => {
          map.flyTo([data.next.lat, data.next.lng], 18);
          showViewer(data.next.id);
        },
      }, '🧭 Show the next clue'),
    );
  } else {
    box.append(el('p', { class: 'notice' }, 'The next step of this hunt has been taken down.'));
  }
}

function renderReplies(replies, drop) {
  const list = $('#reply-list');
  list.replaceChildren(
    ...replies.map((r) => el('li', {},
      el('p', {}, r.body),
      el('span', { class: 'fine' },
        [r.byDropper ? 'the dropper' : r.mine ? 'you' : 'a finder', timeAgo(r.createdAt)].join(' · '),
        (r.mine || drop.mine)
          ? el('button', { class: 'link danger', onclick: () => deleteReply(r.id, drop) }, 'Delete')
          : el('button', { class: 'link', onclick: () => startReport('reply', r.id) }, 'Report'),
      ),
    )),
  );
  if (!replies.length) list.append(el('li', { class: 'fine' }, 'No replies yet. Be the first.'));
}

async function reloadReplies(drop) {
  const { replies } = await api(`/api/drops/${drop.id}/replies`);
  renderReplies(replies, drop);
}

async function postReply(e) {
  e.preventDefault();
  const entry = state.drops.get(state.viewing);
  const input = $('#reply-input');
  if (!entry || !input.value.trim()) return;
  try {
    await api(`/api/drops/${entry.drop.id}/replies`, { method: 'POST', body: { body: input.value } });
    input.value = '';
    await reloadReplies(entry.drop);
  } catch (err) {
    $('#viewer-error').textContent = err.message;
  }
}

async function deleteReply(replyId, drop) {
  if (!confirm('Delete this reply?')) return;
  try {
    await api(`/api/replies/${replyId}`, { method: 'DELETE' });
    await reloadReplies(drop);
  } catch (err) {
    $('#viewer-error').textContent = err.message;
  }
}

async function deleteViewedDrop() {
  const id = state.viewing;
  if (!confirm('Delete this drop for everyone? This cannot be undone.')) return;
  try {
    await api(`/api/drops/${id}`, { method: 'DELETE' });
    removeDrop(id);
    toast('Deleted.');
    loadPinned();
  } catch (err) {
    $('#viewer-error').textContent = err.message;
  }
}

function shareViewedDrop() {
  const { drop } = state.drops.get(state.viewing);
  if (drop.hunt) share(huntLink(drop.hunt.id), drop.hunt.title);
  else share(dropLink(drop.id), 'Someone left you a drop');
}

// ---------- reporting ----------

function startReport(targetType, targetId) {
  state.reporting = { targetType, targetId };
  $('#report-reasons').replaceChildren(
    ...state.config.reportReasons.map((r, i) =>
      el('label', {}, el('input', { type: 'radio', name: 'reason', value: r, checked: i === 0 }), el('span', {}, REASON_LABELS[r] || r))),
  );
  $('#report-note').value = '';
  $('#report').hidden = false;
}

async function submitReport(e) {
  e.preventDefault();
  const reason = document.querySelector('input[name="reason"]:checked')?.value;
  try {
    await api('/api/reports', { method: 'POST', body: { ...state.reporting, reason, note: $('#report-note').value } });
    closeSheet('#report');
    toast('Thanks. Reported content is hidden once a few people flag it.');
  } catch (err) {
    toast(err.message);
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

function openCompose() {
  const b = state.building;
  $('#compose-title').textContent = b ? `Step ${b.steps + 1} of “${b.title}”` : 'Leave a drop';
  $('#drop-options').hidden = Boolean(b);
  $('#hint-input').placeholder = b
    ? 'Clue to find this spot, shown to players who solved the previous step'
    : 'Hint (optional), e.g. “under the oak by the gate”';
  $('#compose-fine').textContent = b
    ? `This step is pinned exactly where you're standing. Players must be within ${state.config.unlockRadiusM} m to open it.`
    : `Pinned exactly where you're standing. People must be within ${state.config.unlockRadiusM} m to open it. Pins are visible, so don't drop at your home.`;
  $('#submit-btn').textContent = b ? 'Add step' : 'Drop it';
  $('#compose-error').textContent = '';
  openSheet('#compose');
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
  if (state.building) {
    fd.append('huntId', state.building.id);
  } else {
    fd.append('visibility', document.querySelector('input[name="visibility"]:checked').value);
    fd.append('maxOpens', $('#max-opens').value);
    fd.append('expiresInHours', $('#expires').value);
  }
  if (blob) {
    const ext = blob.type.includes('jpeg') ? 'jpg' : (blob.type.split('/')[1] || 'bin').split(';')[0];
    fd.append('media', blob, `${kind}.${ext}`);
  }

  const btn = $('#submit-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Dropping…';
  try {
    const drop = await api('/api/drops', { method: 'POST', body: fd });
    upsertDrop(drop, { pinned: true });
    renderDrops();
    closeSheet('#compose');
    $('#body-input').value = '';
    $('#hint-input').value = '';
    resetMedia();
    if (state.building) {
      setBuilding({ ...state.building, steps: drop.hunt.step });
      toast(`Step ${drop.hunt.step} added. Walk to the next spot.`);
    } else if (drop.visibility === 'private') {
      toast('Dropped! Only people with the link can find it.');
      share(dropLink(drop.id), 'Someone left you a drop');
    } else {
      toast('Dropped! It stays here for whoever finds it.');
    }
    updateStatus();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------- hunts ----------

function setBuilding(b) {
  state.building = b;
  store.set('drop.building', b);
  $('#build-banner').hidden = !b;
  $('#drop-btn').textContent = b ? `＋ Add step ${b.steps + 1}` : '＋ Drop here';
  if (b) {
    $('#build-title').textContent = b.title;
    $('#build-steps').textContent = plural(b.steps, 'step');
    $('#build-publish').disabled = b.steps < 2;
  }
}

async function createHunt(e) {
  e.preventDefault();
  try {
    const hunt = await api('/api/hunts', {
      method: 'POST',
      body: {
        title: $('#hunt-title').value,
        description: $('#hunt-desc').value,
        visibility: document.querySelector('input[name="hunt-visibility"]:checked').value,
      },
    });
    $('#hunt-form').reset();
    $('#hunt-form').hidden = true;
    closeSheet('#mine');
    setBuilding({ id: hunt.id, title: hunt.title, steps: 0 });
    toast('Go to the first spot and tap “Add step 1”.');
  } catch (err) {
    toast(err.message);
  }
}

async function publishHunt(id) {
  try {
    const hunt = await api(`/api/hunts/${id}/publish`, { method: 'POST' });
    if (state.building?.id === id) setBuilding(null);
    toast(hunt.visibility === 'public' ? 'Published! Step 1 is now on the map.' : 'Published! Share the link with your players.');
    if (hunt.visibility === 'private') share(huntLink(id), hunt.title);
    loadPinned();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteHunt(id) {
  if (!confirm('Delete this hunt and all its steps?')) return;
  try {
    const { steps = [] } = await api(`/api/hunts/${id}`);
    await api(`/api/hunts/${id}`, { method: 'DELETE' });
    for (const s of steps) removeDrop(s.id);
    if (state.building?.id === id) setBuilding(null);
    toast('Hunt deleted.');
    loadPinned();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- my stuff ----------

function renderMine({ drops, hunts }) {
  $('#mine-hunts').replaceChildren(
    ...hunts.map((h) => el('li', {},
      el('div', {},
        el('b', {}, `🧭 ${h.title}`),
        el('div', { class: 'fine' }, [
          plural(h.stepCount, 'step'),
          h.published ? `${plural(h.finishers, 'finisher')}` : 'not published',
          h.visibility === 'private' ? '🔑 link only' : '🌍 public',
        ].join(' · ')),
      ),
      el('div', { class: 'list-actions' },
        h.published
          ? el('button', { class: 'link', onclick: () => share(huntLink(h.id), h.title) }, 'Share')
          : el('button', {
            class: 'link',
            onclick: () => {
              setBuilding({ id: h.id, title: h.title, steps: h.stepCount });
              closeSheet('#mine');
            },
          }, 'Keep building'),
        !h.published && h.stepCount >= 2 && el('button', { class: 'link', onclick: () => publishHunt(h.id) }, 'Publish'),
        el('button', { class: 'link danger', onclick: () => deleteHunt(h.id) }, 'Delete'),
      ),
    )),
  );
  if (!hunts.length) $('#mine-hunts').append(el('li', { class: 'fine' }, 'No hunts yet.'));

  $('#mine-drops').replaceChildren(
    ...drops.map((d) => el('li', {},
      el('div', {},
        el('b', {}, `${KIND[d.kind].icon} ${d.hint || KIND[d.kind].label}`),
        el('div', { class: 'fine' }, d.gone ? '💥 self-destructed' : describeDrop(d)),
      ),
      el('div', { class: 'list-actions' },
        !d.gone && el('button', {
          class: 'link',
          onclick: () => {
            closeSheet('#mine');
            map.flyTo([d.lat, d.lng], 18);
            showViewer(d.id);
          },
        }, 'Show'),
      ),
    )),
  );
  if (!drops.length) $('#mine-drops').append(el('li', { class: 'fine' }, 'Nothing dropped yet.'));
}

async function openMine() {
  openSheet('#mine');
  try {
    renderMine(await api('/api/me'));
  } catch (err) {
    toast(err.message);
  }
}

// ---------- deep links ----------

async function handleLink() {
  const params = new URLSearchParams(location.search);
  const dropId = params.get('drop');
  const huntId = params.get('hunt');
  if (!dropId && !huntId) return;
  history.replaceState(null, '', '/');
  try {
    let drop;
    if (huntId) {
      const hunt = await api(`/api/hunts/${huntId}`);
      if (!hunt.start) throw new Error('This hunt has no starting point right now.');
      drop = hunt.start;
      toast(`🧭 ${hunt.title}${hunt.description ? ` — ${hunt.description}` : ''}`);
    } else {
      drop = await api(`/api/drops/${dropId}`);
    }
    remember(drop.id);
    upsertDrop(drop, { pinned: true });
    centered = true;
    map.setView([drop.lat, drop.lng], 17);
    showViewer(drop.id);
  } catch (err) {
    toast(err.status === 410 ? 'That drop has already self-destructed.' : err.status === 404 ? 'That link no longer works.' : err.message);
  }
}

// ---------- boot ----------

async function boot() {
  try {
    state.config = { ...state.config, ...(await api('/api/config')) };
  } catch { /* keep defaults */ }

  for (const tab of document.querySelectorAll('[data-kind]')) tab.addEventListener('click', () => setKind(tab.dataset.kind));
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => closeSheet(`#${btn.closest('.sheet').id}`));
  }
  $('#drop-btn').addEventListener('click', openCompose);
  $('#mine-btn').addEventListener('click', openMine);
  $('#locate-btn').addEventListener('click', () => state.pos && map.flyTo([state.pos.lat, state.pos.lng], 18));
  $('#photo-input').addEventListener('change', onPhotoChosen);
  $('#record-btn').addEventListener('click', toggleRecording);
  $('#submit-btn').addEventListener('click', submitDrop);
  $('#open-btn').addEventListener('click', openDrop);
  $('#reply-form').addEventListener('submit', postReply);
  $('#share-btn').addEventListener('click', shareViewedDrop);
  $('#delete-btn').addEventListener('click', deleteViewedDrop);
  $('#report-btn').addEventListener('click', () => startReport('drop', state.viewing));
  $('#report-form').addEventListener('submit', submitReport);
  $('#new-hunt-btn').addEventListener('click', () => ($('#hunt-form').hidden = !$('#hunt-form').hidden));
  $('#hunt-form').addEventListener('submit', createHunt);
  $('#build-publish').addEventListener('click', () => publishHunt(state.building.id));
  $('#build-pause').addEventListener('click', () => {
    setBuilding(null);
    toast('Paused. Pick it back up from ☰ → Keep building.');
  });
  if (!window.MediaRecorder) document.querySelector('[data-kind="voice"]').hidden = true;
  setKind('note');
  setBuilding(state.building);

  await loadPinned();
  await handleLink();

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
  setInterval(refreshNearby, REFRESH_INTERVAL_MS);
}

boot();
