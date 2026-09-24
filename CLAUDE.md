# Blue Kite Ops - Project Context for Claude Code

This file is read automatically at the start of every Claude Code session in
this folder. It orients a fresh session fast - full history lives in
`docs/phase-3-punch-list.md` (same folder as this file, read it for anything
not covered here).

## What this is

A custom project-management desktop app for Blue Kite Media (podcast/video
production company). Built for Humayun, a non-technical founder - explain
things in plain language, avoid jargon unless he's asked for the technical
detail.

## Stack

- **Frontend:** vanilla JS (`src/main.js` - large single file, no framework),
  built with Vite. Design system (Phase 5, "Take Flight," 2026-09-29 on):
  Plus Jakarta Sans font, a blue/white color palette defined as CSS custom
  properties in `src/style.css` (`--blue`, `--ink`, `--paper`, `--surface`,
  etc., with dark-theme overrides), the Blue Kite kite-mark logo
  (`public/logo-mark.png`, transparent background, also baked into the
  Tauri app icon via `scripts/gen-icons.cjs`), and a sky/mountain hero
  banner (`public/hero-banner.webp`) used on the Home page - now admin-
  editable (upload/reposition/zoom) via `appSettings/hero`, schema_v20-22.
- **Desktop shell:** Tauri v2 (Rust, `src-tauri/`) - produces a Windows
  installer/`.exe`. No Mac build yet (planned, Phase 8, not started).
- **Backend:** Supabase (Postgres + Auth + Row Level Security). Accessed
  through a thin Firestore-style shim, `src/lib/db.js`
  (`db.collection(x).where().onSnapshot()`, `db.doc(x).get()/set()/update()`)
  so the app's render code reads like it's against a document store even
  though it's really Postgres underneath.
- **File storage:** Cloudflare R2 via a Worker (`worker-r2/`).
- **Realtime calling ("Connect"):** Cloudflare Realtime SFU via another
  Worker (`worker-realtime/`), signaling over Supabase Realtime presence/
  broadcast channels (`src/lib/connect.js`).
- **Music player:** streams from a Google Drive folder Humayun owns (one
  subfolder per mood, e.g. `electronic`, `lofi` - exact lowercase keys, see
  `worker-drive-music/wrangler.toml`) via `worker-drive-music/`, a Worker
  authenticated as a Google service account (JWT-bearer flow, signed with
  Web Crypto - see that Worker's own file for the full auth flow). Replaced
  an earlier YouTube-embed version entirely (2026-09-29) - `src/lib/
  music.js` is a real `<audio>` element now, no iframe. Any mood is always
  selectable regardless of what was picked at signup (that used to be a
  hard restriction and was a real bug, see punch list round 22).
- **Build:** GitHub Actions, Windows runner (`.github/workflows/
  build-windows.yml`) - this is what actually compiles the Rust/Tauri build;
  a push of a version tag (`v*`) triggers it and attaches the built `.exe`
  straight to a GitHub Release (no zip wrapper). A plain push to `main`
  does NOT trigger a build (deliberately disabled - see punch list). This
  session also triggered ad-hoc `workflow_dispatch` runs directly via
  `gh workflow run "Build Windows exe" --ref main` for testing rounds -
  fine to keep doing that, just don't add a new automatic trigger on push
  without Humayun asking.

## Critical conventions - read before editing `src/main.js`

- **`paint(html)`** is the ONLY function that prepends the back-button UI and
  wires its click handler. Any page-render function that sets
  `app.innerHTML` directly instead of calling `paint()` silently loses the
  back button. Always route full-page renders through `paint()`.
- **Live-lookup-over-baked-in-value pattern**: several things (task
  dependencies, task display order, task role/group) are "baked in" to a
  `tasks` row at the moment an episode is generated from a template, but
  should ideally reflect the CURRENT template if it's edited later. The
  established fix pattern (used repeatedly, e.g. `liveDepStepIds()`,
  `liveOrderNum()`) is: fetch the current template's steps once per page
  load into a `stepById` map, and at render time look up the task's
  originating step live (a task's id is deterministically
  `episodeId+'_'+stepId`), falling back to the task's own baked-in value if
  no live step is found (custom task, one-off episode, or step since
  deleted). Follow this pattern for any similar "template changed but old
  episodes didn't update" bug.
- **Group header order vs. step order are two separate concepts** (fixed
  2026-09-27, see punch list "round 8.9-fix"): a template's steps share one
  flat `order` sequence across the whole template, but which GROUP HEADER
  shows first on the episode checklist is driven by a separate, append-only
  `groupOrder` field on the template (`tplGroupOrder()` in `main.js`) - never
  infer group header order from step order again, that was the root cause
  of a real bug.
- **Schema changes ship as a new `supabase/schema_vN.sql` file**, additive
  only (never edit an old one) - Humayun runs it by hand in the Supabase SQL
  editor. **When a schema file and code both need applying, the SQL must be
  run FIRST** - the app's `.update()` calls target specific columns, and an
  update naming a column that doesn't exist yet fails the whole write, not
  just the new part.
- **This app requires Windows UAC elevation on every launch**
  (`src-tauri/windows-app-manifest.xml`, `requireAdministrator`) for
  reliable global keyboard/mouse hooks (TimeLog activity tracking). This has
  real downstream consequences - e.g. registry-based autostart cannot work
  with an elevated app (fixed via a Scheduled Task instead, see punch list).
  Keep this constraint in mind for any future native/OS-level feature.
- **No automated tests exist yet.** Verification has been: `node --check`
  after stripping ES module imports (Node can't run ESM `import` outside a
  real bundler context, but can still syntax-check everything else), JSON/
  YAML validation for config files, and manual brace/paren balance checks
  for Rust (no local Rust toolchain was available where this was built
  originally). If you have `cargo`/`npm` available locally, actually running
  `npm run build` and `cargo check`/`cargo build` (from `src-tauri/`) is a
  real step up from that - do it.
- **Every round of work updates `docs/phase-3-punch-list.md`** with a dated,
  detailed entry (root cause, fix, confirmation status) - keep doing this,
  it's the project's institutional memory and Humayun relies on it.
- **Never use `db.doc(table+'/'+id).set(...)` to create a row on behalf of
  someone ELSE** (e.g. a notification, an invite) if that table's UPDATE
  RLS policy wouldn't let the current user touch a row belonging to that
  other person. `.set()` goes through the shim's upsert path
  (`INSERT ... ON CONFLICT (id) DO UPDATE`), and Postgres validates the
  UPDATE policy's `WITH CHECK` for that statement SHAPE regardless of
  whether a real conflict ever occurs (ids here are always freshly
  random) - this was a real bug (notifications failing with a
  cryptic-looking RLS violation that had nothing to do with the INSERT
  policy at all). Also don't reach for `db.collection(table).add(...)`
  as the fix either - that shim method chains `.select().single()`,
  and PostgREST silently filters a RETURNING row through the table's
  SELECT policy, which can ALSO fail for a row created "for" someone
  else. The correct fix is a genuine bare insert with no `.select()` at
  all: `supabase.from(table).insert(row)`, called directly (see
  `insertNotification()` in `main.js` for the working pattern).
- **A render that depends on an async-loaded cache (roles, teams,
  services, moods, etc.) must be re-run once that cache actually
  resolves - calling it once synchronously before the fetch even starts
  is a real, repeatable bug**, not just a rare race. Found twice this
  session in different spots (the sidebar identity card showing raw role
  keys because `ROLES` was still empty on first paint; the music player
  never mounting because `musicMoods` sometimes wasn't saved yet on the
  very first profile snapshot). The safe pattern: call it eagerly for a
  snappy first paint if you want, but ALSO call it again in the
  `.then()` of whatever async refresh populates the underlying cache.
- **A `position:fixed` element with no explicit `left`/`top` renders at
  its normal in-flow "static" position, not pinned to a viewport
  corner** - if you move something out of the document's normal layout
  (e.g. to float over the whole app instead of sitting inside a
  container), give it a real on-screen position before measuring or
  relying on its rendered location, or it can silently land off-screen.
- **A table's old CHECK constraint from before the dynamic-roles system
  (Phase 3) can still be sitting on some OTHER table**, hardcoding the
  original 5 job-title keys - `invites.role` and `profiles.role` both had
  this and it took a real "can't invite to a custom role" bug report to
  surface it (schema_v21/v22.sql fix). If a brand-new custom role ever
  fails a write with a check-constraint violation, this is almost
  certainly why - look for (and drop) any check constraint anywhere in
  `public` whose definition mentions the old fixed role list.
- **Google Drive API calls from a service account need
  `supportsAllDrives=true&includeItemsFromAllDrives=true`** even for a
  perfectly ordinary folder just shared with that service account (not a
  real Shared Drive) - without these, `files.list` silently returns an
  empty result instead of an error, which looks exactly like "the folder
  is empty" from the outside. Cost a whole debugging round before
  `wrangler tail`-ing the Worker's own live logs surfaced the real error.
  When in doubt about ANY Cloudflare Worker behaving strangely against a
  live API, `npx wrangler tail --format pretty` (from that worker's own
  folder) streams real server-side errors while the person reproduces the
  issue - far faster than guessing from the frontend's (often generic)
  symptom.
- **On Windows, piping a file into `wrangler secret put` needs
  `Get-Content <path> -Raw`, not plain `Get-Content`** - without `-Raw`
  the file content doesn't actually survive the pipe into the external
  `npx` process, and the secret silently ends up empty (no error at
  secret-set time - it only surfaces later as a confusing runtime
  failure). Also: don't assume Downloads goes to the default Windows
  Downloads folder - Humayun's goes to a custom `H:\` drive.

## Delivery workflow (now obsolete with Claude Code - context for why the
punch list mentions zip files everywhere)

Before Claude Code, fixes were built in a sandboxed environment with no git/
GitHub access at all, so every change was packaged as a zip file and applied
by hand through GitHub's web "Edit file"/"Upload files" UI - a slow, error-
prone loop (a few real incidents in the punch list trace back to a file
being misapplied this way). With Claude Code + git access, use real commits
and pushes instead - this is a strict improvement, no reason to keep
simulating the zip-file workflow.

## Where things stand (as of 2026-09-29/30, end of the Phase 5 session)

Phase 5 (the "complete UI/UX overhaul," Take Flight design system) is
substantially delivered, not just started: global design tokens, logo, app
icon, hero banner (now admin-editable with drag/zoom), Home page, the
sound-mute toggle, the music player's full rebuild off YouTube onto Google
Drive, and a long tail of real bugs found and fixed along the way (mention
notifications, the roles/invites check-constraint leftover, the sidebar
identity card's render-timing bug, the music player going invisible after
being made draggable). **Most recent round's schema files: `schema_v20.sql`
through `schema_v22.sql`** (hero editor's `appSettings` table + zoom column,
role check-constraint cleanup) - confirm with Humayun whether these are
already run before assuming so. `worker-drive-music/` is deployed and its
secrets are set correctly as of this session's end, but its Google Drive
folder is Humayun's own ongoing upload job (not everything may be uploaded
yet) - "no tracks in X" for a specific mood may just mean that folder is
still empty, not a bug. Still open: a broader animations/micro-interactions
pass, and confirming the sidebar role-display fix actually resolved things
for Humayun (last reported fix, not yet re-confirmed by him).

## Where to look for more

- `docs/phase-3-punch-list.md` - full dated history of every round: what was
  asked, what was built, root causes for every bug found, what's confirmed
  working vs. still open. Read this before starting new work in an
  unfamiliar area. Rounds 17-24 cover this session's entire Phase 5 work in
  detail - start there for anything not already covered above.
- `docs/phase-2-requirements.md` - original Phase 2 feature spec/decisions
  log (roles, teams, music player, TimeLog, Connect) - mostly superseded by
  later punch-list entries but has useful original context/reasoning.
