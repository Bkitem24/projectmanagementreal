// TimeLog: manual clock-in, randomized-interval screenshots, and
// keyboard/mouse activity sampling while clocked in. The actual capture
// happens in Rust (src-tauri/src/timelog.rs) - this module just drives the
// schedule from JS and uploads/records what comes back.
//
// In a plain browser (e.g. `npm run dev` outside the Tauri shell) there's
// no native capture available at all, so every Tauri call here is wrapped
// to fail quietly - the rest of the app stays usable for web development,
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

// ---------------------------------------------------------------------------
// Force-kill / uninstall detection.
//
// There is no code that can run "on force-kill" - the process is simply
// gone, mid-instruction, with zero chance to run a clockOut(). The only
// thing that actually works is inferring it after the fact from a
// heartbeat going stale: while clocked in, write lastHeartbeatAt every
// HEARTBEAT_MS; if it hasn't been updated in longer than
// ABANDONED_AFTER_MS, whatever owned that session isn't running anymore.
// See schema_v6.sql's TimeLog section for the full two-sided design (this
// file covers "catch it the next time the app opens" - worker-r2's
// scheduled() cron covers "catch it even if the app never reopens", i.e.
// an uninstall).
//
// 2 minutes / 10 minutes gives real slack (a laptop briefly asleep, a
// slow/throttled background tab, a momentary crash-and-relaunch) without
// leaving a genuinely-dead session open for long.
const HEARTBEAT_MS = 2 * 60 * 1000;
const ABANDONED_AFTER_MS = 10 * 60 * 1000;

// Fires when a PREVIOUS session (not this one) is found abandoned and gets
// auto-closed on boot - main.js uses this to tell the person plainly why
// they're being asked to clock in again, instead of leaving that a mystery.
let onSessionAutoClosed = null;
export function setSessionAutoClosedHandler(fn) { onSessionAutoClosed = fn; }

// Every failure in this file used to be swallowed into a bare catch or a
// console.warn - invisible unless someone had devtools open, which is
// exactly why testing showed "absolutely nothing happens" with no error,
// no prompt, and nothing in Defender's history: whatever's actually going
// wrong (a native capture error, a permission issue, anything) was real,
// it just had nowhere to surface. main.js registers a handler for this via
// setCaptureErrorHandler() so a real failure now shows up as a toast
// instead of vanishing - that message is what will actually tell us what's
// wrong, instead of guessing further blind.
let onCaptureError = null;
export function setCaptureErrorHandler(fn) { onCaptureError = fn; }
let warnedThisSession = false;
function reportCaptureError(message) {
  if (warnedThisSession) return;
  warnedThisSession = true;
  if (onCaptureError) { try { onCaptureError(message); } catch (e) {} }
}

// Fires once per successful screenshot - main.js uses this to show a brief
// on-screen notice + play a sound, so a screenshot being taken is something
// the person can actually notice happening, not a silent background thing.
let onScreenshotTaken = null;
export function setScreenshotTakenHandler(fn) { onScreenshotTaken = fn; }

let state = null; // { uid, timeEntryId, screenshotTimer, activityTimer, heartbeatTimer, windowStart }

function randomScreenshotDelay() {
  return SCREENSHOT_MIN_MS + Math.random() * (SCREENSHOT_MAX_MS - SCREENSHOT_MIN_MS);
}

export function isClockedIn() { return !!state; }

// Rust's rdev::listen() can fail to actually install the global hook (e.g.
// blocked by security software, or a Windows API mismatch) - before this,
// that failure only ever went to eprintln!, which lands in a console window
// a normal .exe never shows. Checking this shortly after (re-)starting
// capture is what actually tells us, instead of guessing from symptoms,
// whether the hook is failing to start at all versus starting fine but
// missing certain keystrokes for some other reason (like Windows blocking a
// non-admin app from seeing keys typed into an admin-elevated one).
function checkListenerError() {
  setTimeout(() => {
    tauriInvoke('timelog_listener_error').then((msg) => {
      if (msg) reportCaptureError('Screen/keyboard/mouse activity capture could not start: ' + msg);
    }).catch(() => {});
  }, 1500);
}

export async function clockIn(uid) {
  if (state) return state.timeEntryId;
  const timeEntryId = 'te_' + randomId().slice(0, 10);
  const now = new Date().toISOString();
  await db.doc('timeEntries/' + timeEntryId).set({ userId: uid, clockInAt: now, clockOutAt: null, lastHeartbeatAt: now, autoClosedReason: null });
  state = { uid, timeEntryId, windowStart: new Date().toISOString() };
  warnedThisSession = false;
  scheduleScreenshot();
  scheduleActivityFlush();
  scheduleHeartbeat();
  try {
    await tauriInvoke('timelog_start');
    checkListenerError();
  } catch (e) {
    // Only warn for a REAL failure inside the desktop app - not for the
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

// A page reload wipes this module's in-memory `state` - before this fix,
// that silently stopped all further screenshots/activity flushes even
// though the actual clock-in row (and, in practice, the still-running Rust
// process) never really stopped, so the UI showing "Clock in" again after a
// reload was flat-out wrong. Call this once at boot (after the signed-in
// user's uid is known) to reconnect to whatever's genuinely still open in
// the database, instead of treating a reload as an implicit clock-out.
export async function resumeIfClockedIn(uid) {
  if (state) return; // already tracking this session (e.g. clockIn() already ran)
  let open;
  try {
    const snap = await db.collection('timeEntries').where('userId', '==', uid).orderBy('clockInAt', 'desc').limit(5).get();
    open = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())).find((e) => !e.clockOutAt);
  } catch (e) { return; }
  if (!open) return;

  // The session that owned this row may not be the one running right now -
  // if its heartbeat has gone stale far longer than any real interruption
  // would explain, whatever process had it open is gone (force-killed,
  // crashed, or the machine was off) and it should be closed out at the
  // last moment it's actually known to have still been running, not
  // silently resumed as if nothing happened. See schema_v6.sql for the
  // full design (this is the "catch it on next launch" half).
  const lastSeen = open.lastHeartbeatAt || open.clockInAt;
  const staleMs = Date.now() - new Date(lastSeen).getTime();
  if (staleMs > ABANDONED_AFTER_MS) {
    await db.doc('timeEntries/' + open.id).update({ clockOutAt: lastSeen, autoClosedReason: 'stale_heartbeat' }).catch(() => {});
    if (onSessionAutoClosed) {
      try { onSessionAutoClosed(lastSeen); } catch (e) {}
    }
    return; // don't resume it - the caller's own isClockedIn() check will show the normal "ready to start your day?" prompt
  }

  state = { uid, timeEntryId: open.id, windowStart: new Date().toISOString() };
  warnedThisSession = false;
  scheduleScreenshot();
  scheduleActivityFlush();
  scheduleHeartbeat();
  try {
    // Safe to call again even if the native hook is already running -
    // timelog_start() only resets the activity buffer the first time
    // (see src-tauri/src/timelog.rs), so resuming after a reload doesn't
    // throw away whatever was already collected in the current window.
    await tauriInvoke('timelog_start');
    checkListenerError();
  } catch (e) {
    if (e && e.message !== 'Not running inside the Blue Kite Ops desktop app') {
      reportCaptureError('Time tracking resumed, but screen/activity capture could not restart: ' + (e.message || e));
    }
  }
}

export async function clockOut() {
  if (!state) return;
  const s = state; state = null;
  if (s.screenshotTimer) clearTimeout(s.screenshotTimer);
  if (s.activityTimer) clearTimeout(s.activityTimer);
  if (s.heartbeatTimer) clearTimeout(s.heartbeatTimer);
  await flushActivity(s).catch(() => {});
  await db.doc('timeEntries/' + s.timeEntryId).update({ clockOutAt: new Date().toISOString() });
  try { await tauriInvoke('timelog_stop'); } catch (e) {}
}

// Keeps lastHeartbeatAt fresh while genuinely clocked in and running - this
// is the one signal that lets a LATER session (or the server-side sweep)
// tell "still open, actually still running" apart from "still open because
// nothing ever closed it out." Deliberately its own timer, independent of
// the 5-minute activity flush, so the staleness threshold above can stay
// short without being tied to that unrelated schedule.
function scheduleHeartbeat() {
  if (!state) return;
  const s = state;
  s.heartbeatTimer = setTimeout(async () => {
    if (state !== s) return;
    await db.doc('timeEntries/' + s.timeEntryId).update({ lastHeartbeatAt: new Date().toISOString() }).catch(() => {});
    scheduleHeartbeat();
  }, HEARTBEAT_MS);
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
  if (onScreenshotTaken) { try { onScreenshotTaken(); } catch (e) {} }
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
// Viewing - an employee's own history, or (for a Manager/Admin) a
// teammate's. RLS enforces who's actually allowed to see what; this just
// runs the query.
// ---------------------------------------------------------------------------
export async function listScreenshots(userId, limitN) {
  const snap = await db.collection('screenshots').where('userId', '==', userId).orderBy('takenAt', 'desc').limit(limitN || 60).get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

// Screenshots for one specific clock-in session, oldest first - used by the
// TimeLog page's per-session view (see main.js's renderTimeLog) so a
// session's screenshots sit directly under that session's clock-in/clock-out
// summary instead of one long flat "recent screenshots" grid with no sense
// of which work day or shift any of them belonged to.
export async function listScreenshotsForEntry(timeEntryId, limitN) {
  const snap = await db.collection('screenshots').where('timeEntryId', '==', timeEntryId).orderBy('takenAt', 'asc').limit(limitN || 60).get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

export async function listTimeEntries(userId, limitN) {
  const snap = await db.collection('timeEntries').where('userId', '==', userId).orderBy('clockInAt', 'desc').limit(limitN || 30).get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

// All activity windows recorded during one clock-in - used to find which
// window (if any) overlaps a given screenshot's takenAt, for the "click a
// screenshot, see the activity around it" view in main.js.
export async function listActivityForEntry(timeEntryId) {
  const snap = await db.collection('activitySamples').where('timeEntryId', '==', timeEntryId).orderBy('windowStart', 'asc').get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}
