// "Meetings" - video calls with screen share and host-side local recording.
// Deliberately a separate feature from "Connect" (src/lib/connect.js, audio-
// only huddles) - built the same way (Supabase Realtime for signaling,
// Cloudflare Realtime SFU for media) but with its own Worker
// (worker-meetings/) and its own code end to end, so nothing here can ever
// regress Connect. See worker-meetings/wrangler.toml for why a separate
// Worker instead of extending worker-realtime.
//
// Two kinds of Cloudflare Realtime "session" per person in a meeting:
//   - main session: mic + camera, created once on joining.
//   - screen session: a screen-share video (+ system audio if the browser
//     grants it) - created only while actively sharing, torn down when
//     sharing stops. Modeled as a fully separate RTCPeerConnection/session
//     rather than a track added to the main session, which avoids the
//     renegotiation complexity of adding a track mid-session on the
//     PUBLISHING side (receiving an added remote track already needs
//     renegotiation handling regardless - see pullRemoteTrack below, the
//     same logic Connect already uses and has verified).
//
// Signaling: everyone in a meeting tracks their own presence (uid, name,
// mic/camera session id, screen session id if sharing, mute/camera-off
// state, and whether the HOST is currently recording) on one Supabase
// Realtime channel named after the meeting id - same core mechanism as
// Connect's call rooms (src/lib/connect.js's joinCallRoom), reimplemented
// here rather than imported so the two features share no runtime state at
// all.
import { supabase } from './supabaseClient.js';

const MEETINGS_WORKER_URL = import.meta.env.VITE_MEETINGS_WORKER_URL || '';
export const meetingsConfigured = /^https?:\/\//i.test(MEETINGS_WORKER_URL);

// Mic processing preferences (Round 39) - "Echo cancellation" and "Noise
// suppression & auto volume" switches, both ON by default (Discord-style;
// Zoom's equivalent is "Original sound"). A per-computer choice (depends on
// whether THIS machine uses headphones), so localStorage, same as music.js.
const MIC_PROCESSING_KEY = 'bko_micProcessing';
export function getMicProcessing() {
  try {
    const v = JSON.parse(localStorage.getItem(MIC_PROCESSING_KEY) || 'null');
    if (v && typeof v.echoCancellation === 'boolean' && typeof v.noiseSuppression === 'boolean') return v;
  } catch (e) {}
  return { echoCancellation: true, noiseSuppression: true };
}
export function setMicProcessing(p) {
  try { localStorage.setItem(MIC_PROCESSING_KEY, JSON.stringify({ echoCancellation: !!p.echoCancellation, noiseSuppression: !!p.noiseSuppression })); } catch (e) {}
}
function micConstraints(micId) {
  const p = getMicProcessing();
  const c = { echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.noiseSuppression };
  if (micId) c.deviceId = { exact: micId };
  return c;
}

export function newMeetingId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // Extremely unlikely fallback path (only if crypto.randomUUID is somehow
  // unavailable) - still needs to be hard to guess since a meeting id
  // doubles as its signaling room name.
  return Date.now().toString(16) + '-' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

// ---------------------------------------------------------------------------
// Signaling: the meeting room (Presence-based, mirrors Connect's call room)
// ---------------------------------------------------------------------------
// handlers:
//   onTrack(meta, sessionId, trackName) - a track we don't have yet from an
//     already-there-or-just-joined participant. Return a Promise (from
//     pullRemoteTrack) - calls are queued and awaited one at a time so
//     concurrent renegotiations on the same RTCPeerConnection never race.
//   onMeta(uid, meta) - full metadata refresh for a participant (mute
//     state, screen-share on/off, recording flag) - fires on every
//     sync/update, use it to redraw mute icons etc. even when no new track
//     needs pulling.
//   onLeft(uid) - a participant left the room entirely.
export function joinMeetingRoom(meetingId, myProfile, initialMeta, handlers) {
  var pulled = {};   // uid+':'+trackName -> true, so a re-fired sync doesn't double-pull
  var pullChain = Promise.resolve();
  var topic = 'meeting_room:' + meetingId;
  var myMeta = Object.assign({ uid: myProfile.id, name: myProfile.name || '' }, initialMeta || {});
  var room = null;
  var leftBeforeReady = false;
  var reconnectAttempt = 0; // presence-channel error/timeout/close recovery - see wireAndSubscribe's .subscribe() callback

  function pullableTracksFor(meta) {
    var list = [];
    if (meta.sessionId) {
      list.push({ sessionId: meta.sessionId, trackName: 'mic' });
      list.push({ sessionId: meta.sessionId, trackName: 'camera' });
    }
    if (meta.screenSessionId) {
      list.push({ sessionId: meta.screenSessionId, trackName: 'screen' });
      list.push({ sessionId: meta.screenSessionId, trackName: 'screenAudio' });
    }
    return list;
  }

  function considerMeta(uid, meta) {
    if (!meta) return;
    pullableTracksFor(meta).forEach(function (t) {
      var key = uid + ':' + t.trackName + ':' + t.sessionId;
      if (pulled[key]) return;
      pulled[key] = true;
      pullChain = pullChain.then(function () { return handlers.onTrack(meta, t.sessionId, t.trackName); })
        .catch(function (err) { console.error('Meetings: failed to pull track', uid, t.trackName, err); });
    });
    if (handlers.onMeta) handlers.onMeta(uid, meta);
  }

  function latestMetaFor(uid, state) {
    var metas = state[uid];
    return metas && metas[metas.length - 1];
  }

  function wireAndSubscribe() {
    if (leftBeforeReady) return;
    room = supabase.channel(topic, {
      config: { presence: { key: myProfile.id } },
    });
    room
      .on('presence', { event: 'sync' }, function () {
        var state = room.presenceState();
        Object.keys(state).forEach(function (uid) {
          if (uid === myProfile.id) return;
          considerMeta(uid, latestMetaFor(uid, state));
        });
      })
      .on('presence', { event: 'leave' }, function (payload) {
        // A metadata-only update (updateMeta() re-tracking - toggling mic/
        // camera/starting or stopping screen share) surfaces as a leave+join
        // pair for the SAME key in Phoenix Presence, not just a join -
        // confirmed by reading @supabase/phoenix's Presence.syncDiff: its
        // joins loop runs before its leaves loop, so by the time onLeave
        // fires for a re-track, that key's state already has the NEW meta
        // merged in too, and onLeave's own "delete this key" only happens
        // if metas end up empty - which they don't, for a re-track. Real bug
        // this caused (2026-09-24, "the other user randomly disappeared
        // from the call, but on their own end they were still on the
        // call"): every leave was treated as a real departure, tearing down
        // a still-present participant's tile/audio on every one of their
        // mute/camera/screen-share toggles - and since `sync` sees their
        // track key as already-pulled, it never re-pulls the video/audio to
        // rebuild what onLeft just tore down, leaving an empty, silent tile.
        // payload.currentPresences (what's still there for this key after
        // the diff) is the disambiguator: empty means genuinely gone,
        // non-empty means "still here, just updated."
        var stillPresent = {};
        (payload.currentPresences || []).forEach(function (meta) { if (meta && meta.uid) stillPresent[meta.uid] = true; });
        (payload.leftPresences || []).forEach(function (meta) {
          if (!meta || meta.uid === myProfile.id) return;
          if (stillPresent[meta.uid]) return; // metadata re-track, not a real leave
          // Forget every track key for this session AND their screen
          // session, so if they rejoin (or restart screen share with a new
          // session id) it gets pulled fresh instead of being treated as
          // already-pulled.
          Object.keys(pulled).forEach(function (k) { if (k.indexOf(meta.uid + ':') === 0) delete pulled[k]; });
          if (handlers.onLeft) handlers.onLeft(meta.uid, meta);
        });
      })
      // Host controls (mute-a-participant / remove-a-participant) can't be
      // done TO someone else's device directly - each person's mic/camera is
      // only ever controlled by their own client. This is a plain broadcast
      // "please do X" request; the target's own client (checking
      // payload.targetUid === myProfile.id) is what actually acts on it -
      // see main.js's renderMeetingRoom for the host-side send and the
      // target-side handling.
      .on('broadcast', { event: 'host-control' }, function (msg) {
        if (handlers.onHostControl) handlers.onHostControl(msg.payload || {});
      })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') { reconnectAttempt = 0; room.track(myMeta); return; }
        // Real, confirmed gap (2026-09-25, "screen share went black and
        // restarting sharing/camera didn't fix it for the other person"):
        // this callback only ever handled 'SUBSCRIBED' - if the channel
        // hits 'CHANNEL_ERROR', 'TIMED_OUT', or 'CLOSED' (real Realtime
        // states, e.g. from exactly the kind of long backgrounding + a
        // device change a person switching tabs and plugging in
        // headphones would cause), there was NO recovery at all: that
        // person's OWN presence channel just stayed dead for the rest of
        // the meeting. Since it's THEIR channel that's broken, nothing the
        // sharer does on their end (toggling screen share/camera, which
        // only affects the SHARER's own re-tracked metadata) could ever
        // reach them - matching exactly what was reported. Now tears down
        // and rebuilds the channel on any non-SUBSCRIBED terminal status,
        // with backoff, same rebuild path already used for a stale
        // pre-existing channel above.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (leftBeforeReady) return;
          reconnectAttempt++;
          var delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 10000);
          setTimeout(function () {
            if (leftBeforeReady) return;
            try { supabase.removeChannel(room); } catch (e) {}
            wireAndSubscribe();
          }, delay);
        }
      });
  }

  // A channel for this exact room can still be mid-teardown (removeChannel's
  // unsubscribe is a network round trip) from a just-ended previous join of
  // the SAME meeting - supabase-js's channel(topic) dedupes by topic and
  // hands back that still-subscribed instance instead of a fresh one, and
  // calling .on() on an already-subscribed channel throws ("cannot add
  // `presence` callbacks ... after `subscribe()`", seen live 2026-09-24 when
  // a meeting ended and reopened in quick succession). Explicitly removing
  // any stale instance and waiting for that to finish before wiring the new
  // one guarantees a genuinely fresh channel every time.
  var stale = supabase.getChannels().filter(function (c) { return c.topic === 'realtime:' + topic; });
  if (stale.length) {
    Promise.all(stale.map(function (c) { return supabase.removeChannel(c).catch(function () {}); })).then(wireAndSubscribe);
  } else {
    wireAndSubscribe();
  }

  return {
    // Merge new fields into this person's own tracked metadata (e.g.
    // "I just muted", "I just started sharing my screen") - re-tracking is
    // what actually broadcasts the change to everyone else's `sync`.
    updateMeta: function (patch) {
      myMeta = Object.assign({}, myMeta, patch);
      if (room) { try { room.track(myMeta); } catch (e) {} }
    },
    myMeta: function () { return myMeta; },
    sendHostControl: function (action, targetUid) {
      if (room) { try { room.send({ type: 'broadcast', event: 'host-control', payload: { action: action, targetUid: targetUid, from: myProfile.id } }); } catch (e) {} }
    },
    leave: function () {
      leftBeforeReady = true;
      if (room) { try { room.untrack(); } catch (e) {} try { supabase.removeChannel(room); } catch (e) {} }
    },
  };
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------
async function authedFetch(path, opts) {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session && data.session.access_token;
  const url = MEETINGS_WORKER_URL.replace(/\/$/, '') + path;
  try {
    return await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}),
    }));
  } catch (err) {
    throw new Error('Could not reach the Meetings server at ' + url + ' - ' + (err && err.message ? err.message : 'the request failed') + '. Try opening ' + MEETINGS_WORKER_URL.replace(/\/$/, '') + '/health in a browser to check it\'s deployed and reachable.');
  }
}

async function parseJsonResponse(res, what) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const preview = (await res.text().catch(() => '')).slice(0, 120);
    throw new Error(
      'Meetings worker did not return ' + what + ' (got ' + (res.status) + ', ' + (contentType || 'no content-type') + ')'
      + (preview ? ' - response started with: ' + preview.replace(/\s+/g, ' ') : '')
      + '. Check VITE_MEETINGS_WORKER_URL points at the deployed worker-meetings, not something else.'
    );
  }
  return res.json();
}

async function describeWorkerError(res) {
  try {
    const errBody = await res.json();
    const parts = [errBody && errBody.error, errBody && errBody.detail].filter(Boolean);
    return parts.length ? ' - ' + parts.join(': ') : '';
  } catch (e) {
    return '';
  }
}

// Turns a just-negotiated local offer + the tracks just added onto it into
// the {mid, trackName} pairs the worker needs - `mid` is only reliably
// populated on each transceiver once setLocalDescription has run.
function describeLocalTracks(pc, trackMetaBySender) {
  return pc.getTransceivers().map(function (tr) {
    var meta = trackMetaBySender.get(tr.sender);
    return meta ? { mid: tr.mid, trackName: meta } : null;
  }).filter(Boolean);
}

async function publishSession(stream, trackNameFor) {
  if (!meetingsConfigured) throw new Error('Meetings is not configured yet - see README.md (needs the Meetings Worker deployed, same Cloudflare Realtime credentials Connect already uses).');
  const pc = new RTCPeerConnection();
  const trackMetaBySender = new Map();
  stream.getTracks().forEach((t) => {
    const sender = pc.addTrack(t, stream);
    trackMetaBySender.set(sender, trackNameFor(t));
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const tracks = describeLocalTracks(pc, trackMetaBySender);
  const res = await authedFetch('/session/new', { method: 'POST', body: JSON.stringify({ offer: pc.localDescription, tracks }) });
  if (!res.ok) {
    const detail = res.status === 404
      ? ' - the request reached ' + MEETINGS_WORKER_URL.replace(/\/$/, '') + '/session/new but got a 404. Check VITE_MEETINGS_WORKER_URL has no extra path or typo, and that worker-meetings has been deployed (`cd worker-meetings && npx wrangler deploy`).'
      : await describeWorkerError(res);
    throw new Error('Could not start Meetings session (' + res.status + ')' + detail);
  }
  const body = await parseJsonResponse(res, 'a new session');
  await pc.setRemoteDescription(body.answer);
  return { sessionId: body.sessionId, pc, stream };
}

// Lists real device labels/ids for a camera/mic picker in Settings -
// labels only come through once permission's already been granted once
// (browsers hide them otherwise), which is always true by the time this
// gets called from the meeting room (camera/mic already granted to join).
export async function listMediaDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: devices.filter((d) => d.kind === 'videoinput'),
    mics: devices.filter((d) => d.kind === 'audioinput'),
    // Output devices (Round 39) - only usable where HTMLMediaElement.setSinkId
    // exists (Chromium/WebView2 yes; re-check for the macOS/WebKit build).
    speakers: devices.filter((d) => d.kind === 'audiooutput'),
  };
}

// Camera + mic acquired as TWO SEPARATE getUserMedia() calls, not one
// combined {audio, video} call - found this the hard way (2026-09-30,
// Humayun: "mic muting reloads the screen, making the video go away").
// On some Windows webcam/driver combinations, a single combined stream
// shares one underlying capture pipeline for both devices - toggling
// `track.enabled` on the audio track can visibly glitch the video track
// riding the same pipeline. Two independent getUserMedia() calls give
// each device its own pipeline, and combining their tracks into one
// MediaStream afterward for WebRTC purposes works exactly the same as if
// they'd come from one call - RTCPeerConnection doesn't care. This also
// means camera/mic can now be swapped independently later (see
// switchDevice) without tearing down the other one.
// Resolution/framerate are deliberately capped (not left at the camera's
// native max) - uncapped 1080p+ webcam streams are a big part of why an
// early build felt laggy; 720p/24fps is still sharp for a meeting tile
// and meaningfully lighter on bandwidth/CPU for both ends.
export async function startLocalSession(withCamera, deviceIds) {
  let audioStream = null, videoStream = null;
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(deviceIds && deviceIds.micId),
    });
  } catch (err) {
    throw new Error(describeMediaError(err, 'microphone'));
  }
  if (withCamera !== false) {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: Object.assign(
          { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } },
          (deviceIds && deviceIds.camId) ? { deviceId: { exact: deviceIds.camId } } : {}
        ),
      });
    } catch (err) {
      audioStream.getTracks().forEach((t) => t.stop());
      throw new Error(describeMediaError(err, 'camera'));
    }
  }
  const stream = new MediaStream([...audioStream.getTracks(), ...(videoStream ? videoStream.getTracks() : [])]);
  return publishSession(stream, (t) => (t.kind === 'video' ? 'camera' : 'mic'));
}

// Swaps just the camera or just the mic on an already-connected session,
// via replaceTrack() - this is the whole point of doing it this way
// instead of ending the session and rejoining: replaceTrack swaps the
// outgoing media on an existing, already-negotiated RTCPeerConnection
// with NO renegotiation at all, so switching devices mid-meeting doesn't
// even briefly interrupt the connection to everyone else.
export async function switchDevice(session, kind, deviceId) {
  const constraints = kind === 'camera'
    ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } } }
    : { audio: micConstraints(deviceId) };
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    throw new Error(describeMediaError(err, kind === 'camera' ? 'camera' : 'microphone'));
  }
  const newTrack = kind === 'camera' ? newStream.getVideoTracks()[0] : newStream.getAudioTracks()[0];
  const oldTrack = kind === 'camera' ? session.stream.getVideoTracks()[0] : session.stream.getAudioTracks()[0];
  // Round 39, real privacy bug: a brand-new track is always enabled, so a
  // MUTED person who switched mic (or toggled echo cancellation) went live
  // without knowing - same for camera-off. Carry the old on/off state over.
  newTrack.enabled = oldTrack ? oldTrack.enabled : true;
  const sender = session.pc.getSenders().find((s) => s.track && s.track.kind === newTrack.kind);
  if (sender) await sender.replaceTrack(newTrack);
  if (oldTrack) { session.stream.removeTrack(oldTrack); oldTrack.stop(); }
  session.stream.addTrack(newTrack);
  return newTrack;
}

// Borrowed from Cloudflare's own reference implementation for this same
// SFU (github.com/cloudflare/orange, via its partytracks library -
// resilientTrack$.ts) at Humayun's request after he pointed us at it. A
// camera/mic track can go stale while this window sits backgrounded for a
// while (device reclaimed by the OS, driver hiccup, etc.) with no event
// firing to tell the app - the tab/window only finds out once it's back in
// the foreground. Cloudflare's own client re-checks track health exactly
// on that visibilitychange and silently reacquires the SAME device if it's
// gone bad, rather than leaving the person mid-meeting with a frozen tile
// and no idea why. Same idea here, scaled to this app's simpler needs (one
// device, not a full priority-ordered device list).
function isTrackHealthy(track) {
  return !!track && track.readyState === 'live' && !track.muted;
}
export function startDeviceHealthWatch(session, onReacquired, onFailure) {
  var checking = false;
  function handler() {
    if (document.visibilityState !== 'visible' || checking || !session || !session.pc) return;
    checking = true;
    Promise.resolve().then(async () => {
      for (const kind of ['camera', 'mic']) {
        const track = kind === 'camera' ? session.stream.getVideoTracks()[0] : session.stream.getAudioTracks()[0];
        if (!track || isTrackHealthy(track)) continue;
        const deviceId = track.getSettings && track.getSettings().deviceId;
        if (!deviceId) continue;
        try {
          await switchDevice(session, kind, deviceId);
          if (onReacquired) onReacquired(kind);
        } catch (err) {
          if (onFailure) onFailure(kind, err);
        }
      }
    }).finally(() => { checking = false; });
  }
  document.addEventListener('visibilitychange', handler);
  return function stop() { document.removeEventListener('visibilitychange', handler); };
}

// Screen/window/tab share, with system audio if the OS/browser offers it
// AND the person ticks that checkbox in the OS's own share picker (not
// every source supports it either - a bare window share commonly has no
// audio track at all, which is normal, not an error).
//
// Shared audio echo (Round 39, see punch list): "Entire Screen + system
// audio" records everything this PC plays. Two things used to loop back
// into it - the other participants' voices played by this app, and the
// sharer's own unmuted preview of the capture (now muted in main.js's
// showScreenShare). restrictOwnAudio (standard constraint, confirmed
// supported by the Chromium 153 WebView2 runtime this app ships on) keeps
// this app's own playback out of the capture. Voice filters (echo
// cancellation / noise suppression / auto gain) are turned OFF here: they
// exist for a voice through a mic and turn music/video sound watery and
// "echoey" - Meet/Zoom send shared audio untouched too. Engines that
// don't know a constraint just ignore it (the future macOS/WebKit build).
export async function startScreenShareSession(opts) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 24 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      },
      // Explicit hint (Chromium-specific getDisplayMedia extension) that
      // system/tab audio should actually be offered in the share picker.
      systemAudio: 'include',
    });
    const shareAudio = stream.getAudioTracks()[0];
    console.log('[meetings] screen share audio:', shareAudio ? { label: shareAudio.label, settings: shareAudio.getSettings() } : 'none (window share, or box unticked)');
  } catch (err) {
    throw new Error(describeMediaError(err, 'screen share'));
  }
  const hadNoAudioTrack = stream.getAudioTracks().length === 0;
  if (opts && opts.hdrCompensate) stream = compensateHdrVideo(stream);
  const session = await publishSession(stream, (t) => (t.kind === 'video' ? 'screen' : 'screenAudio'));
  // Surfaced to the caller (main.js) so it can warn immediately instead of
  // the person only finding out there's no audio much later - real,
  // documented Windows/Chromium limitation: sharing a single Window (not
  // Entire Screen) never offers system audio at all, no error anywhere.
  session.noSystemAudio = hadNoAudioTrack;
  return session;
}

// HDR-display workaround (2026-09-30, Humayun: shared screen "appears
// extremely bright on the other end" when his display is HDR). Being
// upfront about what this actually is: there is no standard web API that
// tells JavaScript whether a display is in HDR mode, or that does real
// HDR-to-SDR tone mapping (which needs to compress bright highlights
// while preserving shadow detail, not just dim everything uniformly) - so
// true automatic detection-and-correction isn't something a web app can
// reliably do today. This is a manual, approximate workaround someone
// turns on themselves when they know their own screen is HDR: it redraws
// the captured video through a canvas with a flat brightness/contrast
// reduction before sending it, which is a blunter tool than real tone
// mapping but does noticeably tame the "blown out" look. It costs a small
// amount of extra CPU (a second render loop) and one extra encode step,
// so it's opt-in rather than always-on.
function compensateHdrVideo(stream) {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) return stream;
  const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
  const width = settings.width || 1920, height = settings.height || 1080;
  // Real bug, confirmed by direct reproduction (a <video> fed by
  // captureStream() via srcObject and never attached to the document never
  // actually starts decoding in this engine - play() just hangs forever,
  // readyState stays 0, videoWidth stays 0 - so every drawImage() below was
  // silently throwing and getting swallowed, leaving the canvas (and thus
  // the whole compensated stream sent to everyone else) solid black. Fixed
  // by actually attaching it to the DOM - off-screen (position:fixed,
  // pushed off the left edge), NOT display:none (browsers withhold
  // rendering from display:none elements too, same underlying problem).
  const videoEl = document.createElement('video');
  videoEl.srcObject = new MediaStream([videoTrack]);
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.style.position = 'fixed';
  videoEl.style.left = '-9999px';
  videoEl.style.top = '0';
  videoEl.style.width = '2px';
  videoEl.style.height = '2px';
  document.body.appendChild(videoEl);
  videoEl.play().catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  // setInterval, not requestAnimationFrame - the person sharing their
  // screen usually isn't looking at THIS window while they do it (that's
  // the whole point of screen share), and Chromium suspends/heavily
  // throttles rAF callbacks once a window's document goes hidden -
  // wouldn't just slow the compensation down, it can stop it outright for
  // as long as the app stays backgrounded, which reads as "still not
  // compensated" from the far end. setInterval keeps running regardless of
  // window visibility.
  let drawTimer = setInterval(() => {
    ctx.filter = 'brightness(0.62) contrast(0.88) saturate(0.92)';
    try { ctx.drawImage(videoEl, 0, 0, width, height); } catch (e) {}
  }, 1000 / 15);
  const processed = canvas.captureStream(15);
  // Second and third real bugs, both from the same cause: the published
  // track is this canvas's own captureStream track, with NO lifecycle tie
  // to the original screen-capture track in EITHER direction.
  //   - Original ends (person clicks the browser/OS's native "Stop
  //     sharing" control) but the canvas track just keeps going, so the
  //     app's own vTrack.onended listener (wired to whichever track ends
  //     up in the returned stream) never fires - "have to click the share
  //     button again to actually stop it."
  //   - Canvas track ends (person clicks the app's OWN stop-sharing
  //     button, which just calls session.stream.getTracks().forEach(stop))
  //     but the ORIGINAL getDisplayMedia track was never included in that
  //     stream, so it just keeps capturing the screen in the background
  //     indefinitely - a real resource leak, and the OS's own "you are
  //     sharing your screen" indicator would never go away either.
  // Wiring both directions closes the loop, with a shared idempotent
  // cleanup so it doesn't matter which side triggers first.
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(drawTimer);
    videoEl.remove();
    videoTrack.stop();
    processed.getVideoTracks().forEach((t) => t.stop());
  }
  videoTrack.addEventListener('ended', cleanup);
  processed.getVideoTracks().forEach((t) => t.addEventListener('ended', cleanup));
  return new MediaStream([...processed.getVideoTracks(), ...stream.getAudioTracks()]);
}

function describeMediaError(err, what) {
  var name = err && err.name;
  if (name === 'NotAllowedError') return 'Permission for ' + what + ' was blocked. Check Windows Settings -> Privacy & security -> ' + (what.indexOf('screen') > -1 ? 'Screen recording' : 'Camera/Microphone') + ', and make sure Blue Kite Ops is allowed there.';
  if (name === 'NotFoundError') return 'No ' + what + ' device was found on this computer.';
  if (name === 'NotReadableError') return 'Could not access ' + what + ' - another app may already be using it.';
  if (name === 'AbortError') return (what.indexOf('screen') > -1 ? 'Screen share was cancelled.' : 'Cancelled.');
  return 'Could not start ' + what + ' - ' + (err && err.message ? err.message : String(err));
}

// Real bug, root-caused by comparing against Cloudflare's own reference
// client for this same SFU (partytracks, via github.com/cloudflare/orange):
// this used to just call setRemoteDescription/renegotiate and return,
// leaving the CALLER (main.js) to figure out which incoming pc.ontrack
// event belonged to which pull by assuming they'd fire in the exact order
// pulls were requested (a FIFO queue, pendingPulls.shift()). That
// assumption is false under real network conditions: pc.ontrack fires once
// SRTP/ICE is actually ready for a track, which is timed independently of
// when the pull's HTTP round-trip resolves - two pulls in quick succession
// (e.g. someone's camera tile PLUS their screen share both need pulling)
// can easily have their ontrack events arrive in a different order than
// requested, silently misassigning a track name and audio/video stream to
// the WRONG participant's tile, or leaving one blank - matching real
// reports of a camera/screen-share appearing blank on the far end and mute
// state taking a long time to visibly update. Cloudflare's own client
// resolves this correctly by matching each pulled track's real `mid`
// (which their /tracks/new response already returns - the worker was
// discarding it, now forwards it) against pc.getTransceivers(), completely
// order-independent. Same fix here: resolve and return the actual
// MediaStreamTrack directly, so the caller never needs pc.ontrack/FIFO
// guessing at all.
function resolveTransceiver(pc, matches, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var existing = pc.getTransceivers().find(matches);
    if (existing && existing.receiver && existing.receiver.track) { resolve(existing.receiver.track); return; }
    var timer = setTimeout(function () {
      pc.removeEventListener('track', handler);
      reject(new Error('Timed out waiting for the pulled track to attach.'));
    }, timeoutMs || 8000);
    function handler() {
      var t = pc.getTransceivers().find(matches);
      if (t && t.receiver && t.receiver.track) {
        clearTimeout(timer);
        pc.removeEventListener('track', handler);
        resolve(t.receiver.track);
      }
    }
    pc.addEventListener('track', handler);
  });
}

// Identical to Connect's own pullRemoteTrack (see src/lib/connect.js for
// the full explanation of the renegotiation handshake) - reimplemented
// here rather than imported, on purpose, so Meetings and Connect share no
// code path at runtime.
async function pullRemoteTrackOnce(localSessionId, remoteSessionId, trackName, pc) {
  const res = await authedFetch('/session/' + localSessionId + '/pull', {
    method: 'POST', body: JSON.stringify({ remoteSessionId, trackName }),
  });
  if (!res.ok) throw new Error('Could not pull "' + trackName + '" (' + res.status + ')' + await describeWorkerError(res));
  const body = await parseJsonResponse(res, 'remote-track details');

  if (body.requiresRenegotiation) {
    await pc.setRemoteDescription(body.answer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const renegRes = await authedFetch('/session/' + localSessionId + '/renegotiate', {
      method: 'POST', body: JSON.stringify({ answer: pc.localDescription }),
    });
    if (!renegRes.ok) throw new Error('Could not complete renegotiation for "' + trackName + '" (' + renegRes.status + ')' + await describeWorkerError(renegRes));
  } else if (body.answer) {
    await pc.setRemoteDescription(body.answer);
  }

  if (body.mid) {
    return resolveTransceiver(pc, function (t) { return t.mid === body.mid; });
  }
  // No mid came back (an older/unpatched worker deploy) - fall back to
  // null and let the caller keep using its own FIFO guess for this one
  // pull, rather than hard-failing a call that used to work.
  return null;
}
// Borrowed from Cloudflare's own reference client for this SFU (partytracks
// - its pull path wraps every pull in retryWithBackoff()) - a transient
// blip pulling someone's track used to just fail once and give up
// (console.error, and that participant's tile silently stays empty
// forever). Three attempts with a short backoff gives a flaky connection a
// real chance to recover instead of a permanent dead tile over one bad
// request.
export async function pullRemoteTrack(localSessionId, remoteSessionId, trackName, pc) {
  const delays = [500, 1500];
  for (let attempt = 0; ; attempt++) {
    try {
      return await pullRemoteTrackOnce(localSessionId, remoteSessionId, trackName, pc);
    } catch (err) {
      if (attempt >= delays.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

export function endSession(session) {
  if (!session) return;
  try { session.pc.close(); } catch (e) {}
  try { session.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
}
