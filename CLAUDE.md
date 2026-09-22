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
  built with Vite.
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
- **Build:** GitHub Actions, Windows runner (`.github/workflows/
  build-windows.yml`) - this is what actually compiles the Rust/Tauri build;
  a push of a version tag (`v*`) triggers it and attaches the built `.exe`
  straight to a GitHub Release (no zip wrapper). A plain push to `main`
  does NOT trigger a build (deliberately disabled - see punch list).

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

## Delivery workflow (now obsolete with Claude Code - context for why the
punch list mentions zip files everywhere)

Before Claude Code, fixes were built in a sandboxed environment with no git/
GitHub access at all, so every change was packaged as a zip file and applied
by hand through GitHub's web "Edit file"/"Upload files" UI - a slow, error-
prone loop (a few real incidents in the punch list trace back to a file
being misapplied this way). With Claude Code + git access, use real commits
and pushes instead - this is a strict improvement, no reason to keep
simulating the zip-file workflow.

## Where to look for more

- `docs/phase-3-punch-list.md` - full dated history of every round: what was
  asked, what was built, root causes for every bug found, what's confirmed
  working vs. still open. Read this before starting new work in an
  unfamiliar area.
- `docs/phase-2-requirements.md` - original Phase 2 feature spec/decisions
  log (roles, teams, music player, TimeLog, Connect) - mostly superseded by
  later punch-list entries but has useful original context/reasoning.
