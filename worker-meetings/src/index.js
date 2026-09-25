// Proxies "Meetings" (video calls - camera, screen share, host recording)
// to Cloudflare Realtime's SFU REST API. Same underlying service and
// credentials as worker-realtime/ (Connect), but a fully separate Worker -
// see wrangler.toml's header for why. The one real design difference from
// worker-realtime: that Worker hardcodes a single audio-only track
// (mid: '0'); this one accepts a LIST of local tracks per session (mic +
// camera together, or a screen-share video track on its own session), with
// the client telling us each track's real `mid` (read off its own
// RTCPeerConnection after creating the offer) instead of guessing it.
//
// Screen share is modeled as its own separate Realtime session (its own
// RTCPeerConnection + sessionId), created only while sharing and torn down
// when it stops - not a track added to the main mic+camera session. That
// avoids the renegotiation complexity of adding a track mid-session for
// the PUBLISHING side (pulling a remote track still needs it - see /pull
// below, unchanged from Connect's own already-verified handling of that).
// A remote participant just pulls whichever trackNames a person is
// currently publishing across their (up to two) sessions, exactly like
// Connect already does for group calls.
//
// Endpoints:
//   GET  /health
//   POST /session/new              body { offer, tracks: [{mid, trackName}] } -> { sessionId, answer }
//   POST /session/:id/pull         body { remoteSessionId, trackName }        -> { answer, requiresRenegotiation }
//   POST /session/:id/renegotiate  body { answer }                           -> { ok: true }

const CF_BASE = 'https://rtc.live.cloudflare.com/v1';

async function verifySession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const res = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
  });
  return res.ok;
}

// Same "don't send a body at all when there isn't one" gotcha Connect's
// worker already found the hard way (Cloudflare's /sessions/new rejects an
// empty {} body outright) - see worker-realtime/src/index.js's own comment
// on this for the full story.
function cf(env, path, body) {
  const opts = {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CF_REALTIME_APP_TOKEN },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(CF_BASE + '/apps/' + env.CF_REALTIME_APP_ID + path, opts);
}

function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  resp.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return resp;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return cors(json({ ok: true, reachable: true, configured: !!(env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_TOKEN) }));
    }

    if (request.method !== 'POST') return cors(new Response('Method not allowed', { status: 405 }));

    if (!env.CF_REALTIME_APP_ID || !env.CF_REALTIME_APP_TOKEN) {
      return cors(json({ error: 'Meetings is not configured on the server yet (missing CF_REALTIME_APP_ID / CF_REALTIME_APP_TOKEN).' }, 503));
    }

    const ok = await verifySession(request, env);
    if (!ok) return cors(new Response('Unauthorized', { status: 401 }));

    // --- POST /session/new -------------------------------------------------
    if (url.pathname === '/session/new' && request.method === 'POST') {
      try {
        const { offer, tracks } = await request.json();
        if (!offer || !offer.sdp) return cors(json({ error: 'Missing offer.sdp' }, 400));
        if (!Array.isArray(tracks) || !tracks.length) return cors(json({ error: 'Missing tracks (need at least one {mid, trackName})' }, 400));
        if (tracks.some((t) => !t || !t.mid || !t.trackName)) return cors(json({ error: 'Every track needs a mid and a trackName' }, 400));

        const newSessionRes = await cf(env, '/sessions/new');
        if (!newSessionRes.ok) {
          const detail = await newSessionRes.text();
          console.error('[session/new] Cloudflare Realtime session create failed:', newSessionRes.status, detail);
          return cors(json({ error: 'Cloudflare Realtime session create failed', detail }, 502));
        }
        const { sessionId } = await newSessionRes.json();

        const tracksRes = await cf(env, '/sessions/' + sessionId + '/tracks/new', {
          sessionDescription: { type: 'offer', sdp: offer.sdp },
          tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })),
        });
        if (!tracksRes.ok) {
          const detail = await tracksRes.text();
          console.error('[session/new] Cloudflare Realtime track push failed:', tracksRes.status, detail);
          return cors(json({ error: 'Cloudflare Realtime track push failed', detail }, 502));
        }
        const tracksBody = await tracksRes.json();
        return cors(json({ sessionId, answer: tracksBody.sessionDescription }));
      } catch (err) {
        return cors(json({ error: String(err) }, 500));
      }
    }

    // --- POST /session/:id/pull --------------------------------------------
    // Identical to worker-realtime's own /pull - pulling a remote track
    // works the same way regardless of how many local tracks this side is
    // publishing.
    const pullMatch = url.pathname.match(/^\/session\/([^/]+)\/pull$/);
    if (pullMatch && request.method === 'POST') {
      const localSessionId = pullMatch[1];
      try {
        const { remoteSessionId, trackName } = await request.json();
        if (!remoteSessionId || !trackName) return cors(json({ error: 'Missing remoteSessionId or trackName' }, 400));

        const tracksRes = await cf(env, '/sessions/' + localSessionId + '/tracks/new', {
          tracks: [{ location: 'remote', sessionId: remoteSessionId, trackName }],
        });
        if (!tracksRes.ok) {
          const detail = await tracksRes.text();
          console.error('[session/pull] Cloudflare Realtime remote track pull failed:', tracksRes.status, detail);
          return cors(json({ error: 'Cloudflare Realtime remote track pull failed', detail }, 502));
        }
        const tracksBody = await tracksRes.json();
        // mid (2026-09-24, real bug fix): Cloudflare's own /tracks/new
        // response already tells us exactly which mid this pulled track
        // landed on (tracksBody.tracks[0].mid) - forwarding it lets the
        // client identify the right RTCRtpTransceiver directly instead of
        // assuming pc.ontrack events fire in the same order tracks were
        // requested, which real network jitter can and does violate (two
        // renegotiations can easily have their ontrack events arrive out
        // of order). Same approach Cloudflare's own reference client
        // (partytracks, used by github.com/cloudflare/orange) takes.
        const pulledMid = tracksBody.tracks && tracksBody.tracks[0] && tracksBody.tracks[0].mid;
        return cors(json({
          answer: tracksBody.sessionDescription,
          requiresRenegotiation: !!tracksBody.requiresImmediateRenegotiation,
          mid: pulledMid || null,
        }));
      } catch (err) {
        return cors(json({ error: String(err) }, 500));
      }
    }

    // --- POST /session/:id/renegotiate --------------------------------------
    const renegMatch = url.pathname.match(/^\/session\/([^/]+)\/renegotiate$/);
    if (renegMatch && request.method === 'POST') {
      const sessionId = renegMatch[1];
      try {
        const { answer } = await request.json();
        if (!answer || !answer.sdp) return cors(json({ error: 'Missing answer.sdp' }, 400));

        const renegRes = await fetch(CF_BASE + '/apps/' + env.CF_REALTIME_APP_ID + '/sessions/' + sessionId + '/renegotiate', {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + env.CF_REALTIME_APP_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionDescription: { type: 'answer', sdp: answer.sdp } }),
        });
        if (!renegRes.ok) {
          const detail = await renegRes.text();
          console.error('[session/renegotiate] Cloudflare Realtime renegotiate failed:', renegRes.status, detail);
          return cors(json({ error: 'Cloudflare Realtime renegotiate failed', detail }, 502));
        }
        return cors(json({ ok: true }));
      } catch (err) {
        return cors(json({ error: String(err) }, 500));
      }
    }

    return cors(new Response('Not found', { status: 404 }));
  },
};
