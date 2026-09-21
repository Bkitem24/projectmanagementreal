// "Connect" - instant voice huddles (1:1 and group) over Cloudflare Realtime
// (WebRTC SFU). See README.md's "Connect / Cloudflare Realtime" section
// before wiring this up for real - it needs a Cloudflare Realtime App ID +
// App Token, which only exist once Humayun creates that Cloudflare account.
//
// Two halves, deliberately split so the working half can ship now:
//
//   1. SIGNALING - who's calling whom, and relaying session/track ids
//      between peers. This is fully working today: it rides on the same
//      Supabase Realtime the rest of the app already uses (see
//      lib/presence.js), no Cloudflare account needed for this part.
//
//   2. MEDIA - actually standing up the WebRTC audio session through
//      Cloudflare's SFU. This is a STUB. Cloudflare's Calls/Realtime REST
//      API (create a session, push a local track's SDP offer, pull a
//      remote track by {sessionId, trackName}) is what this needs to call,
//      proxied through worker-realtime/ so the App Token never ships inside
//      this desktop app. The exact request/response shape should be
//      double-checked against developers.cloudflare.com/realtime at the
//      time this gets finished - API surfaces like this do shift, and
//      guessing it confidently here would be worse than flagging it.
import { supabase } from './supabaseClient.js';

const REALTIME_WORKER_URL = import.meta.env.VITE_REALTIME_WORKER_URL || '';
export const connectConfigured = !!REALTIME_WORKER_URL;

let ringChannel = null;
let onIncoming = null;
let onAnswered = null;
let onHangup = null;

// ---------------------------------------------------------------------------
// Signaling (working today)
// ---------------------------------------------------------------------------
// Three messages, one channel per user (their own uid), listened to once at
// boot: 'ring' (someone wants to call you), 'answer' (the person you rang
// has set up their own session and is telling you its id, so you can pull
// their audio back), 'hangup' (either side ending the call - this is what
// lets the OTHER side's UI clean up too, not just the one who clicked hang
// up). Call this once per app session; main.js wires all three handlers up
// at boot alongside the existing presence/timelog setup.
export function listenForConnects(myUid, handlers) {
  onIncoming = handlers && handlers.onRing;
  onAnswered = handlers && handlers.onAnswer;
  onHangup = handlers && handlers.onHangup;
  if (ringChannel) supabase.removeChannel(ringChannel);
  ringChannel = supabase.channel('connect:' + myUid)
    .on('broadcast', { event: 'ring' }, (msg) => { if (onIncoming) onIncoming(msg.payload); })
    .on('broadcast', { event: 'answer' }, (msg) => { if (onAnswered) onAnswered(msg.payload); })
    .on('broadcast', { event: 'hangup' }, (msg) => { if (onHangup) onHangup(msg.payload); })
    .subscribe();
  return () => { if (ringChannel) { supabase.removeChannel(ringChannel); ringChannel = null; } };
}

// Because "online" already means "connectable" per Humayun's spec (no
// accept/decline step for a 1:1 when the other side is online), ringing a
// single online person immediately proceeds to media setup on both ends -
// this broadcast is really just "here's my session id, come pull my audio."
export async function ring(targetUid, fromProfile, sessionId, isGroup) {
  await supabase.channel('connect:' + targetUid).send({
    type: 'broadcast', event: 'ring',
    payload: { from: fromProfile, sessionId, isGroup: !!isGroup, at: new Date().toISOString() },
  });
}

// The callee sends this back once THEY have their own session up and have
// pulled the caller's audio - it's what lets the original caller learn the
// callee's session id and pull audio the other direction, completing a
// real two-way call instead of one-way.
export async function answerRing(callerUid, fromProfile, sessionId) {
  await supabase.channel('connect:' + callerUid).send({
    type: 'broadcast', event: 'answer',
    payload: { from: fromProfile, sessionId, at: new Date().toISOString() },
  });
}

// Either side can send this when ending the call, so the other side's UI
// and local session get torn down too instead of thinking the call is
// still live.
export async function sendHangup(targetUid) {
  await supabase.channel('connect:' + targetUid).send({ type: 'broadcast', event: 'hangup', payload: {} });
}

// ---------------------------------------------------------------------------
// Media (stub - needs worker-realtime/ + real Cloudflare Realtime creds)
// ---------------------------------------------------------------------------
async function authedFetch(path, opts) {
  const { data } = await supabase.auth.getSession();
  const token = data && data.session && data.session.access_token;
  return fetch(REALTIME_WORKER_URL.replace(/\/$/, '') + path, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}),
  }));
}

// Starts a new SFU session for the local mic, returns { sessionId, pc }.
// TODO once Cloudflare creds exist: confirm this against the current
// Realtime API reference - this assumes POST /session/new + POST
// /session/:id/tracks/new taking/returning SDP, proxied by worker-realtime/.
export async function startLocalSession() {
  if (!connectConfigured) throw new Error('Connect is not configured yet - see README.md (needs Cloudflare Realtime credentials).');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const pc = new RTCPeerConnection();
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const res = await authedFetch('/session/new', { method: 'POST', body: JSON.stringify({ offer: pc.localDescription }) });
  if (!res.ok) throw new Error('Could not start Connect session (' + res.status + ')');
  const body = await res.json();
  await pc.setRemoteDescription(body.answer);
  return { sessionId: body.sessionId, pc, localStream: stream };
}

// Pulls a remote participant's track into an existing local session.
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
  if (!res.ok) throw new Error('Could not join remote audio (' + res.status + ')');
  const body = await res.json();

  if (body.requiresRenegotiation) {
    await pc.setRemoteDescription(body.answer); // actually an offer in this branch
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const renegRes = await authedFetch('/session/' + localSessionId + '/renegotiate', {
      method: 'POST', body: JSON.stringify({ answer: pc.localDescription }),
    });
    if (!renegRes.ok) throw new Error('Could not complete remote audio renegotiation (' + renegRes.status + ')');
  } else if (body.answer) {
    await pc.setRemoteDescription(body.answer);
  }
}

export function endSession(session) {
  if (!session) return;
  try { session.pc.close(); } catch (e) {}
  try { session.localStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
}
