# Blue Kite Ops

Two things exist now:

1. **Live prototype** (Claude artifact, v3): https://claude.ai/artifact/UJqdCyWUxw4emXZvvXFoJ5
2. **Real standalone codebase** (sent as a .zip in chat): Supabase (Postgres + real logins) + Tauri (Windows .exe) + optional Cloudflare R2 worker for file uploads later. Not deployed yet — Humayun has the code, needs to create his own Supabase project and GitHub repo to finish setup (steps below).

## Workflow model (same in both)
- **Client** — overview, services, publishing schedule (recurring rules like "1st Monday → Guest Episode").
- **Workflow template** — per client, per episode type. Ordered checklist, each step owned by one role, optional "waiting on" note for soft dependencies.
- **Episode** — generated instance of a schedule rule, with its own copy of the template's tasks.
- **Role-based visibility** — a task belongs to one role (Guest Booker, Video Editor, Packaging & Titles, SEO & Show Notes, Social Clips, Manager). Other roles see it as a read-only status chip.
- **My Board** — cross-client view filtered to your current role. Manager sees everything + admin controls.

## v3 fixes/changes to the live prototype
- Fixed the "Add client" bug: all writes now show a real error toast on failure, and on success the app navigates straight to the new client + shows a confirmation toast (previous silent failure/success was the likely cause of "it didn't work").
- Full visual redesign: refined palette/depth, custom animated checkboxes, route transitions, polished modals, toast system, nav icons, hover/press micro-interactions.
- Fixed a real latent bug: the sidebar's client list subscription was being torn down on the first navigation (it shared a cleanup array with per-page subscriptions) — client list now stays live across the whole session.

## Real standalone build — what's in the zip
- `supabase/schema.sql` + `seed.sql` — full Postgres schema (camelCase quoted columns matching the JS field names 1:1, no translation layer), RLS policies, realtime, auto-profile-on-signup trigger. **Verified by actually running it against a real local Postgres 16 instance in this session** — applies cleanly, is idempotent (safe to re-run), and the new-user trigger correctly creates a profiles row.
- `src/` — the ported web app (same UI/logic as the prototype), now talking to Supabase via `src/lib/db.js` (a small shim replicating the same collection/doc/onSnapshot API so the render code needed almost no changes) and `src/lib/auth.js` (real email/password accounts).
- `src-tauri/` — Tauri config + generated app icons, targeting a Windows installer (nsis + msi) only, per Humayun's choice (no Mac build, so no $99/yr Apple Developer account needed).
- `.github/workflows/build-windows.yml` — builds the actual .exe on a GitHub Actions Windows runner (this container can't cross-compile Windows binaries) — download the installer from the workflow run's artifacts.
- `worker-r2/` — optional Cloudflare Worker fronting an R2 bucket for future file uploads. Clarified for Humayun: R2 is object/file storage, not a replacement for Supabase's database+auth — the two are complementary (Supabase for the actual PM data + logins, R2 only if/when the app gets an image-upload feature). Not wired into any UI yet.
- Verified: `npm install && npm run build` succeeds (Vite build passes clean); all JS files pass `node --check`.

## Next steps (Humayun's to do, per README.md in the zip)
1. Create a free Supabase project, run schema.sql then seed.sql in its SQL editor, copy the API URL/anon key into `.env`.
2. `npm install && npm run dev` to test locally.
3. Push to a GitHub repo, add the Supabase URL/key as repo secrets, push to `main` (or run the workflow manually) to get the Windows installer from GitHub Actions.
4. First person to sign up should set their role to "Manager" in the sidebar to unlock admin controls (permissions are soft/self-service by design, matching the original small-team model).

**Note (added when this doc was exported for Claude Code, 2026-09-22):** this describes the ORIGINAL Phase 1 spec/setup. Almost everything here has evolved substantially since - real roles/teams/permissions replaced the placeholder role list, multi-role support was added, the build now ships as a single NSIS installer via tag-triggered GitHub Releases (not the Artifacts tab), and a great deal more has shipped across many rounds. Treat this file as historical context for the original shape of the project, not a current setup guide - `phase-3-punch-list.md` is the up-to-date source of truth.
