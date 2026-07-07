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

function tick() {
  const now = new Date();
  const t = formatStamp(now);
  const d = formatDate(now);
  const timerEl = document.getElementById('clock-time');
  const dateEl = document.getElementById('date');
  if (timerEl) timerEl.textContent = t;
  if (dateEl) dateEl.textContent = d;
  const holdEl = document.getElementById('hold-clock');
  if (holdEl && holdEl.parentElement.classList.contains('showing')) holdEl.textContent = t;
  requestAnimationFrame(tick);
}

// ── Hold / armed overlay ─────────────────────────────────────────────────
function showHold(type) {
  const o = document.getElementById('hold-overlay');
  if (!o) return;
  o.classList.remove('start', 'finish');
  o.classList.add(type === 'START' ? 'start' : 'finish', 'showing');
  document.getElementById('hold-type').textContent = type;
  const athlete = document.getElementById('athlete').value.trim();
  document.getElementById('hold-athlete').textContent = athlete ? '#' + athlete : '';
  if (navigator.vibrate) navigator.vibrate(20); // Android tactile confirm; iOS ignores
}

function hideHold() {
  const o = document.getElementById('hold-overlay');
  if (o) o.classList.remove('showing');
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
  lastAddedKey = null;
  hideMenu();
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) document.getElementById('join-code').value = saved;
  showScreen('screen-lobby');
}

function updateBadge(name, code) {
  const badge = document.getElementById('room-badge');
  badge.innerHTML = name
    ? `${escapeHtml(name)} <span class="badge-code">${code}</span>`
    : code;
}

function goToTimer(code, name = '') {
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
    updateFinishBtn();
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
      const { name = code, createdAt = Date.now() } = metaSnap.val();
      db.ref(`roomIndex/${code}`).set({ name, createdAt, deleted: false });
    });
  });
}

function subscribeToRoomIndex() {
  db.ref('roomIndex').on('value', snap => {
    const rooms = [];
    snap.forEach(child => {
      const r = child.val();
      if (!r.deleted) rooms.push({ code: child.key, ...r });
    });
    rooms.sort((a, b) => b.createdAt - a.createdAt);
    renderRoomList(rooms);
  });
}

function renderRoomList(rooms) {
  const el = document.getElementById('room-list');
  if (!el) return;
  if (!rooms.length) {
    el.innerHTML = '<p class="no-rooms">No active rooms yet.</p>';
    return;
  }
  el.innerHTML = rooms.map(r => `
    <div class="room-list-item">
      <span class="room-list-name">${escapeHtml(r.name)}</span>
    </div>
  `).join('');
}

// ── Room actions ───────────────────────────────────────────────────────────

function createRoom() {
  const name = document.getElementById('room-name').value.trim() || 'Unnamed Room';
  const code = generateCode();
  const meta = { name, createdAt: Date.now(), deleted: false };
  db.ref(`rooms/${code}/meta`).set(meta)
    .then(() => db.ref(`roomIndex/${code}`).set({ name, createdAt: meta.createdAt, deleted: false }))
    .then(() => goToTimer(code, name))
    .catch(err => alert('Could not create room: ' + err.message));
}

function joinRoomFromInput() {
  const raw = document.getElementById('join-code').value.trim().toUpperCase();
  if (raw.length !== 4) { alert('Please enter a 4-character room code.'); return; }

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
  db.ref(`rooms/${currentRoom}/meta/name`).set(name);
  db.ref(`roomIndex/${currentRoom}/name`).set(name);
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
  if (!confirm(`Delete room "${code}"?\n\nThis removes all timestamps for everyone in the room.`)) return;

  db.ref(`rooms/${code}/meta/deleted`).set(true).then(() => {
    db.ref(`roomIndex/${code}/deleted`).set(true);
    setTimeout(() => {
      db.ref(`rooms/${code}`).remove();
      db.ref(`roomIndex/${code}`).remove();
    }, 3000);
  });

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
  const now = new Date();
  const rec = {
    type,
    time: formatStamp(now),
    date: formatDate(now),
    iso: now.toISOString(),
    epoch_ms: now.getTime(),
    athlete: document.getElementById('athlete').value.trim(),
    operator: document.getElementById('operator').value.trim(),
    note: document.getElementById('note').value.trim()
  };
  const ref = db.ref(`rooms/${currentRoom}/stamps`).push();
  ref.set(rec);
  document.getElementById('last').innerHTML =
    `<span class="last-time">${rec.time}</span><span class="last-athlete">${escapeHtml(rec.athlete) || '—'}</span>`;
  if (navigator.vibrate) navigator.vibrate(35);
}

// ── Finish button state ─────────────────────────────────────────────────────

function updateFinishBtn() {
  const athlete = document.getElementById('athlete').value.trim();
  const btn = document.querySelector('.finish');
  const hasStarted = !athlete || stamps.some(s => s.type === 'START' && s.athlete === athlete);
  btn.disabled = !hasStarted;
}

// ── Active racers ───────────────────────────────────────────────────────────

function renderActiveRacers() {
  const el = document.getElementById('active-racers');
  if (!el) return;

  // stamps are already sorted by epoch_ms ascending, so last write wins
  const lastType = {};
  stamps.forEach(s => {
    if (!s.athlete) return;
    lastType[s.athlete] = s.type;
  });

  const active = Object.entries(lastType)
    .filter(([, type]) => type === 'START')
    .map(([athlete]) => athlete);

  if (!active.length) {
    el.classList.add('hidden');
    return;
  }

  el.classList.remove('hidden');
  el.innerHTML = active.map(a => `<span class="active-racer-name" data-athlete="${escapeHtml(a)}">${escapeHtml(a)}</span>`).join(' · ');
  el.querySelectorAll('.active-racer-name').forEach(span => {
    span.onclick = () => {
      document.getElementById('athlete').value = span.dataset.athlete;
      updateFinishBtn();
    };
  });
}

// ── Render ─────────────────────────────────────────────────────────────────

function render() {
  const tbody = document.getElementById('rows');
  if (!tbody) return;
  tbody.innerHTML = '';
  stamps.slice().reverse().forEach((r, i) => {
    const n = stamps.length - i;
    const tr = document.createElement('tr');
    tr.className = 'row-clickable';
    tr.onclick = () => openEditSheet(r._key);
    tr.innerHTML = `
      <td>${n}${r.editedAt ? '<span class="edited-dot"></span>' : ''}</td>
      <td>${escapeHtml(r.type)}</td>
      <td>${escapeHtml(r.time)}</td>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.athlete)}</td>
      <td>${escapeHtml(r.operator)}</td>
      <td>${escapeHtml(r.note)}</td>`;
    tbody.appendChild(tr);
  });
}

// ── CSV ────────────────────────────────────────────────────────────────────

function csvText() {
  const header = ['n', 'type', 'date', 'time', 'iso', 'epoch_ms', 'athlete', 'operator', 'note'];
  const lines = [header.join(',')];
  stamps.forEach((r, i) => {
    const row = { ...r, n: i + 1 };
    lines.push(header.map(k => `"${String(row[k] ?? '').replace(/"/g, '""')}"`).join(','));
  });
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
// Build the list of athletes with both a start and a finish, computing each
// one's elapsed time from the earliest start to the first finish after it.
function getFinishedAthletes() {
  const byAthlete = {};
  stamps.forEach(s => {
    const a = (s.athlete || '').trim();
    if (!a || typeof s.epoch_ms !== 'number') return;
    (byAthlete[a] = byAthlete[a] || { starts: [], finishes: [] });
    if (s.type === 'START') byAthlete[a].starts.push(s.epoch_ms);
    else if (s.type === 'FINISH') byAthlete[a].finishes.push(s.epoch_ms);
  });
  const out = [];
  Object.keys(byAthlete).forEach(a => {
    const { starts, finishes } = byAthlete[a];
    if (!starts.length || !finishes.length) return;
    const startMs = Math.min(...starts);
    const after = finishes.filter(f => f >= startMs).sort((x, y) => x - y);
    const finishMs = after.length ? after[0] : Math.max(...finishes);
    out.push({
      athlete: a,
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

function openLookup() {
  hideMenu();
  const select = document.getElementById('lookup-select');
  const result = document.getElementById('lookup-result');
  const finished = getFinishedAthletes();
  if (!finished.length) {
    select.innerHTML = '<option value="">No finished athletes yet</option>';
    result.innerHTML = '<p class="lookup-empty">No athlete has both a start and a finish yet.</p>';
  } else {
    select.innerHTML =
      '<option value="">Select an athlete…</option>' +
      finished.map(f => `<option value="${escapeHtml(f.athlete)}">${escapeHtml(f.athlete)}</option>`).join('');
    result.innerHTML = '';
  }
  document.getElementById('lookup-overlay').classList.remove('hidden');
  document.getElementById('lookup-sheet').classList.remove('hidden');
}

function closeLookup() {
  document.getElementById('lookup-overlay').classList.add('hidden');
  document.getElementById('lookup-sheet').classList.add('hidden');
}

function renderLookupResult() {
  const athlete = document.getElementById('lookup-select').value;
  const el = document.getElementById('lookup-result');
  if (!athlete) { el.innerHTML = ''; return; }
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

// ── Edit sheet ─────────────────────────────────────────────────────────────

function openEditSheet(key) {
  const stamp = stamps.find(s => s._key === key);
  if (!stamp) return;
  editingKey = key;
  document.getElementById('edit-sheet-title').textContent = `${stamp.type} · ${stamp.time}`;
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
  const sheet = document.getElementById('edit-sheet');
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
  const sheet = document.getElementById('edit-sheet');
  if (sheet) sheet.style.transform = '';
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
    editedAt: Date.now(),
  };
  db.ref(`rooms/${currentRoom}/stamps/${editingKey}`).update(updates);
  closeEditSheet();
}

// ── Init ───────────────────────────────────────────────────────────────────

(function init() {
  tick();
  subscribeToRoomIndex();
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) {
    document.getElementById('join-code').value = saved;
    ensureRoomIndexed(saved);
  }
  showScreen('screen-lobby');

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

  document.getElementById('athlete').addEventListener('input', updateFinishBtn);

  // Stamp buttons: fire on release, primary pointer only, no context menu
  [['start', 'START'], ['finish', 'FINISH']].forEach(([cls, type]) => {
    const btn = document.querySelector(`.${cls}`);
    btn.addEventListener('pointerdown',  e => { if (e.isPrimary && !btn.disabled) { btn.classList.add('is-pressed'); showHold(type); } });
    btn.addEventListener('pointerup',    e => { btn.classList.remove('is-pressed'); hideHold(); if (e.isPrimary && e.button === 0 && !btn.disabled) logStamp(type); });
    btn.addEventListener('pointercancel',() => { btn.classList.remove('is-pressed'); hideHold(); });
    btn.addEventListener('pointerleave', () => { btn.classList.remove('is-pressed'); hideHold(); });
    btn.addEventListener('contextmenu',  e => e.preventDefault());
  });
})();
