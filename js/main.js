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
import { parseNames, rosterKey, matchRoster } from './roster.js';

const ROOM_KEY = 'ttt_room_code';
const TEAM_KEY = 'ttt_team_code';
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes O/0 and I/1 to avoid confusion

// Code lengths. Open rooms keep 4 characters because people type them. The
// database rules make knowing a code the only barrier to reading a team, so
// team codes (typed once, then remembered) are 6, and rooms inside a team,
// reached by tapping rather than typing, are 8: too many to guess.
const ROOM_CODE_LEN = 4;
const TEAM_CODE_LEN = 6;
const TEAM_ROOM_CODE_LEN = 8;

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

function generateCode(len = ROOM_CODE_LEN) {
  let code = '';
  for (let i = 0; i < len; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code;
}

// Where a room's lobby-facing summary lives: open rooms are listed in the
// public index, team rooms only inside their team.
function indexPath(code, team) {
  return team ? `teams/${team}/rooms/${code}` : `roomIndex/${code}`;
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
  stopTeamPolling();
  state.room = null;
  state.roomTeam = null;
  state.team = null;
  state.teamName = '';
  state.stamps = [];
  hideMenu();
  disableWakeLock();
  disconnectDb(); // free the live connection; the lobby polls over HTTPS
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) $('join-code').value = saved;
  renderKnownTeams();
  startLobbyPolling();
  showScreen('screen-lobby');
}

function updateBadge(name, code, badgeId = 'room-badge') {
  const badge = $(badgeId);
  badge.innerHTML = name
    ? `${escapeHtml(name)} <span class="badge-code">${escapeHtml(code)}</span>`
    : escapeHtml(code);
}

// A team room's badge shows the team instead of the 8-character code, which
// nobody needs to read off a screen.
function updateRoomBadge() {
  if (state.roomTeam) updateBadge(state.roomName || state.room, state.teamName || 'Team');
  else updateBadge(state.roomName, state.room);
}

function goToTimer(code, name = '', team = null) {
  connectDb();
  stopLobbyPolling();
  stopTeamPolling();
  state.room = code;
  state.roomName = name;
  state.roomTeam = team;
  localStorage.setItem(ROOM_KEY, code);
  if (!team) ensureRoomIndexed(code);
  updateRoomBadge();
  $('deleted-banner').classList.add('hidden');
  applySplitsEnabled(false); // until the room's meta listener says otherwise
  applyResultsHidden(false);
  // Team rooms are private already; hiding results only means something for
  // rooms listed in the public lobby.
  $('menu-hide').classList.toggle('hidden', !!team);
  hideMenu();
  enableWakeLock();
  showScreen('screen-timer');
  subscribeToRoom(code);
}

// Leaving a room returns to wherever it was entered from: a team's room list
// or the public lobby.
function exitRoom() {
  if (state.roomTeam) goToTeam(state.roomTeam, state.team === state.roomTeam ? state.teamName : '');
  else goToLobby();
}

// ── Firebase listeners ─────────────────────────────────────────────────────

function detachFirebaseListeners() {
  if (!state.room) return;
  db.ref(`rooms/${state.room}/stamps`).off();
  db.ref(`rooms/${state.room}/meta/deleted`).off();
  db.ref(`rooms/${state.room}/meta/splitsEnabled`).off();
  db.ref(`rooms/${state.room}/meta/resultsHidden`).off();
  db.ref(`rooms/${state.room}/roster`).off();
}

function subscribeToRoom(code) {
  state.stamps = [];
  state.roster = [];
  applyRoster();

  db.ref(`rooms/${code}/stamps`).on('value', snap => {
    const stamps = [];
    snap.forEach(child => { stamps.push({ _key: child.key, ...child.val() }); });
    stamps.sort((a, b) => a.epoch_ms - b.epoch_ms);
    state.stamps = stamps;
    render();
    renderActiveRacers();
    refreshSuggestions();
  });

  db.ref(`rooms/${code}/meta/deleted`).on('value', snap => {
    if (snap.val() === true) showDeletedBanner();
  });

  db.ref(`rooms/${code}/meta/splitsEnabled`).on('value', snap => {
    applySplitsEnabled(snap.val() === true);
  });

  db.ref(`rooms/${code}/meta/resultsHidden`).on('value', snap => {
    applyResultsHidden(snap.val() === true);
  });

  db.ref(`rooms/${code}/roster`).on('value', snap => {
    const names = Object.values(snap.val() || {}).filter(v => typeof v === 'string' && v.trim());
    names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    state.roster = names;
    applyRoster();
  });
}

// The flag only controls whether the SPLIT button renders — stamps already
// recorded stay visible everywhere no matter what it says.
function applySplitsEnabled(enabled) {
  state.splitsEnabled = enabled;
  // Scoped to the button row: the hold overlay also carries a type class
  // ('split') after a press, and a bare .split query would match it first.
  document.querySelector('.buttons .split').classList.toggle('hidden', !enabled);
  $('menu-split').textContent = enabled ? 'Disable Split Timer' : 'Enable Split Timer';
}

function toggleSplits() {
  if (!state.room) return;
  db.ref(`rooms/${state.room}/meta/splitsEnabled`).set(!state.splitsEnabled);
  hideMenu();
}

// Hiding results locks the room from the outside: the lobby entry goes grey
// and unclickable, and the spectate screen refuses to show its times. People
// who have the 4-character code can still join as operators.
function applyResultsHidden(hidden) {
  state.resultsHidden = hidden;
  $('menu-hide').textContent = hidden ? 'Show Results' : 'Hide Results';
}

function toggleResultsHidden() {
  if (!state.room) return;
  const hidden = !state.resultsHidden;
  // Atomic write so the room and the lobby index can't diverge
  db.ref().update({
    [`rooms/${state.room}/meta/resultsHidden`]: hidden,
    [`roomIndex/${state.room}/resultsHidden`]: hidden,
  });
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

const IDLE_CUTOFF_MS = 3 * 24 * 60 * 60 * 1000;

function fetchRoomList() {
  // Skip while the Rooms tab isn't showing; switching to it fetches at once.
  if (document.hidden || $('lobby-rooms').classList.contains('hidden')) return;
  fetch(`${firebaseConfig.databaseURL}/roomIndex.json`)
    .then(r => r.json())
    .then(data => {
      const idleSince = Date.now() - IDLE_CUTOFF_MS;
      const rooms = Object.entries(data || {})
        .filter(([, r]) => r && !r.deleted)
        // Idle rooms (no stamp and no creation within the cutoff) drop off the
        // lobby; the data stays and joining by code still works.
        .filter(([, r]) => Math.max(r.createdAt || 0, r.lastActivityAt || 0) >= idleSince)
        .map(([code, r]) => ({ code, ...r }));
      rooms.sort((a, b) => b.createdAt - a.createdAt);
      renderRoomList(rooms);
    })
    .catch(() => {}); // keep showing the last list if a poll fails
}

// The lobby has a Rooms tab (open rooms) and a Teams tab. The last tab used is
// remembered; a first visit opens Teams if this device already knows a team.
const LOBBY_TAB_KEY = 'ttt_lobby_tab';

function setLobbyTab(tab) {
  ['rooms', 'teams'].forEach(t => {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
    $(`lobby-${t}`).classList.toggle('hidden', t !== tab);
  });
  localStorage.setItem(LOBBY_TAB_KEY, tab);
  if (tab === 'rooms' && lobbyPollTimer) fetchRoomList();
}

function initialLobbyTab() {
  const saved = localStorage.getItem(LOBBY_TAB_KEY);
  if (saved === 'rooms' || saved === 'teams') return saved;
  return getKnownTeams().length ? 'teams' : 'rooms';
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
  el.innerHTML = rooms.map(r => r.resultsHidden ? `
    <button type="button" class="room-list-item room-list-locked" disabled>
      <span class="room-list-name">${escapeHtml(r.name)}</span>
      <span class="room-list-view">Hidden</span>
    </button>
  ` : `
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
  // 4 for open rooms, 8 for a team room whose code a teammate passed along
  if (raw.length !== ROOM_CODE_LEN && raw.length !== TEAM_ROOM_CODE_LEN) {
    alert(`Please enter a ${ROOM_CODE_LEN}-character room code.`);
    return;
  }
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
      const { name = '', team = null } = snap.val() || {};
      if (!team) { goToTimer(raw, name); return; }
      // A team room joined by code: pick up the team's name for the badge,
      // and adopt the team so leaving the room lands on its room list.
      return db.ref(`teams/${team}/meta/name`).get().then(nameSnap => {
        state.team = team;
        state.teamName = nameSnap.val() || '';
        goToTimer(raw, name, team);
      });
    })
    .catch(() => {
      // Network error — allow re-joining a previously saved room
      if (localStorage.getItem(ROOM_KEY) === raw) { goToTimer(raw); return; }
      alert('Cannot connect. Check your connection and try again.');
    });
}

// ── Menu ───────────────────────────────────────────────────────────────────

// The timer and team screens each have a menu; only one screen is visible at
// a time, so closing every menu is always safe.
function toggleMenu(e) {
  e.currentTarget.closest('.menu-wrapper').classList.toggle('is-open');
}

function hideMenu() {
  document.querySelectorAll('.menu-wrapper').forEach(w => w.classList.remove('is-open'));
  $('rename-section').classList.add('hidden');
  $('team-rename-section').classList.add('hidden');
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
    [`${indexPath(state.room, state.roomTeam)}/name`]: name,
  });
  updateRoomBadge();
  hideMenu();
}

function leaveRoom() {
  hideMenu();
  localStorage.removeItem(ROOM_KEY);
  exitRoom();
}

function deleteRoom() {
  hideMenu();
  const code = state.room;
  if (!confirm(`Delete room "${code}"?\n\nThe room will close for everyone in it.`)) return;

  // Soft delete: mark the room deleted (atomically, in both places) but keep
  // the data, so an accidental delete never destroys recorded times.
  db.ref().update({
    [`rooms/${code}/meta/deleted`]: true,
    [`${indexPath(code, state.roomTeam)}/deleted`]: true,
  }).catch(err => alert('Could not delete room: ' + err.message));

  localStorage.removeItem(ROOM_KEY);
  showDeletedBanner();
  setTimeout(exitRoom, 6000);
}

// ── Teams ──────────────────────────────────────────────────────────────────
// A team is a private group of rooms. The database rules only let a client
// read `teams/<code>` when it asks for that exact code, and team rooms never
// enter the public roomIndex, so knowing the team code is what grants access.
// The team screen polls over HTTPS like the lobby, holding no live connection.

let teamPollTimer = null;

// Every team this device has entered, most recent first, as [{ code, name }].
// Lives only in this browser: the lobby lists it so switching teams is one
// tap, and nobody else's teams ever appear.
const TEAMS_KEY = 'ttt_teams';

function getKnownTeams() {
  try {
    const list = JSON.parse(localStorage.getItem(TEAMS_KEY) || '[]');
    return Array.isArray(list) ? list.filter(t => t && typeof t.code === 'string') : [];
  } catch { return []; }
}

// Move the team to the front, keeping the last known name if none is given.
function rememberTeam(code, name) {
  const known = getKnownTeams();
  const prev = known.find(t => t.code === code);
  const entry = { code, name: name || prev?.name || '' };
  localStorage.setItem(TEAMS_KEY, JSON.stringify([entry, ...known.filter(t => t.code !== code)]));
}

function forgetTeam(code) {
  localStorage.setItem(TEAMS_KEY, JSON.stringify(getKnownTeams().filter(t => t.code !== code)));
}

function renderKnownTeams() {
  const teams = getKnownTeams();
  if (!teams.length) {
    $('known-team-list').innerHTML = '<p class="no-rooms">Teams you enter on this device appear here.</p>';
    return;
  }
  $('known-team-list').innerHTML = teams.map(t => `
    <button type="button" class="room-list-item" data-code="${escapeHtml(t.code)}" data-name="${escapeHtml(t.name)}">
      <span class="room-list-name">${escapeHtml(t.name || t.code)}</span>
      <span class="room-list-view">Open ›</span>
    </button>
  `).join('');
}

function goToTeam(code, name = '') {
  detachFirebaseListeners();
  state.room = null;
  state.roomTeam = null;
  state.stamps = [];
  state.team = code;
  state.teamName = name;
  localStorage.setItem(TEAM_KEY, code);
  rememberTeam(code, name);
  hideMenu();
  disableWakeLock();
  disconnectDb();
  stopLobbyPolling();
  updateBadge(name, code, 'team-badge');
  $('team-room-name').value = '';
  startTeamPolling();
  showScreen('screen-team');
}

function createTeam() {
  const name = $('team-name').value.trim();
  if (!name) {
    alert('Please give the team a name first.');
    $('team-name').focus();
    return;
  }
  connectDb();
  const code = generateCode(TEAM_CODE_LEN);
  db.ref(`teams/${code}/meta`).get()
    .then(snap => {
      if (snap.exists()) { createTeam(); return; } // code already taken — roll a new one
      return db.ref(`teams/${code}/meta`)
        .set({ name, createdAt: syncedNow(), deleted: false })
        .then(() => {
          // Reset the form so the lobby doesn't still show it after leaving
          $('team-name').value = '';
          goToTeam(code, name);
        });
    })
    .catch(err => alert('Could not create team: ' + err.message));
}

function enterTeamFromInput() {
  const raw = $('team-code').value.trim().toUpperCase();
  if (raw.length !== TEAM_CODE_LEN) { alert(`Please enter a ${TEAM_CODE_LEN}-character team code.`); return; }
  fetch(`${firebaseConfig.databaseURL}/teams/${raw}/meta.json`)
    .then(r => r.json())
    .then(meta => {
      if (!meta) { alert(`Team "${raw}" not found.`); return; }
      if (meta.deleted) { alert(`Team "${raw}" has been deleted.`); return; }
      goToTeam(raw, meta.name || '');
    })
    .catch(() => alert('Cannot connect. Check your connection and try again.'));
}

function fetchTeam() {
  if (!state.team || document.hidden) return;
  const code = state.team;
  fetch(`${firebaseConfig.databaseURL}/teams/${code}.json`)
    .then(r => r.json())
    .then(data => {
      if (code !== state.team) return; // left the screen mid-fetch
      if (!data || !data.meta || data.meta.deleted) {
        alert('This team no longer exists.');
        leaveTeam();
        return;
      }
      if (data.meta.name && data.meta.name !== state.teamName) {
        state.teamName = data.meta.name;
        updateBadge(state.teamName, code, 'team-badge');
        rememberTeam(code, state.teamName);
      }
      // Every room the team has ever used stays listed (no idle cutoff), most
      // recently active first, so old results stay a tap away.
      const rooms = Object.entries(data.rooms || {})
        .filter(([, r]) => r && !r.deleted)
        .map(([roomCode, r]) => ({ code: roomCode, ...r, activeAt: Math.max(r.createdAt || 0, r.lastActivityAt || 0) }));
      rooms.sort((a, b) => b.activeAt - a.activeAt);
      renderTeamRoomList(rooms);
    })
    .catch(() => {}); // keep showing the last list if a poll fails
}

function startTeamPolling() {
  stopTeamPolling();
  fetchTeam();
  teamPollTimer = setInterval(fetchTeam, 20000);
}

function stopTeamPolling() {
  clearInterval(teamPollTimer);
  teamPollTimer = null;
}

// Tapping a room enters it as an operator; the Results link watches it.
function renderTeamRoomList(rooms) {
  const el = $('team-room-list');
  if (!rooms.length) {
    el.innerHTML = '<p class="no-rooms">No rooms yet.</p>';
    return;
  }
  el.innerHTML = rooms.map(r => `
    <div class="room-list-item team-room-item" data-code="${escapeHtml(r.code)}" data-name="${escapeHtml(r.name)}">
      <span class="room-list-name">${escapeHtml(r.name)}</span>
      <button type="button" class="room-list-view team-room-results">Results ›</button>
    </div>
  `).join('');
}

function createTeamRoom() {
  const name = $('team-room-name').value.trim();
  if (!name) {
    alert('Please give the room a name first.');
    $('team-room-name').focus();
    return;
  }
  const team = state.team;
  connectDb();
  const code = generateCode(TEAM_ROOM_CODE_LEN);
  db.ref(`rooms/${code}/meta`).get()
    .then(snap => {
      if (snap.exists()) { createTeamRoom(); return; } // code already taken — roll a new one
      const createdAt = syncedNow();
      // One atomic write: the room itself (tagged with its team) and the
      // team's own index entry, so neither can exist without the other.
      return db.ref().update({
        [`rooms/${code}/meta`]: { name, createdAt, deleted: false, team },
        [`teams/${team}/rooms/${code}`]: { name, createdAt, deleted: false },
      }).then(() => goToTimer(code, name, team));
    })
    .catch(err => alert('Could not create room: ' + err.message));
}

function toggleTeamRenameField() {
  const section = $('team-rename-section');
  const isHidden = section.classList.toggle('hidden');
  if (!isHidden) {
    const input = $('team-rename-input');
    input.value = state.teamName;
    input.focus();
    input.select();
  }
}

function saveTeamName() {
  const name = $('team-rename-input').value.trim();
  if (!name || !state.team) return;
  state.teamName = name;
  rememberTeam(state.team, name);
  connectDb();
  db.ref(`teams/${state.team}/meta/name`).set(name)
    // Drop the connection again unless a room was entered in the meantime
    .then(() => { if (!state.room) disconnectDb(); })
    .catch(err => alert('Could not rename team: ' + err.message));
  updateBadge(name, state.team, 'team-badge');
  hideMenu();
}

// Forget the team on this device and go back to the lobby.
function leaveTeam() {
  hideMenu();
  localStorage.removeItem(TEAM_KEY);
  forgetTeam(state.team);
  goToLobby();
}

function deleteTeam() {
  hideMenu();
  const code = state.team;
  if (!confirm(`Delete team "${state.teamName || code}"?\n\nIts rooms will no longer be reachable from the team code.`)) return;
  // Soft delete, like rooms: the data stays, only the entry point closes.
  // Wait for the write before leaving, since leaving closes the connection.
  connectDb();
  db.ref(`teams/${code}/meta/deleted`).set(true)
    .then(() => leaveTeam())
    .catch(err => { disconnectDb(); alert('Could not delete team: ' + err.message); });
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
  const key = db.ref(`rooms/${state.room}/stamps`).push().key;
  // One atomic write: the stamp plus the lobby index's activity marker, which
  // keeps the room from being filtered out as idle while it's still in use.
  db.ref().update({
    [`rooms/${state.room}/stamps/${key}`]: rec,
    [`${indexPath(state.room, state.roomTeam)}/lastActivityAt`]: rec.epoch_ms,
  });
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
// Custom suggestion dropdown shared by the timer's athlete field and the edit
// sheet's (a native <datalist> stacks with the browser's own autofill popup and
// behaves inconsistently). With a roster loaded it lists roster names whose
// start matches what's typed (the whole roster when the field is blank), each
// tagged with race status. Athletes on course who were typed ad hoc, outside
// the roster, are still offered by substring so a finish station never loses
// them. Typing a name that isn't in the roster adds a row to append it.
const SUGGEST_FIELDS = [['athlete', 'athlete-suggest'], ['edit-athlete', 'edit-athlete-suggest']];

function hideSuggest(box) {
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function refreshSuggestions() {
  SUGGEST_FIELDS.forEach(([inputId, boxId]) => renderSuggestions($(inputId), $(boxId)));
}

function suggestBadge(entry) {
  if (!entry) return '';
  if (entry.finished) return '<span class="suggest-badge finished">finished</span>';
  if (entry.started) return '<span class="suggest-badge oncourse">on course</span>';
  return '';
}

function renderSuggestions(input, box) {
  if (!box || !input) return;
  if (document.activeElement !== input) return hideSuggest(box);
  const typed = input.value.trim();
  const q = normAthlete(typed);
  if (!q && !state.roster.length) return hideSuggest(box);

  const index = getAthleteIndex(state.stamps);
  const rosterKeys = new Set(state.roster.map(normAthlete));
  const items = matchRoster(state.roster, q)
    .map(name => ({ display: name, entry: index.get(normAthlete(name)) }));
  [...index.values()]
    .filter(e => e.started && !e.finished && !rosterKeys.has(e.key) && e.key.includes(q))
    .sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }))
    .forEach(e => items.push({ display: e.display, entry: e }));

  // Only offer to add once a roster exists, so rooms that never import one
  // keep the plain on-course dropdown they had before.
  const canAdd = !!q && state.roster.length > 0 && !rosterKeys.has(q);
  const exact = items.some(it => normAthlete(it.display) === q);
  // Nothing to offer, or the field already holds the one name we'd show.
  if (!items.length && !canAdd) return hideSuggest(box);
  if (exact && items.length === 1 && !canAdd) return hideSuggest(box);

  let html = items
    .map(it => `<button type="button" class="suggest-item" data-name="${escapeHtml(it.display)}">` +
               `<span>${escapeHtml(it.display)}</span>${suggestBadge(it.entry)}</button>`)
    .join('');
  if (canAdd) {
    html += `<button type="button" class="suggest-item suggest-add" data-name="${escapeHtml(typed)}">` +
            `+ Add "${escapeHtml(typed)}" to list</button>`;
  }
  box.innerHTML = html;
  box.classList.remove('hidden');
}

function bindSuggestField(inputId, boxId) {
  const input = $(inputId);
  const box = $(boxId);
  if (!input || !box) return;
  input.addEventListener('input', () => renderSuggestions(input, box));
  input.addEventListener('focus', () => renderSuggestions(input, box));
  input.addEventListener('blur', () => setTimeout(() => hideSuggest(box), 100));
  box.addEventListener('pointerdown', e => {
    const item = e.target.closest('.suggest-item');
    if (!item) return;
    e.preventDefault(); // keep focus; avoid a blur race hiding the list first
    const name = item.dataset.name;
    if (item.classList.contains('suggest-add')) addToRoster(name);
    input.value = name;
    hideSuggest(box);
  });
}

// ── Roster (imported athlete list) ─────────────────────────────────────────
// Names live under rooms/CODE/roster keyed by their normalized form, so every
// station in the room sees the same list and re-importing the same sheet is a
// no-op. Stamping never touches the roster: only Import and the Add row do.

function applyRoster() {
  const n = state.roster.length;
  $('menu-roster').textContent = n ? `Import Athletes (${n})` : 'Import Athletes';
  $('menu-clear-roster').classList.toggle('hidden', !n);
  refreshSuggestions();
  updateRosterPreview();
}

function addToRoster(name) {
  const display = (name || '').trim();
  if (!state.room || !display) return;
  db.ref(`rooms/${state.room}/roster/${rosterKey(display)}`).set(display);
}

function openRosterSheet() {
  hideMenu();
  $('roster-text').value = '';
  $('roster-file').value = '';
  updateRosterPreview();
  $('roster-overlay').classList.remove('hidden');
  $('roster-sheet').classList.remove('hidden');
  bindKeyboardTracking();
}

function closeRosterSheet() {
  $('roster-overlay').classList.add('hidden');
  $('roster-sheet').classList.add('hidden');
  unbindKeyboardTracking();
}

// Parsed names from the textarea, split into all of them and the ones the
// room doesn't have yet.
function pendingRosterNames() {
  const names = parseNames($('roster-text').value);
  const existing = new Set(state.roster.map(normAthlete));
  return { names, fresh: names.filter(n => !existing.has(normAthlete(n))) };
}

function updateRosterPreview() {
  const sheet = $('roster-sheet');
  if (!sheet || sheet.classList.contains('hidden')) return;
  const { names, fresh } = pendingRosterNames();
  const el = $('roster-preview');
  if (!names.length) {
    el.textContent = $('roster-text').value.trim() ? 'No names found' : '';
  } else {
    const dup = names.length - fresh.length;
    el.textContent = `${names.length} name${names.length === 1 ? '' : 's'}` +
      (dup ? ` · ${dup} already in list` : '');
  }
  $('roster-import').disabled = !fresh.length;
}

function loadRosterFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('roster-text').value = String(reader.result || '');
    updateRosterPreview();
  };
  reader.readAsText(file);
}

function importRoster() {
  if (!state.room) return;
  const { fresh } = pendingRosterNames();
  if (!fresh.length) return;
  // One multi-path write so the list lands atomically on every station.
  const updates = {};
  fresh.forEach(n => { updates[`rooms/${state.room}/roster/${rosterKey(n)}`] = n; });
  db.ref().update(updates);
  closeRosterSheet();
}

function clearRoster() {
  hideMenu();
  if (!state.room || !state.roster.length) return;
  const n = state.roster.length;
  if (!confirm(`Remove all ${n} name${n === 1 ? '' : 's'} from this room's athlete list?`)) return;
  db.ref(`rooms/${state.room}/roster`).set(null);
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
  // Fastest first, ranked before filtering so a match keeps its overall place.
  const ranked = [...finished]
    .sort((a, b) => a.elapsedMs - b.elapsedMs)
    .map((f, i) => ({ ...f, rank: i + 1 }));
  const matches = q ? ranked.filter(f => f.athlete.toLowerCase().includes(q)) : ranked;
  opts.innerHTML = matches.length
    ? matches.map(f =>
        `<button type="button" class="lookup-option" data-athlete="${escapeHtml(f.athlete)}">` +
        `<span class="lookup-option-rank">${f.rank}</span>` +
        `<span class="lookup-option-name">${escapeHtml(f.athlete)}</span>` +
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
  stopTeamPolling(); // state.team stays set so ✕ returns to the team screen
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
  if (state.team) goToTeam(state.team, state.teamName);
  else goToLobby();
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
  // Also covers spectators already on this screen when the room flips hidden.
  if (data.meta.resultsHidden) {
    content.innerHTML = '<p class="spectate-empty">Results for this room are hidden.</p>';
    return;
  }

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
  hideSuggest($('edit-athlete-suggest'));
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
  db.ref(`${indexPath(state.room, state.roomTeam)}/lastActivityAt`).set(updates.editedAt);
  closeEditSheet();
}

// ── Init ───────────────────────────────────────────────────────────────────

function init() {
  disconnectDb(); // no live connection until someone joins a room as operator
  tick();
  startLobbyPolling();
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) $('join-code').value = saved;
  // A device that entered a team lands straight on that team's rooms.
  renderKnownTeams();
  setLobbyTab(initialLobbyTab());
  const savedTeam = localStorage.getItem(TEAM_KEY);
  if (savedTeam) goToTeam(savedTeam);
  else showScreen('screen-lobby');

  if (isInAppBrowser()) $('inapp-banner').classList.remove('hidden');
  $('inapp-close').addEventListener('click', () => $('inapp-banner').classList.add('hidden'));

  // Lobby
  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoomFromInput);
  $('btn-team-join').addEventListener('click', enterTeamFromInput);
  $('btn-team-create').addEventListener('click', createTeam);
  document.querySelectorAll('.lobby-tab').forEach(tab =>
    tab.addEventListener('click', () => setLobbyTab(tab.dataset.tab)));

  // Tap a live room to watch its results (read-only)
  $('room-list').addEventListener('click', e => {
    const item = e.target.closest('.room-list-item');
    if (item) enterSpectate(item.dataset.code, item.dataset.name || '');
  });

  // Lobby: tap one of this device's teams to open it
  $('known-team-list').addEventListener('click', e => {
    const item = e.target.closest('.room-list-item');
    if (item) goToTeam(item.dataset.code, item.dataset.name || '');
  });

  // Team screen: tap a room to time in it, or its Results link to watch it
  $('team-room-list').addEventListener('click', e => {
    const item = e.target.closest('.team-room-item');
    if (!item) return;
    if (e.target.closest('.team-room-results')) enterSpectate(item.dataset.code, item.dataset.name || '');
    else goToTimer(item.dataset.code, item.dataset.name || '', state.team);
  });
  $('btn-team-room-create').addEventListener('click', createTeamRoom);
  $('team-menu-btn').addEventListener('click', toggleMenu);
  $('team-menu-close').addEventListener('click', hideMenu);
  $('team-menu-rename').addEventListener('click', toggleTeamRenameField);
  $('team-rename-save').addEventListener('click', saveTeamName);
  $('team-menu-lobby').addEventListener('click', goToLobby);
  $('team-menu-leave').addEventListener('click', leaveTeam);
  $('team-menu-delete').addEventListener('click', deleteTeam);

  // Spectate
  $('spectate-back').addEventListener('click', leaveSpectate);

  // Menu
  $('menu-btn').addEventListener('click', toggleMenu);
  $('menu-close').addEventListener('click', hideMenu);
  $('menu-lookup').addEventListener('click', openLookup);
  $('menu-roster').addEventListener('click', openRosterSheet);
  $('menu-clear-roster').addEventListener('click', clearRoster);
  $('menu-csv').addEventListener('click', downloadCSV);
  $('menu-split').addEventListener('click', toggleSplits);
  $('menu-hide').addEventListener('click', toggleResultsHidden);
  $('menu-rename').addEventListener('click', toggleRenameField);
  $('rename-save').addEventListener('click', saveRoomName);
  $('menu-leave').addEventListener('click', leaveRoom);
  $('menu-delete').addEventListener('click', deleteRoom);

  // Deleted-room banner
  $('deleted-export').addEventListener('click', downloadCSV);
  $('deleted-lobby').addEventListener('click', exitRoom);

  // Edit sheet
  $('edit-overlay').addEventListener('click', closeEditSheet);
  $('edit-close').addEventListener('click', closeEditSheet);
  $('edit-cancel').addEventListener('click', closeEditSheet);
  $('edit-save').addEventListener('click', saveEdit);

  // Roster import sheet
  $('roster-overlay').addEventListener('click', closeRosterSheet);
  $('roster-close').addEventListener('click', closeRosterSheet);
  $('roster-cancel').addEventListener('click', closeRosterSheet);
  $('roster-import').addEventListener('click', importRoster);
  $('roster-text').addEventListener('input', updateRosterPreview);
  $('roster-file').addEventListener('change', loadRosterFile);

  // Lookup sheet
  $('lookup-overlay').addEventListener('click', closeLookup);
  $('lookup-close').addEventListener('click', closeLookup);
  $('lookup-input').addEventListener('input', renderLookupOptions);

  // Refresh polled data as soon as the tab becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.spectateCode) fetchSpectate();
    else if (teamPollTimer) fetchTeam();
    else if (lobbyPollTimer) fetchRoomList();
  });

  // Close menus on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.menu-wrapper')) hideMenu();
  });

  // Allow pressing Enter to join / enter a team
  $('join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoomFromInput();
  });
  $('team-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') enterTeamFromInput();
  });

  // Allow pressing Enter in a name field to create
  [['room-name', createRoom], ['team-name', createTeam], ['team-room-name', createTeamRoom]]
    .forEach(([id, create]) => $(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') create();
    }));

  // Allow pressing Enter to save renames
  $('rename-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveRoomName();
  });
  $('team-rename-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveTeamName();
  });

  // Athlete suggestion dropdowns (timer field and edit sheet field)
  SUGGEST_FIELDS.forEach(([inputId, boxId]) => bindSuggestField(inputId, boxId));

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
