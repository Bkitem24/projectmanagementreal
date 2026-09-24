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
  var room = supabase.channel('meeting_room:' + meetingId, {
    config: { presence: { key: myProfile.id } },
  });
  var myMeta = Object.assign({ uid: myProfile.id, name: myProfile.name || '' }, initialMeta || {});

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

  room
    .on('presence', { event: 'sync' }, function () {
      var state = room.presenceState();
      Object.keys(state).forEach(function (uid) {
        if (uid === myProfile.id) return;
        considerMeta(uid, latestMetaFor(uid, state));
      });
    })
    .on('presence', { event: 'leave' }, function (payload) {
      (payload.leftPresences || []).forEach(function (meta) {
        if (!meta || meta.uid === myProfile.id) return;
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
      if (status === 'SUBSCRIBED') room.track(myMeta);
    });

  return {
    // Merge new fields into this person's own tracked metadata (e.g.
    // "I just muted", "I just started sharing my screen") - re-tracking is
    // what actually broadcasts the change to everyone else's `sync`.
    updateMeta: function (patch) {
      myMeta = Object.assign({}, myMeta, patch);
      try { room.track(myMeta); } catch (e) {}
    },
    myMeta: function () { return myMeta; },
    sendHostControl: function (action, targetUid) {
      try { room.send({ type: 'broadcast', event: 'host-control', payload: { action: action, targetUid: targetUid, from: myProfile.id } }); } catch (e) {}
    },
    leave: function () {
      try { room.untrack(); } catch (e) {}
      try { supabase.removeChannel(room); } catch (e) {}
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
      audio: (deviceIds && deviceIds.micId) ? { deviceId: { exact: deviceIds.micId } } : true,
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
    : { audio: { deviceId: { exact: deviceId } } };
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    throw new Error(describeMediaError(err, kind === 'camera' ? 'camera' : 'microphone'));
  }
  const newTrack = kind === 'camera' ? newStream.getVideoTracks()[0] : newStream.getAudioTracks()[0];
  const oldTrack = kind === 'camera' ? session.stream.getVideoTracks()[0] : session.stream.getAudioTracks()[0];
  const sender = session.pc.getSenders().find((s) => s.track && s.track.kind === newTrack.kind);
  if (sender) await sender.replaceTrack(newTrack);
  if (oldTrack) { session.stream.removeTrack(oldTrack); oldTrack.stop(); }
  session.stream.addTrack(newTrack);
  return newTrack;
}

// Screen/window/tab share, with system audio if the OS/browser offers it
// AND the person ticks that checkbox in the OS's own share picker (not
// every source supports it either - a bare window share commonly has no
// audio track at all, which is normal, not an error).
//
// echoCancellation/noiseSuppression on the AUDIO constraint (2026-09-30,
// Humayun: "voice keeps echoing... despite my microphone being muted"):
// system-audio capture is a completely separate signal path from the
// microphone, and does NOT get the same acoustic echo cancellation the
// mic does by default - so muting the mic does nothing about it. This is
// what's actually happening: sharing "system audio" sends whatever's
// playing through the sharer's OWN speakers (the other person's voice,
// a YouTube video, anything) straight back out - if the sharer is on
// speakers rather than headphones, the other person ends up hearing
// their own voice echoed back a moment later. Chromium does support
// requesting echo cancellation on a captured display audio track;
// asking for it here can only help, though headphones on the sharer's
// end is the real fix - see the confirm() prompt in main.js's screen-
// share handler, which asks about exactly this before turning it on.
export async function startScreenShareSession(opts) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    throw new Error(describeMediaError(err, 'screen share'));
  }
  if (opts && opts.hdrCompensate) stream = compensateHdrVideo(stream);
  return publishSession(stream, (t) => (t.kind === 'video' ? 'screen' : 'screenAudio'));
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
  const videoEl = document.createElement('video');
  videoEl.srcObject = new MediaStream([videoTrack]);
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.play().catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  let running = true;
  (function draw() {
    if (!running) return;
    ctx.filter = 'brightness(0.62) contrast(0.88) saturate(0.92)';
    try { ctx.drawImage(videoEl, 0, 0, width, height); } catch (e) {}
    requestAnimationFrame(draw);
  })();
  videoTrack.addEventListener('ended', () => { running = false; });
  const processed = canvas.captureStream(15);
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

// Identical to Connect's own pullRemoteTrack (see src/lib/connect.js for
// the full explanation of the renegotiation handshake) - reimplemented
// here rather than imported, on purpose, so Meetings and Connect share no
// code path at runtime.
export async function pullRemoteTrack(localSessionId, remoteSessionId, trackName, pc) {
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
}

export function endSession(session) {
  if (!session) return;
  try { session.pc.close(); } catch (e) {}
  try { session.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
}
