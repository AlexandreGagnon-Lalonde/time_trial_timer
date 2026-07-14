// Server-synced clock and connection lifecycle.
//
// Phone clocks can disagree by seconds, so a start on one phone and a finish
// on another would corrupt the elapsed time. Firebase reports how far this
// device's clock is from its servers; stamping with the corrected time puts
// every phone on the same clock.
//
// Only operators hold a live Firebase connection (the free plan caps
// simultaneous connections at 100). The lobby and the spectator screen read
// over plain HTTPS instead, so any number of viewers costs zero connections.
// The socket opens when someone joins a room and closes back in the lobby.
import { db } from './firebase-db.js';

let serverTimeOffset = 0;
let clockSyncStarted = false;

export function connectDb() {
  if (!clockSyncStarted) {
    clockSyncStarted = true;
    db.ref('.info/serverTimeOffset').on('value', snap => {
      serverTimeOffset = snap.val() || 0;
    });
  }
  db.goOnline();
}

export function disconnectDb() {
  db.goOffline();
}

export function syncedNow() { return Date.now() + serverTimeOffset; }
