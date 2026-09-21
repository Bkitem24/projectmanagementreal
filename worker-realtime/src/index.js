// Proxies "Connect" (voice huddles) to Cloudflare Realtime's SFU REST API,
// so the App Token that can create/read call sessions never ships inside
// the desktop app — only this Worker holds it, as a secret.
//
// Checked 2026-09-21 against Cloudflare's current Realtime SFU HTTP API
// reference (developers.cloudflare.com/realtime/sfu/https-api/ + its
// OpenAPI schema) once Humayun had a real "Serverless SFU" app to confirm
// against — the endpoint paths and field names below (POST /sessions/new,
// POST /sessions/:id/tracks/new with a sessionDescription + tracks array)
// match. One real gap this pass found and fixed: pulling a REMOTE track
// into an already-established session very often requires a renegotiation
// round-trip (the API flags this back as `requiresImmediateRenegotiation`),
// which the original version of this file didn't handle at all — it would
// have just tried to apply an offer as if it were the final answer and
// failed. See the /session/:id/pull and new /session/:id/renegotiate
// handlers below, and the matching client-side handling in
// src/lib/connect.js's pullRemoteTrack().
//
// Still genuinely unverified: an actual end-to-end call between two real
// clients, which needs Humayun to deploy this and try it — this Worker's
// own comments and the request/response bodies it forwards are the first
// thing to check against a fresh export of the OpenAPI spec if that test
// fails, since Cloudflare's Realtime surface has moved before.
//
// Endpoints this exposes to the app (see src/lib/connect.js):
//   POST /session/new              body { offer }                          -> { sessionId, answer }
//   POST /session/:id/pull         body { remoteSessionId, trackName }      -> { answer, requiresRenegotiation }
//   POST /session/:id/renegotiate  body { answer }                         -> { ok: true }

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

function cf(env, path, body) {
  return fetch(CF_BASE + '/apps/' + env.CF_REALTIME_APP_ID + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.CF_REALTIME_APP_TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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

    // GET /health - added 2026-09-21 while chasing the "failed to fetch"
    // then "Could not start Connect session (404)" report. Deliberately
    // ahead of every other check below (no auth, no CF-creds requirement,
    // works for GET) so it answers ONE question on its own: is
    // VITE_REALTIME_WORKER_URL actually pointing at this deployed worker at
    // all? Visit "<that URL>/health" directly in a browser - "reachable"
    // rules out a wrong/stale URL or a worker that was never (re)deployed;
    // "configured": false narrows it further to the CF_REALTIME_APP_ID/
    // CF_REALTIME_APP_TOKEN secrets not being set yet. Neither of those is
    // something code here can fix - but telling them apart from a real code
    // bug (which would show up as a 500/502 from the actual call, not a
    // 404) is most of the diagnosis.
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return cors(json({ ok: true, reachable: true, configured: !!(env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_TOKEN) }));
    }

    if (request.method !== 'POST') return cors(new Response('Method not allowed', { status: 405 }));

    if (!env.CF_REALTIME_APP_ID || !env.CF_REALTIME_APP_TOKEN) {
      return cors(json({ error: 'Connect is not configured on the server yet (missing CF_REALTIME_APP_ID / CF_REALTIME_APP_TOKEN).' }, 503));
    }

    const ok = await verifySession(request, env);
    if (!ok) return cors(new Response('Unauthorized', { status: 401 }));

    // --- POST /session/new -------------------------------------------------
    // Creates a new Realtime session, then immediately pushes the caller's
    // local mic track (the SDP offer) into it, in one round trip.
    if (url.pathname === '/session/new' && request.method === 'POST') {
      try {
        const { offer } = await request.json();
        if (!offer || !offer.sdp) return cors(json({ error: 'Missing offer.sdp' }, 400));

        const newSessionRes = await cf(env, '/sessions/new', {});
        if (!newSessionRes.ok) {
          return cors(json({ error: 'Cloudflare Realtime session create failed', detail: await newSessionRes.text() }, 502));
        }
        const { sessionId } = await newSessionRes.json();

        // Push the local track. `mid: '0'` assumes a single audio-only m-line
        // (Connect is audio-only per spec) — if a future change adds video,
        // this needs to read the actual mid out of the offer SDP instead of
        // assuming '0'.
        const tracksRes = await cf(env, '/sessions/' + sessionId + '/tracks/new', {
          sessionDescription: { type: 'offer', sdp: offer.sdp },
          tracks: [{ location: 'local', mid: '0', trackName: 'mic' }],
        });
        if (!tracksRes.ok) {
          return cors(json({ error: 'Cloudflare Realtime track push failed', detail: await tracksRes.text() }, 502));
        }
        const tracksBody = await tracksRes.json();
        return cors(json({ sessionId, answer: tracksBody.sessionDescription }));
      } catch (err) {
        return cors(json({ error: String(err) }, 500));
      }
    }

    // --- POST /session/:id/pull ---------------------------------------------
    // Pulls a remote participant's already-published track into the
    // caller's existing session. Per Cloudflare's current API, adding a
    // track to an already-negotiated session commonly needs a follow-up
    // renegotiation round trip rather than returning a ready-to-use answer
    // directly — `requiresImmediateRenegotiation` says which case this is:
    //   - false: `sessionDescription` (if present) is a normal answer.
    //   - true: `sessionDescription` is actually an OFFER the client must
    //     answer and send back via POST /session/:id/renegotiate below.
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
          return cors(json({ error: 'Cloudflare Realtime remote track pull failed', detail: await tracksRes.text() }, 502));
        }
        const tracksBody = await tracksRes.json();
        return cors(json({
          answer: tracksBody.sessionDescription,
          requiresRenegotiation: !!tracksBody.requiresImmediateRenegotiation,
        }));
      } catch (err) {
        return cors(json({ error: String(err) }, 500));
      }
    }

    // --- POST /session/:id/renegotiate --------------------------------------
    // Completes the renegotiation Cloudflare asked for above: the client
    // has applied the offer we handed back from /pull and generated its own
    // answer — this forwards that answer to Cloudflare's renegotiate
    // endpoint to finish the handshake.
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
          return cors(json({ error: 'Cloudflare Realtime renegotiate failed', detail: await renegRes.text() }, 502));
        }
        return cors(json({ ok: true }));
      } catch (err) {
        return cors(json({ error: String(err) }, 500));
      }
    }

    return cors(new Response('Not found', { status: 404 }));
  },
};

