// In-app music player - streams straight out of Humayun's own Google Drive
// library via the worker-drive-music Cloudflare Worker (2026-09-29),
// replacing the earlier YouTube-embed version entirely. Real <audio>
// playback now, not a video iframe - which also incidentally fixes the
// "the embed never even showed up for employees, only worked for me"
// report from the YouTube version (no more third-party embed/account/
// region quirks - it's just an audio file being streamed).
//
// Mood selection (2026-09-29 redesign): any mood is selectable at any
// time, not just whatever was picked at signup - that restriction was the
// direct cause of "I can only choose Electronic or Mixed" (whoever only
// picked one mood at signup only ever saw that one mood as a real choice).
// Signup's picks are now only used to choose which mood plays first when
// the player mounts; every mood is always in the dropdown after that.
// "Mixed" shuffles across every mood combined, not just the signup picks.
import { supabase } from './supabaseClient.js';

const WORKER_URL = import.meta.env.VITE_DRIVE_MUSIC_WORKER_URL;
export const musicConfigured = !!WORKER_URL;

// Same catalog Humayun's Drive folders are asked to use, one folder per
// key (see worker-drive-music's own header comment) - labels here are
// purely for display, matching the original YouTube-era catalog's wording.
const MOOD_LABELS = {
  nature: 'Nature/Ambient Sounds',
  film: 'Film Music',
  lofi: 'Lo-fi Music',
  western_classical: 'Western Classical Music',
  eastern_classical: 'Eastern Classical Music',
  electronic: 'Electronic (Chillstep, Future Garage, Synthwave)',
  high_bpm: 'High-BPM Instrumental Rock or Pop',
  color_noise: 'Color Noise (White, Pink, Brown)',
};
const MOOD_KEYS = Object.keys(MOOD_LABELS);

// Still exported under the same name/shape the signup mood-picker (Phase 4)
// already renders from - unchanged there, only what happens AFTER signup
// changed.
export const MOODS = MOOD_KEYS.map((key) => ({ key, label: MOOD_LABELS[key] }))
  .concat([{ key: 'none', label: "I'd rather not" }]);

// ---------------------------------------------------------------------------
// Worker calls
// ---------------------------------------------------------------------------
async function authedGet(path) {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session && data.session.access_token;
  const res = await fetch(WORKER_URL.replace(/\/$/, '') + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  if (!res.ok) throw new Error('Music request failed (' + res.status + ')');
  return res.json();
}

// Per-mood track list cache (10 min - folder contents basically never
// change minute to minute, no reason to re-list on every single track
// change). Keyed by mood key; "Mixed" is built by combining all of these,
// not cached separately.
const tracksCache = {}; // moodKey -> { value, expAtMs }
async function getTracks(moodKey) {
  const now = Date.now();
  const cached = tracksCache[moodKey];
  if (cached && cached.expAtMs > now) return cached.value;
  const tracks = await authedGet('/tracks?mood=' + encodeURIComponent(moodKey));
  tracksCache[moodKey] = { value: tracks, expAtMs: now + 10 * 60 * 1000 };
  return tracks;
}

function warnAndEmpty(moodKey, err) {
  // Was a silent `.catch(() => [])` - indistinguishable from a genuinely
  // empty mood folder, which made "no tracks" impossible to diagnose from
  // the browser console. A real failure (auth, Drive API, network) now at
  // least surfaces here, even though the UI still just shows "no tracks"
  // (a mood-select dropdown isn't the place for a raw error message).
  console.warn('[blue-kite-ops] could not load tracks for mood "'+moodKey+'":', err);
  return [];
}
async function poolFor(moodKey) {
  if (!moodKey) {
    const lists = await Promise.all(MOOD_KEYS.map((m) => getTracks(m).catch((err) => warnAndEmpty(m, err))));
    return lists.reduce((acc, list) => acc.concat(list), []);
  }
  return getTracks(moodKey).catch((err) => warnAndEmpty(moodKey, err));
}

function trackUrl(fileId) {
  return WORKER_URL.replace(/\/$/, '') + '/stream/' + encodeURIComponent(fileId);
}

// ---------------------------------------------------------------------------
// Playback state
// ---------------------------------------------------------------------------
let audioEl = null;
let currentMoodFilter = null; // null = Mixed (every mood combined); otherwise one mood key
let currentTrack = null; // { id, name, size }
let listeners = new Set();

function notify() { listeners.forEach((cb) => { try { cb(state()); } catch (e) {} }); }

function state() {
  let playing = false, muted = false, volume = 70;
  if (audioEl) {
    playing = !audioEl.paused && !audioEl.ended;
    muted = !!audioEl.muted;
    volume = Math.round(audioEl.volume * 100);
  }
  return {
    moodFilter: currentMoodFilter,
    moodLabel: currentMoodFilter ? (MOOD_LABELS[currentMoodFilter] || currentMoodFilter) : 'Mixed shuffle',
    hasTracks: !!currentTrack,
    track: currentTrack ? { title: currentTrack.name.replace(/\.[a-zA-Z0-9]{2,5}$/, '') } : null,
    playing, muted, volume,
  };
}

async function loadRandom(autoplay) {
  try {
    const items = await poolFor(currentMoodFilter);
    if (!items.length) { currentTrack = null; notify(); return; }
    let choice = items[Math.floor(Math.random() * items.length)];
    let guard = 0;
    while (items.length > 1 && currentTrack && choice.id === currentTrack.id && guard < 8) {
      choice = items[Math.floor(Math.random() * items.length)];
      guard++;
    }
    currentTrack = choice;
    if (audioEl) {
      audioEl.src = trackUrl(choice.id);
      if (autoplay) audioEl.play().catch(() => {});
    }
    notify();
  } catch (e) {
    console.warn('[music] could not load a track:', e);
    currentTrack = null;
    notify();
  }
}

// Browsers still require a real user gesture before allowing audio to
// start - the very first click or keypress anywhere in the app after the
// player mounts plays it, so nobody has to hunt for a play button first.
let autoplayArmed = false;
function armAutoplayOnFirstGesture() {
  if (autoplayArmed) return;
  autoplayArmed = true;
  const handler = () => {
    document.removeEventListener('click', handler, true);
    document.removeEventListener('keydown', handler, true);
    if (audioEl) audioEl.play().catch(() => {});
  };
  document.addEventListener('click', handler, true);
  document.addEventListener('keydown', handler, true);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function initPlayer(_mountElId, signupMoods) {
  if (!WORKER_URL) { notify(); return; }
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.volume = 0.7;
    audioEl.addEventListener('ended', () => loadRandom(true));
    audioEl.addEventListener('play', notify);
    audioEl.addEventListener('pause', notify);
    audioEl.addEventListener('volumechange', notify);
  } else {
    return; // already initialized this session
  }
  // Whatever this person picked at signup just chooses what plays FIRST -
  // every mood (plus Mixed) is a real choice from here on, see the header
  // comment above for why that changed.
  const preferred = (signupMoods || []).filter((m) => MOOD_LABELS[m])[0];
  currentMoodFilter = preferred || null;
  armAutoplayOnFirstGesture();
  loadRandom(false);
}

export function onPlayerChange(cb) { listeners.add(cb); cb(state()); return () => listeners.delete(cb); }

export function setFilter(moodKey) {
  const next = moodKey && MOOD_LABELS[moodKey] ? moodKey : null;
  const wasPlaying = state().playing;
  currentMoodFilter = next;
  currentTrack = null;
  loadRandom(wasPlaying);
}

export function play() { if (audioEl) audioEl.play().catch(() => {}); }
export function pause() { if (audioEl) audioEl.pause(); }
export function toggle() { if (state().playing) pause(); else play(); }
export function next() { loadRandom(true); }

export function mute() { if (audioEl) { audioEl.muted = true; notify(); } }
export function unmute() { if (audioEl) { audioEl.muted = false; notify(); } }
export function toggleMute() { if (state().muted) unmute(); else mute(); }
export function setVolume(v) {
  if (!audioEl) return;
  const vol = Math.max(0, Math.min(100, Math.round(v)));
  audioEl.volume = vol / 100;
  if (vol > 0 && audioEl.muted) unmute();
  notify();
}
