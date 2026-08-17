// CSV export of the current room's stamps plus a finished-athletes section.
import { state } from './state.js';
import { formatDate, formatDateTimeMs, formatTimeMs, formatElapsed, stampTime, stampDate } from './format.js';
import { getFinishedAthletes, getSplits } from './results.js';

function csvText() {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['n', 'type', 'date', 'time', 'iso', 'time_ms', 'epoch_ms', 'athlete', 'operator', 'note'];
  const lines = [header.join(',')];
  state.stamps.forEach((r, i) => {
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
  const indent = ',,,';
  const finished = getFinishedAthletes(state.stamps);
  if (finished.length) {
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

  // Third section: splits, one row per SPLIT stamp in time order. Only
  // written when the room has splits, so other rooms' exports are unchanged.
  // Elapsed is from the athlete's start; blank when there is no start.
  const splits = getSplits(state.stamps);
  if (splits.length) {
    lines.push('');
    lines.push(indent + 'Splits');
    lines.push(indent + ['athlete', 'checkpoint', 'time', 'elapsed'].join(','));
    splits.forEach(sp => {
      lines.push(indent + [
        esc(sp.athlete),
        esc(sp.checkpoint),
        esc(formatDateTimeMs(sp.splitMs)),
        esc(sp.elapsedMs !== null ? formatElapsed(sp.elapsedMs) : ''),
      ].join(','));
    });
  }
  return lines.join('\n');
}

export function downloadCSV() {
  const blob = new Blob([csvText()], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `timestamps-${state.room}-${formatDate(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
