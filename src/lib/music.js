// In-app music player, keyed off the mood/genre an employee picked at
// signup (profiles.musicMood). Built on the YouTube IFrame Player API,
// playing from the curated links Humayun sent per mood (CATALOG below) -
// this replaces an earlier self-hosted-<audio> draft, since real YouTube
// links per category is the direction actually chosen.
//
// Two YouTube-specific things worth knowing before touching this file:
//
//   1. YouTube's Required Minimum Functionality policy requires an embedded
//      player to stay visible (roughly 200x200px or larger) while it's
//      playing - unlike a plain <audio> tag, this can't be fully hidden.
//      The player widget in main.js keeps a small always-visible video
//      frame for exactly this reason. It's deliberately compact (not
//      hidden), which keeps the embed compliant without taking over the
//      sidebar.
//   2. "Shuffle" here means picking a random entry from the mood's own
//      curated list below - the IFrame API has no supported way to force
//      real shuffle on an embedded playlist. Two entries below (Film Music,
//      and one High-BPM entry) are a whole curated YouTube playlist rather
//      than single videos, per Humayun's "add this entire playlist" notes;
//      for those, "change track" advances through that playlist in
//      YouTube's own order (player.nextVideo()) instead of jumping
//      elsewhere in the category, since there's no reliable way to shuffle
//      inside someone else's playlist from the API. Everything else in a
//      category is a flat list of individual videos, and "change track" /
//      auto-advance-on-end pick a new random one from that list.
//
// No YouTube Data API key needed anywhere here - track titles come from
// the embedded player itself (player.getVideoData()), which is free and
// needs no server-side credential.

// ---------------------------------------------------------------------------
// Catalog - Humayun's Sep 21 2026 list, one entry per mood. `id` is a plain
// 11-char YouTube video id for a `video` entry, or a playlist id (the
// `list=` param) for a `playlist` entry. Radio-mix params some of the
// pasted links carried (`&list=RD...&start_radio=1`) are intentionally
// dropped - those are YouTube's own "start an auto mix from this video"
// convenience for a human browsing youtube.com, not something the IFrame
// API can reliably reproduce for an embedded viewer, and Humayun's pasted
// video itself is already the point of that link.
// ---------------------------------------------------------------------------
const CATALOG = {
  nature: {
    label: 'Nature/Ambient Sounds',
    items: [
      { type: 'video', id: 'xNN7iTA57jM' },
      { type: 'video', id: '29XymHesxa0' },
      { type: 'video', id: 'mPZkdNFkNps' },
    ],
  },
  film: {
    label: 'Film Music (Interstellar, Oppenheimer, etc.)',
    items: [
      { type: 'playlist', id: 'PLXEg1KA5o1XlTxYy2_rX72MiQcsJzqdHi' },
    ],
  },
  lofi: {
    label: 'Lo-fi Music',
    items: [
      { type: 'video', id: 'n61ULEU7CO0' },
      { type: 'video', id: 'Q89Dzox4jAE' },
    ],
  },
  western_classical: {
    label: 'Western Classical Music (Mozart, Beethoven, etc.)',
    items: [
      { type: 'video', id: 'Hlp6aawXVoY' },
      { type: 'video', id: '0UN_HbOTTcI' },
      { type: 'video', id: 'mdJU5ogrPMY' },
      { type: 'video', id: 'SllpB3W5f6s' },
    ],
  },
  eastern_classical: {
    label: 'Eastern Classical Music (Sitar, Oud, etc.)',
    items: [
      { type: 'video', id: 'Ef0tk0q-ITo' },
      { type: 'video', id: '3Zmk5G6h-qo' },
      { type: 'video', id: 'PVGFHGLRjK4' },
      { type: 'video', id: '-u8YnZlqY2A' },
      { type: 'video', id: 'ZLG-0jbSnEU' },
    ],
  },
  electronic: {
    label: 'Electronic (Chillstep, Future Garage, Synthwave)',
    items: [
      { type: 'video', id: 'wELOA2U7FPQ' },
      { type: 'video', id: 'RU1uAAff024' },
      { type: 'video', id: '_ZFtRmMuZ24' },
      { type: 'video', id: 'am1VJP0RnmQ' },
      { type: 'video', id: 'e1w7R1hEvCs' },
      { type: 'video', id: 'T2QZpy07j4s' },
      { type: 'video', id: 'Hs5C8x6Z6VQ' },
      { type: 'video', id: 'fhL67fnDXcU' },
      { type: 'video', id: 'QBEvosdra48' },
    ],
  },
  high_bpm: {
    label: 'High-BPM Instrumental Rock or Pop',
    items: [
      { type: 'video', id: 'dI47HRTjSFU' },
      { type: 'playlist', id: 'PLKUA473MWUv2jmkqIxzQR3YL4kuPArj4G' },
    ],
  },
  color_noise: {
    label: 'Color Noise (White, Pink, Brown)',
    items: [
      { type: 'video', id: '0GDfOAuUvQ0' },
      { type: 'video', id: 'bIjlfqPDTjY' },
      { type: 'video', id: 'yLOM8R6lbzg' },
    ],
  },
};

export const MOODS = Object.keys(CATALOG).map((key) => ({ key, label: CATALOG[key].label }))
  .concat([{ key: 'none', label: "I'd rather not" }]);

// ---------------------------------------------------------------------------
// YouTube IFrame API loader - injects the script once, resolves once the
// global YT.Player constructor exists.
// ---------------------------------------------------------------------------
let ytApiPromise = null;
function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(window.YT); return; }
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      if (typeof prevReady === 'function') prevReady();
      resolve(window.YT);
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  });
  return ytApiPromise;
}

let player = null;
let currentMood = null;
let currentItem = null;
let listeners = new Set();
let pollTimer = null;

function pool() { return (CATALOG[currentMood] && CATALOG[currentMood].items) || []; }

function pickRandom(excludeItem) {
  const items = pool();
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  let choice = items[Math.floor(Math.random() * items.length)];
  let guard = 0;
  while (excludeItem && choice.type === excludeItem.type && choice.id === excludeItem.id && guard < 8) {
    choice = items[Math.floor(Math.random() * items.length)];
    guard++;
  }
  return choice;
}

function notify() { listeners.forEach((cb) => { try { cb(state()); } catch (e) {} }); }

function state() {
  const items = pool();
  let title = '';
  if (player && typeof player.getVideoData === 'function') {
    try { title = (player.getVideoData() || {}).title || ''; } catch (e) {}
  }
  let playing = false, muted = false, volume = 70;
  if (player) {
    try { playing = player.getPlayerState && player.getPlayerState() === 1; } catch (e) {}
    try { muted = !!(player.isMuted && player.isMuted()); } catch (e) {}
    try { volume = player.getVolume ? player.getVolume() : 70; } catch (e) {}
  }
  return {
    mood: currentMood,
    moodLabel: (CATALOG[currentMood] || {}).label || '',
    hasTracks: items.length > 0,
    track: title ? { title } : null,
    isPlaylist: !!(currentItem && currentItem.type === 'playlist'),
    playing, muted, volume,
  };
}

function loadItem(item, autoplay) {
  if (!player || !item) return;
  currentItem = item;
  if (item.type === 'playlist') {
    if (autoplay) player.loadPlaylist({ listType: 'playlist', list: item.id });
    else player.cuePlaylist({ listType: 'playlist', list: item.id });
  } else {
    if (autoplay) player.loadVideoById(item.id);
    else player.cueVideoById(item.id);
  }
  notify();
}

function startPolling() {
  if (pollTimer) return;
  // Only used to catch title metadata arriving a beat after cue/load, and
  // to keep the "playing" indicator honest if something external pauses
  // the underlying <iframe> - cheap and local, no network calls of its own.
  pollTimer = setInterval(notify, 2000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function initPlayer(mountElId, mood) {
  currentMood = mood && CATALOG[mood] ? mood : null;
  if (!currentMood) { notify(); return; }
  loadYouTubeApi().then((YT) => {
    if (player) { loadItem(pickRandom(), false); return; }
    player = new YT.Player(mountElId, {
      height: '100%',
      width: '100%',
      playerVars: { autoplay: 0, controls: 0, modestbranding: 1, rel: 0, iv_load_policy: 3, fs: 0, disablekb: 1 },
      events: {
        onReady: function () {
          player.setVolume(70);
          loadItem(pickRandom(), false);
          startPolling();
        },
        onStateChange: function (e) {
          // 0 = ended. A single video has nothing to continue into; a
          // playlist item reaching this point has run itself out too
          // (YouTube advances through a playlist's own tracks internally
          // without an ENDED in between) - either way, move on.
          if (e.data === 0) next();
          else notify();
        },
      },
    });
  });
}

export function onPlayerChange(cb) { listeners.add(cb); cb(state()); return () => listeners.delete(cb); }

export function setMood(mood) {
  if (!CATALOG[mood]) return;
  const wasPlaying = state().playing;
  currentMood = mood;
  loadItem(pickRandom(), wasPlaying);
}

export function play() { if (player && player.playVideo) player.playVideo(); }
export function pause() { if (player && player.pauseVideo) player.pauseVideo(); }
export function toggle() { if (state().playing) pause(); else play(); }

// "Change the piece of music within the category": for a lone curated
// playlist entry, step to its next track (YouTube's own order); for a
// standalone video, jump to a new random pick from the category.
export function next() {
  if (!currentMood) return;
  if (currentItem && currentItem.type === 'playlist' && player && player.nextVideo) {
    player.nextVideo();
    notify();
    return;
  }
  loadItem(pickRandom(currentItem), true);
}

export function mute() { if (player && player.mute) { player.mute(); notify(); } }
export function unmute() { if (player && player.unMute) { player.unMute(); notify(); } }
export function toggleMute() { if (state().muted) unmute(); else mute(); }
export function setVolume(v) {
  if (!player || !player.setVolume) return;
  const vol = Math.max(0, Math.min(100, Math.round(v)));
  player.setVolume(vol);
  if (vol > 0 && state().muted) unmute();
  notify();
}
