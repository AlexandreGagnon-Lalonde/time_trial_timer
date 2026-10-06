// Room roster: parsing a pasted or uploaded list of athlete names and
// matching against it. Pure functions only, no DOM or Firebase.
import { normAthlete } from './results.js';

const MAX_NAMES = 1000;
const MAX_LEN = 60; // matches the room-name length cap in database.rules.json

// A first cell that is just a column heading, in English or French.
const HEADER_RE = /^(name|names|nom|noms|athlete|athletes|athlète|athlètes)$/i;

// Split free text into distinct display names. Accepts one name per line, or
// names separated by commas or semicolons (French Excel exports CSV with `;`).
// Surrounding quotes from CSV cells are stripped, blanks dropped, and names
// that differ only in case or spacing collapse to the first spelling seen.
export function parseNames(text) {
  const seen = new Set();
  const out = [];
  const cells = String(text || '').replace(/^﻿/, '').split(/[\r\n,;]+/);
  cells.forEach((cell, i) => {
    let name = cell.trim().replace(/^"(.*)"$/s, '$1').trim().slice(0, MAX_LEN);
    if (!name) return;
    if (i === 0 && HEADER_RE.test(name)) return;
    const key = normAthlete(name);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out.slice(0, MAX_NAMES);
}

// Firebase child keys cannot contain . # $ [ ] or /. Keying the roster by the
// normalized name makes imports idempotent across stations: the same sheet
// imported twice, even concurrently, yields one entry per athlete.
export function rosterKey(name) {
  return normAthlete(name).replace(/[.#$\[\]\/]/g, '_');
}

// Roster names whose start matches the (already normalized) query, sorted the
// way the rest of the app sorts athletes. An empty query returns the whole list.
export function matchRoster(roster, q) {
  return roster
    .filter(name => normAthlete(name).startsWith(q))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
