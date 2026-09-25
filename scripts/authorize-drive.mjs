// One-time interactive OAuth setup for scripts/upload-installer-to-drive.mjs.
// Service accounts can't own files on a personal (non-Workspace) Google
// account - they have no storage quota of their own, even in a folder
// shared with them as Editor - so uploads have to run as the real Google
// account via a normal OAuth "installed app" flow instead. This script
// only needs to be run once: it opens the consent screen, then saves a
// refresh token the upload script reuses forever after (no repeat consent).
//
// Usage: node scripts/authorize-drive.mjs
// Requires secrets/oauth-client.json (a Desktop-app OAuth client id,
// downloaded from Google Cloud Console - Credentials - Create Credentials
// - OAuth client ID - Desktop app).

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';

const CLIENT_KEY_PATH = new URL('../secrets/oauth-client.json', import.meta.url);
const TOKEN_PATH = new URL('../secrets/drive-oauth-token.json', import.meta.url);
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

async function main() {
  const { installed, web } = JSON.parse(readFileSync(CLIENT_KEY_PATH, 'utf8'));
  const client = installed || web;
  if (!client) throw new Error('secrets/oauth-client.json is missing an "installed" or "web" client entry.');
  const { client_id, client_secret } = client;

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') return;
      const code = url.searchParams.get('code');
      res.end(code ? 'Authorized - you can close this tab and return to the terminal.' : 'No code received.');
      server.close();
      code ? resolve(code) : reject(new Error('No code in callback.'));
    });
    server.listen(REDIRECT_PORT, () => {
      console.log('Opening browser for Google sign-in...');
      console.log('If it does not open automatically, visit:\n' + authUrl);
      // On Windows, `start "url"` treats the quoted string as the new
      // window's TITLE (not the target) and opens nothing - needs an
      // empty title first: `start "" "url"`.
      const command = process.platform === 'win32' ? `start "" "${authUrl}"`
        : process.platform === 'darwin' ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
      exec(command);
    });
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + res.status + ' ' + (await res.text()));
  const tokens = await res.json();
  if (!tokens.refresh_token) {
    throw new Error('No refresh_token returned - revoke this app\'s access at https://myaccount.google.com/permissions and rerun (Google only issues a refresh token on first consent).');
  }
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('Saved refresh token to ' + TOKEN_PATH.pathname.replace(/^\//, ''));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
