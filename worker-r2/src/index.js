// Cloudflare Worker fronting the R2 bucket for all file storage: profile
// photos, client photos, task attachments, and TimeLog screenshots.
//
// Two jobs:
//   1. fetch()      — PUT to upload a file (always requires a valid,
//                     logged-in Supabase session), GET to read one back
//                     (requires that same session too, but only for
//                     screenshots/ and attachments/ keys — see
//                     isSensitiveKey() below. Avatars and client photos stay
//                     openly readable so a plain <img src> can use the URL).
//                     DELETE removes an object outright (same auth check as
//                     PUT) — used when someone deletes an attachment from
//                     the comments/discussion UI, so the object doesn't sit
//                     in the bucket forever as an orphan once its database
//                     row is gone (the 6-month retention job below only
//                     ever looks at rows that still exist).
//   2. scheduled()   — a daily cron job that deletes screenshots, task
//                     attachments, and activity samples once they're 6
//                     months old, per Humayun's retention decision — both
//                     the R2 object and its database row, so nothing is
//                     ever a broken link or an orphaned row.
//
// Usage from the app (see src/lib/r2.js):
//   PUT    /f/<key>   Authorization: Bearer <supabase access token>   body: file bytes
//   GET    /f/<key>   Authorization required only for screenshots/*, attachments/*   -> file bytes back
//   DELETE /f/<key>   Authorization: Bearer <supabase access token>   -> removes the object

async function verifySession(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const res = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
    headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
  });
  return res.ok;
}

// Screenshots and task attachments can contain real work content and, for
// screenshots, whatever was on someone's screen while clocked in — those
// need an authenticated GET. Avatars and client photos are just profile
// pictures (comparable to any app's public-ish avatar image) and stay
// simple, unauthenticated reads so an <img src="..."> tag can use the URL
// directly — the moment a folder here holds anything more sensitive than a
// picture of a person's face, it belongs in this list.
function isSensitiveKey(key) {
  return key.startsWith('screenshots/') || key.startsWith('attachments/');
}

function cors(resp) {
  resp.headers.set('Access-Control-Allow-Origin', '*');
  resp.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  resp.headers.set('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  return resp;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/f\/(.+)$/);
    if (!match) return cors(new Response('Not found', { status: 404 }));
    const key = match[1];

    if (request.method === 'GET') {
      if (isSensitiveKey(key)) {
        const ok = await verifySession(request, env);
        if (!ok) return cors(new Response('Unauthorized', { status: 401 }));
      }
      const obj = await env.BUCKET.get(key);
      if (!obj) return cors(new Response('Not found', { status: 404 }));
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      return cors(new Response(obj.body, { headers }));
    }

    if (request.method === 'PUT') {
      const ok = await verifySession(request, env);
      if (!ok) return cors(new Response('Unauthorized', { status: 401 }));
      if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 25 * 1024 * 1024) {
        return cors(new Response('File too large (25MB max)', { status: 413 }));
      }
      await env.BUCKET.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' },
      });
      return cors(new Response(JSON.stringify({ key }), { headers: { 'content-type': 'application/json' } }));
    }

    if (request.method === 'DELETE') {
      // Same auth bar as PUT — any logged-in user can delete any key, just
      // like any logged-in user can already overwrite any key. Real
      // per-user/per-Team enforcement for *which* attachment someone is
      // allowed to remove happens one layer up, in Postgres RLS on
      // taskAttachments/episodeAttachments (see schema_v5.sql) — the app
      // only ever calls this after that row-delete already succeeded.
      const ok = await verifySession(request, env);
      if (!ok) return cors(new Response('Unauthorized', { status: 401 }));
      await env.BUCKET.delete(key);
      return cors(new Response(null, { status: 204 }));
    }

    return cors(new Response('Method not allowed', { status: 405 }));
  },

  // Runs on the schedule set in wrangler.toml's [triggers] block (daily).
  // Needs SUPABASE_SERVICE_ROLE_KEY — a secret, server-side-only credential
  // that bypasses Row Level Security. That's appropriate here (this job
  // legitimately needs to touch every user's rows to expire them), but it
  // must never be put anywhere the desktop app itself can read it — it
  // only ever lives as a Cloudflare Worker secret.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRetention(env));
  },
};

const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;

async function runRetention(env) {
  const cutoff = new Date(Date.now() - SIX_MONTHS_MS).toISOString();
  const results = await Promise.allSettled([
    purgeTable(env, 'screenshots', 'takenAt', cutoff, 'r2Key'),
    purgeTable(env, 'taskAttachments', 'createdAt', cutoff, 'r2Key'),
    // Added alongside the new per-episode discussion thread (schema_v4.sql,
    // "Additional Fixes Phase 1") — same retention rule as task attachments.
    purgeTable(env, 'episodeAttachments', 'createdAt', cutoff, 'r2Key'),
    purgeTable(env, 'activitySamples', 'windowStart', cutoff, null),
  ]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error('[retention] table', i, 'failed:', r.reason);
  });
}

// Deletes rows in `table` older than `cutoff` (by `dateField`), removing
// each row's R2 object first (when `fileField` names one), then the row
// itself. Paginates in batches so a large backlog on the first-ever run
// doesn't time out the worker.
async function purgeTable(env, table, dateField, cutoff, fileField) {
  const pageSize = 200;
  let deletedTotal = 0;
  for (let i = 0; i < 25; i++) { // hard cap: 5,000 rows/run is plenty for this team's scale
    const res = await sbFetch(env, `/rest/v1/${table}?${dateField}=lt.${encodeURIComponent(cutoff)}&select=id${fileField ? ',' + fileField : ''}&limit=${pageSize}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    if (fileField) {
      await Promise.allSettled(rows.map((row) => (row[fileField] ? env.BUCKET.delete(row[fileField]) : Promise.resolve())));
    }
    const ids = rows.map((row) => row.id);
    await sbFetch(env, `/rest/v1/${table}?id=in.(${ids.map((id) => `"${id}"`).join(',')})`, { method: 'DELETE' });
    deletedTotal += rows.length;
    if (rows.length < pageSize) break;
  }
  if (deletedTotal) console.log('[retention]', table, 'purged', deletedTotal, 'row(s) older than', cutoff);
}

function sbFetch(env, path, opts) {
  return fetch(env.SUPABASE_URL + path, Object.assign({}, opts, {
    headers: Object.assign({
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    }, (opts && opts.headers) || {}),
  }));
}
