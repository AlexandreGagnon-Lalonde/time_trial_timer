// Athlete pairing and indexing over a list of stamps. Pure functions only:
// callers pass the stamp list in, nothing here touches the DOM or Firebase.

// Match athletes case- and whitespace-insensitively so "Stephanie",
// "stephanie" and " Stephanie " count as the same person.
export function normAthlete(s) {
  return (s || '').trim().toLowerCase();
}

// Build the list of athletes with both a start and a finish, computing each
// one's elapsed time from the earliest start to the first finish after it.
export function getFinishedAthletes(list) {
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
export function getAthleteIndex(list) {
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
