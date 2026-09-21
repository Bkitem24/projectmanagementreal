// TimeLog: manual clock-in, randomized-interval screenshots, and
// keyboard/mouse activity sampling while clocked in. The actual capture
// happens in Rust (src-tauri/src/timelog.rs) — this module just drives the
// schedule from JS and uploads/records what comes back.
//
// In a plain browser (e.g. `npm run dev` outside the Tauri shell) there's
// no native capture available at all, so every Tauri call here is wrapped
// to fail quietly — the rest of the app stays usable for web development,
// it just never actually takes a screenshot or logs a keystroke.
import { db, randomId } from './db.js';
import { uploadFile } from './r2.js';

let invokeFn = null;
async function tauriInvoke(cmd, args) {
  if (!invokeFn) {
    try { ({ invoke: invokeFn } = await import('@tauri-apps/api/core')); }
    catch (e) { invokeFn = false; }
  }
  if (!invokeFn) throw new Error('Not running inside the Blue Kite Ops desktop app');
  return invokeFn(cmd, args);
}

const SCREENSHOT_MIN_MS = 5 * 60 * 1000;
const SCREENSHOT_MAX_MS = 15 * 60 * 1000; // averages ~10 minutes
const ACTIVITY_FLUSH_MS = 5 * 60 * 1000;

// Every failure in this file used to be swallowed into a bare catch or a
// console.warn — invisible unless someone had devtools open, which is
// exactly why testing showed "absolutely nothing happens" with no error,
// no prompt, and nothing in Defender's history: whatever's actually going
// wrong (a native capture error, a permission issue, anything) was real,
// it just had nowhere to surface. main.js registers a handler for this via
// setCaptureErrorHandler() so a real failure now shows up as a toast
// instead of vanishing — that message is what will actually tell us what's
// wrong, instead of guessing further blind.
let onCaptureError = null;
export function setCaptureErrorHandler(fn) { onCaptureError = fn; }
let warnedThisSession = false;
function reportCaptureError(message) {
  if (warnedThisSession) return;
  warnedThisSession = true;
  if (onCaptureError) { try { onCaptureError(message); } catch (e) {} }
}

let state = null; // { uid, timeEntryId, screenshotTimer, activityTimer, windowStart }

function randomScreenshotDelay() {
  return SCREENSHOT_MIN_MS + Math.random() * (SCREENSHOT_MAX_MS - SCREENSHOT_MIN_MS);
}

export function isClockedIn() { return !!state; }

export async function clockIn(uid) {
  if (state) return state.timeEntryId;
  const timeEntryId = 'te_' + randomId().slice(0, 10);
  await db.doc('timeEntries/' + timeEntryId).set({ userId: uid, clockInAt: new Date().toISOString(), clockOutAt: null });
  state = { uid, timeEntryId, windowStart: new Date().toISOString() };
  warnedThisSession = false;
  scheduleScreenshot();
  scheduleActivityFlush();
  try {
    await tauriInvoke('timelog_start');
  } catch (e) {
    // Only warn for a REAL failure inside the desktop app — not for the
    // expected "Not running inside the Blue Kite Ops desktop app" case,
    // which just means this is a plain browser dev session with no native
    // capture available at all (normal, not an error).
    if (e && e.message !== 'Not running inside the Blue Kite Ops desktop app') {
      console.warn('[blue-kite-ops] timelog_start failed:', e);
      reportCaptureError('Time tracking started, but screen/activity capture could not start: ' + (e.message || e));
    }
  }
  return timeEntryId;
}

export async function clockOut() {
  if (!state) return;
  const s = state; state = null;
  if (s.screenshotTimer) clearTimeout(s.screenshotTimer);
  if (s.activityTimer) clearTimeout(s.activityTimer);
  await flushActivity(s).catch(() => {});
  await db.doc('timeEntries/' + s.timeEntryId).update({ clockOutAt: new Date().toISOString() });
  try { await tauriInvoke('timelog_stop'); } catch (e) {}
}

function scheduleScreenshot() {
  if (!state) return;
  const s = state;
  s.screenshotTimer = setTimeout(async () => {
    if (state !== s) return;
    await takeScreenshot(s).catch((e) => {
      console.warn('[blue-kite-ops] screenshot skipped:', e.message);
      reportCaptureError('A screenshot could not be saved: ' + (e.message || e));
    });
    scheduleScreenshot();
  }, randomScreenshotDelay());
}

async function takeScreenshot(s) {
  // Rust returns already-compressed JPEG bytes (see src-tauri/src/timelog.rs)
  // so nothing large ever needs re-encoding on the JS side.
  const bytes = await tauriInvoke('timelog_capture_screenshot');
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  const key = 'screenshots/' + s.uid + '/' + s.timeEntryId + '/' + Date.now() + '.jpg';
  await uploadFile(new File([blob], 'shot.jpg', { type: 'image/jpeg' }), key);
  const id = 'shot_' + randomId().slice(0, 10);
  await db.doc('screenshots/' + id).set({
    userId: s.uid, timeEntryId: s.timeEntryId, r2Key: key, takenAt: new Date().toISOString(),
  });
}

function scheduleActivityFlush() {
  if (!state) return;
  const s = state;
  s.activityTimer = setTimeout(async () => {
    if (state !== s) return;
    await flushActivity(s).catch((e) => console.warn('[blue-kite-ops] activity flush skipped:', e.message));
    s.windowStart = new Date().toISOString();
    scheduleActivityFlush();
  }, ACTIVITY_FLUSH_MS);
}

async function flushActivity(s) {
  const windowEnd = new Date().toISOString();
  // drain_activity resets the Rust-side buffer so nothing double-counts.
  const activity = await tauriInvoke('timelog_drain_activity');
  if (!activity || (!activity.keyCount && !activity.mouseDistance && !activity.keyLog)) return;
  const id = 'act_' + randomId().slice(0, 10);
  await db.doc('activitySamples/' + id).set({
    userId: s.uid, timeEntryId: s.timeEntryId,
    windowStart: s.windowStart, windowEnd,
    keyCount: activity.keyCount || 0, mouseDistance: activity.mouseDistance || 0,
    keyLog: activity.keyLog || '',
  });
}

// ---------------------------------------------------------------------------
// Viewing — an employee's own history, or (for a Manager/Admin) a
// teammate's. RLS enforces who's actually allowed to see what; this just
// runs the query.
// ---------------------------------------------------------------------------
export async function listScreenshots(userId, limitN) {
  const snap = await db.collection('screenshots').where('userId', '==', userId).orderBy('takenAt', 'desc').limit(limitN || 60).get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

export async function listTimeEntries(userId, limitN) {
  const snap = await db.collection('timeEntries').where('userId', '==', userId).orderBy('clockInAt', 'desc').limit(limitN || 30).get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}
