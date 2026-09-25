# Round 39 - Meetings Audio, Output Devices, MP4 Playback, Clear-Meetings Permission - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every issue from Humayun's 2026-09-25 test of build `..._2026-09-25T09-21-22-747Z.exe`: screen-share system audio echo and its coupling to the mic button, add speaker (output) selection, add echo-cancellation/noise-suppression toggles, make recordings play properly in Windows' own Media Player, and make "Clear past meetings" admin/manager-only.

**Architecture:** All Meetings changes stay inside the Meetings codepath (`src/lib/meetings.js`, `src/lib/recorder.js`, the Meetings section of `src/main.js`) - Connect (`src/lib/connect.js`, `worker-realtime/`) is NOT touched. The MP4 fix moves from byte-patching in JS to a new native Rust command (`src-tauri/src/mp4fix.rs`) that converts Chromium's fragmented MP4 into a regular MP4 in place, in seconds, with no re-encoding and no extra binaries. One additive SQL file (`schema_v34.sql`) tightens the meetings DELETE policy.

**Tech Stack:** Vanilla JS + Vite, Tauri v2 (Rust), Supabase RLS (Postgres), WebView2 runtime 153 (Chromium 153), ffmpeg/ffprobe (already installed on Humayun's machine via winget - used only for tests).

**Spec:** No separate spec file - this is a bug-fix round. The evidence and decisions are recorded in the "Root causes (evidence)" section below; read it before starting any task.

---

## Root causes (evidence) - read first

Humayun's report, verbatim facts:
1. Screen share: system audio only reaches the other person while **his mic button is ON**, and then it sounds "weird echoey". Mic OFF → no system audio at all.
2. Wants an output-device (speaker) picker in the call's device settings.
3. Asked whether an echo-cancellation on/off toggle makes sense.
4. MP4 recordings play correctly in VLC now, but NOT in Windows' normal media player (plays like a live stream).
5. With the mic button ON but the boom mic physically detached from his Corsair HS60 headset, system audio still reaches the other person even with screen share OFF (clean, not echoey) - and **only when Windows output is set to the headset, never when output is the speakers**.
6. (Mid-planning) An employee can still click "Clear past meetings".

What the code actually does (all line numbers as of 2026-09-25, before this round):

- **Cause of #1 "no audio when mic off":** `src/main.js:5719` - the mic button handler also sets `enabled = next` on the **screen-share audio track** ("Mute now covers both"), and `src/main.js:5744` disables screen audio if a share starts while muted. So muting the mic silences the shared system audio. Mainstream apps (Meet, Zoom, Teams) never tie shared-content audio to the mic mute. Fix: decouple.
- **Cause of #1 "echoey":** three stacked problems:
  1. `src/main.js:5542` - `showScreenShare()` creates the sharer's OWN preview `<video>` with the full captured stream (video + system audio) and does **not** mute it. The sharer's app therefore plays the captured system audio back out of their speakers/headset a fraction of a second late - and "Entire Screen + system audio" capture records everything the PC plays, including that delayed copy. That is a real audio feedback loop: every sound arrives several times with growing delay = echo. (The camera tile at `main.js:5481` already mutes `me` - the screen tile was just missed.)
  2. `src/lib/meetings.js:425` requests `echoCancellation/noiseSuppression/autoGainControl: true` on the **system-audio** track. Those filters are built for a voice through a mic; applied to music/video audio they produce the watery, swirly, "underwater/echoey" artifacts. Meet/Zoom send shared audio unprocessed.
  3. System-audio capture also records the app's own playback of the OTHER participants' voices, so they hear themselves back. Chromium 153 (WebView2 runtime installed here is 153.0.4234.48) supports the standard `restrictOwnAudio` constraint - confirmed by probing `navigator.mediaDevices.getSupportedConstraints()` in the same-version Edge headless: `restrictOwnAudio: true`. Setting it tells the engine to exclude the app's own audio output from the capture.
- **Cause of #5 (not an app bug):** the leak only happens when output = the Corsair headset and stops when output = speakers. That pattern fits electrical crosstalk ("bleed") inside the headset's USB adapter / combo jack: with the boom mic unplugged, the adapter's mic input is left floating and picks up the headphone signal electrically. The HS60 has no second hidden mic. The app faithfully sends whatever Windows says the mic hears - Zoom/Meet would send it too. What the app CAN do: show which mic is actually in use plus a live level meter (so this becomes visible), and warn when the active mic changes or disconnects (Task 3). Humayun can confirm the hardware cause himself - see "Handoff checks for Humayun".
- **Cause of #4:** Chromium's `MediaRecorder` always writes **fragmented** MP4 (`ftyp, moov(mvex, empty sample tables), [moof, mdat]..., mfra`). Confirmed on a real file: codecs are H.264 + AAC (Windows decodes both natively), the moov's `stbl` tables are empty and `mvex` is present. VLC/ffmpeg handle fragments; Windows Media Player / Movies & TV treat it as a stream with no seek index. Windows' shell already reads the correct duration (`Shell.Application` `System.Media.Duration` = 45.88s on the test file), so duration metadata alone is NOT the remaining problem - the fragmented layout is. Also: the previous round's `fixMp4Durations()` patches `tkhd` (version 1) at body offset **36**; the correct offset per ISO/IEC 14496-12 is **28** (fullbox header 4 + creation 8 + modification 8 + track_ID 4 + reserved 4). It wrote into reserved bytes instead. Harmless, but the tkhd duration was never actually fixed.
- **Cause of #6:** `supabase/schema_v31.sql:33` - DELETE policy is `"hostUserId" = auth.uid() or public.is_admin()`. Employees can host meetings, so they can delete their own. The button is also rendered for everyone (`main.js:5020`).

## Global Constraints

- Meetings and Connect stay fully separate - do not edit `src/lib/connect.js`, `worker-realtime/`, or any Connect UI (CLAUDE.md "Meetings vs. Connect").
- Schema changes ship as a NEW additive file `supabase/schema_v34.sql`; never edit old schema files. Humayun runs it by hand in the Supabase SQL editor, BEFORE installing the new build.
- Verify every JS task with a real `npm run build` (must finish with no errors). Verify every Rust change with `cargo test` from `src-tauri/` (the shell must be elevated - the app manifest requires admin; Claude Code is already running as Administrator on this machine).
- Never write any login credentials, app passwords, or tokens into any file in this repo. Test logins for the admin/employee accounts are in the previous session transcript or can be requested from Humayun.
- Explain things to Humayun in plain language (non-technical founder).
- Update `docs/phase-3-punch-list.md` with a dated "Round 39" entry (root cause, fix, confirmation status) - project convention.
- Finish with `npm run build-and-upload` (builds the Windows installer locally and uploads it to Humayun's Drive folder) and report the uploaded filename.
- Engine = WebView2 (Chromium 153) on Windows. Anything Chromium-specific must be feature-detected so the future macOS (WebKit) build degrades gracefully instead of throwing.

## Review Focus

1. **Speaker device unplugged mid-call** (saved `sinkId` no longer exists) → audio must fall back to the default output, never go silent. Covered in Task 3, Step 6.
2. **Muted person switches mic device or toggles echo cancellation** → must stay muted (today `switchDevice` creates a new track that is unmuted by default - a real privacy bug). Covered in Task 4, Step 5.
3. **Recording in progress while the host switches mic** → the recording must keep the host's voice (today `recorder.addAudioSource` binds to the OLD track, which is stopped on switch, so the host goes silent in the recording). Covered in Task 4, Step 6.
4. **Recording stopped after a crash/truncation, or a file that's already been converted** → the MP4 converter must refuse cleanly and leave the file byte-for-byte untouched. Covered in Task 5 tests.
5. **Screen share started while mic is muted** → system audio must still be shared (the old line 5744 behavior must be gone). Covered in Task 2, Step 6.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `supabase/schema_v34.sql` | Create | Meetings DELETE policy → admin, or manager of that meeting's team |
| `src/main.js` | Modify (Meetings section only) | Hide/guard Clear button; decouple mute; mute own screen preview; speaker picker + test sound + mic meter + processing toggles in devices modal; device-change handling; recorder follows mic swaps; "Finalizing recording" toast |
| `src/lib/meetings.js` | Modify | Screen-audio constraints; `listMediaDevices` adds speakers; mic processing prefs + constraints; `switchDevice` preserves mute state |
| `src/lib/recorder.js` | Modify | Call native `mp4_defragment` after stop; fix fallback `tkhd` offset 36 → 28 |
| `src-tauri/src/mp4fix.rs` | Create | Fragmented-MP4 → regular-MP4 in-place converter + its tests |
| `src-tauri/src/main.rs` | Modify | Register `mp4fix::mp4_defragment` command |
| `src-tauri/tests/fixtures/*.mp4` | Create | Small test recordings for the converter tests |
| `docs/phase-3-punch-list.md` | Modify | Round 39 entry |

---

### Task 1: "Clear past meetings" becomes admin/manager-only

**Files:**
- Create: `supabase/schema_v34.sql`
- Modify: `src/main.js:5020` (button markup) and `src/main.js:5035` (click handler)

**Interfaces:**
- Consumes: existing SQL helpers `public.is_admin()`, `public.is_manager()` (multi-role aware, created in schema_v10, already used by schema_v14.sql:53), `public.current_team()`; existing JS `canManage()` (`main.js:501`).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the schema file**

```sql
-- schema_v34.sql (2026-09-25, Round 39)
-- "Employee is still able to click clear past meetings which should be an
-- admin/manager only access." Root cause: schema_v31's DELETE policy let a
-- meeting's HOST delete it, and employees can host meetings. Deleting
-- meeting history is now admin, or a manager of that meeting's own Team.
-- Hosts (including employees) can still CANCEL their own scheduled meeting -
-- that's an UPDATE (status='cancelled'), governed by a different policy,
-- untouched here.
drop policy if exists "meetings deletable by host or admin" on public.meetings;
drop policy if exists "meetings deletable by admin or team manager" on public.meetings;
create policy "meetings deletable by admin or team manager" on public.meetings for delete using (
  public.is_admin()
  or (public.is_manager() and "teamId" = public.current_team())
);
```

- [ ] **Step 2: Gate the button in the UI**

In `renderMeetingsList()` replace the Past section header markup at `main.js:5020`:

```js
    '<div class="section"><div class="section-head"><h2 class="section-title">Past</h2>'+(canManage()?'<button type="button" class="btn btn-sm" id="clearPastMeetingsBtn" style="width:auto;">Clear past meetings</button>':'')+'</div><div id="pastMeetingsBox"><div class="skeleton" style="height:60px;"></div></div></div>'
```

And at `main.js:5035` guard the listener (element may not exist now):

```js
  var clearPastBtn = document.getElementById('clearPastMeetingsBtn');
  if(clearPastBtn) clearPastBtn.addEventListener('click', function(){
```

(keep the existing handler body unchanged; update the comment above it: it's admin/manager-only since schema_v34, and the database enforces it too, not just the hidden button).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `✓ built in ...`, no errors.

- [ ] **Step 4: Live-verify (after Humayun has run schema_v34.sql - ask him to, SQL first)**

Start the dev server in the browser pane, log in as the **employee** test account, open `#/meetings`:
- Expected: no "Clear past meetings" button.
- In the browser console run (replace the id with a past meeting id the employee hosted, from the `data-meeting-id` attribute):
  `await (await import('/src/lib/supabaseClient.js')).supabase.from('meetings').delete().eq('id','<id>').select()`
  Expected: `data: []` (0 rows deleted - RLS blocked it).
Log in as **admin**: button visible, clearing works.

- [ ] **Step 5: Commit** (only if Humayun has OK'd committing this round - see "Before you start")

```bash
git add supabase/schema_v34.sql src/main.js
git commit -m "Round 39: clear past meetings is admin/manager-only (UI + RLS)"
```

---

### Task 2: Screen-share audio - kill the echo loop, stop tying it to the mic button

**Files:**
- Modify: `src/lib/meetings.js:401-446` (`startScreenShareSession` + its comment block)
- Modify: `src/main.js:5531-5543` (`showScreenShare`), `src/main.js:5710-5722` (mic button), `src/main.js:5744` (share-start line)

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged signatures - `startScreenShareSession(opts)` still returns a session with `.noSystemAudio`.

- [ ] **Step 1: Change the capture constraints**

In `src/lib/meetings.js`, replace the `getDisplayMedia` call and the log line after it:

```js
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 24 } },
      // Shared audio is music/video/app sound, not a voice - voice filters
      // (echo cancellation, noise suppression, auto gain) mangle it into the
      // watery "echoey" sound Humayun reported. Meet/Zoom send it raw.
      // restrictOwnAudio (Chromium 153+, confirmed supported in the WebView2
      // runtime this app ships on) keeps THIS app's own playback - the other
      // participants' voices, and our own preview - out of the capture, so
      // nobody hears themselves echoed back. Unknown constraints are simply
      // ignored by engines that don't support them (future macOS/WebKit).
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      },
      systemAudio: 'include',
    });
    const shareAudio = stream.getAudioTracks()[0];
    console.log('[meetings] screen share audio:', shareAudio ? { label: shareAudio.label, settings: shareAudio.getSettings() } : 'none (window share, or box unticked)');
```

Replace the old comment block at lines 401-419 (the one claiming echo cancellation on display audio "can only help") with a short accurate one pointing at Round 39 in the punch list: shared audio is sent raw, `restrictOwnAudio` prevents the loop, and the sharer's own preview is muted in `main.js`.

- [ ] **Step 2: Mute the sharer's own preview**

In `showScreenShare()` (`main.js:5541-5542`), the preview must never play sound (remote screen audio plays through its own hidden `<audio>` element, `audioEls['screen_'+uid]`, so muting every screen `<video>` loses nothing):

```js
      var v = document.createElement('video');
      // Always muted: for the sharer this element holds the raw captured
      // system audio - playing it out loud feeds it straight back into the
      // "Entire Screen + system audio" capture (a real feedback loop = the
      // echo reported in Round 39). Remote screen audio has its own <audio>
      // element (attachPulledTrack's 'screenAudio' branch), so nothing is lost.
      v.muted = true;
      v.autoplay = true; v.playsInline = true; v.srcObject = stream;
```

- [ ] **Step 3: Decouple the mic button**

In the `micBtn` click handler (`main.js:5710-5722`) delete the screen-share line and its comment so it reads:

```js
    document.getElementById('micBtn').addEventListener('click', function(){
      if(!mainSession) return;
      var next = !micOn;
      // Mic only. Shared screen audio is independent on purpose (Round 39) -
      // same as Meet/Zoom: muting yourself never silences what you're sharing.
      mainSession.stream.getAudioTracks().forEach(function(t){ t.enabled = next; });
      updateMicBtn(next);
      if(roomHandle) roomHandle.updateMeta({ micOn: next });
    });
```

- [ ] **Step 4: Remove the share-start mute**

Delete `main.js:5744`:

```js
          if(!micOn) session.stream.getAudioTracks().forEach(function(t){ t.enabled = false; }); // stay muted through a screen share started while already muted
```

Also check `onHostControl`'s `'mute'` branch (`main.js:5683-5687`) only touches `mainSession` (it does - leave it).

- [ ] **Step 5: Build**

Run: `npm run build` - Expected: success.

- [ ] **Step 6: Verify in the dev browser (two sessions, admin + employee, same meeting)**

- Sharer console shows `[meetings] screen share audio: {label: ..., settings: {... restrictOwnAudio: true ...}}` when sharing a tab/screen with audio. If `restrictOwnAudio` is missing from `settings`, note it in the punch list (constraint accepted but not applied) - do not fail the task.
- Sharer mutes mic, THEN starts a share with audio → the other session still receives a live `screenAudio` track (`audioEls['screen_<uid>'].srcObject.getAudioTracks()[0].enabled === true` in the receiver's console) - Review Focus #5.
- Sharer's preview `<video>` in `#meetingScreenRow` has `muted === true`.
Final audible confirmation is Humayun's hardware test (see Handoff).

- [ ] **Step 7: Commit**

```bash
git add src/lib/meetings.js src/main.js
git commit -m "Round 39: fix screen-share audio echo loop, decouple shared audio from mic mute"
```

---

### Task 3: Speaker (output) picker, test sound, live mic meter, device-change awareness

**Files:**
- Modify: `src/lib/meetings.js:288-294` (`listMediaDevices`)
- Modify: `src/main.js` - module-level helpers (put them right above `function meetingIsHost` at `main.js:4925`), `playRemoteAudio` (`5523`), `attachPulledTrack` screenAudio branch (`5641-5644`), devices modal (`5760-5780`), room cleanup (find `function cleanup` inside `renderMeetingRoom`)

**Interfaces:**
- Produces (module-level in `main.js`, used by Task 4):
  - `savedSpeakerId(): string`, `saveSpeakerId(id: string): void`
  - `applySpeaker(el: HTMLMediaElement): Promise<void>`
  - `playTestTone(sinkId: string): Promise<void>`
  - `startMicMeter(track: MediaStreamTrack, barEl: HTMLElement): () => void` (returns stop fn)
- `listMediaDevices()` now resolves `{ cameras, mics, speakers }`.

- [ ] **Step 1: List speakers**

```js
export async function listMediaDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: devices.filter((d) => d.kind === 'videoinput'),
    mics: devices.filter((d) => d.kind === 'audioinput'),
    // Output devices - only meaningful where HTMLMediaElement.setSinkId
    // exists (Chromium/WebView2 yes; check again for the macOS build).
    speakers: devices.filter((d) => d.kind === 'audiooutput'),
  };
}
```

- [ ] **Step 2: Add the module-level helpers in `main.js`**

```js
// ---- Meetings audio output + mic diagnostics (Round 39) ----
// Speaker choice is a per-computer convenience (which headset is plugged in
// HERE), so localStorage is the right home - not the database.
var MEETING_SPEAKER_KEY = 'bko_meetingSpeakerId';
function savedSpeakerId(){ try { return localStorage.getItem(MEETING_SPEAKER_KEY) || ''; } catch(e){ return ''; } }
function saveSpeakerId(id){ try { if(id) localStorage.setItem(MEETING_SPEAKER_KEY, id); else localStorage.removeItem(MEETING_SPEAKER_KEY); } catch(e){} }
// Routes one <audio> element to the saved speaker. If that device is gone
// (headset unplugged), fall back to the system default instead of going
// silent - Review Focus #1.
function applySpeaker(el){
  if(!el || typeof el.setSinkId !== 'function') return Promise.resolve();
  var id = savedSpeakerId();
  return el.setSinkId(id).catch(function(err){
    console.warn('[meetings] saved speaker unavailable, using default output:', err);
    return el.setSinkId('').catch(function(){});
  });
}
function playTestTone(sinkId){
  var ctx = new AudioContext();
  var ready = (sinkId && typeof ctx.setSinkId === 'function') ? ctx.setSinkId(sinkId) : Promise.resolve();
  return ready.then(function(){
    var osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 660; gain.gain.value = 0.15;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.onended = function(){ ctx.close(); };
    osc.start(); osc.stop(ctx.currentTime + 0.6);
  });
}
// Live level bar for the mic actually in use - makes "what is my mic
// hearing?" visible (Round 39 #5: a headset adapter leaking playback into a
// detached mic input showed up as mystery system audio). Stops itself once
// its bar leaves the DOM (modal closed), so callers can't leak it.
function startMicMeter(track, barEl){
  var ctx = new AudioContext();
  var src = ctx.createMediaStreamSource(new MediaStream([track]));
  var analyser = ctx.createAnalyser(); analyser.fftSize = 512;
  src.connect(analyser);
  var data = new Uint8Array(analyser.fftSize);
  var stopped = false;
  function stop(){ if(stopped) return; stopped = true; clearInterval(timer); try { src.disconnect(); } catch(e){} ctx.close(); }
  var timer = setInterval(function(){
    if(!document.body.contains(barEl)) return stop();
    analyser.getByteTimeDomainData(data);
    var peak = 0;
    for(var i=0;i<data.length;i++){ var v = Math.abs(data[i]-128); if(v>peak) peak = v; }
    barEl.style.width = Math.min(100, Math.round(peak/128*160)) + '%';
  }, 80);
  return stop;
}
```

- [ ] **Step 3: Route every remote audio element through the saved speaker**

In `playRemoteAudio` (`main.js:5524`):

```js
      if(!audioEls[uid]){ audioEls[uid] = document.createElement('audio'); audioEls[uid].autoplay = true; document.body.appendChild(audioEls[uid]); applySpeaker(audioEls[uid]); }
```

In `attachPulledTrack`'s `screenAudio` branch (`main.js:5642`):

```js
          if(!audioEls['screen_'+uid]){ audioEls['screen_'+uid]=document.createElement('audio'); audioEls['screen_'+uid].autoplay=true; document.body.appendChild(audioEls['screen_'+uid]); applySpeaker(audioEls['screen_'+uid]); }
```

- [ ] **Step 4: Rebuild the devices modal**

Replace the `devicesBtn` handler body (`main.js:5760-5780`). Rename the modal title to "Audio & video". New markup and save logic (the echo/noise toggles are added in Task 4 - leave a clearly marked insertion point by building the HTML in an array):

```js
    document.getElementById('devicesBtn').addEventListener('click', function(){
      if(!mainSession) return;
      var curMic = mainSession.stream.getAudioTracks()[0], curCam = mainSession.stream.getVideoTracks()[0];
      meetingsLib.listMediaDevices().then(function(res){
        function opts(list, cur, fallback){ return list.map(function(d,i){ return '<option value="'+escapeHtml(d.deviceId)+'"'+(cur===d.deviceId?' selected':'')+'>'+escapeHtml(d.label||fallback+' '+(i+1))+'</option>'; }).join(''); }
        var micOptions = opts(res.mics, curMic && curMic.getSettings().deviceId, 'Microphone');
        var camOptions = opts(res.cameras, curCam && curCam.getSettings().deviceId, 'Camera');
        var canPickSpeaker = typeof HTMLMediaElement.prototype.setSinkId === 'function' && res.speakers.length > 0;
        var spkOptions = opts(res.speakers, savedSpeakerId() || 'default', 'Speaker');
        var html = [
          '<div class="field"><label>Microphone</label><select name="micId">'+(micOptions||'<option value="">No microphones found</option>')+'</select>',
          '<div class="mic-meter"><div class="mic-meter-bar" id="micMeterBar"></div></div>',
          '<div class="field-hint">'+(curMic ? 'Now using: '+escapeHtml(curMic.label||'unknown mic') : 'No microphone active')+(micOn?'':' (you\'re muted - unmute to see the level)')+'</div></div>',
          canPickSpeaker ? '<div class="field"><label>Speaker / headphones</label><select name="spkId">'+spkOptions+'</select><button type="button" class="btn btn-sm" id="testSpeakerBtn" style="width:auto;margin-top:6px;">Play test sound</button></div>' : '',
          '<div class="field"><label>Camera</label><select name="camId">'+(camOptions||'<option value="">No cameras found</option>')+'</select></div>'
          // Task 4 inserts the audio-processing toggles here
        ];
        openModal('Audio & video', html.join(''), function(fd){
          setModalBusy(true);
          var micId = fd.get('micId'), camId = fd.get('camId'), spkId = fd.get('spkId');
          if(canPickSpeaker && spkId !== null){ saveSpeakerId(spkId === 'default' ? '' : spkId); Object.keys(audioEls).forEach(function(k){ applySpeaker(audioEls[k]); }); }
          Promise.all([
            (micId && (!curMic || curMic.getSettings().deviceId!==micId)) ? meetingsLib.switchDevice(mainSession, 'mic', micId).then(afterMicSwap) : Promise.resolve(),
            (camId && (!curCam || curCam.getSettings().deviceId!==camId)) ? meetingsLib.switchDevice(mainSession, 'camera', camId) : Promise.resolve(),
          ]).then(function(){
            closeModal(); showToast('success','Devices updated');
          }).catch(function(err){ showModalError(errMsg(err)); });
        }, 'Save');
        var bar = document.getElementById('micMeterBar');
        if(bar && curMic) startMicMeter(curMic, bar);
        var testBtn = document.getElementById('testSpeakerBtn');
        if(testBtn) testBtn.addEventListener('click', function(){
          var sel = document.querySelector('select[name="spkId"]');
          var id = sel ? sel.value : '';
          playTestTone(id === 'default' ? '' : id).catch(function(err){ showToast('error', 'Could not play on that device - '+errMsg(err)); });
        });
      }).catch(function(err){ showToast('error', errMsg(err)); });
    });
```

`afterMicSwap` is defined in Task 4 Step 6; until then add a temporary one-liner inside `renderMeetingRoom` so the build passes: `function afterMicSwap(track){ return track; }` - Task 4 replaces it.

Add CSS to `src/style.css` (next to the other meeting styles - search `.meeting-tile`):

```css
.mic-meter{height:6px;border-radius:3px;background:var(--surface-2, rgba(127,127,127,.2));overflow:hidden;margin-top:8px;}
.mic-meter-bar{height:100%;width:0;background:var(--blue);transition:width .08s linear;}
.field-hint{font-size:12px;opacity:.7;margin-top:6px;}
```

(If `--surface-2` doesn't exist in `style.css`, use the existing surface token nearest to it - grep `--surface` first.)

- [ ] **Step 5: React to devices appearing/disappearing mid-call**

Inside `renderMeetingRoom`, once `mainSession` is set (next to where `stopHealthWatch` is wired), add:

```js
      // Round 39: tell people when their mic changes under them (unplugged
      // headset, Windows switching the default device) instead of silently
      // sending whatever the new device hears.
      var lastMicLabel = (mainSession.stream.getAudioTracks()[0]||{}).label || '';
      function onMeetingDeviceChange(){
        if(!mainSession) return;
        var t = mainSession.stream.getAudioTracks()[0];
        if(t && t.readyState === 'ended'){
          meetingsLib.switchDevice(mainSession, 'mic', 'default').then(function(nt){
            afterMicSwap(nt);
            lastMicLabel = nt.label || '';
            showToast('info', 'Your microphone was disconnected - now using: '+(nt.label||'default microphone'));
          }).catch(function(err){ showToast('error', 'Microphone disconnected and no other microphone was found - '+errMsg(err)); });
          return;
        }
        if(t && t.label && t.label !== lastMicLabel){
          lastMicLabel = t.label;
          showToast('info', 'Microphone is now: '+t.label);
        }
        Object.keys(audioEls).forEach(function(k){ applySpeaker(audioEls[k]); });
      }
      navigator.mediaDevices.addEventListener('devicechange', onMeetingDeviceChange);
```

And in the room's `cleanup()` add:

```js
      navigator.mediaDevices.removeEventListener('devicechange', onMeetingDeviceChange);
```

(`onMeetingDeviceChange` must be declared in a scope `cleanup()` can see - declare `var onMeetingDeviceChange = function(){};` next to the other room-level vars such as `stopHealthWatch`, and assign it here.)

- [ ] **Step 6: Build and verify**

Run: `npm run build` - Expected: success.
In the dev browser: open the devices modal, confirm the Speaker select lists outputs (labels appear because mic permission is already granted), "Play test sound" beeps, the meter moves when you make noise. Review Focus #1: in the console set a bogus saved id and apply it - `localStorage.setItem('bko_meetingSpeakerId','nope'); ` then open/close modal or call `applySpeaker` via the next remote join - expect the console warning and audio still playing on default.

- [ ] **Step 7: Commit**

```bash
git add src/lib/meetings.js src/main.js src/style.css
git commit -m "Round 39: speaker picker, test sound, mic level meter, device-change notices in Meetings"
```

---

### Task 4: Echo-cancellation / noise-suppression toggles; device switches keep mute state and recording audio

**Decision (mainstream behavior):** Google Meet always processes the mic (no toggle). Zoom has "Original sound for musicians" (turns processing off), Discord has separate Echo Cancellation and Noise Suppression switches. We do Discord-style: two switches, **both ON by default**, with a hint that they should only be turned off with headphones. Auto gain control follows the noise-suppression switch.

**Files:**
- Modify: `src/lib/meetings.js:312-361` (`startLocalSession`, `switchDevice`)
- Modify: `src/main.js` - devices modal (Task 3's insertion point), `renderMeetingRoom` (`afterMicSwap`), health-watch `onReacquired` callback

**Interfaces:**
- Consumes: Task 3's modal structure.
- Produces (exported from `meetings.js`):
  - `getMicProcessing(): { echoCancellation: boolean, noiseSuppression: boolean }`
  - `setMicProcessing(p: { echoCancellation: boolean, noiseSuppression: boolean }): void`
  - `switchDevice(session, kind, deviceId)` - unchanged signature; now preserves `enabled` and applies processing prefs to mics.
- Produces (in `main.js`, inside `renderMeetingRoom`): `afterMicSwap(track: MediaStreamTrack): MediaStreamTrack`

- [ ] **Step 1: Processing prefs + constraint builder in `meetings.js`** (top of file, after imports)

```js
// Mic processing preferences (Round 39) - a per-computer choice (depends on
// whether THIS machine uses headphones), so localStorage, same as music.js.
const MIC_PROCESSING_KEY = 'bko_micProcessing';
export function getMicProcessing() {
  try {
    const v = JSON.parse(localStorage.getItem(MIC_PROCESSING_KEY) || 'null');
    if (v && typeof v.echoCancellation === 'boolean' && typeof v.noiseSuppression === 'boolean') return v;
  } catch (e) {}
  return { echoCancellation: true, noiseSuppression: true };
}
export function setMicProcessing(p) {
  try { localStorage.setItem(MIC_PROCESSING_KEY, JSON.stringify({ echoCancellation: !!p.echoCancellation, noiseSuppression: !!p.noiseSuppression })); } catch (e) {}
}
function micConstraints(micId) {
  const p = getMicProcessing();
  const c = { echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.noiseSuppression };
  if (micId) c.deviceId = { exact: micId };
  return c;
}
```

- [ ] **Step 2: Use it when joining**

In `startLocalSession` replace the audio constraint:

```js
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(deviceIds && deviceIds.micId),
    });
```

- [ ] **Step 3: Use it when switching, and keep mute state**

Replace `switchDevice`:

```js
export async function switchDevice(session, kind, deviceId) {
  const constraints = kind === 'camera'
    ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } } }
    : { audio: micConstraints(deviceId) };
  let newStream;
  try {
    newStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    throw new Error(describeMediaError(err, kind === 'camera' ? 'camera' : 'microphone'));
  }
  const newTrack = kind === 'camera' ? newStream.getVideoTracks()[0] : newStream.getAudioTracks()[0];
  const oldTrack = kind === 'camera' ? session.stream.getVideoTracks()[0] : session.stream.getAudioTracks()[0];
  // Round 39, real privacy bug: a brand-new track is always enabled, so a
  // MUTED person who switched mic (or toggled echo cancellation) went live
  // without knowing. Carry the old track's on/off state across.
  newTrack.enabled = oldTrack ? oldTrack.enabled : true;
  const sender = session.pc.getSenders().find((s) => s.track && s.track.kind === newTrack.kind);
  if (sender) await sender.replaceTrack(newTrack);
  if (oldTrack) { session.stream.removeTrack(oldTrack); oldTrack.stop(); }
  session.stream.addTrack(newTrack);
  return newTrack;
}
```

Note: `startDeviceHealthWatch` passes the old track's `deviceId` - unchanged, and now also gets processing prefs + mute preservation for free.

- [ ] **Step 4: Toggles in the modal**

At Task 3's insertion point add (after the Camera field):

```js
          ,'<div class="field"><label>Audio processing</label>'+
            '<label class="check-row"><input type="checkbox" name="procEC"'+(meetingsLib.getMicProcessing().echoCancellation?' checked':'')+'> Echo cancellation</label>'+
            '<label class="check-row"><input type="checkbox" name="procNS"'+(meetingsLib.getMicProcessing().noiseSuppression?' checked':'')+'> Noise suppression &amp; auto volume</label>'+
            '<div class="field-hint">Leave both on unless you\'re wearing headphones and need people to hear music or an instrument exactly as it sounds (like Zoom\'s "Original sound").</div></div>'
```

(Check `style.css` for an existing checkbox-row class used in other modals - grep `type="checkbox"` in `main.js` - and reuse it instead of `check-row` if one exists.)

In the save callback, before `Promise.all`, compute:

```js
          var prevProc = meetingsLib.getMicProcessing();
          var nextProc = { echoCancellation: fd.get('procEC') === 'on', noiseSuppression: fd.get('procNS') === 'on' };
          var procChanged = prevProc.echoCancellation !== nextProc.echoCancellation || prevProc.noiseSuppression !== nextProc.noiseSuppression;
          meetingsLib.setMicProcessing(nextProc);
          var micChanged = micId && (!curMic || curMic.getSettings().deviceId !== micId);
          var micTarget = micChanged ? micId : (curMic && curMic.getSettings().deviceId);
```

and replace the mic entry of `Promise.all` with:

```js
            ((micChanged || procChanged) && micTarget) ? meetingsLib.switchDevice(mainSession, 'mic', micTarget).then(afterMicSwap) : Promise.resolve(),
```

- [ ] **Step 5: Verify mute preservation (Review Focus #2)**

In the dev browser: join, mute, open the modal, toggle echo cancellation off, Save. Console:
`mainSession` isn't global - instead verify via the other session: the receiver's `audioEls['<uid>'].srcObject.getAudioTracks()[0]` stays silent (`muted` flag from the SFU is true while sender is disabled), and the mic button still shows muted. Also on the sender, log from inside `afterMicSwap` (Step 6) `console.log('[meetings] mic swapped', track.label, 'enabled:', track.enabled, track.getSettings())` - expect `enabled: false` and `echoCancellation: false` in settings.

- [ ] **Step 6: Recording follows mic swaps (Review Focus #3)**

Replace the temporary `afterMicSwap` from Task 3 inside `renderMeetingRoom`:

```js
    // Round 39: the recorder's Web Audio source is bound to the exact track
    // it was given; switchDevice() stops that track, so without this the
    // host's own voice silently vanished from a recording after any mic
    // switch. Connect the new track too (the old, stopped one just goes silent).
    function afterMicSwap(track){
      console.log('[meetings] mic swapped', track && track.label, 'enabled:', track && track.enabled, track && track.getSettings && track.getSettings());
      if(track && iAmRecording && recorder) recorder.addAudioSource(new MediaStream([track]));
      return track;
    }
```

And in the `startDeviceHealthWatch(...)` call's `onReacquired` callback add:

```js
          if(kind === 'mic') afterMicSwap(mainSession.stream.getAudioTracks()[0]);
```

- [ ] **Step 7: Build**

Run: `npm run build` - Expected: success.

- [ ] **Step 8: Commit**

```bash
git add src/lib/meetings.js src/main.js src/style.css
git commit -m "Round 39: echo cancellation/noise suppression toggles; device switches keep mute state and recording audio"
```

---

### Task 5: Recordings become regular MP4s (native in-place converter)

**Why this approach:** Chromium can only record fragmented MP4. Options considered: (a) bundle ffmpeg as a sidecar (`-c copy -movflags +faststart`) - proven, but +30-90 MB installer and a second binary for macOS; (b) byte-patch durations (last round - not sufficient, see Root causes); (c) **chosen:** a small Rust converter that reads only the small fragment headers, writes a complete regular `moov` (full sample tables) at the end of the file, and relabels the old `moov`/`moof`/`mfra` boxes as `free` (a standard "ignore me" box type). Media bytes never move, so a multi-GB 3-hour file converts in seconds with no extra disk space and no re-encoding. If it ever fails, the file is left untouched and the old fallback runs. If Windows Media Player still misbehaves after this, fall back to option (a).

**Files:**
- Create: `src-tauri/src/mp4fix.rs`
- Create: `src-tauri/tests/fixtures/rec-45s.mp4`, `rec-frag-moof.mp4`, `rec-frag-explicit.mp4`
- Modify: `src-tauri/src/main.rs` (module + handler)
- Modify: `src/lib/recorder.js:252-254` (call converter) and `:332` (fallback offset fix)
- Modify: `src/main.js` record-button stop branch (`~5783`) - "Finalizing" toast

**Interfaces:**
- Produces: Tauri command `mp4_defragment(path: String) -> Result<DefragReport, String>`, where `DefragReport { fragments: usize, samples: usize, duration_secs: f64 }` (serde default, so JS receives snake_case keys: `{ fragments, samples, duration_secs }`). JS: `invoke('mp4_defragment', { path })`.

- [ ] **Step 1: Create the test fixtures**

The scratch recordings from the earlier investigation contain a single fragment, so also generate multi-fragment variants with ffmpeg (covers both ways a fragment can point at its data):

```bash
mkdir -p src-tauri/tests/fixtures
cp "C:/Users/Humay/AppData/Local/Temp/claude/E--Project-Management-Software-projectmanagementreal/935551a4-bd62-46cc-8d59-6f1393e836c2/scratchpad/longtest.mp4" src-tauri/tests/fixtures/rec-45s.mp4
ffmpeg -v error -y -i src-tauri/tests/fixtures/rec-45s.mp4 -c copy -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000 src-tauri/tests/fixtures/rec-frag-moof.mp4
ffmpeg -v error -y -i src-tauri/tests/fixtures/rec-45s.mp4 -c copy -movflags frag_keyframe+empty_moov -frag_duration 1000000 src-tauri/tests/fixtures/rec-frag-explicit.mp4
```

(If the scratchpad file is gone, record a ~30s test in the current app build and use that instead. Keep each fixture under ~2 MB.) Confirm the new ones really have multiple fragments:

```bash
python "C:/Users/Humay/AppData/Local/Temp/claude/E--Project-Management-Software-projectmanagementreal/935551a4-bd62-46cc-8d59-6f1393e836c2/scratchpad/mp4_inspect.py" src-tauri/tests/fixtures/rec-frag-moof.mp4 | grep -c "^moof"
```
Expected: a number > 1. (Note: that inspector script has the same wrong tkhd offset, 36 instead of 28 - ignore its tkhd line.)

Ask Humayun for one real 1-2 minute recording from the current build too; if under ~10 MB add it as `rec-real.mp4` and include it in the test lists below.

- [ ] **Step 2: Write the failing tests** - create `src-tauri/src/mp4fix.rs` with only the tests module and stub:

```rust
// Fragmented-MP4 -> regular-MP4 converter for Meetings recordings (Round 39).
// See docs/superpowers/plans/2026-09-25-round-39-meetings-audio-mp4.md.
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct DefragReport { pub fragments: usize, pub samples: usize, pub duration_secs: f64 }

pub fn defragment_in_place(_path: &Path) -> Result<DefragReport, String> {
    Err("not implemented".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::path::PathBuf;
    use std::process::Command;

    const FIXTURES: [&str; 3] = ["rec-45s.mp4", "rec-frag-moof.mp4", "rec-frag-explicit.mp4"];

    fn fixture_copy(name: &str, tag: &str) -> PathBuf {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
        let dst = std::env::temp_dir().join(format!("bko-mp4fix-{}-{}-{}", std::process::id(), tag, name));
        std::fs::copy(&src, &dst).unwrap();
        dst
    }

    fn top_types(path: &Path) -> Vec<String> {
        let mut f = File::open(path).unwrap();
        let len = f.metadata().unwrap().len();
        let mut out = vec![];
        let mut pos = 0;
        while let Some(h) = read_hdr(&mut f, pos, len).unwrap() {
            out.push(String::from_utf8_lossy(&h.typ).to_string());
            pos = h.start + h.size;
        }
        out
    }

    #[test]
    fn converts_to_single_trailing_moov_without_fragments() {
        for name in FIXTURES {
            let p = fixture_copy(name, "conv");
            let before = std::fs::metadata(&p).unwrap().len();
            let rep = defragment_in_place(&p).unwrap();
            let types = top_types(&p);
            assert!(!types.iter().any(|t| t == "moof" || t == "mfra"), "{}: {:?}", name, types);
            assert_eq!(types.iter().filter(|t| *t == "moov").count(), 1, "{}", name);
            assert_eq!(types.last().unwrap(), "moov", "{}", name);
            assert!(std::fs::metadata(&p).unwrap().len() > before);
            assert!(rep.samples > 0 && rep.fragments > 0 && rep.duration_secs > 1.0, "{}: {:?}", name, rep);
        }
    }

    #[test]
    fn second_run_refuses_and_leaves_file_untouched() {
        let p = fixture_copy("rec-frag-moof.mp4", "twice");
        defragment_in_place(&p).unwrap();
        let before = std::fs::read(&p).unwrap();
        let err = defragment_in_place(&p).unwrap_err();
        assert!(err.contains("no moof"), "{}", err);
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }

    #[test]
    fn truncated_file_is_rejected_without_modification() {
        let p = fixture_copy("rec-frag-moof.mp4", "trunc");
        let data = std::fs::read(&p).unwrap();
        std::fs::write(&p, &data[..data.len() - 1000]).unwrap();
        let before = std::fs::read(&p).unwrap();
        assert!(defragment_in_place(&p).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }

    fn probe(p: &Path, args: &[&str]) -> Option<String> {
        let o = Command::new("ffprobe").args(args).arg(p).output().ok()?;
        if !o.status.success() { return None; }
        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
    }

    #[test]
    fn ffmpeg_sees_identical_media_after_conversion() {
        for name in FIXTURES {
            let orig = fixture_copy(name, "orig");
            let fixed = fixture_copy(name, "fixed");
            defragment_in_place(&fixed).unwrap();
            let frames = ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"];
            let Some(f_before) = probe(&orig, &frames) else { eprintln!("ffprobe not on PATH - skipping"); return; };
            assert_eq!(f_before, probe(&fixed, &frames).unwrap(), "{} video frames", name);
            let pkts = ["-v", "error", "-select_streams", "a:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"];
            assert_eq!(probe(&orig, &pkts).unwrap(), probe(&fixed, &pkts).unwrap(), "{} audio packets", name);
            let dur = ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"];
            let d0: f64 = probe(&orig, &dur).unwrap().parse().unwrap();
            let d1: f64 = probe(&fixed, &dur).unwrap().parse().unwrap();
            assert!((d0 - d1).abs() < 0.15, "{} duration {} vs {}", name, d0, d1);
            let dec = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&fixed).args(["-f", "null", "-"]).output().unwrap();
            assert!(dec.stderr.is_empty(), "{} decode errors: {}", name, String::from_utf8_lossy(&dec.stderr));
        }
    }
}
```

Add `mod mp4fix;` to `main.rs` (next to `mod timelog;`) so it compiles.

- [ ] **Step 3: Run the tests to see them fail**

Run (from `src-tauri/`): `cargo test mp4fix`
Expected: compile error "cannot find function `read_hdr`" - that's the expected failure (the helper doesn't exist yet).

- [ ] **Step 4: Implement the converter** - replace the stub (keep the tests module) with:

```rust
// Fragmented-MP4 -> regular-MP4 converter for Meetings recordings (Round 39).
//
// Chromium's MediaRecorder can only write FRAGMENTED MP4: an empty index up
// front (moov with empty sample tables + mvex), then many moof+mdat pairs.
// VLC/ffmpeg cope; Windows' own Media Player treats it like a live stream.
// This builds the full index the fragments describe (every sample's size,
// duration, keyframe flag and file position) as a normal moov, appends it at
// the END of the file, then relabels the old moov/moof/mfra boxes as 'free'
// (the standard "ignore this box" type). Media data never moves: a multi-GB
// recording converts in seconds, needs no extra disk space, no re-encode.
// Any parse problem -> Err before a single byte is written.
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct DefragReport { pub fragments: usize, pub samples: usize, pub duration_secs: f64 }

fn be32(b: &[u8], p: usize) -> Result<u32, String> {
    b.get(p..p + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| format!("read past end of box at {}", p))
}
fn be64(b: &[u8], p: usize) -> Result<u64, String> {
    b.get(p..p + 8).map(|s| { let mut a = [0u8; 8]; a.copy_from_slice(s); u64::from_be_bytes(a) }).ok_or_else(|| format!("read past end of box at {}", p))
}
fn version(b: &[u8]) -> Result<u8, String> { b.first().copied().ok_or_else(|| "empty full box".to_string()) }

#[derive(Clone, Copy, Debug)]
struct BoxHdr { typ: [u8; 4], start: u64, header_len: u64, size: u64 }

fn read_hdr<R: Read + Seek>(f: &mut R, pos: u64, file_len: u64) -> Result<Option<BoxHdr>, String> {
    if pos == file_len { return Ok(None); }
    if pos + 8 > file_len { return Err(format!("{} stray bytes at end of file (truncated recording?)", file_len - pos)); }
    f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
    let mut h = [0u8; 8];
    f.read_exact(&mut h).map_err(|e| e.to_string())?;
    let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]);
    let typ = [h[4], h[5], h[6], h[7]];
    let (size, header_len) = match size32 {
        0 => (file_len - pos, 8),
        1 => { let mut b = [0u8; 8]; f.read_exact(&mut b).map_err(|e| e.to_string())?; (u64::from_be_bytes(b), 16) }
        n => (n as u64, 8),
    };
    if size < header_len || pos + size > file_len {
        return Err(format!("box '{}' at {} runs past end of file (truncated recording?)", String::from_utf8_lossy(&typ), pos));
    }
    Ok(Some(BoxHdr { typ, start: pos, header_len, size }))
}

fn read_body<R: Read + Seek>(f: &mut R, h: &BoxHdr) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; (h.size - h.header_len) as usize];
    f.seek(SeekFrom::Start(h.start + h.header_len)).map_err(|e| e.to_string())?;
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

struct Child<'a> { typ: [u8; 4], body: &'a [u8], raw: &'a [u8] }

fn children(buf: &[u8]) -> Result<Vec<Child<'_>>, String> {
    let mut out = Vec::new();
    let mut p = 0usize;
    while p + 8 <= buf.len() {
        let size32 = be32(buf, p)? as usize;
        let typ = [buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]];
        let (size, hl) = match size32 { 0 => (buf.len() - p, 8), 1 => (be64(buf, p + 8)? as usize, 16), n => (n, 8) };
        if size < hl || p + size > buf.len() {
            return Err(format!("malformed '{}' box at {}", String::from_utf8_lossy(&typ), p));
        }
        out.push(Child { typ, body: &buf[p + hl..p + size], raw: &buf[p..p + size] });
        p += size;
    }
    Ok(out)
}

fn find<'a>(kids: &'a [Child<'a>], typ: &[u8; 4]) -> Result<&'a Child<'a>, String> {
    kids.iter().find(|k| &k.typ == typ).ok_or_else(|| format!("missing '{}' box", String::from_utf8_lossy(typ)))
}

fn make_box(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 8);
    v.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    v.extend_from_slice(typ);
    v.extend_from_slice(body);
    v
}
fn make_full_box(typ: &[u8; 4], ver: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(body.len() + 4);
    b.push(ver);
    b.extend_from_slice(&flags.to_be_bytes()[1..]);
    b.extend_from_slice(body);
    make_box(typ, &b)
}

#[derive(Clone, Copy)]
struct Sample { size: u32, duration: u32, flags: u32, cto: i32 }

struct Track {
    id: u32,
    media_timescale: u32,
    trex_duration: u32,
    trex_size: u32,
    trex_flags: u32,
    samples: Vec<Sample>,
    chunks: Vec<(u64, u32)>, // (absolute file offset, sample count) - one per trun
    first_dts: Option<u64>,
    next_dts: u64,
}

fn track_id_and_timescale(trak_body: &[u8]) -> Result<(u32, u32), String> {
    let kids = children(trak_body)?;
    let tkhd = find(&kids, b"tkhd")?;
    let id = if version(tkhd.body)? == 1 { be32(tkhd.body, 20)? } else { be32(tkhd.body, 12)? };
    let mdia = find(&kids, b"mdia")?;
    let mk = children(mdia.body)?;
    let mdhd = find(&mk, b"mdhd")?;
    let ts = if version(mdhd.body)? == 1 { be32(mdhd.body, 20)? } else { be32(mdhd.body, 12)? };
    if ts == 0 { return Err(format!("track {} has timescale 0", id)); }
    Ok((id, ts))
}

fn parse_moof(moof_start: u64, body: &[u8], tracks: &mut [Track]) -> Result<(), String> {
    let mut prev_traf_end: Option<u64> = None;
    for traf in children(body)?.iter().filter(|c| &c.typ == b"traf") {
        let kids = children(traf.body)?;
        let tfhd = find(&kids, b"tfhd")?.body;
        let flags = be32(tfhd, 0)? & 0x00FF_FFFF;
        let track_id = be32(tfhd, 4)?;
        let mut p = 8;
        let mut explicit_base = None;
        if flags & 0x1 != 0 { explicit_base = Some(be64(tfhd, p)?); p += 8; }
        if flags & 0x2 != 0 { p += 4; }
        let mut def_dur = None; if flags & 0x8 != 0 { def_dur = Some(be32(tfhd, p)?); p += 4; }
        let mut def_size = None; if flags & 0x10 != 0 { def_size = Some(be32(tfhd, p)?); p += 4; }
        let mut def_flags = None; if flags & 0x20 != 0 { def_flags = Some(be32(tfhd, p)?); }
        // ISO 14496-12 8.8.7: explicit base > default-base-is-moof > (first traf: moof start, later trafs: end of previous traf's data)
        let base = match explicit_base {
            Some(b) => b,
            None if flags & 0x2_0000 != 0 => moof_start,
            None => prev_traf_end.unwrap_or(moof_start),
        };
        let t = tracks.iter_mut().find(|t| t.id == track_id).ok_or_else(|| format!("fragment for unknown track {}", track_id))?;
        let dur_d = def_dur.unwrap_or(t.trex_duration);
        let size_d = def_size.unwrap_or(t.trex_size);
        let flags_d = def_flags.unwrap_or(t.trex_flags);
        if let Some(tfdt) = kids.iter().find(|k| &k.typ == b"tfdt") {
            let dts = if version(tfdt.body)? == 1 { be64(tfdt.body, 4)? } else { be32(tfdt.body, 4)? as u64 };
            if t.samples.is_empty() {
                t.first_dts = Some(dts);
                t.next_dts = dts;
            } else if dts > t.next_dts {
                // Gap between fragments (dropped frames): stretch the previous sample so A/V stay in sync.
                let gap = (dts - t.next_dts).min(u32::MAX as u64) as u32;
                if let Some(last) = t.samples.last_mut() { last.duration = last.duration.saturating_add(gap); }
                t.next_dts = dts;
            }
        }
        let mut cursor = base;
        for trun in kids.iter().filter(|k| &k.typ == b"trun") {
            let b = trun.body;
            let ver = version(b)?;
            let fl = be32(b, 0)? & 0x00FF_FFFF;
            let count = be32(b, 4)?;
            let mut p = 8;
            if fl & 0x1 != 0 { let off = be32(b, p)? as i32; cursor = (base as i64 + off as i64) as u64; p += 4; }
            let mut first_flags = None; if fl & 0x4 != 0 { first_flags = Some(be32(b, p)?); p += 4; }
            let chunk_start = cursor;
            for i in 0..count {
                let duration = if fl & 0x100 != 0 { let v = be32(b, p)?; p += 4; v } else { dur_d };
                let size = if fl & 0x200 != 0 { let v = be32(b, p)?; p += 4; v } else { size_d };
                let mut sflags = if fl & 0x400 != 0 { let v = be32(b, p)?; p += 4; v } else { flags_d };
                if i == 0 { if let Some(ff) = first_flags { sflags = ff; } }
                let cto = if fl & 0x800 != 0 { let v = be32(b, p)?; p += 4; if ver == 0 { v.min(i32::MAX as u32) as i32 } else { v as i32 } } else { 0 };
                t.samples.push(Sample { size, duration, flags: sflags, cto });
                t.next_dts += duration as u64;
                cursor += size as u64;
            }
            if count > 0 { t.chunks.push((chunk_start, count)); }
        }
        prev_traf_end = Some(cursor);
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum DurKind { Mvhd, Tkhd, Mdhd }

// Copies a full box (raw, 8-byte header) with its duration field replaced.
// Offsets per ISO 14496-12 (body offsets after the 4-byte version/flags):
// mvhd/mdhd v1 @24 (u64), v0 @16 (u32); tkhd v1 @28 (u64), v0 @20 (u32).
fn patch_duration(raw: &[u8], kind: DurKind, dur: u64) -> Result<Vec<u8>, String> {
    let mut out = raw.to_vec();
    let ver = *out.get(8).ok_or("empty full box")?;
    let body_off = match (kind, ver) {
        (DurKind::Tkhd, 1) => 28, (DurKind::Tkhd, 0) => 20,
        (_, 1) => 24, (_, 0) => 16,
        _ => return Err(format!("unsupported box version {}", ver)),
    };
    let off = 8 + body_off;
    if ver == 1 {
        out.get_mut(off..off + 8).ok_or("short box")?.copy_from_slice(&dur.to_be_bytes());
    } else {
        let d = u32::try_from(dur).map_err(|_| "duration too large for a version-0 box".to_string())?;
        out.get_mut(off..off + 4).ok_or("short box")?.copy_from_slice(&d.to_be_bytes());
    }
    Ok(out)
}

fn build_stbl(stsd_raw: &[u8], t: &Track) -> Vec<u8> {
    let mut body = stsd_raw.to_vec();

    let mut stts: Vec<(u32, u32)> = vec![];
    for s in &t.samples { match stts.last_mut() { Some((c, d)) if *d == s.duration => *c += 1, _ => stts.push((1, s.duration)) } }
    let mut b = (stts.len() as u32).to_be_bytes().to_vec();
    for (c, d) in &stts { b.extend_from_slice(&c.to_be_bytes()); b.extend_from_slice(&d.to_be_bytes()); }
    body.extend(make_full_box(b"stts", 0, 0, &b));

    if t.samples.iter().any(|s| s.cto != 0) {
        let mut runs: Vec<(u32, i32)> = vec![];
        for s in &t.samples { match runs.last_mut() { Some((c, o)) if *o == s.cto => *c += 1, _ => runs.push((1, s.cto)) } }
        let ver = if t.samples.iter().any(|s| s.cto < 0) { 1 } else { 0 };
        let mut b = (runs.len() as u32).to_be_bytes().to_vec();
        for (c, o) in &runs { b.extend_from_slice(&c.to_be_bytes()); b.extend_from_slice(&o.to_be_bytes()); }
        body.extend(make_full_box(b"ctts", ver, 0, &b));
    }

    // sample_is_non_sync_sample = bit 16 of sample flags. Omit stss when every sample is a keyframe (audio).
    if t.samples.iter().any(|s| s.flags & 0x0001_0000 != 0) {
        let sync: Vec<u32> = t.samples.iter().enumerate().filter(|(_, s)| s.flags & 0x0001_0000 == 0).map(|(i, _)| i as u32 + 1).collect();
        let mut b = (sync.len() as u32).to_be_bytes().to_vec();
        for n in &sync { b.extend_from_slice(&n.to_be_bytes()); }
        body.extend(make_full_box(b"stss", 0, 0, &b));
    }

    let mut stsc: Vec<(u32, u32)> = vec![];
    for (i, (_, n)) in t.chunks.iter().enumerate() { if stsc.last().map(|l| l.1) != Some(*n) { stsc.push((i as u32 + 1, *n)); } }
    let mut b = (stsc.len() as u32).to_be_bytes().to_vec();
    for (first, n) in &stsc { b.extend_from_slice(&first.to_be_bytes()); b.extend_from_slice(&n.to_be_bytes()); b.extend_from_slice(&1u32.to_be_bytes()); }
    body.extend(make_full_box(b"stsc", 0, 0, &b));

    let mut b = 0u32.to_be_bytes().to_vec();
    b.extend_from_slice(&(t.samples.len() as u32).to_be_bytes());
    for s in &t.samples { b.extend_from_slice(&s.size.to_be_bytes()); }
    body.extend(make_full_box(b"stsz", 0, 0, &b));

    let mut b = (t.chunks.len() as u32).to_be_bytes().to_vec();
    for (off, _) in &t.chunks { b.extend_from_slice(&off.to_be_bytes()); }
    body.extend(make_full_box(b"co64", 0, 0, &b));

    make_box(b"stbl", &body)
}

fn make_edts(delay_movie: u64, dur_movie: u64) -> Vec<u8> {
    let mut e = 2u32.to_be_bytes().to_vec();
    e.extend_from_slice(&delay_movie.to_be_bytes()); e.extend_from_slice(&(-1i64).to_be_bytes()); e.extend_from_slice(&[0, 1, 0, 0]);
    e.extend_from_slice(&dur_movie.to_be_bytes()); e.extend_from_slice(&0i64.to_be_bytes()); e.extend_from_slice(&[0, 1, 0, 0]);
    make_box(b"edts", &make_full_box(b"elst", 1, 0, &e))
}

fn rebuild_minf(body: &[u8], t: &Track) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    for k in children(body)? {
        if &k.typ == b"stbl" {
            let sk = children(k.body)?;
            out.extend(build_stbl(find(&sk, b"stsd")?.raw, t));
        } else { out.extend_from_slice(k.raw); }
    }
    Ok(make_box(b"minf", &out))
}

fn rebuild_mdia(body: &[u8], t: &Track, media_dur: u64) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    for k in children(body)? {
        match &k.typ {
            b"mdhd" => out.extend(patch_duration(k.raw, DurKind::Mdhd, media_dur)?),
            b"minf" => out.extend(rebuild_minf(k.body, t)?),
            _ => out.extend_from_slice(k.raw),
        }
    }
    Ok(make_box(b"mdia", &out))
}

fn rebuild_trak(body: &[u8], t: &Track, media_dur: u64, delay_movie: u64, dur_movie: u64) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    for k in children(body)? {
        match &k.typ {
            b"tkhd" => {
                out.extend(patch_duration(k.raw, DurKind::Tkhd, delay_movie + dur_movie)?);
                if delay_movie > 0 { out.extend(make_edts(delay_movie, dur_movie)); }
            }
            b"edts" => {} // replaced above when needed
            b"mdia" => out.extend(rebuild_mdia(k.body, t, media_dur)?),
            _ => out.extend_from_slice(k.raw),
        }
    }
    Ok(make_box(b"trak", &out))
}

fn rebuild_moov(moov_body: &[u8], tracks: &[Track]) -> Result<(Vec<u8>, f64), String> {
    let kids = children(moov_body)?;
    let mvhd = find(&kids, b"mvhd")?;
    let movie_ts = (if version(mvhd.body)? == 1 { be32(mvhd.body, 20)? } else { be32(mvhd.body, 12)? }) as u64;
    if movie_ts == 0 { return Err("movie timescale is 0".into()); }
    let mut movie_dur = 0u64;
    let mut per: Vec<(u32, u64, u64, u64)> = vec![]; // (id, media_dur, delay_movie, dur_movie)
    for t in tracks {
        let media_dur: u64 = t.samples.iter().map(|s| s.duration as u64).sum();
        let ts = t.media_timescale as u64;
        let delay_movie = t.first_dts.unwrap_or(0) * movie_ts / ts;
        let dur_movie = media_dur * movie_ts / ts;
        movie_dur = movie_dur.max(delay_movie + dur_movie);
        per.push((t.id, media_dur, delay_movie, dur_movie));
    }
    let mut out = vec![];
    for k in &kids {
        match &k.typ {
            b"mvhd" => out.extend(patch_duration(k.raw, DurKind::Mvhd, movie_dur)?),
            b"mvex" => {}
            b"trak" => {
                let (id, _) = track_id_and_timescale(k.body)?;
                let t = tracks.iter().find(|t| t.id == id).ok_or("trak/track mismatch")?;
                let &(_, media_dur, delay, dur_movie) = per.iter().find(|p| p.0 == id).ok_or("trak/track mismatch")?;
                out.extend(rebuild_trak(k.body, t, media_dur, delay, dur_movie)?);
            }
            _ => out.extend_from_slice(k.raw),
        }
    }
    Ok((make_box(b"moov", &out), movie_dur as f64 / movie_ts as f64))
}

fn write_type(f: &mut File, box_start: u64, typ: &[u8; 4]) -> Result<(), String> {
    f.seek(SeekFrom::Start(box_start + 4)).map_err(|e| e.to_string())?;
    f.write_all(typ).map_err(|e| e.to_string())
}

pub fn defragment_in_place(path: &Path) -> Result<DefragReport, String> {
    let mut f = OpenOptions::new().read(true).write(true).open(path).map_err(|e| format!("could not open recording: {}", e))?;
    let file_len = f.metadata().map_err(|e| e.to_string())?.len();

    // 1. Parse everything first. No writes happen unless this whole block succeeds.
    let mut top = vec![];
    let mut pos = 0u64;
    while let Some(h) = read_hdr(&mut f, pos, file_len)? { pos = h.start + h.size; top.push(h); }
    let moovs: Vec<BoxHdr> = top.iter().copied().filter(|h| &h.typ == b"moov").collect();
    if moovs.len() != 1 { return Err(format!("expected exactly one moov box, found {}", moovs.len())); }
    let moov_h = moovs[0];
    let moof_hdrs: Vec<BoxHdr> = top.iter().copied().filter(|h| &h.typ == b"moof").collect();
    if moof_hdrs.is_empty() { return Err("no moof boxes - already a regular MP4, nothing to do".into()); }

    let moov_body = read_body(&mut f, &moov_h)?;
    let moov_kids = children(&moov_body)?;
    let mut tracks = vec![];
    for k in moov_kids.iter().filter(|k| &k.typ == b"trak") {
        let (id, ts) = track_id_and_timescale(k.body)?;
        tracks.push(Track { id, media_timescale: ts, trex_duration: 0, trex_size: 0, trex_flags: 0, samples: vec![], chunks: vec![], first_dts: None, next_dts: 0 });
    }
    if let Some(mvex) = moov_kids.iter().find(|k| &k.typ == b"mvex") {
        for trex in children(mvex.body)?.iter().filter(|k| &k.typ == b"trex") {
            let id = be32(trex.body, 4)?;
            if let Some(t) = tracks.iter_mut().find(|t| t.id == id) {
                t.trex_duration = be32(trex.body, 12)?;
                t.trex_size = be32(trex.body, 16)?;
                t.trex_flags = be32(trex.body, 20)?;
            }
        }
    }
    for h in &moof_hdrs { let body = read_body(&mut f, h)?; parse_moof(h.start, &body, &mut tracks)?; }
    for t in &tracks { if t.samples.is_empty() { return Err(format!("track {} has no samples", t.id)); } }
    for t in &tracks { for (off, _) in &t.chunks { if *off >= file_len { return Err("sample data points past end of file".into()); } } }
    let (new_moov, duration_secs) = rebuild_moov(&moov_body, &tracks)?;

    // 2. Write. Append the new index labelled 'free' (invisible to players),
    //    flush, then flip labels: fragments -> free, old moov -> free, new -> moov.
    let mut staged = new_moov.clone();
    staged[4..8].copy_from_slice(b"free");
    f.seek(SeekFrom::Start(file_len)).map_err(|e| e.to_string())?;
    f.write_all(&staged).map_err(|e| e.to_string())?;
    f.sync_data().map_err(|e| e.to_string())?;
    for h in top.iter().filter(|h| &h.typ == b"moof" || &h.typ == b"mfra") { write_type(&mut f, h.start, b"free")?; }
    write_type(&mut f, moov_h.start, b"free")?;
    write_type(&mut f, file_len, b"moov")?;
    f.sync_all().map_err(|e| e.to_string())?;

    Ok(DefragReport { fragments: moof_hdrs.len(), samples: tracks.iter().map(|t| t.samples.len()).sum(), duration_secs })
}

#[tauri::command]
pub async fn mp4_defragment(path: String) -> Result<DefragReport, String> {
    if !path.to_ascii_lowercase().ends_with(".mp4") { return Err("not an .mp4 file".into()); }
    tauri::async_runtime::spawn_blocking(move || defragment_in_place(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}
```

(Keep the `#[cfg(test)] mod tests` block from Step 2 at the bottom.)

- [ ] **Step 5: Run the tests to see them pass**

Run (from `src-tauri/`): `cargo test mp4fix -- --nocapture`
Expected: 4 passed. If `ffmpeg_sees_identical_media_after_conversion` fails on frame counts, the bug is in `parse_moof` data-offset handling - compare against `rec-frag-explicit.mp4` vs `rec-frag-moof.mp4` to see which base-offset path is wrong. Do NOT loosen the assertions.

- [ ] **Step 6: Performance check (3-hour meetings)**

Generate a 1-hour synthetic fragmented file (takes a few minutes; delete it afterwards, do not commit):

```bash
ffmpeg -v error -y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 3600 -c:v libx264 -preset ultrafast -g 60 -c:a aac -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000 "%TEMP%/bko-1h.mp4"
```

Add a temporary `#[ignore]` test (or a scratch `main`) that calls `defragment_in_place` on it and prints elapsed time. Expected: well under 10 seconds. Then open it with `ffprobe -v error -show_entries format=duration` (≈3600). Remove the temporary test.

- [ ] **Step 7: Register the command**

`src-tauri/src/main.rs`:

```rust
mod mp4fix;
mod timelog;
```

and add to `generate_handler![...]`:

```rust
            mp4fix::mp4_defragment,
```

Check whether the timelog commands needed an entry in `src-tauri/capabilities/default.json` or a `build.rs` app manifest (`grep -r timelog src-tauri/capabilities src-tauri/build.rs`). If they did, add the equivalent for `mp4_defragment`; if not (default: app's own commands are allowed), add nothing.

Run: `cargo build` (from `src-tauri/`) - Expected: success.

- [ ] **Step 8: Call it from the recorder**

`src/lib/recorder.js:252-254` becomes:

```js
    if (this.mimeType && this.mimeType.indexOf('mp4') > -1) {
      // Round 39: convert Chromium's fragmented MP4 into a regular MP4 so
      // Windows' own Media Player plays and seeks it (see src-tauri/src/mp4fix.rs).
      // Falls back to the old duration-only patch if conversion fails - the
      // converter never touches the file unless it fully parsed first.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const report = await invoke('mp4_defragment', { path });
        console.log('[meetings] recording converted to a regular MP4:', report);
      } catch (err) {
        console.warn('[meetings] regular-MP4 conversion failed, using duration-only fallback:', err);
        await fixMp4Durations(path).catch((e) => console.warn('[meetings] duration fallback also failed (file still plays in VLC):', e));
      }
    }
```

(Confirm `@tauri-apps/api` is already a dependency - `grep '"@tauri-apps/api"' package.json`; `src/lib/timelog.js` uses `invoke` and shows the existing import style - match it.)

Fix the fallback's wrong offset at `recorder.js:332`:

```js
          if (v === 1) patches.push({ offset: tkhd.bodyStart + 28, size: 8, value: movieDuration });
```

and correct the comment block above `fixMp4Durations` to say it is now only a fallback.

- [ ] **Step 9: "Finalizing" feedback**

In `main.js`'s record-button stop branch (`if(iAmRecording){ recordBtn.disabled = true;` ~5783) add right after `recordBtn.disabled = true;`:

```js
        showToast('info','Finalizing recording…');
```

- [ ] **Step 10: Build and commit**

Run: `npm run build` → success. Run: `cargo test mp4fix` → 4 passed.

```bash
git add src-tauri/src/mp4fix.rs src-tauri/src/main.rs src-tauri/tests/fixtures src/lib/recorder.js src/main.js
git commit -m "Round 39: convert Meetings recordings to regular MP4 natively so Windows Media Player plays them"
```

---

### Task 6: Punch list, installer, handoff

**Files:**
- Modify: `docs/phase-3-punch-list.md` (append "Round 39 (2026-09-25)")

- [ ] **Step 1: Write the punch-list entry** - one bullet per item: #1 echo (the three causes + fixes), #1 mic coupling, #2 speaker picker, #3 processing toggles (with the Meet/Zoom/Discord comparison), #4 MP4 (fragmented layout was the real cause; last round's tkhd offset mistake owned honestly), #5 Corsair crosstalk explanation + the new meter/notices, #6 clear-meetings RLS, plus the two Review Focus bugs found and fixed along the way (muted-switch goes live; recording loses host mic after switch). Mark everything "needs Humayun's live test" and list `schema_v34.sql` as needing to be run first.

- [ ] **Step 2: Build and upload the installer**

Run: `npm run build-and-upload` (in background; takes ~2 minutes). Expected last line: `Uploaded: Blue Kite Ops_0.1.0_x64-setup_<timestamp>.exe`. If the upload fails with an auth error (`invalid_grant`), the Google sign-in expired (the "Testing"-mode 7-day expiry) - tell Humayun to click **Publish app** in Google Cloud Console → Google Auth Platform → Audience, then run `node scripts/authorize-drive.mjs` once and retry.

- [ ] **Step 3: Commit** the punch list.

```bash
git add docs/phase-3-punch-list.md
git commit -m "Round 39: punch list"
```

- [ ] **Step 4: Report to Humayun** with the filename, "run schema_v34.sql first", and the handoff checks below, in plain language.

---

## Handoff checks for Humayun (hardware only he can do)

1. **Run `supabase/schema_v34.sql` first**, then install the new build.
2. **Echo:** share **Entire Screen** with "Share system audio" ticked, play a YouTube video. The other person should hear it clean, no echo - **with your mic muted AND unmuted**. Have them talk while it plays: they should NOT hear themselves back.
3. **Speaker picker:** in the call, open the devices button → pick speakers vs headset → "Play test sound" comes out of the right one; switching mid-call moves everyone's voices.
4. **Echo toggles:** turn Echo cancellation off with speakers (not headphones) on - the other person will hear themselves echo (that's expected and proves the toggle works). Turn it back on.
5. **Corsair check (#5):** with the boom mic detached, open Windows Settings → System → Sound → Input → pick the Corsair device, play YouTube to the headset, watch the volume bar. If it moves, the headset adapter is leaking sound into the empty mic socket (a hardware thing - Zoom/Meet would transmit it too). The new mic level bar in the app's device settings shows the same thing.
6. **Recording:** record ~2 minutes with screen share + audio, stop, open the file in **Windows Media Player** (and Films & TV): correct length shown, seek bar works, audio plays.
7. **Employee:** logged in as an employee, "Clear past meetings" is gone.

## Before you start (executor)

- The working tree has Rounds 32-38 uncommitted (see `git status`). Ask Humayun once whether to commit that baseline first (recommended: yes, one commit "Rounds 32-38"), confirming `secrets/` is gitignored and not staged. If he says no, skip all commit steps in this plan and just leave the changes in the working tree.
