// Entry point: screens, lobby, rooms, stamping, spectate and the edit/lookup
// sheets. Pure logic (formatting, athlete pairing, CSV) lives in the sibling
// modules; this file owns the DOM and the Firebase wiring.
import { db, firebaseConfig } from './firebase-db.js';
import { state } from './state.js';
import { escapeHtml, formatStamp, formatDate, formatElapsed, stampTime, stampDate } from './format.js';
import { normAthlete, getFinishedAthletes, getAthleteIndex, getSplits } from './results.js';
import { connectDb, disconnectDb, syncedNow } from './clock.js';
import { enableWakeLock, disableWakeLock } from './wake-lock.js';
import { downloadCSV } from './csv.js';

const ROOM_KEY = 'ttt_room_code';
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes O/0 and I/1 to avoid confusion

const $ = id => document.getElementById(id);

// ── In-app browser detection ────────────────────────────────────────────────
// Messenger/Instagram/Facebook webviews (WKWebView) don't reliably honor
// text-selection suppression or fire VisualViewport keyboard events, so
// buttons select text and the edit sheet won't lift. Nudge users to open the
// page in a real browser, where the fixes work.
function isInAppBrowser() {
  const ua = navigator.userAgent || '';
  return /FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\/|MicroMessenger|Twitter/i.test(ua);
}

// ── Utility ────────────────────────────────────────────────────────────────

function generateCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code;
}

// ── Clock display ──────────────────────────────────────────────────────────

function tick() {
  const now = new Date(syncedNow());
  const t = formatStamp(now);
  const d = formatDate(now);
  const timerEl = $('clock-time');
  const dateEl = $('date');
  if (timerEl) timerEl.textContent = t;
  if (dateEl) dateEl.textContent = d;
  const holdEl = $('hold-clock');
  if (holdEl && holdEl.parentElement.classList.contains('showing')) holdEl.textContent = t;
  // Live "on course" timers on the spectator screen
  if (state.spectateCode) {
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
  const o = $('hold-overlay');
  if (!o) return;
  holdCancelActive = false;
  o.classList.remove('start', 'finish', 'split', 'in-cancel');
  o.classList.add(type === 'START' ? 'start' : type === 'SPLIT' ? 'split' : 'finish', 'showing');
  $('hold-type').textContent = type;
  const athlete = $('athlete').value.trim();
  $('hold-athlete').textContent = athlete ? '#' + athlete : '';
  if (navigator.vibrate) navigator.vibrate(20); // Android tactile confirm; iOS ignores
}

function hideHold() {
  const o = $('hold-overlay');
  if (o) o.classList.remove('showing', 'in-cancel');
}

// While armed, light up the cancel zone when the finger is over it and flag
// that releasing there should discard the time instead of recording it.
function updateHoldCancel(clientY) {
  const o = $('hold-overlay');
  const zone = $('hold-cancel');
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
  $(id).classList.remove('hidden');
}

function goToLobby() {
  detachFirebaseListeners();
  state.room = null;
  state.stamps = [];
  hideMenu();
  disableWakeLock();
  disconnectDb(); // free the live connection; the lobby polls over HTTPS
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) $('join-code').value = saved;
  startLobbyPolling();
  showScreen('screen-lobby');
}

function updateBadge(name, code) {
  const badge = $('room-badge');
  badge.innerHTML = name
    ? `${escapeHtml(name)} <span class="badge-code">${escapeHtml(code)}</span>`
    : escapeHtml(code);
}

function goToTimer(code, name = '') {
  connectDb();
  stopLobbyPolling();
  state.room = code;
  state.roomName = name;
  localStorage.setItem(ROOM_KEY, code);
  ensureRoomIndexed(code);
  updateBadge(name, code);
  $('deleted-banner').classList.add('hidden');
  applySplitsEnabled(false); // until the room's meta listener says otherwise
  hideMenu();
  enableWakeLock();
  showScreen('screen-timer');
  subscribeToRoom(code);
}

// ── Firebase listeners ─────────────────────────────────────────────────────

function detachFirebaseListeners() {
  if (!state.room) return;
  db.ref(`rooms/${state.room}/stamps`).off();
  db.ref(`rooms/${state.room}/meta/deleted`).off();
  db.ref(`rooms/${state.room}/meta/splitsEnabled`).off();
}

function subscribeToRoom(code) {
  state.stamps = [];

  db.ref(`rooms/${code}/stamps`).on('value', snap => {
    const stamps = [];
    snap.forEach(child => { stamps.push({ _key: child.key, ...child.val() }); });
    stamps.sort((a, b) => a.epoch_ms - b.epoch_ms);
    state.stamps = stamps;
    render();
    renderActiveRacers();
    updateAthleteSuggestions();
  });

  db.ref(`rooms/${code}/meta/deleted`).on('value', snap => {
    if (snap.val() === true) showDeletedBanner();
  });

  db.ref(`rooms/${code}/meta/splitsEnabled`).on('value', snap => {
    applySplitsEnabled(snap.val() === true);
  });
}

// The flag only controls whether the SPLIT button renders — stamps already
// recorded stay visible everywhere no matter what it says.
function applySplitsEnabled(enabled) {
  state.splitsEnabled = enabled;
  document.querySelector('.split').classList.toggle('hidden', !enabled);
  $('menu-split').textContent = enabled ? 'Disable Split Timer' : 'Enable Split Timer';
}

function toggleSplits() {
  if (!state.room) return;
  db.ref(`rooms/${state.room}/meta/splitsEnabled`).set(!state.splitsEnabled);
  hideMenu();
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
  const el = $('room-list');
  if (!el) return;
  if (!rooms.length) {
    el.innerHTML = '<p class="no-rooms">No active rooms yet.</p>';
    return;
  }
  el.innerHTML = rooms.map(r => `
    <button type="button" class="room-list-item" data-code="${escapeHtml(r.code)}" data-name="${escapeHtml(r.name)}">
      <span class="room-list-name">${escapeHtml(r.name)}</span>
      <span class="room-list-view">Results ›</span>
    </button>
  `).join('');
}

// ── Room actions ───────────────────────────────────────────────────────────

function createRoom() {
  const name = $('room-name').value.trim();
  if (!name) {
    alert('Please give the room a name first.');
    $('room-name').focus();
    return;
  }
  connectDb();
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
  const raw = $('join-code').value.trim().toUpperCase();
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
  $('rename-section').classList.add('hidden');
}

function toggleRenameField() {
  const section = $('rename-section');
  const isHidden = section.classList.toggle('hidden');
  if (!isHidden) {
    const input = $('rename-input');
    input.value = state.roomName;
    input.focus();
    input.select();
  }
}

function saveRoomName() {
  const name = $('rename-input').value.trim();
  if (!name || !state.room) return;
  state.roomName = name;
  db.ref().update({
    [`rooms/${state.room}/meta/name`]: name,
    [`roomIndex/${state.room}/name`]: name,
  });
  updateBadge(name, state.room);
  hideMenu();
}

function leaveRoom() {
  hideMenu();
  localStorage.removeItem(ROOM_KEY);
  goToLobby();
}

function deleteRoom() {
  hideMenu();
  const code = state.room;
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
  $('deleted-banner').classList.remove('hidden');
  hideMenu();
}

// ── Stamp logging ──────────────────────────────────────────────────────────

function logStamp(type) {
  if (!state.room) return;
  const rec = {
    type,
    epoch_ms: syncedNow(),
    athlete: $('athlete').value.trim(),
    operator: $('operator').value.trim(),
    note: $('note').value.trim()
  };
  const ref = db.ref(`rooms/${state.room}/stamps`).push();
  ref.set(rec);
  $('last').innerHTML =
    `<span class="last-time">${stampTime(rec.epoch_ms)}</span><span class="last-athlete">${escapeHtml(rec.athlete) || '—'}</span>`;
  if (navigator.vibrate) navigator.vibrate(35);
}

// ── Active racers ───────────────────────────────────────────────────────────

function renderActiveRacers() {
  const el = $('active-racers');
  if (!el) return;

  // stamps are already sorted by epoch_ms ascending, so last write wins.
  // Key by normalized name so "214 " and "214" are the same racer. Splits
  // are ignored: a racer stays on course until a FINISH, period.
  const lastByKey = new Map();
  state.stamps.forEach(s => {
    if (s.type !== 'START' && s.type !== 'FINISH') return;
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
      $('athlete').value = span.dataset.athlete;
    };
  });
}

// ── Render ─────────────────────────────────────────────────────────────────

function render() {
  const tbody = $('rows');
  if (!tbody) return;
  // Athletes who have a start, for flagging finishes that can't be paired.
  const startedKeys = new Set();
  state.stamps.forEach(s => { if (s.type === 'START') startedKeys.add(normAthlete(s.athlete)); });
  // Splits outside their athlete's start–finish window get the same flag.
  const splitUnmatched = new Set();
  getSplits(state.stamps).forEach(sp => { if (sp.unmatched) splitUnmatched.add(sp._key); });
  tbody.innerHTML = '';
  state.stamps.slice().reverse().forEach((r, i) => {
    const n = state.stamps.length - i;
    const unmatched =
      (r.type === 'FINISH' && !startedKeys.has(normAthlete(r.athlete))) ||
      (r.type === 'SPLIT' && splitUnmatched.has(r._key));
    const flagTitle = r.type === 'SPLIT' ? 'No matching start, or after the finish' : 'No matching start';
    const tr = document.createElement('tr');
    tr.className = 'row-clickable' + (unmatched ? ' row-unmatched' : '');
    tr.onclick = () => openEditSheet(r._key);
    tr.innerHTML = `
      <td>${n}${r.editedAt ? '<span class="edited-dot"></span>' : ''}</td>
      <td>${escapeHtml(r.type)}${unmatched ? `<span class="unmatched-dot" title="${flagTitle}"></span>` : ''}</td>
      <td>${stampTime(r.epoch_ms)}</td>
      <td>${stampDate(r.epoch_ms)}</td>
      <td>${escapeHtml(r.athlete)}</td>
      <td>${escapeHtml(r.operator)}</td>
      <td>${escapeHtml(r.note)}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Athlete suggestions ────────────────────────────────────────────────────
// Custom suggestion dropdown for the athlete field (a native <datalist> stacks
// with the browser's own autofill popup and behaves inconsistently). Shows only
// athletes who've started but not finished, filtered to what's typed; hidden
// when the field is blank, unfocused, has no match, or exactly matches a name.
function hideAthleteSuggest() {
  const box = $('athlete-suggest');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function updateAthleteSuggestions() {
  const box = $('athlete-suggest');
  const input = $('athlete');
  if (!box || !input) return;
  if (document.activeElement !== input) return hideAthleteSuggest();
  const q = normAthlete(input.value);
  if (!q) return hideAthleteSuggest();
  const matches = [...getAthleteIndex(state.stamps).values()]
    .filter(e => e.started && !e.finished && normAthlete(e.display).includes(q))
    .sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }));
  if (!matches.length || matches.some(e => normAthlete(e.display) === q)) return hideAthleteSuggest();
  box.innerHTML = matches
    .map(e => `<button type="button" class="suggest-item" data-name="${escapeHtml(e.display)}">${escapeHtml(e.display)}</button>`)
    .join('');
  box.classList.remove('hidden');
}

// ── Athlete lookup ─────────────────────────────────────────────────────────

function openLookup() {
  hideMenu();
  $('lookup-input').value = '';
  $('lookup-result').innerHTML = '';
  renderLookupOptions();
  $('lookup-overlay').classList.remove('hidden');
  $('lookup-sheet').classList.remove('hidden');
  bindKeyboardTracking();
}

function closeLookup() {
  $('lookup-overlay').classList.add('hidden');
  $('lookup-sheet').classList.add('hidden');
  unbindKeyboardTracking();
}

// Filter the finished-athlete list by what's typed; show an exact match's result.
function renderLookupOptions() {
  const q = $('lookup-input').value.trim().toLowerCase();
  const opts = $('lookup-options');
  const result = $('lookup-result');
  const finished = getFinishedAthletes(state.stamps);
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
  $('lookup-input').value = name;
  $('lookup-options').innerHTML = '';
  $('lookup-input').blur();
  showLookupResult(name);
}

function showLookupResult(athlete) {
  const el = $('lookup-result');
  const f = getFinishedAthletes(state.stamps).find(x => x.athlete === athlete);
  if (!f) { el.innerHTML = ''; return; }
  const parts = [];
  if (f.multiStart) parts.push('starts');
  if (f.multiFinish) parts.push('finishes');
  const warn = parts.length
    ? `<p class="lookup-warn">Multiple ${parts.join(' & ')} recorded — using the earliest start and the first finish after it.</p>`
    : '';
  // Every split for this athlete, in time order, labelled by its checkpoint
  // (the operator/station field). Elapsed is from the start; a split with no
  // usable start falls back to its wall-clock time. Flagged splits keep the
  // same red treatment as the stamps table.
  const splitRows = getSplits(state.stamps)
    .filter(sp => normAthlete(sp.athlete) === normAthlete(athlete))
    .map(sp => {
      const label = sp.checkpoint || 'Split';
      const value = sp.elapsedMs !== null ? formatElapsed(sp.elapsedMs) : formatStamp(new Date(sp.splitMs));
      return `<span class="lookup-split${sp.unmatched ? ' lookup-split-flagged' : ''}">${escapeHtml(label)}</span>` +
             `<strong class="${sp.unmatched ? 'lookup-split-flagged' : ''}">${value}</strong>`;
    }).join('');
  el.innerHTML = `
    <div class="lookup-elapsed">${formatElapsed(f.elapsedMs)}</div>
    <div class="lookup-detail">
      <span>Start</span><strong>${formatStamp(new Date(f.startMs))}</strong>
      ${splitRows}
      <span>Finish</span><strong>${formatStamp(new Date(f.finishMs))}</strong>
    </div>
    ${warn}
  `;
}

// ── Spectate (read-only results, polled over HTTPS) ───────────────────────

let spectatePollTimer = null;

function enterSpectate(code, name) {
  state.spectateCode = code;
  stopLobbyPolling();
  updateSpectateBadge(name || 'Live results');
  $('spectate-updated').textContent = 'Loading…';
  $('spectate-content').innerHTML = '';
  showScreen('screen-spectate');
  fetchSpectate();
  clearInterval(spectatePollTimer);
  spectatePollTimer = setInterval(fetchSpectate, 15000);
}

function leaveSpectate() {
  state.spectateCode = null;
  clearInterval(spectatePollTimer);
  spectatePollTimer = null;
  goToLobby();
}

// Spectators only see the room name — never the join code, so someone
// watching results can't use it to enter the room as an operator.
function updateSpectateBadge(name) {
  $('spectate-badge').innerHTML = escapeHtml(name);
}

function fetchSpectate() {
  if (!state.spectateCode || document.hidden) return;
  const code = state.spectateCode;
  fetch(`${firebaseConfig.databaseURL}/rooms/${code}.json`)
    .then(r => r.json())
    .then(data => {
      if (code !== state.spectateCode) return; // left the screen mid-fetch
      renderSpectate(data, code);
      $('spectate-updated').textContent =
        `Updated ${formatStamp(new Date()).slice(0, 8)} · refreshes automatically`;
    })
    .catch(() => {
      if (code !== state.spectateCode) return;
      $('spectate-updated').textContent = 'Offline — retrying…';
    });
}

function renderSpectate(data, code) {
  const content = $('spectate-content');
  if (!data || !data.meta || data.meta.deleted) {
    content.innerHTML = '<p class="spectate-empty">This room is no longer available.</p>';
    return;
  }
  updateSpectateBadge(data.meta.name || 'Live results');

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
  const stamp = state.stamps.find(s => s._key === key);
  if (!stamp) return;
  state.editingKey = key;
  $('edit-sheet-title').textContent = `${stamp.type} · ${stampTime(stamp.epoch_ms)}`;
  $('edit-athlete').value = stamp.athlete || '';
  $('edit-operator').value = stamp.operator || '';
  $('edit-note').value = stamp.note || '';
  $('edit-overlay').classList.remove('hidden');
  $('edit-sheet').classList.remove('hidden');
  bindKeyboardTracking();
  $('edit-note').focus();
}

function closeEditSheet() {
  state.editingKey = null;
  $('edit-overlay').classList.add('hidden');
  $('edit-sheet').classList.add('hidden');
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
  if (!state.editingKey || !state.room) return;
  const updates = {
    athlete:  $('edit-athlete').value.trim(),
    operator: $('edit-operator').value.trim(),
    note:     $('edit-note').value.trim(),
    editedAt: syncedNow(),
  };
  db.ref(`rooms/${state.room}/stamps/${state.editingKey}`).update(updates);
  closeEditSheet();
}

// ── Init ───────────────────────────────────────────────────────────────────

function init() {
  disconnectDb(); // no live connection until someone joins a room as operator
  tick();
  startLobbyPolling();
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) $('join-code').value = saved;
  showScreen('screen-lobby');

  if (isInAppBrowser()) $('inapp-banner').classList.remove('hidden');
  $('inapp-close').addEventListener('click', () => $('inapp-banner').classList.add('hidden'));

  // Lobby
  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoomFromInput);

  // Tap a live room to watch its results (read-only)
  $('room-list').addEventListener('click', e => {
    const item = e.target.closest('.room-list-item');
    if (item) enterSpectate(item.dataset.code, item.dataset.name || '');
  });

  // Spectate
  $('spectate-back').addEventListener('click', leaveSpectate);

  // Menu
  $('menu-btn').addEventListener('click', toggleMenu);
  $('menu-close').addEventListener('click', hideMenu);
  $('menu-lookup').addEventListener('click', openLookup);
  $('menu-csv').addEventListener('click', downloadCSV);
  $('menu-split').addEventListener('click', toggleSplits);
  $('menu-rename').addEventListener('click', toggleRenameField);
  $('rename-save').addEventListener('click', saveRoomName);
  $('menu-leave').addEventListener('click', leaveRoom);
  $('menu-delete').addEventListener('click', deleteRoom);

  // Deleted-room banner
  $('deleted-export').addEventListener('click', downloadCSV);
  $('deleted-lobby').addEventListener('click', goToLobby);

  // Edit sheet
  $('edit-overlay').addEventListener('click', closeEditSheet);
  $('edit-close').addEventListener('click', closeEditSheet);
  $('edit-cancel').addEventListener('click', closeEditSheet);
  $('edit-save').addEventListener('click', saveEdit);

  // Lookup sheet
  $('lookup-overlay').addEventListener('click', closeLookup);
  $('lookup-close').addEventListener('click', closeLookup);
  $('lookup-input').addEventListener('input', renderLookupOptions);

  // Refresh polled data as soon as the tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.spectateCode) fetchSpectate();
    else if (lobbyPollTimer) fetchRoomList();
  });

  // Close menu on outside click
  document.addEventListener('click', e => {
    const wrapper = document.querySelector('.menu-wrapper');
    if (wrapper && !wrapper.contains(e.target)) hideMenu();
  });

  // Allow pressing Enter to join
  $('join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoomFromInput();
  });

  // Allow pressing Enter to save room rename
  $('rename-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveRoomName();
  });

  const athleteInput = $('athlete');
  athleteInput.addEventListener('input', updateAthleteSuggestions);
  athleteInput.addEventListener('focus', updateAthleteSuggestions);
  athleteInput.addEventListener('blur', () => setTimeout(hideAthleteSuggest, 100));
  $('athlete-suggest').addEventListener('pointerdown', e => {
    const item = e.target.closest('.suggest-item');
    if (!item) return;
    e.preventDefault(); // keep focus; avoid a blur race hiding the list first
    athleteInput.value = item.dataset.name;
    hideAthleteSuggest();
  });

  // Lookup: pick a filtered athlete (delegated so it survives re-renders)
  $('lookup-options').addEventListener('click', e => {
    const btn = e.target.closest('.lookup-option');
    if (btn) selectLookupAthlete(btn.dataset.athlete);
  });

  // Stamp buttons: fire on release, primary pointer only, no context menu
  [['start', 'START'], ['finish', 'FINISH'], ['split', 'SPLIT']].forEach(([cls, type]) => {
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
}

init();
