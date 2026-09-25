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
    this.drawTimer = null;
    this.tiles = []; // kept live via setTiles() so _drawFrame() always reflects who's currently in the meeting
    this.filePath = null;
    this.writeChain = Promise.resolve();
  }

  // tiles: [{ videoEl, label, isScreen }]
  setTiles(tiles) { this.tiles = tiles || []; }

  // Mixes one more participant's audio track(s) into the recording. Safe
  // to call again later for someone who joins mid-recording.
  addAudioSource(stream) {
    var trackCount = stream ? stream.getAudioTracks().length : 0;
    console.log('[meetings] addAudioSource called - audioCtx ready:', !!this.audioCtx, 'track count:', trackCount);
    if (!stream || !this.audioCtx || !trackCount) return;
    try {
      const src = this.audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      src.connect(this.mixDest);
      console.log('[meetings] audio source connected to recording mix');
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
    // Diagnostic for the "recording plays back like a live/growing stream,
    // no real duration" report: raw-concatenated WebM chunks are written
    // with no final duration index (a well-known limitation - the browser
    // marks it "unknown" until a proper remux), while concatenated
    // fragmented MP4 reported a correct duration in direct testing. Which
    // one actually gets picked depends on what THIS engine's
    // MediaRecorder.isTypeSupported() says, which could differ from what
    // was tested elsewhere - logging it removes the guesswork for next time.
    console.log('[meetings] recording mimeType:', mimeType || '(default/none matched)');

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
    this.onWriteError = opts.onWriteError || null;
    let writeErrorReported = false;
    this.recorder = mimeType ? new MediaRecorder(mixed, { mimeType }) : new MediaRecorder(mixed);
    this.recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      this.writeChain = this.writeChain.then(async () => {
        try {
          const buf = new Uint8Array(await e.data.arrayBuffer());
          await this.fileHandle.write(buf);
        } catch (err) {
          // Used to be swallowed to just a console.error - a real chunk
          // write failing (permission revoked mid-recording, disk full,
          // antivirus lock, etc.) left the recording indicator showing
          // "Recording" the whole time with no visible sign anything was
          // wrong, while the file on disk silently stopped growing. Only
          // reported once (not per-chunk-forever) so it doesn't spam.
          console.error('[meetings] recording write failed - a chunk may have been lost:', err);
          if (!writeErrorReported && this.onWriteError) { writeErrorReported = true; this.onWriteError(err); }
        }
      });
    };
    this.recorder.start(1000);
    this.recording = true;
    // setInterval, not requestAnimationFrame - a real recording can run for
    // hours while the host tabs away to do other things (check email,
    // present from a different app, etc.), and Chromium suspends/heavily
    // throttles rAF callbacks once this window's document goes hidden. A
    // recording that silently stops updating (or stops outright) the
    // moment the app loses focus, with the "Recording" indicator still
    // showing the whole time, matches exactly what was reported ("just 1 or
    // 2 seconds long no matter how long I record"). setInterval keeps
    // running regardless of window visibility.
    this.drawTimer = setInterval(() => this._drawFrame(), 1000 / 30);
    return this.filePath;
  }

  _drawFrame() {
    if (!this.recording) return;
    // A real meeting's tiles churn constantly (people join/leave/mute/
    // share) while this.tiles holds live DOM <video> element references -
    // wrapped so a transient error touching a tile mid-teardown can't take
    // down the whole draw loop permanently, just skip one frame.
    try {
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
    } catch (err) {
      console.error('[meetings] a recording frame failed to draw (skipped, not fatal):', err);
    }
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    if (this.drawTimer) clearInterval(this.drawTimer);
    const path = this.filePath;
    await new Promise((resolve) => {
      this.recorder.onstop = resolve;
      try { this.recorder.stop(); } catch (e) { resolve(); }
    });
    await this.writeChain;
    try { await this.fileHandle.close(); } catch (e) {}
    try { await this.audioCtx.close(); } catch (e) {}
    this.fileHandle = null;
    if (this.mimeType && this.mimeType.indexOf('mp4') > -1) {
      // Round 39: convert Chromium's fragmented MP4 into a regular MP4 so
      // Windows' own Media Player plays and seeks it (src-tauri/src/mp4fix.rs).
      // The converter never touches the file unless it fully parsed first;
      // if it fails, fall back to the older duration-only patch below.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const report = await invoke('mp4_defragment', { path });
        console.log('[meetings] recording converted to a regular MP4:', report);
      } catch (err) {
        console.warn('[meetings] regular-MP4 conversion failed, using duration-only fallback:', err);
        await fixMp4Durations(path).catch((e) => console.warn('[meetings] duration fallback also failed (file still plays in VLC):', e));
      }
    }
    return path;
  }
}

// FALLBACK ONLY since Round 39 - the real fix is the native regular-MP4
// conversion (mp4_defragment) in stop() above; this runs only if that fails.
// Original note: fix for "the recording plays like a live stream,
// no total duration shown" - confirmed by parsing an actual recorded
// file's raw bytes (2026-09-25): Chromium's fragmented-MP4 muxer writes a
// CORRECT top-level movie duration (the mvhd box), but the PER-TRACK
// duration fields (tkhd, and mdia/mdhd) are left as placeholder values
// that don't match their own declared timescales - e.g. a value that's
// only sane at the movie's 1000-unit timescale gets left in a field
// declared to be in the audio track's 44100 Hz timescale, computing out to
// ~1 second instead of the real ~46. A permissive player (ffprobe, VLC)
// reads the correct top-level mvhd value and displays it fine; a simpler
// player reading the per-track fields directly sees nonsense/near-zero
// durations and falls back to "unknown length" ("live stream") behavior.
// Verified this is safe to patch: ffmpeg's own full-decode pass
// (`-f null -`) and frame-count both came back identical before and after
// patching - only these specific integer fields change, no structural
// change to the file at all, so there's no way this can corrupt playable
// content, only fix or (if the box layout doesn't match what's expected)
// harmlessly no-op.
async function fixMp4Durations(path) {
  const fsMod = await import('@tauri-apps/plugin-fs');
  const handle = await fsMod.open(path, { read: true, write: true });
  try {
    // moov is near the start of the file for this muxer (well before any
    // fragment data) - 256KB is generous headroom. If moov isn't found in
    // that window, something about the file doesn't match what this was
    // written against, and this bails out without touching anything.
    const head = new Uint8Array(262144);
    const n = await handle.read(head);
    if (!n) return;
    const buf = head.subarray(0, n);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const typeAt = (p) => String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    function findChild(start, end, wanted) {
      let p = start;
      while (p + 8 <= end) {
        const size = view.getUint32(p);
        if (size < 8 || p + size > end) return null;
        const type = typeAt(p);
        if (type === wanted) return { start: p, size, bodyStart: p + 8 };
        p += size;
      }
      return null;
    }
    let moov = null;
    { let p = 0; while (p + 8 <= buf.length) {
        const size = view.getUint32(p);
        if (size < 8 || p + size > buf.length) break;
        if (typeAt(p) === 'moov') { moov = { start: p, size, bodyStart: p + 8 }; break; }
        p += size;
      } }
    if (!moov) return;
    const moovEnd = moov.start + moov.size;

    const mvhd = findChild(moov.bodyStart, moovEnd, 'mvhd');
    if (!mvhd) return;
    const mvhdVersion = buf[mvhd.bodyStart];
    let movieTimescale, movieDuration;
    if (mvhdVersion === 1) { movieTimescale = view.getUint32(mvhd.bodyStart + 20); movieDuration = Number(view.getBigUint64(mvhd.bodyStart + 24)); }
    else if (mvhdVersion === 0) { movieTimescale = view.getUint32(mvhd.bodyStart + 12); movieDuration = view.getUint32(mvhd.bodyStart + 16); }
    else return;
    if (!movieTimescale || !movieDuration) return;

    const patches = [];
    let p = moov.bodyStart;
    while (p + 8 <= moovEnd) {
      const size = view.getUint32(p);
      if (size < 8 || p + size > moovEnd) break;
      if (typeAt(p) === 'trak') {
        const trakEnd = p + size;
        const tkhd = findChild(p + 8, trakEnd, 'tkhd');
        if (tkhd) {
          const v = buf[tkhd.bodyStart];
          // tkhd's duration is in the MOVIE's own timescale (same units as mvhd) - a direct copy, no conversion.
          // v1 duration sits at body offset 28 (version/flags 4 + creation 8 +
          // modification 8 + track_ID 4 + reserved 4). Was 36 until Round 39 -
          // that wrote into reserved bytes and never fixed this field.
          if (v === 1) patches.push({ offset: tkhd.bodyStart + 28, size: 8, value: movieDuration });
          else if (v === 0) patches.push({ offset: tkhd.bodyStart + 20, size: 4, value: movieDuration });
        }
        const mdia = findChild(p + 8, trakEnd, 'mdia');
        const mdhd = mdia ? findChild(mdia.bodyStart, mdia.start + mdia.size, 'mdhd') : null;
        if (mdhd) {
          const v = buf[mdhd.bodyStart];
          let trackTimescale, off, sz;
          if (v === 1) { trackTimescale = view.getUint32(mdhd.bodyStart + 20); off = mdhd.bodyStart + 24; sz = 8; }
          else if (v === 0) { trackTimescale = view.getUint32(mdhd.bodyStart + 12); off = mdhd.bodyStart + 16; sz = 4; }
          // mdhd's duration IS in the track's own timescale - has to be converted from the movie's.
          if (trackTimescale) patches.push({ offset: off, size: sz, value: Math.round((movieDuration / movieTimescale) * trackTimescale) });
        }
      }
      p += size;
    }
    for (const patch of patches) {
      const out = new Uint8Array(patch.size);
      const outView = new DataView(out.buffer);
      if (patch.size === 8) outView.setBigUint64(0, BigInt(patch.value)); else outView.setUint32(0, patch.value);
      await handle.seek(patch.offset, fsMod.SeekMode.Start);
      await handle.write(out);
    }
  } finally {
    await handle.close();
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
