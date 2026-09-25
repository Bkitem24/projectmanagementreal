// Uploads the freshly-built NSIS installer to a Google Drive folder,
// authorized as the real Google account (see scripts/authorize-drive.mjs -
// run that once first). Uploads go straight from disk to the Drive API, so
// this never routes the installer's bytes through a chat session (which
// hits hard size limits on that kind of connector for a file this size).
//
// Usage: node scripts/upload-installer-to-drive.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';

const CLIENT_KEY_PATH = new URL('../secrets/oauth-client.json', import.meta.url);
const TOKEN_PATH = new URL('../secrets/drive-oauth-token.json', import.meta.url);
const DRIVE_UPLOAD_FOLDER_ID = '1jmobpiqaFTaov_wQc8V7Y0Rj4oFQhDrh';
const INSTALLER_GLOB = 'src-tauri/target/release/bundle/nsis/*.exe';

async function getAccessToken() {
  const { installed, web } = JSON.parse(readFileSync(CLIENT_KEY_PATH, 'utf8'));
  const { client_id, client_secret } = installed || web;
  const { refresh_token } = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id,
      client_secret,
      refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Token refresh failed: ' + res.status + ' ' + (await res.text()) + '\nRerun scripts/authorize-drive.mjs to re-authorize.');
  return (await res.json()).access_token;
}

async function uploadFile(accessToken, filePath) {
  const fileBuffer = readFileSync(filePath);
  const fileName = filePath.split(/[\\/]/).pop();
  const stamped = fileName.replace(/\.exe$/, '') + '_' + new Date().toISOString().replace(/[:.]/g, '-') + '.exe';
  const metadata = { name: stamped, parents: [DRIVE_UPLOAD_FOLDER_ID] };

  const boundary = 'bkops-upload-boundary';
  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const closePart = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([metadataPart, fileBuffer, closePart]);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error('Upload failed: ' + res.status + ' ' + (await res.text()));
  return res.json();
}

async function main() {
  let installerPath = null;
  for await (const entry of glob(INSTALLER_GLOB)) installerPath = entry;
  if (!installerPath) {
    console.error('No installer found matching ' + INSTALLER_GLOB + ' - run `npm run tauri build` first.');
    process.exit(1);
  }

  console.log('Uploading ' + installerPath + ' ...');
  const accessToken = await getAccessToken();
  const result = await uploadFile(accessToken, installerPath);
  console.log('Uploaded: ' + result.name + ' (Drive file id ' + result.id + ')');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
