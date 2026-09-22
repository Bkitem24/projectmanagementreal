// Streams the in-app music player's library straight out of a shared
// Google Drive folder, authenticated as a Google service account (never a
// public Drive share link - those get rate-limited under real traffic with
// "too many users"/virus-scan-warning errors, which is exactly the
// slowness problem this needed to avoid). See wrangler.toml's header
// comment for the one-time setup this depends on.
//
// Three routes, all requiring a valid logged-in Supabase session (same
// verifySession() check worker-r2 uses):
//   GET /moods              -> [{key, folderId}] - one entry per mood
//                              subfolder that actually exists under the
//                              configured root folder
//   GET /tracks?mood=<key>  -> [{id, name, size}] - every audio file in
//                              that mood's folder
//   GET /stream/<fileId>    -> the audio bytes themselves, Range-aware
//                              (so seeking/scrubbing works) and cached at
//                              Cloudflare's edge after the first play so
//                              every later play of that same track, by
//                              anyone, skips Google entirely.
//
// The mood keys here are the exact same ones src/lib/music.js already
// defines (MOODS) - folder names in Drive must match these exactly
// (lowercase, underscores) so there's no fuzzy name-matching to get wrong.
const MOOD_KEYS = ['nature', 'film', 'lofi', 'western_classical', 'eastern_classical', 'electronic', 'high_bpm', 'color_noise'];

function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  resp.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  resp.headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  return resp;
}

async function verifySession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const res = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Google service-account auth (JWT-bearer flow, signed with Web Crypto -
// Workers have no Node `crypto`/`jsonwebtoken` package, but this flow only
// needs RSASSA-PKCS1-v1_5/SHA-256 signing, which Web Crypto does natively).
// Cached at module scope for the lifetime of this isolate (typically
// minutes to hours) so a warm Worker doesn't re-authenticate on every
// single request - only once per ~hour per isolate, same as the token's
// own real expiry.
// ---------------------------------------------------------------------------
let cachedToken = null; // { value, expAtMs }

function base64url(bytesOrString) {
  const bytes = typeof bytesOrString === 'string' ? new TextEncoder().encode(bytesOrString) : bytesOrString;
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && cachedToken.expAtMs > now + 60000) return cachedToken.value;

  const svc = JSON.parse(env.GDRIVE_SERVICE_ACCOUNT_JSON);
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat, exp,
  }));
  const unsigned = header + '.' + claims;

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(svc.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + base64url(new Uint8Array(sig));

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Google auth failed: ' + JSON.stringify(tokenData));
  cachedToken = { value: tokenData.access_token, expAtMs: now + tokenData.expires_in * 1000 };
  return cachedToken.value;
}

async function driveApiFetch(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch('https://www.googleapis.com/drive/v3/' + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('Drive API ' + path + ' failed: ' + res.status + ' ' + (await res.text()));
  return res.json();
}

// ---------------------------------------------------------------------------
// Mood folder lookup - cached in-memory per isolate for 10 minutes, since
// folder structure basically never changes but each lookup is a real Drive
// API call otherwise.
// ---------------------------------------------------------------------------
let moodFoldersCache = null; // { value: [{key,folderId}], expAtMs }
async function listMoodFolders(env) {
  const now = Date.now();
  if (moodFoldersCache && moodFoldersCache.expAtMs > now) return moodFoldersCache.value;
  const q = `'${env.GDRIVE_ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const data = await driveApiFetch(env, 'files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,name)') + '&pageSize=100');
  const value = (data.files || [])
    .filter((f) => MOOD_KEYS.indexOf(f.name) > -1)
    .map((f) => ({ key: f.name, folderId: f.id }));
  moodFoldersCache = { value, expAtMs: now + 10 * 60 * 1000 };
  return value;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);

    try {
      if (url.pathname === '/moods' && request.method === 'GET') {
        if (!(await verifySession(request, env))) return cors(new Response('Unauthorized', { status: 401 }));
        const moods = await listMoodFolders(env);
        return cors(new Response(JSON.stringify(moods), { headers: { 'content-type': 'application/json' } }));
      }

      if (url.pathname === '/tracks' && request.method === 'GET') {
        if (!(await verifySession(request, env))) return cors(new Response('Unauthorized', { status: 401 }));
        const moodKey = url.searchParams.get('mood') || '';
        const moods = await listMoodFolders(env);
        const mood = moods.filter((m) => m.key === moodKey)[0];
        if (!mood) return cors(new Response('[]', { headers: { 'content-type': 'application/json' } }));
        const q = `'${mood.folderId}' in parents and (mimeType contains 'audio/' or mimeType='video/mp4') and trashed=false`;
        const data = await driveApiFetch(env, 'files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,name,size)') + '&pageSize=1000');
        return cors(new Response(JSON.stringify(data.files || []), { headers: { 'content-type': 'application/json' } }));
      }

      const streamMatch = url.pathname.match(/^\/stream\/([a-zA-Z0-9_-]+)$/);
      if (streamMatch && request.method === 'GET') {
        // Deliberately NOT auth-gated, same reasoning as worker-r2's own
        // avatar/client-photo reads: a plain <audio src="..."> element
        // can't send an Authorization header, and JS-fetching the whole
        // file as a blob first would lose native Range-request streaming -
        // exactly the "has to be as fast as YouTube" requirement this was
        // built for. The file id itself is only ever handed out by the
        // authenticated /tracks endpoint above, so this trades a small
        // amount of security-by-obscurity (same posture this app already
        // accepts for photos) for real streaming performance.
        const fileId = streamMatch[1];

        // Edge cache, keyed by the file id + whatever Range was requested,
        // so a re-play (by anyone) after the first one skips Google
        // entirely - this is what keeps repeat plays fast regardless of
        // how Drive's own API happens to be performing that day.
        const range = request.headers.get('Range') || '';
        const cacheKey = new Request(url.origin + url.pathname + (range ? '?r=' + encodeURIComponent(range) : ''), request);
        const cache = caches.default;
        const cached = await cache.match(cacheKey);
        if (cached) return cors(new Response(cached.body, cached));

        const token = await getAccessToken(env);
        const driveHeaders = { Authorization: 'Bearer ' + token };
        if (range) driveHeaders.Range = range;
        const driveRes = await fetch(
          'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media',
          { headers: driveHeaders }
        );
        if (!driveRes.ok && driveRes.status !== 206) {
          return cors(new Response('Could not stream file (' + driveRes.status + ')', { status: driveRes.status }));
        }
        const headers = new Headers(driveRes.headers);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.delete('set-cookie');
        const resp = new Response(driveRes.body, { status: driveRes.status, headers });
        // Cache a copy without blocking the response the listener is
        // actually waiting on.
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return cors(resp);
      }

      return cors(new Response('Not found', { status: 404 }));
    } catch (err) {
      console.error('[drive-music]', err);
      return cors(new Response('Server error: ' + (err && err.message ? err.message : String(err)), { status: 500 }));
    }
  },
};
