// Keep the screen awake on the timer screen, so an operator waiting between
// racers never has to unlock their phone as an athlete crosses the line.
// The OS releases the lock whenever the tab is hidden or the screen is
// covered, so re-acquire it when the tab becomes visible while still wanted.
// On browsers without the API (or when the OS refuses, e.g. low-battery
// mode) everything silently degrades to today's behavior.
let sentinel = null;
let acquiring = false;
let wanted = false;

async function acquire() {
  if (!wanted || sentinel || acquiring || !('wakeLock' in navigator)) return;
  acquiring = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (wanted) {
      sentinel = lock;
      lock.addEventListener('release', () => { if (sentinel === lock) sentinel = null; });
    } else {
      lock.release().catch(() => {});
    }
  } catch {
    // Request refused — nothing to do, the app works without the lock.
  }
  acquiring = false;
}

export function enableWakeLock() {
  wanted = true;
  acquire();
}

export function disableWakeLock() {
  wanted = false;
  const lock = sentinel;
  sentinel = null;
  if (lock) lock.release().catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') acquire();
});
