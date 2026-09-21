// "Connect" — instant voice huddles (1:1 and group) over Cloudflare Realtime
// (WebRTC SFU). See README.md's "Connect / Cloudflare Realtime" section
// before wiring this up for real — it needs a Cloudflare Realtime App ID +
// App Token, which only exist once Humayun creates that Cloudflare account.
//
// Two halves, deliberately split so the working half can ship now:
//
//   1. SIGNALING — who's calling whom, and relaying session/track ids
//      between peers. This is fully working today: it rides on the same
//      Supabase Realtime the rest of the app already uses (see
//      lib/presence.js), no Cloudflare account needed for this part.
//
//   2. MEDIA — actually standing up the WebRTC audio session through
//      Cloudflare's SFU. This is a STUB. Cloudflare's Calls/Realtime REST
//      API (create a session, push a local track's SDP offer, pull a
//      remote track by {sessionId, trackName}) is what this needs to call,
//      proxied through worker-realtime/ so the App Token never ships inside
//      this desktop app. The exact request/response shape should be
//      double-checked against developers.cloudflare.com/realtime at the
//      time this gets finished — API surfaces like this do shift, and
//      guessing it confidently here would be worse than flagging it.
import { supabase } from './supabaseClient.js';

const REALTIME_WORKER_URL = import.meta.env.VITE_REALTIME_WORKER_URL || '';
export const connectConfigured = !!REALTIME_WORKER_URL;

let ringChannel = null;
let onIncoming = null;

// ---------------------------------------------------------------------------
// Signaling (working today)
// ---------------------------------------------------------------------------
export function listenForConnects(myUid, handler) {
  onIncoming = handler;
  if (ringChannel) supabase.removeChannel(ringChannel);
  ringChannel = supabase.channel('connect:' + myUid)
    .on('broadcast', { event: 'ring' }, (msg) => { if (onIncoming) onIncoming(msg.payload); })
    .subscribe();
  return () => { if (ringChannel) { supabase.removeChannel(ringChannel); ringChannel = null; } };
}

// Because "online" already means "connectable" per Humayun's spec (no
// accept/decline step for a 1:1 when the other side is online), ringing a
// single online person immediately proceeds to media setup on both ends —
// this broadcast is really just "here's the session id, join it now."
export async function ring(targetUid, fromProfile, sessionId, isGroup) {
  await supabase.channel('connect:' + targetUid).send({
    type: 'broadcast', event: 'ring',
    payload: { from: fromProfile, sessionId, isGroup: !!isGroup, at: new Date().toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Media (stub — needs worker-realtime/ + real Cloudflare Realtime creds)
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
// Realtime API reference — this assumes POST /session/new + POST
// /session/:id/tracks/new taking/returning SDP, proxied by worker-realtime/.
export async function startLocalSession() {
  if (!connectConfigured) throw new Error('Connect is not configured yet — see README.md (needs Cloudflare Realtime credentials).');
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
export async function pullRemoteTrack(localSessionId, remoteSessionId, trackName, pc) {
  const res = await authedFetch('/session/' + localSessionId + '/pull', {
    method: 'POST', body: JSON.stringify({ remoteSessionId, trackName }),
  });
  if (!res.ok) throw new Error('Could not join remote audio (' + res.status + ')');
  const body = await res.json();
  await pc.setRemoteDescription(body.answer);
}

export function endSession(session) {
  if (!session) return;
  try { session.pc.close(); } catch (e) {}
  try { session.localStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
}
