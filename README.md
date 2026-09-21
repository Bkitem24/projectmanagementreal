# Blue Kite Ops (desktop)

The Blue Kite Media production board — your own Postgres database, real
team logins with Teams and an Admin tier, and a native Windows app.

Same core workflow as the original prototype: clients each have a
publishing schedule, workflow templates generate episodes with role-owned
checklists, and "My Board" filters to whatever role you're signed in as.
Phase 2 (this build) adds everything on top of that: Teams, invite-only
signup, an Admin panel, a controlled services vocabulary, task
comments/links/attachments, TimeLog (clock-in with screenshots + activity),
an in-app music player, presence + "Connect" voice huddles, and a full
light/dark theme.

**Branding**: the app's icon, sidebar mark, and color palette (navy/blue,
pale-blue chrome, warm gold-orange accent) were pulled directly from your
site, bluekitemedia.com — the mark itself is cropped straight from your
logo and used as-is throughout (`src-tauri/icons/`, `public/logo-mark.png`).
If you have a proper vector logo file (SVG/AI) or an official brand palette
somewhere, send it over and it's a quick swap; nothing here is blocked on
that in the meantime.

## What's here

```
src/               the web app (vanilla JS, no framework — same code style
                    as the original prototype)
  lib/
    teams.js         Teams, invites, services (controlled vocabulary)
    presence.js      online/offline via Supabase Realtime Presence
    connect.js       "Connect" voice huddle signaling + media
    music.js         in-app mood-based music player
    faceDetect.js    face-check on profile photo upload
    imageCompress.js client-side image resize/compress before upload
    timelog.js       clock-in orchestration (screenshots + activity)
    r2.js            Cloudflare R2 upload/download helper
supabase/          schema.sql (run first) + schema_v2.sql (run second) +
                    schema_v3.sql (Teams backfill) + schema_v4.sql (episode
                    discussion + email-change sync) — run all four, in order +
                    seed.sql (optional example client data) + seed_services.sql
                    (optional — Blue Kite's real service vocabulary)
src-tauri/         the Windows desktop wrapper (Tauri), incl. src/timelog.rs
                    (native screen capture + global keyboard/mouse hook)
worker-r2/         Cloudflare Worker fronting R2 — avatars, client photos,
                    task attachments, TimeLog screenshots, + a daily
                    6-month retention purge
worker-realtime/   Cloudflare Worker proxying Cloudflare Realtime (the SFU
                    behind "Connect") so its App Token never ships to the
                    desktop app
.github/workflows/ builds the actual .exe on GitHub's Windows runners
```

## 1. Create your Supabase project (free)

1. Go to [supabase.com](https://supabase.com), sign up, and create a new project.
2. **SQL Editor → New query**: paste `supabase/schema.sql`, run it. Then a
   **second** new query: paste `supabase/schema_v2.sql`, run it too — this
   is the one that adds Teams, Admin, invites, TimeLog, and everything else
   from Phase 2. Both files are safe to re-run if you ever need to.
3. Optional: run `supabase/seed.sql` for an example client to click through,
   and/or `supabase/seed_services.sql` for Blue Kite's real service
   vocabulary (Guest Booking & Management, Full Audio/Video Production,
   Curated Content for Social Media, Packaging, Writeups, Episode Release —
   each with its real sub-tasks and which role owns them). Both optional,
   independent of each other, and safe to re-run.
4. **Settings → API**: copy your **Project URL** and **anon public key**.
5. **Settings → Authentication → Providers → Email**: make sure Email is
   enabled. For a small internal team you likely want **Confirm email**
   turned **off**, so a new hire's account is usable the moment they sign up
   with their invite code, without waiting on a confirmation link.

## 2. Run it locally (to test before building the exe)

```bash
npm install
cp .env.example .env
# paste your Supabase URL + anon key into .env
npm run dev
```

Open the printed `localhost` URL and create an account. **The first account
ever created on a fresh project automatically becomes Admin** — that's you.
Everyone after that needs an invite (see below); signing up without one, or
with a wrong/expired/already-used code, is rejected by the database itself,
not just hidden in the UI.

Sign up as that first Admin account, then:

1. Go to the **Admin** page (visible only to Admin) → create your first
   Team (e.g. "Team A") and assign yourself or a teammate as its Manager.
2. From **Team Settings** (visible to that Team's Manager, and to Admin for
   any team), send an invite: enter the new person's email + role. The app
   shows a short code (e.g. `a1b2c3d4e5f6`) — send that to them directly
   (Slack, text, in person). There's no emailed invite link; the code +
   their matching email is what lets them in.
3. That person opens the app → **Create an account** → enters the invite
   code you gave them + the *same* email address it was issued to. Their
   role and Team come from the invite automatically; they can't pick their
   own role or Team, and can't change it themselves afterward.
4. Invite codes expire after 14 days and can only be used once.

The five employee roles an invite can carry (besides Manager/Admin) are
Outreach Expert/VA, Sr. Video Editor, Jr. Video Editor, Packaging Expert,
and SEO Content Specialist — Blue Kite's real roster, not a placeholder set.

Employees only ever see their own Team's clients/schedule/tasks. Managers
can additionally create clients, schedule rules, workflow templates, and
Team-scoped services for their own Team. Admin sees and manages everything
across every Team, plus Teams themselves and global (cross-team) services.

## 3. Build the actual Windows .exe

This container (and most Macs/Linux dev machines) can't cross-compile a
Windows binary — Tauri builds against the OS it's running on, and the
TimeLog native module (screen capture + keyboard/mouse hook, see
`src-tauri/src/timelog.rs`) especially needs a real Windows build to
compile and be verified. `.github/workflows/build-windows.yml` builds it on
a real Windows machine for you, for free, via GitHub Actions:

1. Push this project to a GitHub repo.
2. **Settings → Secrets and variables → Actions**, add repository secrets:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (required), plus
   `VITE_R2_UPLOAD_WORKER_URL` and `VITE_REALTIME_WORKER_URL` once you've
   set up those two workers (sections 4 and 5 below — leave blank/omit
   until then, the app runs fine without them, just without file uploads
   or Connect calls).
3. Push to `main`, or run "Build Windows exe" manually from the **Actions**
   tab.
4. Download the `blue-kite-ops-windows` artifact from the finished run —
   that's your installer (`.exe` via NSIS, plus a `.msi`). Share it with
   your team; running it installs Blue Kite Ops like any other Windows app.

**Important — this is the module that most needs a first real test:** the
Rust screen-capture/activity code in `src-tauri/src/timelog.rs` was written
carefully but could not be compiled in the sandbox this was built in (no
network access to crates.io to fetch its dependencies). The Windows Actions
build has full internet access and will actually compile it — if that build
fails, the error will point at exactly what needs adjusting (most likely a
version mismatch in the `xcap` or `rdev` crates, which are both pinned to
`"*"` in `src-tauri/Cargo.toml` on purpose, so the build resolves whatever
their current latest release is rather than trusting an unverified guess).
Once a build succeeds, it's worth pinning those three dependencies
(`xcap`, `rdev`, `image`) to the exact versions that worked, copying them
out of the generated `Cargo.lock`, so future builds stay reproducible.

No Apple Developer account or code-signing certificate is needed for this.
Windows' "unknown publisher" SmartScreen prompt on first launch is safe to
click through for an internal team tool; a code-signing certificate (a
separate purchase) would remove that prompt if you ever want to.

## 4. Cloudflare R2 — file uploads (avatars, attachments, TimeLog screenshots)

Needed for: forced profile-photo upload at signup, client photos, task
attachments, and TimeLog screenshots. Free tier: 10GB storage, and unlike
S3, R2 has **zero egress fees** — you only pay if you ever exceed 10GB
stored, which is a long way off for a small team's photos/attachments.

Run these commands yourself, from your own machine's terminal (inside this
project folder) — `npx wrangler login` opens a browser window to authorize
against your Cloudflare account, so it has to happen on a machine you're
logged into, not somewhere else on your behalf:

```bash
cd worker-r2
npx wrangler login
npx wrangler r2 bucket create blue-kite-ops-files
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # Settings -> API -> service_role in Supabase — treat like a master password
npx wrangler deploy
```

Wrangler prints the worker's URL when it deploys — put that in
`VITE_R2_UPLOAD_WORKER_URL` in `.env` (and as a GitHub Actions repo secret,
for the Windows build).

This worker also runs a **daily cron job** (already configured in
`worker-r2/wrangler.toml`) that permanently deletes screenshots, task
attachments, and activity samples once they're 6 months old — both the R2
file and its database row — per your retention decision. Nothing else needs
to be done to turn that on; it starts running once the worker is deployed.

## 5. Cloudflare Realtime — "Connect" voice huddles

Needed for: the actual audio in Connect (1:1 auto-connect when both people
are online, plus group calls). Presence (who's online) and the ring/signal
itself already work with no Cloudflare account, since that rides on the
same Supabase Realtime the rest of the app uses — only the audio hookup
needs this.

1. Cloudflare dashboard → **Realtime** → this now splits into four products
   (RealtimeKit, Turn Server, Serverless SFU, MOQ Relay) — pick
   **Serverless SFU** (that's the one this code is built against: raw
   session/track control, not RealtimeKit's higher-level meeting/room API)
   → create an Application. Usage-based pricing with a free monthly
   allowance (1,000 GB) — no card required to create it and try it at this
   team's scale.
2. Note the **App ID** and generate an **App Token**.
   ```bash
   cd worker-realtime
   npx wrangler deploy
   npx wrangler secret put CF_REALTIME_APP_ID
   npx wrangler secret put CF_REALTIME_APP_TOKEN
   npx wrangler secret put SUPABASE_URL
   npx wrangler secret put SUPABASE_ANON_KEY
   ```
3. Put the deployed worker's URL in `VITE_REALTIME_WORKER_URL` (`.env` and
   the GitHub Actions repo secret).

**This one still needs a live test before you rely on it, but the code is
now checked against Cloudflare's current API reference** (2026-09-21, once
a real Serverless SFU app existed to confirm against) — `worker-realtime/src/index.js`
and `src/lib/connect.js`'s endpoint paths, request/response field names, and
the renegotiation round-trip that pulling a remote track requires now match
the current OpenAPI spec at developers.cloudflare.com/realtime. What's
still unverified is an actual end-to-end call between two real clients.
Once you've done steps 1–3 above, try a real Connect call between two
machines (or two browser profiles signed in as different users). If it
fails, the worker returns the raw Cloudflare error in its response —
compare that against a fresh pull of the current reference and adjust;
the comments at the top of `worker-realtime/src/index.js` point at the
most likely spot for drift.

## 6. Music player

Each employee is asked "What do you prefer listening to when working?" at
signup and picks one of 8 categories (Nature/Ambient Sounds, Film Music,
Lo-fi, Western Classical, Eastern Classical, Electronic, High-BPM
Instrumental Rock/Pop, Color Noise) or "I'd rather not." The player
(`src/lib/music.js`) plays from Humayun's own curated YouTube links per
category — no Cloudflare account, no cost, nothing to upload. This settles
the earlier open question between a self-hosted-audio approach and YouTube:
real curated links were provided, so this is the YouTube route.

Within a category, the player shuffles randomly among the curated links
Humayun sent (two categories are a whole curated YouTube playlist rather
than individual videos — "change track" steps through those in YouTube's
own order instead, since there's no supported way to force-shuffle inside
someone else's playlist). Controls: play/pause, change track, mute, and a
volume slider — all in `src/lib/music.js`'s public functions, wired up in
`main.js`'s `mountMusicPlayer()`.

**One YouTube-specific constraint worth knowing**: YouTube's embed terms
require the player to stay visible (roughly 200×200px or larger) while
playing — it can't be hidden the way a plain `<audio>` tag could. The
sidebar widget keeps a small always-visible video frame for this reason;
see the top of `src/lib/music.js` for the full explanation. To change or
add tracks later, edit the `CATALOG` object at the top of that file — no
YouTube Data API key needed anywhere (track titles come free from the
embedded player itself).

## Notes / what's intentionally simple or deferred right now

- **TimeLog has no consent/disclosure screen before monitoring starts**, and
  logs full keystrokes system-wide (not scoped to the app window) while
  clocked in — both per your explicit direction. Worth knowing this is a
  legal/HR question in some jurisdictions if the team ever grows or changes
  composition; flagging it here rather than silently deciding it for you.
- **Auto-updates**: this build doesn't wire up Tauri's updater, so a new
  version means sending teammates a fresh installer.
- **Realtime**: `src/lib/db.js`'s shim re-fetches a query's full result set
  on every change rather than doing incremental patches — simplest to get
  right, plenty fast at this scale (a handful of Teams, a few hundred
  tasks). Revisit only if it ever feels slow.
- **One open assumption in the seeded service list** (`supabase/seed_services.sql`):
  "Trailer Content Highlight" was listed against a "Scriptwriter" role that
  doesn't appear in the final 5-role roster — assigned to Sr. Video Editor
  as the closest fit, but worth double-checking and editing in-app
  (Team Settings / Admin → services) if that's not what you meant.
- **Blocked on you** (nothing else is waiting on these to keep working, the
  app runs fine without them and picks them up whenever you're ready): any
  remaining brand assets beyond the logo mark already pulled from your site
  (bluekitemedia.com) and applied throughout, the real employee roster
  (who's on which Team, in which role — sent as invites per section 2), and
  real client → Team assignments.
