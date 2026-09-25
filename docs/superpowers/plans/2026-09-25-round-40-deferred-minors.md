# Round 40 - Round 39's Deferred Minor Issues - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (Humayun runs this on Sonnet 5 after Opus wrote it - see memory `feedback_two-step-opus-plans-sonnet-builds.md`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the minor issues the Round 39 independent review deferred: a tiny mute gap during a device swap, the MP4 converter's defensive checks and crash window, test temp-file cleanup, and an honest "Past meetings cleared" count.

**Architecture:** Small, contained edits to three files that Round 39 created or changed: `src-tauri/src/mp4fix.rs`, `src/lib/meetings.js` (`switchDevice`), and `src/lib/recorder.js` / `src/main.js` (clear-past-meetings handler). No schema changes. Nothing touches Connect.

**Tech Stack:** Rust (Tauri v2), vanilla JS, Supabase JS client, ffmpeg/ffprobe (installed, for tests).

**Spec:** No separate spec. Source of the findings: the Round 39 review (summarized per task below) and `docs/phase-3-punch-list.md` Round 39.

## Global Constraints

- Work on a branch `round-40` created in place from `main` (not a separate worktree - the local build needs `.env`, `secrets/`, `node_modules`). At the end, fast-forward `main` locally. **Do not push.**
- Rust tests: run from `src-tauri/` as `cargo test mp4fix` with env var `__COMPAT_LAYER=RunAsInvoker` set in the same shell (the test exe inherits the app's require-admin manifest; the session is usually not elevated - error 740 otherwise). PowerShell: `$env:__COMPAT_LAYER='RunAsInvoker'; cargo test mp4fix`. Bash: `__COMPAT_LAYER=RunAsInvoker cargo test mp4fix`.
- JS: verify every JS change with `npm run build` (must end `✓ built`). The project has no JS test framework - don't add one.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. In PowerShell, pass multi-line messages via a file (`git commit -F <file>`) - `-F -` with a here-string does NOT work in PowerShell; in the Bash tool a heredoc works.
- Never write credentials/tokens into files.
- Meetings and Connect stay separate - do not touch `src/lib/connect.js` or `worker-realtime/`.
- Finish with a punch-list entry "Round 40" in `docs/phase-3-punch-list.md` (insert right before the `## Notes` heading), then `npm run build-and-upload`, and report the uploaded installer filename to Humayun in plain language.

## Review Focus

1. **A mute click that lands while a mic swap is still in progress** → the person must end up muted. (Task 1)
2. **A recording file whose last box says "size 0 = runs to end of file"** → converter must refuse and leave the file untouched, not bury the new index inside that box. (Task 2)
3. **A fragment whose sample sizes point past the end of the file** (corrupted/partial write) → refuse, untouched. (Task 2)
4. **A garbled 64-bit box size** → an error, never a hang or an arithmetic panic. (Task 2)
5. **A manager clicking "Clear past meetings" when some listed meetings belong to another Team** (they can see them as an invitee but RLS won't let them delete) → the toast must say how many were actually cleared, not claim success. (Task 4)

---

### Task 1: Muting during a device swap always sticks

**Finding:** `switchDevice` (`src/lib/meetings.js`) copies `oldTrack.enabled` onto the new track, then `await sender.replaceTrack(newTrack)`, and only afterwards swaps the new track into `session.stream`. A mute click (or host-mute) during that await only reaches the OLD track (it's still the one in `session.stream`), so the new track goes out live.

**Files:**
- Modify: `src/lib/meetings.js` - `switchDevice`, the lines right after `if (sender) await sender.replaceTrack(newTrack);`

- [ ] **Step 1: Write the failing probe** - a throwaway script (scratchpad, NOT in the repo). Save as `<scratchpad>/mute-race-probe.js`, where `<scratchpad>` is the session's scratchpad directory from the system prompt:

```js
// Throwaway: runs meetings.js's REAL switchDevice in Edge 153 with a fake mic and
// clicks "mute" (old track disabled) while replaceTrack is still pending.
const http = require('http');
const fs = require('fs');
const src = fs.readFileSync('E:/Project Management Software/projectmanagementreal/src/lib/meetings.js', 'utf8');
function slice(from, to) { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('marker missing: ' + from); return src.slice(a, b); }
const code = [
  slice('const MIC_PROCESSING_KEY', 'export function newMeetingId'),
  slice('export async function switchDevice', '// Borrowed from Cloudflare'),
  slice('function describeMediaError', '// Real bug, root-caused'),
].join('\n').replace(/export /g, '');
const page = `<!doctype html><html><body><script>
${code}
function report(x){ fetch('/result',{method:'POST',body:JSON.stringify(x)}); }
(async()=>{ const out={};
 try{
  const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(undefined) });
  const t0 = s.getAudioTracks()[0];
  const pc = new RTCPeerConnection(); const sender = pc.addTrack(t0, s);
  const session = { stream: s, pc };
  // The user clicks Mute exactly while replaceTrack is in flight (the mic
  // button handler disables whatever audio tracks are in session.stream).
  // getSenders() returns this same sender object, so the override applies.
  const realReplace = sender.replaceTrack.bind(sender);
  sender.replaceTrack = (t) => {
    session.stream.getAudioTracks().forEach(x => { x.enabled = false; });
    return new Promise(r => setTimeout(r, 100)).then(() => realReplace(t));
  };
  const t1 = await switchDevice(session, 'mic', t0.getSettings().deviceId);
  out.newTrackEnabledAfterMidSwapMute = t1.enabled; // MUST be false
 }catch(e){ out.error = e.name+': '+e.message; }
 report(out);
})();
</script></body></html>`;
http.createServer((req, res) => {
  if (req.method === 'POST') { let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ console.log('RESULT '+b); res.end('ok'); setTimeout(()=>process.exit(0),200); }); return; }
  res.setHeader('Content-Type','text/html'); res.end(page);
}).listen(53995, () => console.log('listening'));
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 30000);
```

- [ ] **Step 2: Run it - expect RED**

PowerShell (replace `$sp` with the scratchpad path):

```powershell
$job = Start-Job { param($p) node "$p\mute-race-probe.js" } -ArgumentList $sp; Start-Sleep 1
$edge="${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
Start-Process $edge -ArgumentList "--headless=new","--user-data-dir=`"$sp\edge-probe-r40`"","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","http://localhost:53995/" | Out-Null
Wait-Job $job -Timeout 33 | Out-Null; Receive-Job $job; Remove-Job $job -Force
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*edge-probe-r40*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Expected: `RESULT {"newTrackEnabledAfterMidSwapMute":true}` (the bug).

- [ ] **Step 3: Fix** - in `switchDevice`, directly after `if (sender) await sender.replaceTrack(newTrack);` add:

```js
  // Round 40: a mute click (or host-mute) during the await above only reached
  // the OLD track, which was still the one in session.stream - re-copy its
  // on/off state now so the new track can't go out live.
  if (oldTrack) newTrack.enabled = oldTrack.enabled;
```

(Keep the existing earlier `newTrack.enabled = oldTrack ? oldTrack.enabled : true;` line - it covers the no-sender case and the time before the swap.)

- [ ] **Step 4: Run the probe again - expect GREEN:** `{"newTrackEnabledAfterMidSwapMute":false}`. Then `npm run build` → `✓ built`.

- [ ] **Step 5: Commit** `src/lib/meetings.js` - message: "Round 40: a mute click during a mic/camera swap now sticks".

---

### Task 2: MP4 converter defensive checks (size-0 box, chunk bounds, overflow) + test temp cleanup

**Findings:** (a) a final top-level box with size 0 ("runs to end of file") is accepted - the appended index would then sit INSIDE it and be invisible; (b) the bounds check only checks a chunk's START is inside the file, not start + its bytes; (c) `pos + size` / `p + size` in the box readers aren't overflow-checked - a garbled 64-bit size can panic (debug) or wrap and loop (release); (d) tests leave `bko-mp4fix-*` copies in `%TEMP%`.

**Files:**
- Modify: `src-tauri/src/mp4fix.rs`

**Interfaces:** `BoxHdr` gains `open_ended: bool`; `Track.chunks` becomes `Vec<(u64, u32, u64)>` = (file offset, sample count, byte length). Both are private to the module.

- [ ] **Step 1: Test temp cleanup first (no behavior change)** - in `mod tests`, replace `fixture_copy` so copies delete themselves:

```rust
    // Deletes the temp copy when the test ends (pass or fail).
    struct TempCopy(PathBuf);
    impl Drop for TempCopy { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
    impl std::ops::Deref for TempCopy { type Target = Path; fn deref(&self) -> &Path { &self.0 } }
    impl AsRef<Path> for TempCopy { fn as_ref(&self) -> &Path { &self.0 } }
    impl AsRef<std::ffi::OsStr> for TempCopy { fn as_ref(&self) -> &std::ffi::OsStr { self.0.as_os_str() } }

    fn fixture_copy(name: &str, tag: &str) -> TempCopy {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
        let dst = std::env::temp_dir().join(format!("bko-mp4fix-{}-{}-{}", std::process::id(), tag, name));
        std::fs::copy(&src, &dst).unwrap();
        TempCopy(dst)
    }
```

Fix any call sites the compiler complains about (e.g. a helper taking `&Path` receives `&p` - deref coercion handles `&TempCopy` → `&Path`; `Command::arg(&fixed)` uses the `OsStr` impl). Run `cargo test mp4fix` → 6 passed. Then confirm cleanup:

```powershell
Remove-Item "$env:TEMP\bko-mp4fix-*" -ErrorAction SilentlyContinue; $env:__COMPAT_LAYER='RunAsInvoker'; cargo test mp4fix; (Get-ChildItem "$env:TEMP\bko-mp4fix-*" -ErrorAction SilentlyContinue).Count
```
Expected: `6 passed`, then `0`.

- [ ] **Step 2: Write the three failing tests** (add to `mod tests`):

```rust
    #[test]
    fn size_zero_final_box_is_refused_untouched() {
        let p = fixture_copy("rec-frag-moof.mp4", "size0");
        // find the last top-level box and rewrite its 32-bit size to 0 ("to end of file")
        let mut f = File::open(&*p).unwrap();
        let len = f.metadata().unwrap().len();
        let (mut pos, mut last) = (0, 0);
        while let Some(h) = read_hdr(&mut f, pos, len).unwrap() { last = h.start; pos = h.start + h.size; }
        drop(f);
        let mut w = OpenOptions::new().write(true).open(&p).unwrap();
        w.seek(SeekFrom::Start(last)).unwrap();
        w.write_all(&0u32.to_be_bytes()).unwrap();
        drop(w);
        let before = std::fs::read(&p).unwrap();
        let err = defragment_in_place(&p).unwrap_err();
        assert!(err.contains("size 0"), "{}", err);
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }

    #[test]
    fn sample_data_past_end_of_file_is_refused_untouched() {
        let p = fixture_copy("rec-frag-moof.mp4", "pastend");
        // In the LAST moof, set the first trun's first sample size to a huge value
        let mut f = File::open(&*p).unwrap();
        let len = f.metadata().unwrap().len();
        let (mut pos, mut last_moof) = (0, None);
        while let Some(h) = read_hdr(&mut f, pos, len).unwrap() { if &h.typ == b"moof" { last_moof = Some(h); } pos = h.start + h.size; }
        let h = last_moof.unwrap();
        let body = read_body(&mut f, &h).unwrap();
        drop(f);
        let traf = children(&body).unwrap().into_iter().find(|c| &c.typ == b"traf").unwrap();
        let kids = children(traf.body).unwrap();
        let trun = kids.iter().find(|k| &k.typ == b"trun").unwrap();
        let fl = be32(trun.body, 0).unwrap() & 0x00FF_FFFF;
        assert!(fl & 0x200 != 0, "fixture trun must carry per-sample sizes");
        let mut off_in_body = 8;
        if fl & 0x1 != 0 { off_in_body += 4; }
        if fl & 0x4 != 0 { off_in_body += 4; }
        if fl & 0x100 != 0 { off_in_body += 4; }
        let abs = h.start + h.header_len + (trun.body.as_ptr() as u64 - body.as_ptr() as u64) + off_in_body as u64;
        let mut w = OpenOptions::new().write(true).open(&p).unwrap();
        w.seek(SeekFrom::Start(abs)).unwrap();
        w.write_all(&0x7FFF_FFFFu32.to_be_bytes()).unwrap();
        drop(w);
        let before = std::fs::read(&p).unwrap();
        let err = defragment_in_place(&p).unwrap_err();
        assert!(err.contains("past end of file"), "{}", err);
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }

    #[test]
    fn garbled_64bit_box_size_is_an_error_not_a_panic() {
        // one child box claiming a 64-bit size of u64::MAX
        let mut buf = vec![0, 0, 0, 1];
        buf.extend_from_slice(b"free");
        buf.extend_from_slice(&u64::MAX.to_be_bytes());
        assert!(children(&buf).is_err());
    }
```

- [ ] **Step 3: Run - expect RED**

Run: `cargo test mp4fix` (with the env var).
Expected: `size_zero_final_box_is_refused_untouched` FAILS (it converts instead of refusing), `sample_data_past_end_of_file_is_refused_untouched` FAILS (either converts, or the error text lacks "past end of file" for the byte-range case - read the message), `garbled_64bit_box_size_is_an_error_not_a_panic` FAILS with a panic "attempt to add with overflow" (debug build). If any of the three passes already, stop and re-read the test - it isn't testing what it should.

- [ ] **Step 4: Implement**

4a. `BoxHdr` gets `open_ended`:

```rust
#[derive(Clone, Copy, Debug)]
struct BoxHdr { typ: [u8; 4], start: u64, header_len: u64, size: u64, open_ended: bool }
```

In `read_hdr`, replace the size check and return:

```rust
    let end = pos.checked_add(size).ok_or_else(|| format!("box '{}' at {} has an impossible size", String::from_utf8_lossy(&typ), pos))?;
    if size < header_len || end > file_len {
        return Err(format!("box '{}' at {} runs past end of file (truncated recording?)", String::from_utf8_lossy(&typ), pos));
    }
    Ok(Some(BoxHdr { typ, start: pos, header_len, size, open_ended: size32 == 0 }))
```

4b. `children`: overflow-safe:

```rust
        let (size, hl) = match size32 { 0 => (buf.len() - p, 8), 1 => (usize::try_from(be64(buf, p + 8)?).unwrap_or(usize::MAX), 16), n => (n, 8) };
        let end = p.checked_add(size);
        if size < hl || end.map_or(true, |e| e > buf.len()) {
            return Err(format!("malformed '{}' box at {}", String::from_utf8_lossy(&typ), p));
        }
```

4c. `defragment_in_place`, right after the top-level walk loop:

```rust
    if top.iter().any(|h| h.open_ended) {
        return Err("a top-level box has size 0 (\"runs to end of file\") - refusing, the new index would be hidden inside it".into());
    }
```

4d. Chunks carry their byte length. `Track.chunks: Vec<(u64, u32, u64)>` (update the field comment: `(absolute file offset, sample count, byte length) - one per trun`). In `parse_moof`, change the push to:

```rust
            if count > 0 { t.chunks.push((chunk_start, count, cursor - chunk_start)); }
```

In `build_stbl`, update the two destructurings: `for (i, (_, n, _)) in t.chunks.iter().enumerate()` and `for (off, _, _) in &t.chunks`. In `defragment_in_place`, replace the old start-only check with:

```rust
    for t in &tracks {
        for (off, _, bytes) in &t.chunks {
            if off.checked_add(*bytes).map_or(true, |end| end > file_len) {
                return Err("sample data points past end of file (corrupted or partial recording)".into());
            }
        }
    }
```

4e. Fix the misleading comment above `patch_duration`: the numbers are body offsets **including** the 4-byte version/flags field. Replace its second/third lines with:

```rust
// Offsets per ISO 14496-12, counted from the start of the box body (the
// 4-byte version/flags field included): mvhd/mdhd v1 @24 (u64), v0 @16
// (u32); tkhd v1 @28 (u64), v0 @20 (u32).
```

Update the construction in the test helpers if any build a `BoxHdr` by hand (none should - they use `read_hdr`).

- [ ] **Step 5: Run - expect GREEN:** `cargo test mp4fix` → `9 passed`. Then `cargo build` (from `src-tauri/`) → `Finished`.

- [ ] **Step 6: Commit** `src-tauri/src/mp4fix.rs` - message: "Round 40: MP4 converter refuses size-0 boxes and out-of-file sample data, overflow-safe box reading, tests clean up temp files".

---

### Task 3: MP4 converter crash window - never run the JS fallback on a half-written file

**Finding:** the final label flips (fragments → `free`, old index → `free`, new → `moov`) take milliseconds, but if a write fails part-way, `recorder.js` then runs the old JS `fixMp4Durations` fallback on a half-flipped file. The window itself can't be removed without copying the whole file (multi-GB) - accepted and documented; the fallback-on-write-failure is fixable.

**Files:**
- Modify: `src-tauri/src/mp4fix.rs` (`defragment_in_place` write section + its comment)
- Modify: `src/lib/recorder.js` (`stop()` catch block)

- [ ] **Step 1: Tag write-phase errors in Rust** - in `defragment_in_place`, wrap everything from `let mut staged = new_moov.clone();` to `f.sync_all()...?;` in a closure so every error in it gets one prefix:

```rust
    // 2. Write. Append the new index labelled 'free' (invisible to players),
    //    flush, then flip labels: fragments -> free, old moov -> free, new -> moov.
    //    Known, accepted window: a crash/power cut DURING the flips (a few
    //    milliseconds) can leave a recording with hidden fragments. Removing
    //    it would mean copying the whole (multi-GB) file. Errors here are
    //    prefixed "write phase:" so the JS side never runs its fallback
    //    patcher on a half-written file.
    let write = |f: &mut File| -> Result<(), String> {
        let mut staged = new_moov.clone();
        staged[4..8].copy_from_slice(b"free");
        f.seek(SeekFrom::Start(file_len)).map_err(|e| e.to_string())?;
        f.write_all(&staged).map_err(|e| e.to_string())?;
        f.sync_data().map_err(|e| e.to_string())?;
        for h in top.iter().filter(|h| &h.typ == b"moof" || &h.typ == b"mfra") { write_type(f, h.start, b"free")?; }
        write_type(f, moov_h.start, b"free")?;
        write_type(f, file_len, b"moov")?;
        f.sync_all().map_err(|e| e.to_string())
    };
    write(&mut f).map_err(|e| format!("write phase: {}", e))?;
```

(Delete the old un-wrapped write lines this replaces.)

Run `cargo test mp4fix` → still `9 passed`.

- [ ] **Step 2: Skip the fallback on write-phase errors** - in `src/lib/recorder.js` `stop()`, replace the `catch (err) { ... }` block of the `mp4_defragment` call with:

```js
      } catch (err) {
        if (String(err).indexOf('write phase:') > -1) {
          // Failed WHILE writing - the file may be half-converted; the old
          // byte patcher must not touch it. VLC can still play it.
          console.error('[meetings] regular-MP4 conversion failed while writing - leaving the file as-is:', err);
        } else {
          console.warn('[meetings] regular-MP4 conversion failed, using duration-only fallback:', err);
          await fixMp4Durations(path).catch((e) => console.warn('[meetings] duration fallback also failed (file still plays in VLC):', e));
        }
      }
```

- [ ] **Step 3: Verify:** `npm run build` → `✓ built`; `cargo build` → `Finished`.

- [ ] **Step 4: Commit** both files - message: "Round 40: MP4 converter tags write-phase errors; recorder never runs the fallback on a half-written file".

---

### Task 4: "Past meetings cleared" reports what was actually cleared

**Finding:** the handler deletes each id with `db.doc('meetings/'+id).delete().catch(function(){})` and always toasts "Past meetings cleared". PostgREST returns NO error when RLS silently filters a delete to 0 rows, so a manager whose Past list includes another Team's meeting (visible because they were invited) sees "cleared" while it stays.

**Files:**
- Modify: `src/main.js` - the `clearPastBtn` click handler in `renderMeetingsList()` (search `clearPastMeetingsBtn`)

- [ ] **Step 1: Replace the delete + toast** - keep the `ids` collection, the empty check and the `confirm()`; replace the `Promise.all(...)` line and its `.then(...)` with:

```js
    // One delete for all ids, asking for the deleted rows back: a row the
    // database's rules won't let this account delete is silently skipped
    // (no error), so count what actually came back instead of assuming.
    supabase.from('meetings').delete().in('id', ids).select('id').then(function(res){
      if(res.error){ showToast('error', errMsg(res.error)); return; }
      var n = (res.data || []).length;
      if(n === ids.length) showToast('success', 'Cleared '+n+' past meeting'+(n===1?'':'s'));
      else if(n === 0) showToast('error', 'Nothing was cleared - you can only clear meetings from your own Team.');
      else showToast('info', 'Cleared '+n+' of '+ids.length+' - the rest belong to another Team.');
    });
```

(`supabase` is already imported in `main.js` - the meetings code uses `supabase.from('meetings')` elsewhere. Returning deleted rows needs SELECT access to them, which anyone who can see them in the Past list has.)

- [ ] **Step 2: Verify:** `npm run build` → `✓ built`. Live check in the browser pane with the dev server (`npm run dev`) logged in as the **admin** test account (ask Humayun for the login if it isn't in context - never write it to a file): start an instant meeting, end it, open `#/meetings`, click "Clear past meetings" → toast "Cleared N past meeting(s)" and the Past list empties.

- [ ] **Step 3: Commit** `src/main.js` - message: "Round 40: Clear past meetings reports how many were actually cleared".

---

### Task 5: Punch list, installer, handoff

- [ ] **Step 1:** Add "### Round 40 (2026-09-25) - Round 39's deferred minor issues closed" to `docs/phase-3-punch-list.md` right before `## Notes`: one `- [x]` bullet per task above (what was wrong, what changed, how verified), and note the accepted crash window from Task 3. Also note under Round 39's open items that Humayun confirmed on 2026-09-25 that all Round 39 Meetings fixes work, and that the "remote shared-screen audio missing from the host's recording" concern did not reproduce in his test.
- [ ] **Step 2:** `npm run build-and-upload` (about 2-3 minutes). Expected last line `Uploaded: Blue Kite Ops_0.1.0_x64-setup_<timestamp>.exe`. If it fails with `invalid_grant`, tell Humayun: Google Cloud Console → Google Auth Platform → **Audience** → click **Publish app** (moves it from "Testing" to "In production"), then run `node scripts/authorize-drive.mjs` once, then retry.
- [ ] **Step 3:** Commit the punch list; `git switch main`; `git merge --ff-only round-40`; `git branch -d round-40`. Do not push.
- [ ] **Step 4:** Report to Humayun in plain language: the installer filename, "no SQL to run this round", and what to spot-check: (1) as admin, Clear past meetings shows "Cleared N past meetings"; (2) mute/unmute and switching mic in a call still behave; (3) one short recording still opens fine in Windows Media Player.
