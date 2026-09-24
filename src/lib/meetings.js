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

// Camera + mic. Explained failures (see main.js's meeting-room UI for how
// these get shown) rather than a raw DOMException - NotAllowedError means
// the OS/browser permission was denied, NotFoundError means no such device
// exists on this machine.
export async function startLocalSession(withCamera) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withCamera !== false });
  } catch (err) {
    throw new Error(describeMediaError(err, withCamera !== false ? 'camera and microphone' : 'microphone'));
  }
  return publishSession(stream, (t) => (t.kind === 'video' ? 'camera' : 'mic'));
}

// Screen/window/tab share, with system audio if the OS/browser offers it
// (not every source supports it - a bare window share commonly has no
// audio track at all, which is normal, not an error).
export async function startScreenShareSession() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    throw new Error(describeMediaError(err, 'screen share'));
  }
  return publishSession(stream, (t) => (t.kind === 'video' ? 'screen' : 'screenAudio'));
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
