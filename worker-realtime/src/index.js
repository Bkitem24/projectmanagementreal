// Proxies "Connect" (voice huddles) to Cloudflare Realtime's SFU REST API,
// so the App Token that can create/read call sessions never ships inside
// the desktop app — only this Worker holds it, as a secret.
//
// *** NOT independently verified. *** This Worker was written without a
// live Cloudflare Realtime account to test against (Humayun hasn't created
// one yet — see README.md's Connect section) and without live network
// access to developers.cloudflare.com from the sandbox this was built in.
// The endpoint shapes below (POST /sessions/new, POST
// /sessions/:id/tracks/new with a sessionDescription + tracks array) match
// Cloudflare's published Realtime/Calls API as of when this was written,
// but that surface has moved before and a field name or two below could be
// stale. Before relying on Connect for real:
//   1. Create the Cloudflare Realtime app, set the four secrets below.
//   2. Try a real 1:1 Connect from two machines (or two browser profiles).
//   3. If it fails, compare the request/response bodies logged here
//      against the CURRENT reference at developers.cloudflare.com/realtime
//      and adjust — most likely spot for drift is the exact shape of the
//      `tracks` array entries (location/mid/trackName/sessionId fields).
//
// Endpoints this exposes to the app (see src/lib/connect.js):
//   POST /session/new              body { offer }                  -> { sessionId, answer }
//   POST /session/:id/pull         body { remoteSessionId, trackName } -> { answer }

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
    if (request.method !== 'POST') return cors(new Response('Method not allowed', { status: 405 }));

    if (!env.CF_REALTIME_APP_ID || !env.CF_REALTIME_APP_TOKEN) {
      return cors(json({ error: 'Connect is not configured on the server yet (missing CF_REALTIME_APP_ID / CF_REALTIME_APP_TOKEN).' }, 503));
    }

    const ok = await verifySession(request, env);
    if (!ok) return cors(new Response('Unauthorized', { status: 401 }));

    const url = new URL(request.url);

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
    // caller's existing session, returning the renegotiated SDP answer.
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
        return cors(json({ answer: tracksBody.sessionDescription }));
      } catch (err) {
        return cors(json({ error: String(err) }, 500));
      }
    }

    return cors(new Response('Not found', { status: 404 }));
  },
};
