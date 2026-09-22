# Blue Kite Ops — Phase 2 Requirements & Research

Captured from Humayun's Sep 21 2026 feature request, on top of the Phase 1 build (Supabase + Tauri Windows app, see `blue-kite-ops-tool.md`).

**Status: Phase 2 build delivered, then refined with Humayun's real brand/role/music/service data on the same day.** Everything not explicitly blocked on Humayun (see below) has been implemented, tested where it could be, and packaged into a zip. See "Build status" at the top for what's solid vs. what needs a first live test.

## Build status (Sep 21 2026, round 2)

**Done and verified this round:**
- **Real role roster** replaced the placeholder one everywhere (schema constraints, RLS, `main.js`'s `ROLES`, seed data): Outreach Expert/VA, Sr. Video Editor, Jr. Video Editor, Packaging Expert, SEO Content Specialist (plus Manager/Admin, unchanged). Old slugs (`guest_booker`/`video_editor`/`packaging`/`seo`/`social`) are gone from the schema entirely — re-verified bootstrap/invite/RLS against a local Postgres after the rename, including confirming the database itself now rejects an invite created with an old role slug.
- **Real service vocabulary** seeded (`supabase/seed_services.sql`, new, optional): Guest Booking & Management, Full Audio/Video Production, Curated Content for Social Media, Packaging, Writeups, Episode Release — each with Humayun's real sub-tasks and role assignments, global scope (editable/extendable by Admin or any Team Manager afterward, per the existing services UI). One assumption flagged: "Trailer Content Highlight" was listed against a "Scriptwriter" role that isn't in the final 5-role list — assigned to Sr. Video Editor as the closest fit, called out in the seed file's own comments and in the README for Humayun to confirm or correct.
- **Music player rebuilt on real data**: Humayun sent actual curated YouTube links across 8 categories (not the placeholder mood tags), which settles the earlier open question — this is the YouTube route, not self-hosted audio. Rewrote `src/lib/music.js` on the YouTube IFrame Player API: 8 real categories with his real links, shuffle-within-category, mute, volume, category switching, all client-side, no API key, no Cloudflare cost. The one real constraint: YouTube requires the embedded player to stay visible (~200px+) while playing, so the sidebar widget has a small always-visible video frame rather than a hidden one — documented in the file and the README.
- **Real branding applied**: cropped the actual Blue Kite Media mark straight from bluekitemedia.com (screenshot Humayun sent), generated the full app icon set (`src-tauri/icons/*`, multi-res `.ico` included) and a transparent sidebar mark (`public/logo-mark.png`) from it, and resampled the color palette in `src/style.css` directly from the source image (vivid-blue-to-navy mark gradient, pale-blue chrome, warm gold-orange accent) — replacing the earlier placeholder coral-orange/sky-blue palette. Verified visually via headless-browser screenshots of the sign-in, sign-up (with the new mood picker), and forced-dark-mode screens — logo renders crisply, contrast reads clean in both themes.
- Full rebuild (`npm run build`) passes clean after all of the above.

**Still unverified — same two items as before, unchanged by this round:**
- `src-tauri/src/timelog.rs` (native screen capture + keystroke/mouse hook) — still needs a real GitHub Actions Windows build to compile/verify (crates.io unreachable from this sandbox).
- `worker-realtime/` (Cloudflare Realtime SFU proxy for Connect's actual audio) — still needs a live Cloudflare Realtime account to test against.

**On the Cloudflare setup questions this round:** nothing needs to be sent back here — the `npx wrangler login`/`secret put`/`deploy` commands in the README have to run from Humayun's own machine (wrangler login opens a browser OAuth flow tied to his Cloudflare account), and this sandbox has confirmed no network path to Cloudflare's API at all (a direct test returned a 403 from the sandbox's own egress policy), so there'd be nothing to do with a token even if one were sent here. Signing up for the Cloudflare account was the actual prerequisite for that README section — done — and the remaining steps are just those README commands, run locally.

**Not started / genuinely blocked on Humayun** (narrowed from before, now that role/service/music/branding data has arrived):
- Any brand assets beyond the logo mark already pulled from the site and applied (e.g. a proper vector/SVG source file, if one exists, would be a clean swap-in but isn't required).
- Real employee roster → sent as invites once he has it (the invite flow itself is done and working, now carrying the real 5-role list).
- Real client → Team assignments.
- Confirming (or correcting) the Scriptwriter → Sr. Video Editor assumption in the seeded services.

---

## 1. Roles, permissions & manager tooling
- Signup is invite-only: whoever creates the invite (Admin or that Team's Manager — see #7) presets both **Role** and **Team** on it. No self-service picker for either.
- The five employee roles (final, replacing the earlier placeholder set): **Outreach Expert/VA**, **Sr. Video Editor**, **Jr. Video Editor**, **Packaging Expert**, **SEO Content Specialist**. Plus Manager and Admin.
- Manager-only UI (scoped to their own Team only — see #7): add new clients (within their team); add/remove schedule rules (Phase 1 only supports adding); add/remove services on a client, drawn from the shared vocabulary.
- Services come from a controlled vocabulary, with a **scope** on each service: `global` (every team can use it) or `team:<team>` (only that team can use it). Team Managers can mint brand-new services, but only scoped to their own team. Admin can mint a service scoped to any specific team, or scoped globally. The real starting vocabulary (seeded, editable afterward):
  1. **Guest Booking & Management** — create guest/podcast target lists, outreach, scheduling, follow-ups. All Outreach Expert/VA.
  2. **Full Audio/Video Production** — trailer content highlight + edit trailer (Sr. Video Editor); full multicam edit, audio enhancement, color grade, overlays, upload to drive (Jr. Video Editor).
  3. **Curated Content for Social Media** — highlight content (SEO Content Specialist), edit the highlighted content (Jr. Video Editor).
  4. **Packaging** — design 2 A/B-testing thumbnail+title packages (Packaging Expert).
  5. **Writeups** — YouTube description, timecoding, show notes, SEO blog post (all SEO Content Specialist).
  6. **Episode Release** — schedule the episode, send the release email (Outreach Expert/VA).
- Client "Overview" text is editable.
- Workflow template entries need drag-to-reorder.
- Client entries get an image (e.g. a host's face photo) — a proper upload+display treatment, not a tiny avatar. **Blocked on: Humayun sourcing the actual client photos when ready — upload/display feature is built regardless.**
- Manager can add one-off custom tasks (special/bonus episodes, ad-hoc tasks) outside the auto-generated recurring schedule.

## 2. Aesthetic overhaul
- Blue Kite Media branding: the real mark and color palette, pulled directly from bluekitemedia.com and applied throughout (see Build status above) — no longer a placeholder.
- Modern/minimal/smooth: shadows, hover/press micro-animations. Bar: better than ClickUp/Trello-tier polish.
- Light mode + dark mode, both re-verified visually against the new palette.
- Forced profile picture upload at signup, rejected if no face is detected (client-side, free, via a WASM face-detection library — no server cost).
- Signup asks "What do you prefer listening to when working?" with the 8 real categories — feeds the music player (see #4).
- Homepage "Employee of the Month" banner, editable by Admin/Manager, company-wide (not per-team).

## 3. Time tracking / activity monitoring ("TimeLog")
- Manual clock-in: large dismissible (✕) popup on app launch; dismissing lets them keep using the app without clocking in.
- Once running: periodic screenshots at randomized intervals (avg ~10 min), plus full keystroke logging (decided) and mouse activity. No consent/disclosure screen before monitoring starts (decided).
- Screenshots compressed before upload to Cloudflare R2.
- Employees can view their own screenshot history in its own tab but cannot delete entries.
- Auto-delete screenshots AND task attachments once they hit 6 months old — via a daily Cloudflare Worker cron job, removing both the R2 object and the corresponding DB row.

## 4. Music player (finalized this round)
- 8 real categories, each with Humayun's own curated YouTube links: Nature/Ambient Sounds, Film Music, Lo-fi, Western Classical, Eastern Classical, Electronic, High-BPM Instrumental Rock/Pop, Color Noise — plus "I'd rather not."
- Built on the YouTube IFrame Player API (not self-hosted audio — settled by Humayun sending real YouTube links). Shuffles randomly within a category's list; two entries are whole curated playlists rather than single videos, which step forward in YouTube's own order instead. Mute + volume controls. No YouTube Data API key needed (titles come from the embedded player itself).
- Constraint carried over from the earlier research: YouTube requires the embedded player to stay visible (~200px+) while playing — the widget keeps a small, always-visible frame rather than hiding it.

## 5. Per-task collaboration
- Comments, links, and file attachments on every task, stored in Cloudflare R2. Attachments also subject to the 6-month auto-delete (#3).

## 6. Presence & calling ("Connect" — name TBD for the group variant)
- Online/offline presence marker per employee.
- 1:1 instant "Connect": if target is online, connects immediately, no accept/decline step. Signaling built on Supabase Realtime (done, working); actual audio built on Cloudflare Realtime SFU via `worker-realtime/` (done, unverified live — needs a real Cloudflare Realtime account to test).
- Group "Connect" (huddle) variant also needed — open on a cooler name than "call"/"huddle".

## 7. Access tiers & Team structure
- Three tiers: **Admin** (Humayun only) → **Manager** (one per Team) → **Employee**.
- **Team** is a top-level grouping: a Team has its own Manager, its own roster of employees, and its own subset of clients. A client belongs to exactly one Team; an employee belongs to exactly one Team.
- Team + Role are both preset on an employee's invite (see #1) — never self-selected.
- **Manager scope**: a Team's Manager only sees/edits that team's clients, schedule, employees, and services — not other teams'. (Decided, implemented via RLS.)
- **Admin scope**: sees and can act across every team, plus Admin-only powers: create a new Team, assign/change a Team's Manager, create globally-scoped or any-team-scoped services (see #1).
- Role-based visibility (the 5 real roles, see #1) still applies *within* a Team's roster — Team is the outer boundary, Role is the inner filter.

## Hard constraint
No new recurring cost. Cloudflare R2, Cloudflare Realtime SFU, and the music source (YouTube, embedded) all run inside always-free tiers/no-cost usage. One Cloudflare account (not split) — the 6-month auto-delete policy (#3) keeps storage from growing unbounded.

## Research findings — kept for reference
- **R2 free tier**: 10 GB-month storage, 1M Class A ops/month, 10M Class B ops/month, zero egress fees at any tier. Overage: $0.015/GB-month storage, $4.50/million Class A ops, $0.36/million Class B ops beyond the free allowance.
- **Realtime SFU**: no per-minute free allowance; 1,000 GB/month free data egress (shared across SFU+TURN), then $0.05/GB. Enormous headroom for a small team's audio huddles.
- **YouTube IFrame API**: Required Minimum Functionality policy forces the player to stay visible (min ~200×200px) and unobscured whenever playing. No supported way to force real shuffle inside an embedded playlist — handled by picking randomly among Humayun's own listed links instead (see #4).
- **Tauri implications**: Realtime SFU (WebRTC) works fine in Tauri's Windows WebView2. Screenshot capture + system-wide keystroke logging need a native Rust-side Tauri plugin using OS APIs — global keyboard hooks read as keylogger-like behavior to antivirus/Windows Defender and likely need code-signing to avoid false-positive flags.
- **Face detection**: doable fully client-side and free via a WASM/JS library (`@vladmandic/face-api`) inside the Tauri webview.
- **This sandbox's own network access**: confirmed (Sep 21, round 2) that Cloudflare's API is not reachable from here at all — any Cloudflare deploy/setup step has to run on Humayun's own machine, not be handed off with credentials.

## Decisions log
1. Activity monitoring: full keystroke logging, not just aggregate signals.
2. Role signup flow: invite-only, Role preset by whoever creates the invite.
3. Monitoring consent screen: skipped.
4. Music player approach: **YouTube IFrame API, using Humayun's real curated links per category** — settled this round; self-hosted audio was the earlier placeholder default, now superseded.
5. Screenshots + task attachments: auto-delete at 6 months old.
6. Cloudflare accounts: one account (not split).
7. Team assignment: preset in the invite, not self-selected.
8. Manager permission scope: restricted to their own Team.
9. Service-creation scope: Team Managers can create new services scoped to their own Team only; Admin can create Team-specific (any team) or globally-scoped services.
10. New Admin tier (Humayun only): creates Teams, assigns Team Managers, plus the global/any-team service powers above.
11. Invite matching uses a secret code (not email alone) to prevent hijacking via a guessed/known email address — my own security addition during implementation, not an explicit ask.
12. Real 5-role roster (Outreach Expert/VA, Sr. Video Editor, Jr. Video Editor, Packaging Expert, SEO Content Specialist) replaces the earlier placeholder roles — this round.
13. Real service vocabulary (6 services, seeded) replaces the earlier placeholder examples — this round.
14. Real brand mark + palette, pulled from bluekitemedia.com, replaces the earlier placeholder design tokens — this round.

## Blocked on Humayun
- Any brand assets beyond what's already been pulled from the live site and applied (a vector source file would be a clean swap if one exists, not required).
- Real employee roster (names/emails/roles/teams) — to be sent as invites.
- Real client → Team assignments.
- Confirming/correcting the "Trailer Content Highlight → Scriptwriter" role assumption in the seeded services (currently mapped to Sr. Video Editor).
- Naming: "TimeLog" and the group-call feature name — open, low priority.
