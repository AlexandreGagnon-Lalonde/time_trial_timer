const ROOM_KEY = 'ttt_room_code';
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excludes O/0 and I/1 to avoid confusion

let currentRoom = null;
let stamps = [];
let lastAddedKey = null;

// ── Utility ────────────────────────────────────────────────────────────────

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

function formatStamp(d) {
  const hundredths = Math.floor(d.getMilliseconds() / 10);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(hundredths)}`;
}

function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  const lobbyEl = document.getElementById('clock-lobby');
  const timerEl = document.getElementById('clock');
  const dateEl = document.getElementById('date');
  if (lobbyEl) lobbyEl.textContent = t;
  if (timerEl) timerEl.textContent = t;
  if (dateEl) dateEl.textContent = d;
  requestAnimationFrame(tick);
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

function goToTimer(code) {
  currentRoom = code;
  localStorage.setItem(ROOM_KEY, code);
  document.getElementById('room-badge').textContent = `Room: ${code}`;
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
    snap.forEach(child => stamps.push({ _key: child.key, ...child.val() }));
    stamps.sort((a, b) => a.epoch_ms - b.epoch_ms);
    render();
  });

  db.ref(`rooms/${code}/meta/deleted`).on('value', snap => {
    if (snap.val() === true) showDeletedBanner();
  });
}

// ── Room actions ───────────────────────────────────────────────────────────

function createRoom() {
  const code = generateCode();
  db.ref(`rooms/${code}/meta`).set({ createdAt: Date.now(), deleted: false })
    .then(() => goToTimer(code))
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
      goToTimer(raw);
    })
    .catch(() => {
      // Network error — allow re-joining a previously saved room
      if (localStorage.getItem(ROOM_KEY) === raw) { goToTimer(raw); return; }
      alert('Cannot connect. Check your connection and try again.');
    });
}

// ── Menu ───────────────────────────────────────────────────────────────────

function toggleMenu() { document.getElementById('room-menu').classList.toggle('hidden'); }
function hideMenu() { document.getElementById('room-menu').classList.add('hidden'); }

function leaveRoom() {
  hideMenu();
  localStorage.removeItem(ROOM_KEY);
  goToLobby();
}

function deleteRoom() {
  hideMenu();
  if (!confirm(`Delete room "${currentRoom}"?\n\nThis removes all timestamps for everyone in the room.`)) return;

  db.ref(`rooms/${currentRoom}/meta/deleted`).set(true).then(() => {
    setTimeout(() => db.ref(`rooms/${currentRoom}`).remove(), 3000);
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
  lastAddedKey = ref.key;
  ref.set(rec);
  document.getElementById('last').textContent =
    `${type} recorded: ${rec.time} — Athlete: ${rec.athlete || '(blank)'}`;
  if (navigator.vibrate) navigator.vibrate(35);
}

function undoLast() {
  if (!lastAddedKey || !currentRoom) return;
  db.ref(`rooms/${currentRoom}/stamps/${lastAddedKey}`).remove().then(() => {
    document.getElementById('last').textContent = 'Last stamp removed.';
    lastAddedKey = null;
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
    tr.innerHTML = `
      <td>${n}</td>
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

// ── Init ───────────────────────────────────────────────────────────────────

(function init() {
  tick();
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) document.getElementById('join-code').value = saved;
  showScreen('screen-lobby');

  // Close menu on outside click
  document.addEventListener('click', e => {
    const menu = document.getElementById('room-menu');
    const btn = document.querySelector('.menu-btn');
    if (menu && btn && !menu.contains(e.target) && !btn.contains(e.target)) hideMenu();
  });

  // Allow pressing Enter to join
  document.getElementById('join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoomFromInput();
  });
})();
