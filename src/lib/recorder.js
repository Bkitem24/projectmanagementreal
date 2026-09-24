// Host-side local Meetings recording - mixes every participant's audio via
// the Web Audio API, composites video onto a canvas (screen share full-
// frame with a strip of camera tiles along the bottom when someone's
// sharing, otherwise a grid of camera tiles), and records the result with
// MediaRecorder straight to a file on the host's own disk. Nothing here
// ever leaves the host's computer - no upload step, no cloud storage, by
// design (see docs/phase-3-punch-list.md's Meetings round for why).
//
// Streamed to disk, not held in memory: MediaRecorder is started in 1-
// second timeslices (`start(1000)`) and each chunk is appended to an
// already-open file handle as it arrives, so a multi-hour recording never
// needs the whole thing in RAM at once. Both Chromium's WebM and its newer
// MP4 muxer produce fragmented output specifically so this kind of
// streaming works - each appended chunk is a self-contained fragment, so a
// crash mid-recording loses at most the last second or so since the
// previous flush, not the whole file; what's already on disk stays valid
// and playable.
//
// Tauri's fs plugin accepts a plain absolute path directly (no
// BaseDirectory needed) as long as it's in an allowed scope - same pattern
// src/lib/r2.js's downloadProtectedFile already uses for its Save-As
// download. $VIDEO/** is explicitly scoped in src-tauri/capabilities/
// default.json for the default "Blue Kite Recordings" folder; a folder
// picked via the dialog plugin's folder picker gets its own runtime scope
// grant from Tauri automatically.
const CANDIDATE_MIME_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType() {
  return CANDIDATE_MIME_TYPES.find((c) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) || '';
}

export function extensionFor(mimeType) {
  return (mimeType || '').indexOf('mp4') > -1 ? 'mp4' : 'webm';
}

async function defaultFolder() {
  const { videoDir, join } = await import('@tauri-apps/api/path');
  return join(await videoDir(), 'Blue Kite Recordings');
}

export async function getRecordingsFolder() {
  let saved = null;
  try { saved = localStorage.getItem('bko_recordingsFolder'); } catch (e) {}
  return saved || defaultFolder();
}

export async function setRecordingsFolder(path) {
  try { localStorage.setItem('bko_recordingsFolder', path); } catch (e) {}
}

// Lets Settings offer a real folder picker instead of typing a path by
// hand - resolves to null if the person cancels.
export async function pickRecordingsFolder() {
  const dialogMod = await import('@tauri-apps/plugin-dialog');
  const dir = await dialogMod.open({ directory: true, multiple: false, title: 'Choose a folder for Blue Kite Meeting recordings' });
  return typeof dir === 'string' ? dir : null;
}

function sanitizeFilename(s) {
  return (s || 'Meeting').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'Meeting';
}

function drawContain(ctx, videoEl, x, y, w, h, label) {
  ctx.save();
  ctx.fillStyle = '#132445';
  ctx.fillRect(x, y, w, h);
  if (videoEl && videoEl.videoWidth) {
    const vRatio = videoEl.videoWidth / videoEl.videoHeight;
    const boxRatio = w / h;
    let dw = w, dh = h;
    if (vRatio > boxRatio) dh = w / vRatio; else dw = h * vRatio;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    ctx.drawImage(videoEl, dx, dy, dw, dh);
  }
  if (label) {
    ctx.font = Math.max(12, Math.round(h * 0.06)) + 'px sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    const tw = ctx.measureText(label).width + 12;
    ctx.fillRect(x + 6, y + h - 26, tw, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 12, y + h - 11);
  }
  ctx.restore();
}

export class MeetingRecorder {
  constructor() {
    this.audioCtx = null;
    this.mixDest = null;
    this.canvas = null;
    this.ctx = null;
    this.recorder = null;
    this.fileHandle = null;
    this.recording = false;
    this.drawHandle = null;
    this.tiles = []; // kept live via setTiles() so _draw() always reflects who's currently in the meeting
    this.filePath = null;
    this.writeChain = Promise.resolve();
  }

  // tiles: [{ videoEl, label, isScreen }]
  setTiles(tiles) { this.tiles = tiles || []; }

  // Mixes one more participant's audio track(s) into the recording. Safe
  // to call again later for someone who joins mid-recording.
  addAudioSource(stream) {
    if (!stream || !this.audioCtx || !stream.getAudioTracks().length) return;
    try {
      const src = this.audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      src.connect(this.mixDest);
    } catch (e) { console.warn('[meetings] could not mix an audio source into the recording:', e); }
  }

  async start(opts) {
    if (this.recording) return this.filePath;
    opts = opts || {};
    const width = opts.width || 1280, height = opts.height || 720;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.mixDest = this.audioCtx.createMediaStreamDestination();
    (opts.audioStreams || []).forEach((s) => this.addAudioSource(s));

    const canvasStream = this.canvas.captureStream(30);
    const mixed = new MediaStream([...canvasStream.getVideoTracks(), ...this.mixDest.stream.getAudioTracks()]);

    const mimeType = pickMimeType();
    this.mimeType = mimeType;
    const ext = extensionFor(mimeType);

    // Wrapped so a raw Tauri IPC rejection (which can come back as a plain
    // string rather than a real Error, especially for a permission/scope
    // denial) never surfaces as the generic "Something went wrong" -
    // exactly what happened 2026-09-30 with no way to tell what actually
    // failed. Every failure here now says WHERE it was trying to write and
    // WHAT it was doing when it failed.
    const fsMod = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');
    let folder, filename;
    try {
      folder = await getRecordingsFolder();
      const already = await fsMod.exists(folder).catch(() => false);
      if (!already) await fsMod.mkdir(folder, { recursive: true });
      filename = sanitizeFilename(opts.title) + ' - ' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;
      this.filePath = await join(folder, filename);
      this.fileHandle = await fsMod.open(this.filePath, { write: true, create: true, append: true });
    } catch (err) {
      const detail = (err && err.message) ? err.message : String(err);
      throw new Error('Could not create the recording file in "' + (folder || '(unresolved folder)') + '" - ' + detail + '. Try picking a different recordings folder from the Meetings page, or check the app has permission to write there.');
    }

    this.writeChain = Promise.resolve();
    this.recorder = mimeType ? new MediaRecorder(mixed, { mimeType }) : new MediaRecorder(mixed);
    this.recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      this.writeChain = this.writeChain.then(async () => {
        try {
          const buf = new Uint8Array(await e.data.arrayBuffer());
          await this.fileHandle.write(buf);
        } catch (err) {
          console.error('[meetings] recording write failed - a chunk may have been lost:', err);
        }
      });
    };
    this.recorder.start(1000);
    this.recording = true;
    this._draw();
    return this.filePath;
  }

  _draw() {
    if (!this.recording) return;
    const ctx = this.ctx, canvas = this.canvas;
    ctx.fillStyle = '#0b1a33';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const screenTile = this.tiles.find((t) => t.isScreen);
    if (screenTile) {
      drawContain(ctx, screenTile.videoEl, 0, 0, canvas.width, canvas.height * 0.78);
      const others = this.tiles.filter((t) => !t.isScreen).slice(0, 8);
      const stripY = canvas.height * 0.78;
      const stripH = canvas.height - stripY;
      const tw = canvas.width / Math.max(others.length, 1);
      others.forEach((t, i) => drawContain(ctx, t.videoEl, i * tw, stripY, tw, stripH, t.label));
    } else {
      const cams = this.tiles.slice(0, 16);
      const cols = Math.max(1, Math.ceil(Math.sqrt(cams.length || 1)));
      const rows = Math.max(1, Math.ceil((cams.length || 1) / cols));
      const cw = canvas.width / cols, ch = canvas.height / rows;
      cams.forEach((t, i) => drawContain(ctx, t.videoEl, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch, t.label));
    }
    this.drawHandle = requestAnimationFrame(() => this._draw());
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    if (this.drawHandle) cancelAnimationFrame(this.drawHandle);
    const path = this.filePath;
    await new Promise((resolve) => {
      this.recorder.onstop = resolve;
      try { this.recorder.stop(); } catch (e) { resolve(); }
    });
    await this.writeChain;
    try { await this.fileHandle.close(); } catch (e) {}
    try { await this.audioCtx.close(); } catch (e) {}
    this.fileHandle = null;
    return path;
  }
}

// "Open folder" button after stopping - reveals the file in Explorer.
export async function revealInFolder(path) {
  const opener = await import('@tauri-apps/plugin-opener').catch(() => null);
  if (opener && opener.revealItemInDir) return opener.revealItemInDir(path);
  if (opener && opener.openPath) {
    const folder = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
    return opener.openPath(folder);
  }
  throw new Error('Could not open the recordings folder automatically - find it at: ' + path);
}
