// "Connect" - instant voice huddles (1:1 and group) over Cloudflare Realtime
// (WebRTC SFU). See README.md's "Connect / Cloudflare Realtime" section
// before wiring this up for real - it needs a Cloudflare Realtime App ID +
// App Token, which only exist once Humayun creates that Cloudflare account.
//
// Two halves, deliberately split so the working half can ship now:
//
//   1. SIGNALING - who's calling whom, and who's currently in a given call.
//      This is fully working today: it rides on the same Supabase Realtime
//      the rest of the app already uses (see lib/presence.js), no
//      Cloudflare account needed for this part.
//
//   2. MEDIA - actually standing up the WebRTC audio session through
//      Cloudflare's SFU. Cloudflare's Calls/Realtime REST API (create a
//      session, push a local track's SDP offer, pull a remote track by
//      {sessionId, trackName}) is what this needs to call, proxied through
//      worker-realtime/ so the App Token never ships inside this desktop
//      app.
//
// 2026-09-21 - rebuilt from a 1:1-only ring/answer handshake into a real
// N-way call model (group Connect, join-a-call-in-progress, and adding a
// participant mid-call - to a 1:1 call too). The key realization: Cloudflare's
// pull-based SFU already supports any number of participants with ZERO
// worker changes - a client just calls /pull once per additional remote
// participant on its own single RTCPeerConnection. The only thing that
// needed to change here is the signaling: instead of a direct
// caller<->callee sessionId handoff, everyone on a given call (identified
// by a shared callId) tracks Supabase Realtime PRESENCE on one channel
// named after that call. Presence's own sync/join/leave events are the
// entire signaling surface a multi-way call needs:
//   - sync (fires right after you join, with everyone already there) =
//     "pull audio from everyone who beat me here"
//   - join = "someone new arrived, pull them too" - and this is ALSO
//     exactly what "add a participant mid-call" is: the new person's
//     ring() handler joins the same room, and everyone already in it gets
//     a join event for them. No separate add-participant code path exists.
//   - leave = "they hung up, tear their audio down"
// This is why ring()/joinCallRoom() below no longer need an isGroup branch
// anywhere in the actual logic - a "group call" is just a callId that more
// than 2 people ever joined.
//
// 2026-09-23 - "online = connectable, no accept step" (this file's design
// from the start) now only holds while the person being rung is clocked
// in. Someone clocked out gets a real ring with Accept/Decline and a ~30s
// timeout instead (see main.js's handleIncomingRing) - this file only had
// to grow one new signal for it, declineRing()/'ring-missed', to tell the
// CALLER a ring was turned down or went unanswered; ACCEPTING still needs
// nothing new, since joining the call room already means exactly that.
import { supabase } from './supabaseClient.js';

const REALTIME_WORKER_URL = import.meta.env.VITE_REALTIME_WORKER_URL || '';
// Deliberately stricter than a plain truthiness check: a bare truthy string
// (even something malformed, or the literal text "undefined" from a build
// where the env var substitution silently failed) used to count as
// "configured" and would go straight into a fetch() call. A relative/
// malformed URL like that resolves against the app's OWN origin instead of
// failing outright, and Tauri's bundled server answers an unmatched path
// with index.html (200 OK, HTML body) rather than a 404 - which is exactly
// what turns into the cryptic "Unexpected token '<', \"<!doctype \"... is
// not valid JSON" error reported 2026-09-21, instead of the clean "Connect
// is not configured" message this is supposed to show. Requiring an actual
// http(s) URL here catches that case up front.
export const connectConfigured = /^https?:\/\//i.test(REALTIME_WORKER_URL);

let ringChannel = null;
let onIncoming = null;
let onIncomingMissed = null;

// ---------------------------------------------------------------------------
// Signaling: "you're being invited to call <callId>" (working today)
// ---------------------------------------------------------------------------
// One channel per user (their own uid), listened to once at boot. Answering,
// mid-call roster changes, and hangup are all handled by the call room's
// Presence state (see joinCallRoom below) instead of extra broadcast events -
// 'ring' is still the only way a call is OFFERED. 'ring-missed' (added
// 2026-09-23, see declineRing below) is the one new message type: the
// caller has no other way to find out a ring was declined or timed out
// unanswered, since presence only ever tells it "someone joined," never
// "someone explicitly said no" or "gave up waiting."
export function listenForConnects(myUid, handlers) {
  onIncoming = handlers && handlers.onRing;
  onIncomingMissed = handlers && handlers.onRingMissed;
  if (ringChannel) supabase.removeChannel(ringChannel);
  ringChannel = supabase.channel('connect:' + myUid)
    .on('broadcast', { event: 'ring' }, (msg) => { if (onIncoming) onIncoming(msg.payload); })
    .on('broadcast', { event: 'ring-missed' }, (msg) => { if (onIncomingMissed) onIncomingMissed(msg.payload); })
    .subscribe();
  return () => { if (ringChannel) { supabase.removeChannel(ringChannel); ringChannel = null; } };
}

// A fresh id identifying one call (used as the Presence room name). The
// person starting a call (1:1 or group) generates one and reuses it for
// every ring() tied to that call, including ringing someone to ADD them
// mid-call later - reusing the same callId is what makes "add a
// participant" and "join a call in progress" work for free.
export function newCallId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now() + '-' + Math.random().toString(16).slice(2);
}

// Because "online" already means "connectable" per Humayun's spec (no
// accept/decline step when the other side is online), ringing someone
// immediately proceeds to media setup on their end too - this broadcast is
// really just "here's the call you're now part of, go join its room."
export async function ring(targetUid, fromProfile, callId, isGroup) {
  await supabase.channel('connect:' + targetUid).send({
    type: 'broadcast', event: 'ring',
    payload: { from: fromProfile, callId, isGroup: !!isGroup, at: new Date().toISOString() },
  });
}

// Added 2026-09-23: whoever rang someone who's clocked out now gets a real
// accept/decline step on the other end (see main.js's handleIncomingRing) -
// this is how that person tells the CALLER what happened, since joining the
// call room (the only signal that existed before) never fires at all for a
// decline or an unanswered ring. `reason` is 'declined' (they clicked
// Decline) or 'timeout' (the ~30s ring window ran out with no response) -
// the caller's UI treats both the same way (stop waiting, show why) but
// gets to say something slightly more specific than a generic "no answer."
export async function declineRing(callerUid, myProfile, callId, reason) {
  await supabase.channel('connect:' + callerUid).send({
    type: 'broadcast', event: 'ring-missed',
    payload: { from: myProfile, callId, reason: reason || 'declined', at: new Date().toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Call room (Presence-based, N-way signaling)
// ---------------------------------------------------------------------------
// Everyone currently on a call tracks their own {uid, name, sessionId} on
// one shared Presence channel named after the call's id. Joining this room
// IS "answering" the call; leaving it IS hanging up - there's no separate
// answer/hangup message type to keep in sync with call-room membership
// anymore, which was a real source of the old code's fragility (a missed
// 'answer' or 'hangup' broadcast could leave one side's UI out of sync with
// reality; Presence leave/join events can't be "missed" the same way since
// they're derived from the actual socket connection, not a one-shot
// message).
//
// handlers:
//   onParticipant(meta) - a participant (already there, or newly joined) we
//     don't have audio from yet. meta is { uid, name, sessionId }. Should
//     return a Promise (pullRemoteTrack's) - calls are queued and awaited
//     one at a time so concurrent renegotiations on the same
//     RTCPeerConnection never race each other.
//   onLeft(meta) - a participant just left the room.
//   onRoster(uids) - full list of other participants' uids, after every
//     sync/leave (handy for a "who's on this call" display if ever needed;
//     current UI derives that from its own participants map instead, but
//     this is here so that isn't the only way).
export function joinCallRoom(callId, myProfile, mySessionId, handlers) {
  var pulled = {};   // uid -> true, so a re-fired sync doesn't double-pull
  var pullChain = Promise.resolve(); // serializes onParticipant calls
  var room = supabase.channel('connect_room:' + callId, {
    config: { presence: { key: myProfile.id } },
  });

  function schedulePull(meta) {
    pulled[meta.uid] = true;
    pullChain = pullChain.then(function () { return handlers.onParticipant(meta); })
      .catch(function (err) { console.error('Connect: failed to pull participant', meta && meta.uid, err); });
  }

  function currentRoster(state) {
    return Object.keys(state).filter(function (uid) { return uid !== myProfile.id; });
  }

  room
    .on('presence', { event: 'sync' }, function () {
      var state = room.presenceState();
      currentRoster(state).forEach(function (uid) {
        var metas = state[uid];
        var meta = metas && metas[metas.length - 1];
        if (meta && meta.sessionId && !pulled[uid]) schedulePull(meta);
      });
      if (handlers.onRoster) handlers.onRoster(currentRoster(state));
    })
    .on('presence', { event: 'leave' }, function (payload) {
      (payload.leftPresences || []).forEach(function (meta) {
        if (!meta || meta.uid === myProfile.id) return;
        delete pulled[meta.uid];
        if (handlers.onLeft) handlers.onLeft(meta);
      });
      if (handlers.onRoster) handlers.onRoster(currentRoster(room.presenceState()));
    })
    .subscribe(function (status) {
      if (status === 'SUBSCRIBED') {
        room.track({ uid: myProfile.id, name: myProfile.name || '', sessionId: mySessionId });
      }
    });

  return {
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
  const url = REALTIME_WORKER_URL.replace(/\/$/, '') + path;
  try {
    return await fetch(url, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}),
    }));
  } catch (err) {
    // A network-level failure here (fetch() itself throwing - DNS not
    // resolving, connection refused, offline) is what "failed to fetch"
    // means, and on its own gives no hint WHICH url that was for. Worth
    // checking this exact url's own /health endpoint directly in a browser
    // (see worker-realtime/src/index.js) - if that doesn't load either, the
    // worker likely isn't deployed yet, or VITE_REALTIME_WORKER_URL doesn't
    // match its real deployed address.
    throw new Error('Could not reach the Connect server at ' + url + ' - ' + (err && err.message ? err.message : 'the request failed') + '. Try opening ' + REALTIME_WORKER_URL.replace(/\/$/, '') + '/health in a browser to check it\'s deployed and reachable.');
  }
}

// A response that isn't actually JSON (most often an HTML error/placeholder
// page served with a 200 status - see the connectConfigured comment above)
// used to reach res.json() directly and throw a raw, cryptic SyntaxError
// ("Unexpected token '<' ... is not valid JSON") straight into the UI. This
// checks the content-type first and raises a message that actually points
// at the real problem instead.
async function parseJsonResponse(res, what) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const preview = (await res.text().catch(() => '')).slice(0, 120);
    throw new Error(
      'Connect worker did not return ' + what + ' (got ' + (res.status) + ', ' + (contentType || 'no content-type') + ')'
      + (preview ? ' - response started with: ' + preview.replace(/\s+/g, ' ') : '')
      + '. Check VITE_REALTIME_WORKER_URL points at the deployed worker-realtime, not something else.'
    );
  }
  return res.json();
}

// Any error status other than 404 from worker-realtime already carries WHY
// in its JSON body (the `error`/`detail` fields set in worker-realtime/
// src/index.js) - added 2026-09-21 so a failure shows the actual reason
// (e.g. Cloudflare rejecting a bad App ID/Token) instead of a bare status
// code the person then has to guess at. Safe to call on a response whose
// body hasn't been read yet; swallows the case where the body isn't JSON.
async function describeWorkerError(res) {
  try {
    const errBody = await res.json();
    const parts = [errBody && errBody.error, errBody && errBody.detail].filter(Boolean);
    return parts.length ? ' - ' + parts.join(': ') : '';
  } catch (e) {
    return '';
  }
}

// Starts a new SFU session for the local mic, returns { sessionId, pc }.
export async function startLocalSession() {
  if (!connectConfigured) throw new Error('Connect is not configured yet - see README.md (needs Cloudflare Realtime credentials).');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const pc = new RTCPeerConnection();
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const res = await authedFetch('/session/new', { method: 'POST', body: JSON.stringify({ offer: pc.localDescription }) });
  if (!res.ok) {
    // A real HTTP response (not a network failure - see authedFetch's own
    // catch above) with a 404 specifically means the request reached SOME
    // server but that server doesn't recognize /session/new - either
    // VITE_REALTIME_WORKER_URL has an extra/wrong path baked into it, or
    // it's pointing at a worker that's running OLDER code than what's in
    // worker-realtime/src/index.js today (a redeploy is needed there
    // whenever that file changes - it's easy to forget to redeploy that
    // specific worker after a round that touched other things too).
    const detail = res.status === 404
      ? ' - the request reached ' + REALTIME_WORKER_URL.replace(/\/$/, '') + '/session/new but got a 404. Check VITE_REALTIME_WORKER_URL has no extra path or typo, and that worker-realtime has been redeployed (`cd worker-realtime && npx wrangler deploy`) since its code last changed.'
      : await describeWorkerError(res);
    throw new Error('Could not start Connect session (' + res.status + ')' + detail);
  }
  const body = await parseJsonResponse(res, 'a new session');
  await pc.setRemoteDescription(body.answer);
  return { sessionId: body.sessionId, pc, localStream: stream };
}

// Pulls a remote participant's track into an existing local session. Safe
// to call more than once on the same `pc` for different remote sessions -
// this is exactly what a group call is: one local pc, one /pull per other
// participant.
//
// Checked 2026-09-21 against Cloudflare's current Realtime SFU API: adding
// a track to an already-negotiated session commonly requires a follow-up
// renegotiation round trip rather than a direct answer - the worker's
// /pull response says which case this is via `requiresRenegotiation`. When
// true, what comes back as `answer` is actually an OFFER from Cloudflare
// that this side must answer and post back via /renegotiate to finish the
// handshake; when false, it's a normal, ready-to-apply answer.
export async function pullRemoteTrack(localSessionId, remoteSessionId, trackName, pc) {
  const res = await authedFetch('/session/' + localSessionId + '/pull', {
    method: 'POST', body: JSON.stringify({ remoteSessionId, trackName }),
  });
  if (!res.ok) throw new Error('Could not join remote audio (' + res.status + ')' + await describeWorkerError(res));
  const body = await parseJsonResponse(res, 'remote-audio details');

  if (body.requiresRenegotiation) {
    await pc.setRemoteDescription(body.answer); // actually an offer in this branch
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const renegRes = await authedFetch('/session/' + localSessionId + '/renegotiate', {
      method: 'POST', body: JSON.stringify({ answer: pc.localDescription }),
    });
    if (!renegRes.ok) throw new Error('Could not complete remote audio renegotiation (' + renegRes.status + ')' + await describeWorkerError(renegRes));
  } else if (body.answer) {
    await pc.setRemoteDescription(body.answer);
  }
}

export function endSession(session) {
  if (!session) return;
  try { session.pc.close(); } catch (e) {}
  try { session.localStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
}
