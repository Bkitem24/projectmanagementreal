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

export async function uploadFile(file, key) {
  if (!WORKER_URL) throw new Error('R2 upload worker is not configured — set VITE_R2_UPLOAD_WORKER_URL in .env');
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData && sessionData.session && sessionData.session.access_token;
  if (!token) throw new Error('You must be signed in to upload files.');
  const res = await fetch(WORKER_URL.replace(/\/$/, '') + '/f/' + encodeURIComponent(key), {
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
  const res = await fetch(WORKER_URL.replace(/\/$/, '') + '/f/' + encodeURIComponent(key), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('Could not load file (' + res.status + ')');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
