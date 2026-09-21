// Client helper for the optional Cloudflare R2 file-storage worker
// (see worker-r2/). Not called anywhere yet — the app has no file-upload
// feature today — but it's ready for when you add one (e.g. an episode
// thumbnail). Wire it up like:
//
//   import { uploadFile, fileUrl } from './lib/r2.js';
//   const key = await uploadFile(fileInput.files[0], 'thumbnails/' + episodeId);
//   imgEl.src = fileUrl(key);
//
import { supabase } from './supabaseClient.js';

const WORKER_URL = import.meta.env.VITE_R2_UPLOAD_WORKER_URL;

export const r2Configured = !!WORKER_URL;

// "Failed to fetch" reports during testing (uploads *and* downloads, on both
// office wifi and different machines) point at transient network blips
// rather than a code bug — the worker itself responds fine when reachable.
// fetch() gives up on the first hiccup with no retry and no timeout, so a
// one-second stall reads to the user as a hard failure. This wraps every
// call to the worker with: an explicit timeout (so a stalled connection
// fails fast with a clear message instead of hanging forever) and a couple
// of automatic retries with backoff for genuine network-level failures
// (fetch() throwing) — but NOT for real HTTP error responses like 401/413,
// which are legitimate and retrying them would just be noise.
const TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [800, 2000];

async function fetchWithRetry(url, opts) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
      clearTimeout(timer);
      return res; // got a real HTTP response (even an error one) — not a network failure, don't retry
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
    }
  }
  const isAbort = lastErr && lastErr.name === 'AbortError';
  throw new Error(isAbort
    ? 'The connection timed out — check your internet connection and try again.'
    : 'Could not reach the file server — check your internet connection and try again.');
}

export async function uploadFile(file, key) {
  if (!WORKER_URL) throw new Error('R2 upload worker is not configured — set VITE_R2_UPLOAD_WORKER_URL in .env');
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData && sessionData.session && sessionData.session.access_token;
  if (!token) throw new Error('You must be signed in to upload files.');
  const res = await fetchWithRetry(WORKER_URL.replace(/\/$/, '') + '/f/' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) throw new Error('Upload failed (' + res.status + ')');
  const body = await res.json();
  return body.key;
}

export function fileUrl(key) {
  if (!WORKER_URL) return '';
  return WORKER_URL.replace(/\/$/, '') + '/f/' + encodeURIComponent(key);
}

// For screenshots/ and attachments/ keys, the worker requires a session on
// GET too (see worker-r2/src/index.js's isSensitiveKey), so a plain
// fileUrl() can't be dropped into <img src> or <a href> for those — there's
// no way to attach an Authorization header to either. This fetches the
// bytes with the header and hands back a blob: URL the browser can use the
// same way. Caller is responsible for URL.revokeObjectURL(...) once done
// with it (e.g. when the element is removed) to avoid leaking memory.
export async function fetchProtectedUrl(key) {
  if (!WORKER_URL) throw new Error('R2 upload worker is not configured.');
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData && sessionData.session && sessionData.session.access_token;
  const res = await fetchWithRetry(WORKER_URL.replace(/\/$/, '') + '/f/' + encodeURIComponent(key), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('Could not load file (' + res.status + ')');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Saving a file the user downloads (task attachments) needs to be reliable,
// and a plain <a download> click on a blob: URL — the only trick available
// in a normal browser — is known to be flaky inside the WebView2 shell Tauri
// uses on Windows: it can silently do nothing, only occasionally prompt a
// save dialog, and feel slow even when it does. That matches exactly what
// testing showed. Tauri's own dialog + fs plugins give a real, native
// "Save As" flow instead, so this uses those when available (i.e. running
// inside the actual desktop app) and only falls back to the old browser
// trick when they can't be loaded at all — e.g. `npm run dev` in a plain
// browser tab, where there's no Tauri shell to talk to.
// Returns true if the file was saved, false if the user cancelled the
// Save As dialog.
export async function downloadProtectedFile(key, suggestedName) {
  if (!WORKER_URL) throw new Error('R2 upload worker is not configured.');
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData && sessionData.session && sessionData.session.access_token;
  const res = await fetchWithRetry(WORKER_URL.replace(/\/$/, '') + '/f/' + encodeURIComponent(key), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('Could not load file (' + res.status + ')');
  const bytes = new Uint8Array(await res.arrayBuffer());

  let dialogMod = null, fsMod = null;
  try {
    [dialogMod, fsMod] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
  } catch (e) { /* not running inside Tauri — fall through to the browser method below */ }

  if (dialogMod && fsMod) {
    const path = await dialogMod.save({ defaultPath: suggestedName || 'file' });
    if (!path) return false; // user cancelled
    await fsMod.writeFile(path, bytes);
    return true;
  }

  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const tmp = document.createElement('a');
  tmp.href = url; tmp.download = suggestedName || 'file';
  document.body.appendChild(tmp); tmp.click(); tmp.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}
