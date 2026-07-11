const ROOM_KEY = 'ttt_room_code';
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes O/0 and I/1 to avoid confusion

let currentRoom = null;
let currentRoomName = '';
let stamps = [];
let editingKey = null;

// ── In-app browser detection ────────────────────────────────────────────────
// Messenger/Instagram/Facebook webviews (WKWebView) don't reliably honor
// text-selection suppression or fire VisualViewport keyboard events, so
// buttons select text and the edit sheet won't lift. Nudge users to open the
// page in a real browser, where the fixes work.
function isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\/|MicroMessenger|Twitter/i.test(ua);
}

function dismissInAppBanner() {
  const banner = document.getElementById('inapp-banner');
  if (banner) banner.classList.add('hidden');
}

if (isInAppBrowser()) {
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.getElementById('inapp-banner');
    if (banner) banner.classList.remove('hidden');
  });
}

// ── Utility ────────────────────────────────────────────────────────────────

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

function formatStamp(d) {
  const hundredths = Math.floor(d.getMilliseconds() / 10);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(hundredths)}`;
}

function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local date + time with millisecond precision: YYYY-MM-DD HH:MM:SS:XXX
function formatDateTimeMs(ms) {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return `${formatDate(d)} ${formatTimeMs(ms)}`;
}

// Local time with millisecond precision: HH:MM:SS:XXX
function formatTimeMs(ms) {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(d.getMilliseconds(), 3)}`;
}

// Display strings derived from a stamp's epoch_ms (the single stored time)
function stampTime(ms) { return typeof ms === 'number' ? formatStamp(new Date(ms)) : ''; }
function stampDate(ms) { return typeof ms === 'number' ? formatDate(new Date(ms)) : ''; }

// Elapsed duration as M:SS.xx (or H:MM:SS.xx past an hour)
function formatElapsed(ms) {
  if (!(ms >= 0)) return '—';
  const totalHundredths = Math.round(ms / 10);
  const hundredths = totalHundredths % 100;
  const totalSeconds = Math.floor(totalHundredths / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`
    : `${minutes}:${pad(seconds)}.${pad(hundredths)}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}

function generateCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code;
}

// ── Clock ──────────────────────────────────────────────────────────────────
// Phone clocks can disagree by seconds, so a start on one phone and a finish
// on another would corrupt the elapsed time. Firebase reports how far this
// device's clock is from its servers; stamping with the corrected time puts
// every phone on the same clock.
let serverTimeOffset = 0;
let clockSyncStarted = false;

// Only operators hold a live Firebase connection (the free plan caps
// simultaneous connections at 100). The lobby and the spectator screen read
// over plain HTTPS instead, so any number of viewers costs zero connections.
// The socket opens when someone joins a room and closes back in the lobby.
function connectDb() {
  if (!clockSyncStarted) {
    clockSyncStarted = true;
    db.ref('.info/serverTimeOffset').on('value', snap => {
      serverTimeOffset = snap.val() || 0;
    });
  }
  db.goOnline();
}

function syncedNow() { return Date.now() + serverTimeOffset; }

function tick() {
  const now = new Date(syncedNow());
  const t = formatStamp(now);
  const d = formatDate(now);
  const timerEl = document.getElementById('clock-time');
  const dateEl = document.getElementById('date');
  if (timerEl) timerEl.textContent = t;
  if (dateEl) dateEl.textContent = d;
  const holdEl = document.getElementById('hold-clock');
  if (holdEl && holdEl.parentElement.classList.contains('showing')) holdEl.textContent = t;
  // Live "on course" timers on the spectator screen
  if (spectateCode) {
    document.querySelectorAll('.oncourse-time').forEach(el => {
      const start = Number(el.dataset.start);
      if (start) el.textContent = formatElapsed(now.getTime() - start);
    });
  }
  requestAnimationFrame(tick);
}

// ── Hold / armed overlay ─────────────────────────────────────────────────
let holdCancelActive = false; // finger currently over the cancel zone

function showHold(type) {
  const o = document.getElementById('hold-overlay');
  if (!o) return;
  holdCancelActive = false;
  o.classList.remove('start', 'finish', 'in-cancel');
  o.classList.add(type === 'START' ? 'start' : 'finish', 'showing');
  document.getElementById('hold-type').textContent = type;
  const athlete = document.getElementById('athlete').value.trim();
  document.getElementById('hold-athlete').textContent = athlete ? '#' + athlete : '';
  if (navigator.vibrate) navigator.vibrate(20); // Android tactile confirm; iOS ignores
}

function hideHold() {
  const o = document.getElementById('hold-overlay');
  if (o) o.classList.remove('showing', 'in-cancel');
}

// While armed, light up the cancel zone when the finger is over it and flag
// that releasing there should discard the time instead of recording it.
function updateHoldCancel(clientY) {
  const o = document.getElementById('hold-overlay');
  const zone = document.getElementById('hold-cancel');
  if (!o || !zone || !o.classList.contains('showing')) return;
  const inZone = clientY >= zone.getBoundingClientRect().top;
  if (inZone !== holdCancelActive) {
    holdCancelActive = inZone;
    o.classList.toggle('in-cancel', inZone);
    if (inZone && navigator.vibrate) navigator.vibrate(15);
  }
}

// ── Screen management ──────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}

function goToLobby() {
  detachFirebaseListeners();
  currentRoom = null;
  stamps = [];
  hideMenu();
  db.goOffline(); // free the live connection; the lobby polls over HTTPS
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) document.getElementById('join-code').value = saved;
  startLobbyPolling();
  showScreen('screen-lobby');
}

function updateBadge(name, code) {
  const badge = document.getElementById('room-badge');
  badge.innerHTML = name
    ? `${escapeHtml(name)} <span class="badge-code">${code}</span>`
    : code;
}

function goToTimer(code, name = '') {
  connectDb();
  stopLobbyPolling();
  currentRoom = code;
  currentRoomName = name;
  localStorage.setItem(ROOM_KEY, code);
  ensureRoomIndexed(code);
  updateBadge(name, code);
  document.getElementById('deleted-banner').classList.add('hidden');
  hideMenu();
  showScreen('screen-timer');
  subscribeToRoom(code);
}

// ── Firebase listeners ─────────────────────────────────────────────────────

function detachFirebaseListeners() {
  if (!currentRoom) return;
  db.ref(`rooms/${currentRoom}/stamps`).off();
  db.ref(`rooms/${currentRoom}/meta/deleted`).off();
}

function subscribeToRoom(code) {
  stamps = [];

  db.ref(`rooms/${code}/stamps`).on('value', snap => {
    stamps = [];
    snap.forEach(child => { stamps.push({ _key: child.key, ...child.val() }); });
    stamps.sort((a, b) => a.epoch_ms - b.epoch_ms);
    render();
    renderActiveRacers();
    updateAthleteSuggestions();
  });

  db.ref(`rooms/${code}/meta/deleted`).on('value', snap => {
    if (snap.val() === true) showDeletedBanner();
  });
}

// ── Room index (lobby list) ────────────────────────────────────────────────

function ensureRoomIndexed(code) {
  db.ref(`roomIndex/${code}`).once('value').then(snap => {
    if (snap.exists()) return;
    db.ref(`rooms/${code}/meta`).get().then(metaSnap => {
      if (!metaSnap.exists() || metaSnap.val().deleted) return;
      const { name = code, createdAt = syncedNow() } = metaSnap.val();
      db.ref(`roomIndex/${code}`).set({ name, createdAt, deleted: false });
    });
  });
}

// The lobby list is fetched over plain HTTPS on an interval instead of a live
// listener, so people browsing the lobby never hold a Firebase connection.
let lobbyPollTimer = null;

function fetchRoomList() {
  if (document.hidden) return;
  fetch(`${firebaseConfig.databaseURL}/roomIndex.json`)
    .then(r => r.json())
    .then(data => {
      const rooms = Object.entries(data || {})
        .filter(([, r]) => r && !r.deleted)
        .map(([code, r]) => ({ code, ...r }));
      rooms.sort((a, b) => b.createdAt - a.createdAt);
      renderRoomList(rooms);
    })
    .catch(() => {}); // keep showing the last list if a poll fails
}

function startLobbyPolling() {
  stopLobbyPolling();
  fetchRoomList();
  lobbyPollTimer = setInterval(fetchRoomList, 20000);
}

function stopLobbyPolling() {
  clearInterval(lobbyPollTimer);
  lobbyPollTimer = null;
}

function renderRoomList(rooms) {
  const el = document.getElementById('room-list');
  if (!el) return;
  if (!rooms.length) {
    el.innerHTML = '<p class="no-rooms">No active rooms yet.</p>';
    return;
  }
  el.innerHTML = rooms.map(r => `
    <button type="button" class="room-list-item" data-code="${r.code}" data-name="${escapeHtml(r.name)}">
      <span class="room-list-name">${escapeHtml(r.name)}</span>
      <span class="room-list-view">Results ›</span>
    </button>
  `).join('');
}

// ── Room actions ───────────────────────────────────────────────────────────

function createRoom() {
  connectDb();
  const name = document.getElementById('room-name').value.trim() || 'Unnamed Room';
  const code = generateCode();
  db.ref(`rooms/${code}/meta`).get()
    .then(snap => {
      if (snap.exists()) { createRoom(); return; } // code already taken — roll a new one
      const meta = { name, createdAt: syncedNow(), deleted: false };
      // Single atomic write so the room and the lobby index can't diverge
      return db.ref().update({
        [`rooms/${code}/meta`]: meta,
        [`roomIndex/${code}`]: meta,
      }).then(() => goToTimer(code, name));
    })
    .catch(err => alert('Could not create room: ' + err.message));
}

function joinRoomFromInput() {
  const raw = document.getElementById('join-code').value.trim().toUpperCase();
  if (raw.length !== 4) { alert('Please enter a 4-character room code.'); return; }
  connectDb();

  db.ref(`rooms/${raw}/meta`).get()
    .then(snap => {
      if (!snap.exists()) {
        // Offline fallback: trust a saved code we've been in before
        if (localStorage.getItem(ROOM_KEY) === raw) { goToTimer(raw); return; }
        alert(`Room "${raw}" not found.`);
        return;
      }
      if (snap.val()?.deleted) { alert(`Room "${raw}" has been deleted.`); return; }
      goToTimer(raw, snap.val()?.name || '');
    })
    .catch(() => {
      // Network error — allow re-joining a previously saved room
      if (localStorage.getItem(ROOM_KEY) === raw) { goToTimer(raw); return; }
      alert('Cannot connect. Check your connection and try again.');
    });
}

// ── Menu ───────────────────────────────────────────────────────────────────

function toggleMenu() {
  document.querySelector('.menu-wrapper').classList.toggle('is-open');
}

function hideMenu() {
  document.querySelector('.menu-wrapper').classList.remove('is-open');
  document.getElementById('rename-section').classList.add('hidden');
}

function toggleRenameField() {
  const section = document.getElementById('rename-section');
  const isHidden = section.classList.toggle('hidden');
  if (!isHidden) {
    const input = document.getElementById('rename-input');
    input.value = currentRoomName;
    input.focus();
    input.select();
  }
}

function saveRoomName() {
  const name = document.getElementById('rename-input').value.trim();
  if (!name || !currentRoom) return;
  currentRoomName = name;
  db.ref().update({
    [`rooms/${currentRoom}/meta/name`]: name,
    [`roomIndex/${currentRoom}/name`]: name,
  });
  updateBadge(name, currentRoom);
  hideMenu();
}

function leaveRoom() {
  hideMenu();
  localStorage.removeItem(ROOM_KEY);
  goToLobby();
}

function deleteRoom() {
  hideMenu();
  const code = currentRoom;
  if (!confirm(`Delete room "${code}"?\n\nThe room will close for everyone in it.`)) return;

  // Soft delete: mark the room deleted (atomically, in both places) but keep
  // the data, so an accidental delete never destroys recorded times.
  db.ref().update({
    [`rooms/${code}/meta/deleted`]: true,
    [`roomIndex/${code}/deleted`]: true,
  }).catch(err => alert('Could not delete room: ' + err.message));

  localStorage.removeItem(ROOM_KEY);
  showDeletedBanner();
  setTimeout(goToLobby, 6000);
}

// ── Deleted banner ─────────────────────────────────────────────────────────

function showDeletedBanner() {
  document.getElementById('deleted-banner').classList.remove('hidden');
  hideMenu();
}

// ── Stamp logging ──────────────────────────────────────────────────────────

function logStamp(type) {
  if (!currentRoom) return;
  const rec = {
    type,
    epoch_ms: syncedNow(),
    athlete: document.getElementById('athlete').value.trim(),
    operator: document.getElementById('operator').value.trim(),
    note: document.getElementById('note').value.trim()
  };
  const ref = db.ref(`rooms/${currentRoom}/stamps`).push();
  ref.set(rec);
  document.getElementById('last').innerHTML =
    `<span class="last-time">${stampTime(rec.epoch_ms)}</span><span class="last-athlete">${escapeHtml(rec.athlete) || '—'}</span>`;
  if (navigator.vibrate) navigator.vibrate(35);
}

// ── Active racers ───────────────────────────────────────────────────────────

function renderActiveRacers() {
  const el = document.getElementById('active-racers');
  if (!el) return;

  // stamps are already sorted by epoch_ms ascending, so last write wins.
  // Key by normalized name so "214 " and "214" are the same racer.
  const lastByKey = new Map();
  stamps.forEach(s => {
    const key = normAthlete(s.athlete);
    if (!key) return;
    lastByKey.set(key, { display: (s.athlete || '').trim(), type: s.type });
  });

  const active = [...lastByKey.values()]
    .filter(e => e.type === 'START')
    .map(e => e.display);

  if (!active.length) {
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = active.map(a => `<span class="active-racer-name" data-athlete="${escapeHtml(a)}">${escapeHtml(a)}</span>`).join(' · ');
  el.querySelectorAll('.active-racer-name').forEach(span => {
    span.onclick = () => {
      document.getElementById('athlete').value = span.dataset.athlete;
    };
  });
}

// ── Render ─────────────────────────────────────────────────────────────────

function render() {
  const tbody = document.getElementById('rows');
  if (!tbody) return;
  // Athletes who have a start, for flagging finishes that can't be paired.
  const startedKeys = new Set();
  stamps.forEach(s => { if (s.type === 'START') startedKeys.add(normAthlete(s.athlete)); });
  tbody.innerHTML = '';
  stamps.slice().reverse().forEach((r, i) => {
    const n = stamps.length - i;
    const unmatched = r.type === 'FINISH' && !startedKeys.has(normAthlete(r.athlete));
    const tr = document.createElement('tr');
    tr.className = 'row-clickable' + (unmatched ? ' row-unmatched' : '');
    tr.onclick = () => openEditSheet(r._key);
    tr.innerHTML = `
      <td>${n}${r.editedAt ? '<span class="edited-dot"></span>' : ''}</td>
      <td>${escapeHtml(r.type)}${unmatched ? '<span class="unmatched-dot" title="No matching start"></span>' : ''}</td>
      <td>${stampTime(r.epoch_ms)}</td>
      <td>${stampDate(r.epoch_ms)}</td>
      <td>${escapeHtml(r.athlete)}</td>
      <td>${escapeHtml(r.operator)}</td>
      <td>${escapeHtml(r.note)}</td>`;
    tbody.appendChild(tr);
  });
}

// ── CSV ────────────────────────────────────────────────────────────────────

function csvText() {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['n', 'type', 'date', 'time', 'iso', 'time_ms', 'epoch_ms', 'athlete', 'operator', 'note'];
  const lines = [header.join(',')];
  stamps.forEach((r, i) => {
    const row = {
      ...r,
      n: i + 1,
      date: stampDate(r.epoch_ms),
      time: stampTime(r.epoch_ms),
      iso: typeof r.epoch_ms === 'number' ? new Date(r.epoch_ms).toISOString() : '',
      time_ms: formatTimeMs(r.epoch_ms),
    };
    lines.push(header.map(k => esc(row[k])).join(','));
  });

  // Second section: finished athletes with their finish (elapsed) time,
  // offset to begin on the 4th column so it sits clear of the main table.
  const finished = getFinishedAthletes();
  if (finished.length) {
    const indent = ',,,';
    lines.push('');
    lines.push(indent + 'Finished Athletes');
    lines.push(indent + ['athlete', 'start', 'finish', 'elapsed'].join(','));
    finished.forEach(f => {
      lines.push(indent + [
        esc(f.athlete),
        esc(formatDateTimeMs(f.startMs)),
        esc(formatDateTimeMs(f.finishMs)),
        esc(formatElapsed(f.elapsedMs)),
      ].join(','));
    });
  }
  return lines.join('\n');
}

async function copyCSV() {
  try {
    await navigator.clipboard.writeText(csvText());
    alert('CSV copied. Paste it into Google Sheets or Excel.');
  } catch {
    prompt('Copy this CSV:', csvText());
  }
}

function downloadCSV() {
  const blob = new Blob([csvText()], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `timestamps-${currentRoom}-${formatDate(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Athlete lookup ───────────────────────────────────────────────────────
// Match athletes case- and whitespace-insensitively so "Stephanie",
// "stephanie" and " Stephanie " count as the same person.
function normAthlete(s) {
  return (s || '').trim().toLowerCase();
}

// Build the list of athletes with both a start and a finish, computing each
// one's elapsed time from the earliest start to the first finish after it.
function getFinishedAthletes(list = stamps) {
  const byKey = {};
  list.forEach(s => {
    const key = normAthlete(s.athlete);
    if (!key || typeof s.epoch_ms !== 'number') return;
    (byKey[key] = byKey[key] || { display: (s.athlete || '').trim(), starts: [], finishes: [] });
    if (s.type === 'START') byKey[key].starts.push(s.epoch_ms);
    else if (s.type === 'FINISH') byKey[key].finishes.push(s.epoch_ms);
  });
  const out = [];
  Object.values(byKey).forEach(({ display, starts, finishes }) => {
    if (!starts.length || !finishes.length) return;
    const startMs = Math.min(...starts);
    const after = finishes.filter(f => f >= startMs).sort((x, y) => x - y);
    const finishMs = after.length ? after[0] : Math.max(...finishes);
    out.push({
      athlete: display,
      startMs,
      finishMs,
      elapsedMs: finishMs - startMs,
      multiStart: starts.length > 1,
      multiFinish: finishes.length > 1,
    });
  });
  out.sort((a, b) => a.athlete.localeCompare(b.athlete, undefined, { numeric: true }));
  return out;
}

// Distinct athlete names seen, each tagged with whether they've started and
// finished. Used for autocomplete suggestions and unmatched-finish flags.
function getAthleteIndex(list = stamps) {
  const seen = new Map();
  list.forEach(s => {
    const key = normAthlete(s.athlete);
    if (!key) return;
    if (!seen.has(key)) seen.set(key, { key, display: (s.athlete || '').trim(), started: false, finished: false, startMs: null });
    const e = seen.get(key);
    if (s.type === 'START') {
      e.started = true;
      if (typeof s.epoch_ms === 'number' && (e.startMs === null || s.epoch_ms < e.startMs)) e.startMs = s.epoch_ms;
    } else if (s.type === 'FINISH') {
      e.finished = true;
    }
  });
  return seen;
}

// Custom suggestion dropdown for the athlete field (a native <datalist> stacks
// with the browser's own autofill popup and behaves inconsistently). Shows only
// athletes who've started but not finished, filtered to what's typed; hidden
// when the field is blank, unfocused, has no match, or exactly matches a name.
function hideAthleteSuggest() {
  const box = document.getElementById('athlete-suggest');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function updateAthleteSuggestions() {
  const box = document.getElementById('athlete-suggest');
  const input = document.getElementById('athlete');
  if (!box || !input) return;
  if (document.activeElement !== input) return hideAthleteSuggest();
  const q = normAthlete(input.value);
  if (!q) return hideAthleteSuggest();
  const matches = [...getAthleteIndex().values()]
    .filter(e => e.started && !e.finished && normAthlete(e.display).includes(q))
    .sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }));
  if (!matches.length || matches.some(e => normAthlete(e.display) === q)) return hideAthleteSuggest();
  box.innerHTML = matches
    .map(e => `<button type="button" class="suggest-item" data-name="${escapeHtml(e.display)}">${escapeHtml(e.display)}</button>`)
    .join('');
  box.classList.remove('hidden');
}

function openLookup() {
  hideMenu();
  document.getElementById('lookup-input').value = '';
  document.getElementById('lookup-result').innerHTML = '';
  renderLookupOptions();
  document.getElementById('lookup-overlay').classList.remove('hidden');
  document.getElementById('lookup-sheet').classList.remove('hidden');
  bindKeyboardTracking();
}

function closeLookup() {
  document.getElementById('lookup-overlay').classList.add('hidden');
  document.getElementById('lookup-sheet').classList.add('hidden');
  unbindKeyboardTracking();
}

// Filter the finished-athlete list by what's typed; show an exact match's result.
function renderLookupOptions() {
  const q = document.getElementById('lookup-input').value.trim().toLowerCase();
  const opts = document.getElementById('lookup-options');
  const result = document.getElementById('lookup-result');
  const finished = getFinishedAthletes();
  if (!finished.length) {
    opts.innerHTML = '<p class="lookup-empty">No athlete has both a start and a finish yet.</p>';
    result.innerHTML = '';
    return;
  }
  const matches = q ? finished.filter(f => f.athlete.toLowerCase().includes(q)) : finished;
  opts.innerHTML = matches.length
    ? matches.map(f =>
        `<button type="button" class="lookup-option" data-athlete="${escapeHtml(f.athlete)}">` +
        `<span>${escapeHtml(f.athlete)}</span>` +
        `<span class="lookup-option-time">${formatElapsed(f.elapsedMs)}</span></button>`
      ).join('')
    : '<p class="lookup-empty">No match.</p>';
  const exact = finished.find(f => f.athlete.toLowerCase() === q);
  if (matches.length === 1) showLookupResult(matches[0].athlete);
  else if (exact) showLookupResult(exact.athlete);
  else result.innerHTML = '';
}

function selectLookupAthlete(name) {
  document.getElementById('lookup-input').value = name;
  document.getElementById('lookup-options').innerHTML = '';
  document.getElementById('lookup-input').blur();
  showLookupResult(name);
}

function showLookupResult(athlete) {
  const el = document.getElementById('lookup-result');
  const f = getFinishedAthletes().find(x => x.athlete === athlete);
  if (!f) { el.innerHTML = ''; return; }
  const parts = [];
  if (f.multiStart) parts.push('starts');
  if (f.multiFinish) parts.push('finishes');
  const warn = parts.length
    ? `<p class="lookup-warn">Multiple ${parts.join(' & ')} recorded — using the earliest start and the first finish after it.</p>`
    : '';
  el.innerHTML = `
    <div class="lookup-elapsed">${formatElapsed(f.elapsedMs)}</div>
    <div class="lookup-detail">
      <span>Start</span><strong>${formatStamp(new Date(f.startMs))}</strong>
      <span>Finish</span><strong>${formatStamp(new Date(f.finishMs))}</strong>
    </div>
    ${warn}
  `;
}

// ── Spectate (read-only results, polled over HTTPS) ───────────────────────

let spectateCode = null;
let spectatePollTimer = null;

function enterSpectate(code, name) {
  spectateCode = code;
  stopLobbyPolling();
  updateSpectateBadge(name || code, code);
  document.getElementById('spectate-updated').textContent = 'Loading…';
  document.getElementById('spectate-content').innerHTML = '';
  showScreen('screen-spectate');
  fetchSpectate();
  clearInterval(spectatePollTimer);
  spectatePollTimer = setInterval(fetchSpectate, 15000);
}

function leaveSpectate() {
  spectateCode = null;
  clearInterval(spectatePollTimer);
  spectatePollTimer = null;
  goToLobby();
}

function updateSpectateBadge(name, code) {
  document.getElementById('spectate-badge').innerHTML =
    `${escapeHtml(name)} <span class="badge-code">${code}</span>`;
}

function fetchSpectate() {
  if (!spectateCode || document.hidden) return;
  const code = spectateCode;
  fetch(`${firebaseConfig.databaseURL}/rooms/${code}.json`)
    .then(r => r.json())
    .then(data => {
      if (code !== spectateCode) return; // left the screen mid-fetch
      renderSpectate(data, code);
      document.getElementById('spectate-updated').textContent =
        `Updated ${formatStamp(new Date()).slice(0, 8)} · refreshes automatically`;
    })
    .catch(() => {
      if (code !== spectateCode) return;
      document.getElementById('spectate-updated').textContent = 'Offline — retrying…';
    });
}

function renderSpectate(data, code) {
  const content = document.getElementById('spectate-content');
  if (!data || !data.meta || data.meta.deleted) {
    content.innerHTML = '<p class="spectate-empty">This room is no longer available.</p>';
    return;
  }
  updateSpectateBadge(data.meta.name || code, code);

  const list = Object.values(data.stamps || {})
    .filter(s => s && typeof s.epoch_ms === 'number')
    .sort((a, b) => a.epoch_ms - b.epoch_ms);

  const results = getFinishedAthletes(list).sort((a, b) => a.elapsedMs - b.elapsedMs);
  const onCourse = [...getAthleteIndex(list).values()]
    .filter(e => e.started && !e.finished)
    .sort((a, b) => (a.startMs || 0) - (b.startMs || 0));

  const resultRows = results.map((f, i) => `
    <div class="spectate-row">
      <span class="spectate-rank">${i + 1}</span>
      <span class="spectate-name">${escapeHtml(f.athlete)}</span>
      <span class="spectate-time">${formatElapsed(f.elapsedMs)}</span>
    </div>`).join('');

  const onCourseRows = onCourse.map(e => `
    <div class="spectate-row oncourse">
      <span class="spectate-rank"><span class="live-dot"></span></span>
      <span class="spectate-name">${escapeHtml(e.display)}</span>
      <span class="spectate-time oncourse-time" data-start="${e.startMs}">—</span>
    </div>`).join('');

  content.innerHTML = `
    <div class="spectate-section-title">On course</div>
    ${onCourse.length ? onCourseRows : '<p class="spectate-empty">Nobody is on course right now.</p>'}
    <div class="spectate-section-title">Results</div>
    ${results.length ? resultRows : '<p class="spectate-empty">No finished athletes yet.</p>'}
  `;
}

// ── Edit sheet ─────────────────────────────────────────────────────────────

function openEditSheet(key) {
  const stamp = stamps.find(s => s._key === key);
  if (!stamp) return;
  editingKey = key;
  document.getElementById('edit-sheet-title').textContent = `${stamp.type} · ${stampTime(stamp.epoch_ms)}`;
  document.getElementById('edit-athlete').value = stamp.athlete || '';
  document.getElementById('edit-operator').value = stamp.operator || '';
  document.getElementById('edit-note').value = stamp.note || '';
  document.getElementById('edit-overlay').classList.remove('hidden');
  document.getElementById('edit-sheet').classList.remove('hidden');
  bindKeyboardTracking();
  document.getElementById('edit-note').focus();
}

function closeEditSheet() {
  editingKey = null;
  document.getElementById('edit-overlay').classList.add('hidden');
  document.getElementById('edit-sheet').classList.add('hidden');
  unbindKeyboardTracking();
}

// Lift the edit sheet above the on-screen keyboard. On mobile (notably iOS
// Safari) the keyboard overlays the viewport instead of resizing it, so a
// `bottom: 0` fixed element ends up hidden behind it. The VisualViewport API
// reports the un-obscured area; translate the sheet up by the covered height.
function updateSheetForKeyboard() {
  const vv = window.visualViewport;
  const sheet = document.querySelector('.edit-sheet:not(.hidden)');
  if (!vv || !sheet) return;
  const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  sheet.style.transform = keyboardHeight ? `translateY(-${keyboardHeight}px)` : '';
}

function bindKeyboardTracking() {
  if (!window.visualViewport) return;
  window.visualViewport.addEventListener('resize', updateSheetForKeyboard);
  window.visualViewport.addEventListener('scroll', updateSheetForKeyboard);
}

function unbindKeyboardTracking() {
  document.querySelectorAll('.edit-sheet').forEach(s => { s.style.transform = ''; });
  if (!window.visualViewport) return;
  window.visualViewport.removeEventListener('resize', updateSheetForKeyboard);
  window.visualViewport.removeEventListener('scroll', updateSheetForKeyboard);
}

function saveEdit() {
  if (!editingKey || !currentRoom) return;
  const updates = {
    athlete:  document.getElementById('edit-athlete').value.trim(),
    operator: document.getElementById('edit-operator').value.trim(),
    note:     document.getElementById('edit-note').value.trim(),
    editedAt: syncedNow(),
  };
  db.ref(`rooms/${currentRoom}/stamps/${editingKey}`).update(updates);
  closeEditSheet();
}

// ── Init ───────────────────────────────────────────────────────────────────

(function init() {
  db.goOffline(); // no live connection until someone joins a room as operator
  tick();
  startLobbyPolling();
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) document.getElementById('join-code').value = saved;
  showScreen('screen-lobby');

  // Tap a live room to watch its results (read-only)
  document.getElementById('room-list').addEventListener('click', e => {
    const item = e.target.closest('.room-list-item');
    if (item) enterSpectate(item.dataset.code, item.dataset.name || '');
  });

  // Refresh polled data as soon as the tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (spectateCode) fetchSpectate();
    else if (lobbyPollTimer) fetchRoomList();
  });

  // Close menu on outside click
  document.addEventListener('click', e => {
    const wrapper = document.querySelector('.menu-wrapper');
    if (wrapper && !wrapper.contains(e.target)) hideMenu();
  });


  // Allow pressing Enter to join
  document.getElementById('join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoomFromInput();
  });

  // Allow pressing Enter to save room rename
  document.getElementById('rename-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveRoomName();
  });

  const athleteInput = document.getElementById('athlete');
  athleteInput.addEventListener('input', updateAthleteSuggestions);
  athleteInput.addEventListener('focus', updateAthleteSuggestions);
  athleteInput.addEventListener('blur', () => setTimeout(hideAthleteSuggest, 100));
  document.getElementById('athlete-suggest').addEventListener('pointerdown', e => {
    const item = e.target.closest('.suggest-item');
    if (!item) return;
    e.preventDefault(); // keep focus; avoid a blur race hiding the list first
    athleteInput.value = item.dataset.name;
    hideAthleteSuggest();
  });

  // Lookup: pick a filtered athlete (delegated so it survives re-renders)
  document.getElementById('lookup-options').addEventListener('click', e => {
    const btn = e.target.closest('.lookup-option');
    if (btn) selectLookupAthlete(btn.dataset.athlete);
  });

  // Stamp buttons: fire on release, primary pointer only, no context menu
  [['start', 'START'], ['finish', 'FINISH']].forEach(([cls, type]) => {
    const btn = document.querySelector(`.${cls}`);
    btn.addEventListener('pointerdown',  e => {
      if (!e.isPrimary || btn.disabled) return;
      // Capture so the gesture stays bound to the button even if the finger
      // slides off it — release anywhere on screen still records the time.
      try { btn.setPointerCapture(e.pointerId); } catch {}
      btn.classList.add('is-pressed');
      showHold(type);
    });
    btn.addEventListener('pointermove',  e => { if (e.isPrimary) updateHoldCancel(e.clientY); });
    btn.addEventListener('pointerup',    e => {
      btn.classList.remove('is-pressed');
      const cancelled = holdCancelActive;
      hideHold();
      if (e.isPrimary && e.button === 0 && !btn.disabled && !cancelled) logStamp(type);
    });
    btn.addEventListener('pointercancel',() => { btn.classList.remove('is-pressed'); hideHold(); });
    btn.addEventListener('contextmenu',  e => e.preventDefault());
  });
})();
