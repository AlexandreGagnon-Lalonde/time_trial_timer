// Time/date formatting and HTML escaping. Pure functions only.

export function pad(n, len = 2) { return String(n).padStart(len, '0'); }

export function formatStamp(d) {
  const hundredths = Math.floor(d.getMilliseconds() / 10);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(hundredths)}`;
}

export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local date + time with millisecond precision: YYYY-MM-DD HH:MM:SS:XXX
export function formatDateTimeMs(ms) {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return `${formatDate(d)} ${formatTimeMs(ms)}`;
}

// Local time with millisecond precision: HH:MM:SS:XXX
export function formatTimeMs(ms) {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}:${pad(d.getMilliseconds(), 3)}`;
}

// Display strings derived from a stamp's epoch_ms (the single stored time)
export function stampTime(ms) { return typeof ms === 'number' ? formatStamp(new Date(ms)) : ''; }
export function stampDate(ms) { return typeof ms === 'number' ? formatDate(new Date(ms)) : ''; }

// Elapsed duration as M:SS.xx (or H:MM:SS.xx past an hour)
export function formatElapsed(ms) {
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

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[c]));
}
