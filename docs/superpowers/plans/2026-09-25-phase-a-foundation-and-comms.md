# Phase A: React Foundation + Client Communications (Gmail) - Implementation Plan

> Written and executed in the same session (Sonnet 5, no Opus/Sonnet handoff this round - Humayun's explicit instruction). Scope is deliberately cut to what's fully unblocked and provable tonight: the React/Tailwind/shadcn/Mica foundation, and Client Communications for Gmail end-to-end. Slack and WhatsApp get their data model and UI slots, but their live channels stay OFF until two real blockers clear (documented below) - wiring them in is a fast follow, not new architecture, once unblocked.

**Goal:** Ship a working React+Tailwind+shadcn+Mica foundation living inside the current app, and a real, working Client Communications inbox for Gmail (read + reply), with the data model, access control, and UI shell built to also hold Slack and WhatsApp the moment they're unblocked.

**Architecture:** Page-by-page migration, exactly as scoped in brainstorming: old vanilla pages keep working untouched; React mounts only on `#/comms` via the same `activeReactRoot` unmount pattern proven in Spike 2. Client Comms' own data (accounts, contacts, threads, messages) lives in new Postgres tables, RLS-scoped by the access rules below. Gmail polling runs in a Cloudflare Worker (`worker-comms-gmail/`, hand-rolled IMAP/SMTP exactly as proven live in the Gmail spike) on a Cron Trigger, writing into Supabase via the service-role key (same pattern as `worker-r2`'s retention job) - the desktop app talks to Supabase directly for reading/replying, never straight to Gmail.

**Tech Stack:** React 18 + Tailwind v4 + shadcn/ui (radix-nova preset) inside the existing Tauri/Vite app; `@vitejs/plugin-react` pinned `^4.7.0` (6.x needs Vite 8); Cloudflare Worker + Cron Trigger for Gmail polling; Supabase Postgres + RLS.

**Spec:** No separate spec doc - this plan's own Architecture/Data Model sections are the authority, built directly from `docs/superpowers/specs/2026-09-25-phase-a-spike-results.md` (Spikes 1-3, all PASS) and `project_overhaul-roadmap.md` (memory).

## Global Constraints

- Schema ships as `supabase/schema_v35.sql`, additive only, run by Humayun by hand - SQL runs BEFORE any code that depends on its columns.
- `@vitejs/plugin-react` pinned to `^4.7.0` exactly (not latest) - confirmed in Spike 2 that 6.x requires Vite 8, this project is on Vite 5.4.
- Tailwind entry point: full preflight (`@import "tailwindcss";`) - Spike 2 proved every current page is already safe under it (every heading/list is inside a sized class or contextual selector); note the fragility (a future bare `<h1>`/`<ul>` would shrink/lose styling) in a code comment where the import lives.
- shadcn CLI (`npx shadcn@latest init`) is known to hang on interactive prompts in this environment (Spike 2) - use `npx shadcn@latest add <component>` (non-interactive, confirmed working) plus the hand-written theme CSS block from the spike, not `init`.
- Employees NEVER see the Comms nav item at all, in any circumstance - checked client-side (hide the nav) AND server-side (RLS on every comms table) per `project_overhaul-roadmap.md`.
- Only messages from contacts explicitly attached to a client record are ever stored or shown, on every channel - no inbox-wide sync.
- Never commit a real credential (Gmail app password, Slack token, WhatsApp token) - all Worker secrets via `wrangler secret put`, matching `worker-r2`'s existing convention.
- Verify every JS change with `npm run build`. Verify the Worker with a live `npx wrangler dev` call against a real test account before considering Gmail done - matching how the spike itself was verified, not just "it compiles."
- Update `docs/phase-3-punch-list.md` with a dated Phase A entry when done.

## Known blockers (why Slack/WhatsApp ship data-model-only tonight)

1. **Slack:** cookie capture (`cookies_for_url` across windows) hangs indefinitely - a real, unresolved WebView2/Tauri bug found live in Spike 5. Token capture works and persists, but a full read/send needs the cookie too. Building the Slack UI/data model now, wiring the live channel in once that bug's fixed (either the cross-window hang is root-caused, or cookies are captured via a script running inside the slack-login window itself instead).
2. **WhatsApp:** the dedicated second number's final "Register" step is failing with an undiagnosed Meta-side error (Spike 4, tested live). Webhook is deployed and verified working. Building the data model/UI now; flipping the channel live once the number registers (retry after 24h+, or Meta support).

## Data Model (schema_v35.sql)

```sql
-- schema_v35.sql - Phase A: Client Communications
-- Run AFTER schema_v34.sql. Additive only.

-- One row per connected external account (a Gmail inbox, a Slack workspace
-- session, the WhatsApp number). "channel" + "externalId" together identify
-- it uniquely (e.g. channel='gmail', externalId='podcast@americanmasculinity.com').
create table if not exists public."commsAccounts" (
  id text primary key,
  channel text not null check (channel in ('gmail','slack','whatsapp')),
  "externalId" text not null, -- email address / Slack team id / WhatsApp phone number id
  label text not null, -- human-readable, e.g. "podcast@americanmasculinity.com"
  "teamId" text references public.teams(id) on delete set null,
  "connectedBy" uuid references public.profiles(id) on delete set null,
  "connectedAt" timestamptz not null default now(),
  active boolean not null default true,
  unique(channel, "externalId")
);

-- Per-account access grants. A manager or employee only sees an account if
-- there's a row here for them (admins always see everything, checked in
-- code/RLS via is_admin(), never needs a row). This is what "admin grants
-- an employee access to Comms" (2026-09-25 requirement) and "admin can also
-- withhold a specific account from a manager" both resolve to - one table,
-- same mechanism, no separate manager-vs-employee grant type needed.
create table if not exists public."commsAccountGrants" (
  id text primary key,
  "accountId" text not null references public."commsAccounts"(id) on delete cascade,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "grantedBy" uuid references public.profiles(id) on delete set null,
  "grantedAt" timestamptz not null default now(),
  unique("accountId", "userId")
);

-- A real-world contact (an email address / Slack user id / WhatsApp phone
-- number) explicitly tied to a client. Nothing from any channel is ever
-- synced/shown unless the sender matches a row here - the privacy rule.
create table if not exists public."commsContacts" (
  id text primary key,
  "clientId" text not null references public.clients(id) on delete cascade,
  channel text not null check (channel in ('gmail','slack','whatsapp')),
  "externalAddress" text not null, -- email address / Slack user id / E.164 phone number
  name text default '',
  "createdAt" timestamptz not null default now(),
  unique(channel, "externalAddress")
);

-- One row per conversation thread with a contact, on a given account.
create table if not exists public."commsThreads" (
  id text primary key,
  "accountId" text not null references public."commsAccounts"(id) on delete cascade,
  "contactId" text not null references public."commsContacts"(id) on delete cascade,
  subject text default '', -- Gmail only; blank for Slack/WhatsApp
  "lastMessageAt" timestamptz not null default now(),
  "createdAt" timestamptz not null default now()
);
create index if not exists "commsThreads_contactId_idx" on public."commsThreads"("contactId");

create table if not exists public."commsMessages" (
  id text primary key,
  "threadId" text not null references public."commsThreads"(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  body text not null default '',
  "externalMessageId" text, -- Message-ID / Slack ts / WhatsApp message id, for de-dup + threading
  "sentAt" timestamptz not null default now(),
  "sentBy" uuid references public.profiles(id) on delete set null, -- set for outbound only
  "createdAt" timestamptz not null default now()
);
create index if not exists "commsMessages_threadId_idx" on public."commsMessages"("threadId");
create unique index if not exists "commsMessages_dedup_idx" on public."commsMessages"("threadId","externalMessageId") where "externalMessageId" is not null;

alter table public."commsAccounts" enable row level security;
alter table public."commsAccountGrants" enable row level security;
alter table public."commsContacts" enable row level security;
alter table public."commsThreads" enable row level security;
alter table public."commsMessages" enable row level security;

-- Visibility rule everywhere below: admin sees everything; anyone else
-- (manager OR employee - the 2026-09-25 "let admin grant an employee too"
-- requirement collapses these into one check) needs an explicit grant row
-- for that specific account. Employees never see the Comms nav item client
-- side either (a UI-layer belt-and-braces, not the real security boundary -
-- this RLS is).
create or replace function public.has_comms_access(aid text) returns boolean as $$
  select public.is_admin() or exists (
    select 1 from public."commsAccountGrants" g where g."accountId" = aid and g."userId" = auth.uid()
  );
$$ language sql stable security definer set search_path = public;

create policy "commsAccounts readable with access" on public."commsAccounts" for select using (public.has_comms_access(id));
create policy "commsAccounts managed by admin" on public."commsAccounts" for all using (public.is_admin()) with check (public.is_admin());

create policy "commsAccountGrants readable by admin or self" on public."commsAccountGrants" for select using (public.is_admin() or "userId" = auth.uid());
create policy "commsAccountGrants managed by admin" on public."commsAccountGrants" for insert with check (public.is_admin());
create policy "commsAccountGrants deletable by admin" on public."commsAccountGrants" for delete using (public.is_admin());

create policy "commsContacts managed by admin" on public."commsContacts" for all using (public.is_admin()) with check (public.is_admin());
-- Managers/granted employees can see contacts for clients they can already see (existing client RLS) - no separate read policy needed beyond admin's, since contacts are only useful alongside a thread, gated below.

create policy "commsThreads readable with account access" on public."commsThreads" for select using (public.has_comms_access("accountId"));
create policy "commsMessages readable with account access" on public."commsMessages" for select using (
  exists (select 1 from public."commsThreads" t where t.id = "threadId" and public.has_comms_access(t."accountId"))
);
-- Sending (outbound insert) happens through the app for accounts the user has access to.
create policy "commsMessages insertable with account access" on public."commsMessages" for insert with check (
  direction = 'outbound' and exists (select 1 from public."commsThreads" t where t.id = "threadId" and public.has_comms_access(t."accountId"))
);
```

## Review Focus

1. **An employee with no grants opens `#/comms` directly by URL** (not just missing nav) → must see nothing, not an error dump. Covered in Task 4.
2. **Two people reply to the same thread near-simultaneously** → both messages must land, no lost update. Postgres insert-only messages table has no update race by construction - verified by design, not a special test.
3. **A Gmail account gets revoked (grant deleted) while its thread is open in someone's browser** → the next fetch must fail closed (empty/403), not show stale cached data as if still valid. Covered in Task 4 (no client-side cache of grant state beyond the current page load).
4. **The Gmail poller sees a message from a sender NOT in `commsContacts`** → must be silently skipped, never stored. Covered in Task 3's poller tests.
5. **The same Gmail message gets polled twice** (poller runs before the last UID is durably saved) → must not create a duplicate row. Covered by the `commsMessages_dedup_idx` unique index (Task 3 test: insert same `externalMessageId` twice, second is a no-op via `on conflict do nothing`).

## File Structure

| File | Responsibility |
|---|---|
| `supabase/schema_v35.sql` | Data model above |
| `vite.config.js` | React + Tailwind plugins, `@` alias (from Spike 2, made permanent) |
| `src/tailwind.css` | Real (non-spike) Tailwind entry + theme tokens, imported from `style.css` |
| `jsconfig.json` | `@/*` alias for editor tooling |
| `src/components/ui/*.jsx` | shadcn components (button, dialog, tabs, dropdown-menu, input, textarea, scroll-area) |
| `src/lib/comms.js` | Thin data-access layer over `db.js` for comms tables (list accounts, threads, messages, send) |
| `src/react/CommsPage.jsx` | Top-level `#/comms` page: account/thread list + message view |
| `src/react/comms/AccountsAdmin.jsx` | Admin-only: connect Gmail account, manage grants |
| `src/main.js` | Router entry for `#/comms`, sidebar nav item (admin/manager/granted-employee only), `activeReactRoot` wiring |
| `worker-comms-gmail/` | Cloudflare Worker: Cron-polls IMAP, sends via SMTP on request, writes to Supabase |

---

### Task 1: React + Tailwind + shadcn + Mica foundation (make Spike 1+2 permanent)

**Files:**
- Modify: `vite.config.js`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src/style.css`
- Create: `src/tailwind.css`, `jsconfig.json`
- Create: `src/components/ui/{button,dialog,tabs,dropdown-menu,input,textarea,scroll-area}.jsx`

**Interfaces:**
- Produces: Tailwind + shadcn usable from any `.jsx` file under `src/`; `--blue` etc. app tokens usable inside Tailwind arbitrary-value classes (`bg-[var(--blue)]`), proven in Spike 2.

- [ ] **Step 1:** `npm i react react-dom && npm i -D @vitejs/plugin-react@^4.7.0 tailwindcss @tailwindcss/vite`.
- [ ] **Step 2:** Update `vite.config.js` - add `react()` and `tailwindcss()` plugins, `resolve.alias['@']` pointing at `./src`, exactly as verified in Spike 2's branch (`git show spike/react-island... -- vite.config.js` if that branch still exists locally, else re-apply from the spike results doc's description).
- [ ] **Step 3:** Create `src/tailwind.css` with the real (non-throwaway-named) Tailwind entry - same content as the spike's `tailwind-spike.css` (full preflight `@import "tailwindcss";` + `tw-animate-css` + the hand-written shadcn neutral theme block, since `shadcn init` is confirmed to hang here). Add a code comment at the top citing the Spike 2 "bare heading/list" fragility finding. Import it from the top of `src/style.css`.
- [ ] **Step 4:** `npx shadcn@latest add button dialog tabs dropdown-menu input textarea scroll-area -y` (non-interactive `add`, confirmed working without `init`). If it reports missing `components.json`, create it by hand matching Spike 2's exact content (`style: "radix-nova"`, `tsx: false`, `css: "src/tailwind.css"`, standard `@/` aliases).
- [ ] **Step 5:** `npm i cn tw-animate-css radix-ui class-variance-authority lucide-react` (the runtime deps `shadcn add` needs, confirmed by hand in Spike 2 since `init`'s own install step is unreliable here).
- [ ] **Step 6:** Mica: in `src-tauri/tauri.conf.json`'s main window config, add `"transparent": true, "windowEffects": {"effects": ["mica"]}`. In `src-tauri/capabilities/default.json`, add `"core:window:allow-set-effects"`. In `src/style.css`: `body{background:transparent}`, and confirm `#main{background:var(--paper)}` (already true per Spike 1 - just verify it wasn't reverted).
- [ ] **Step 7:** Theme-follow fix (Spike 1's real finding - static `mica` only follows Windows' theme, not the app's own toggle): in `applyTheme()` (`main.js`), after setting `data-theme`, call the Tauri window API to switch the live effect:
  ```js
  import('@tauri-apps/api/window').then(function(mod){
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    mod.getCurrentWindow().setEffects({ effects: [isDark ? 'micaDark' : 'micaLight'] }).catch(function(){});
  });
  ```
  Note in a code comment: Spike 1 found calling `setEffects` at runtime caused `PrintWindow`-based screenshots to go blank afterward in testing - unconfirmed whether this is a real visual bug or a screenshot-tool artifact. **Verification for this step is a real human look at the window after toggling theme a few times**, not just a build.
- [ ] **Step 8:** `npm run build` - must succeed clean.
- [ ] **Step 9:** Commit: `git add -A && git commit -m "Phase A: React + Tailwind + shadcn/ui + Mica foundation"`.

---

### Task 2: `#/comms` route, nav item, and the React page shell

**Files:**
- Modify: `src/main.js` (router, sidebar nav, `activeReactRoot`)
- Create: `src/react/CommsPage.jsx`
- Create: `src/lib/comms.js`

**Interfaces:**
- Consumes: `db` from `src/lib/db.js` (existing shim), `canManage()`/`isAdmin()`/`myUid` (existing globals in `main.js`).
- Produces: `src/lib/comms.js` exports `listMyAccounts()`, `listThreads(accountId)`, `listMessages(threadId)`, `sendReply(threadId, body)` - all thin wrappers over `db.collection(...)`/`supabase.from(...)`, following the exact patterns already in `db.js`/`main.js` (e.g. `insertNotification`'s bare-insert pattern for anything written "on behalf of" another flow).

- [ ] **Step 1:** Write `src/lib/comms.js`:
  ```js
  import { db } from './db.js';
  import { supabase } from './supabaseClient.js';

  export async function listMyAccounts() {
    const snap = await db.collection('commsAccounts').where('active', '==', true).get();
    return snap.docs.map((d) => d.data());
  }
  export async function listThreads(accountId) {
    const snap = await db.collection('commsThreads').where('accountId', '==', accountId).orderBy('lastMessageAt', 'desc').get();
    return snap.docs.map((d) => d.data());
  }
  export async function listMessages(threadId) {
    const snap = await db.collection('commsMessages').where('threadId', '==', threadId).orderBy('sentAt', 'asc').get();
    return snap.docs.map((d) => d.data());
  }
  export async function sendReply(threadId, body, myUid) {
    // Bare insert, not db.doc().set() - see CLAUDE.md's own convention note
    // on why (.set() re-validates UPDATE policy shape even for a fresh row).
    const row = { id: 'cm_' + Math.random().toString(36).slice(2, 10), threadId, direction: 'outbound', body, sentAt: new Date().toISOString(), sentBy: myUid, createdAt: new Date().toISOString() };
    const { error } = await supabase.from('commsMessages').insert(row);
    if (error) throw error;
    await supabase.from('commsThreads').update({ lastMessageAt: row.sentAt }).eq('id', threadId);
    return row;
  }
  ```
  Check `db.js`'s actual `where()`/`orderBy()` signatures match this call shape before finalizing (read the file - don't assume).
- [ ] **Step 2:** Write `src/react/CommsPage.jsx` - three-pane layout (account list → thread list → message view) using the Task 1 shadcn components (`ScrollArea`, `Tabs` for account switching), Tailwind utility classes, app's own `--blue`/`--surface` tokens for anything that should match the rest of the app's look. Real data via `comms.js`, no mock data. A "Reply" textarea + button calling `sendReply`.
- [ ] **Step 3:** In `main.js`: add `else if(hash==='/comms') renderComms();` to the router (next to the existing `/react-spike`-style entries), and a `renderComms()` function following the exact `renderReactSpike()` pattern from Spike 2 (dynamic `import('react')`/`import('react-dom/client')`/`import('./react/CommsPage.jsx')`, `activeReactRoot` assignment, `React.createElement`).
- [ ] **Step 4:** Sidebar nav: add a "Client Comms" link, but only rendered when `isAdmin() || canManage() || <has at least one comms grant>` - the grant check needs one query (`db.collection('commsAccountGrants').where('userId','==',myUid).limit(1).get()`), cached alongside the other identity-cache pattern already in `main.js` (follow the existing ROLES-cache-refresh pattern noted in CLAUDE.md: render once optimistically, re-render when the grant check resolves).
- [ ] **Step 5:** `npm run build`. Commit.

---

### Task 3: Gmail Worker (poll + send), formalized from the spike

**Files:**
- Create: `worker-comms-gmail/wrangler.toml`, `worker-comms-gmail/src/index.js`
- Modify: `src/lib/comms.js` (add `connectGmailAccount`, calls the Worker, not Gmail directly)

**Interfaces:**
- Produces: Worker endpoints `POST /poll` (Cron-triggered, also callable manually for testing), `POST /send` (`{ accountId, threadId, to, body, inReplyTo }`).
- Consumes: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` secrets (same pattern as `worker-r2`); per-account `GMAIL_APP_PASSWORD_<accountId>` secrets (one per connected inbox - simplest secret-per-account scheme, matches how `worker-r2` already documents "never in `.env`, only Worker secrets").

- [ ] **Step 1:** Copy the exact, already-proven-live IMAP (`imapReadRecent`) and SMTP (`smtpSendThreadedReply`) functions from `spike-imap/src/index.js` verbatim into `worker-comms-gmail/src/index.js` (they are correct and tested live on two hosts - Spike 3 PASS - no re-verification of the protocol code itself needed, only the new wiring around it).
- [ ] **Step 2:** Add a `scheduled()` handler (Cron Trigger, `[triggers] crons = ["*/2 * * * *"]` in `wrangler.toml` - every 2 minutes, cheap given ~2s per poll per Spike 3's measured timing) that:
  1. Queries Supabase (service role) for all active `commsAccounts` where `channel='gmail'`.
  2. For each, calls `imapReadRecent` using that account's stored app-password secret and a stored `lastUid` (new column needed - see Step 3).
  3. For each fetched message, checks `From` address against `commsContacts` (channel='gmail') for that client - **skip silently if no match** (Review Focus #4).
  4. For a match: finds or creates a `commsThreads` row (by `contactId`+`accountId`), inserts into `commsMessages` with `on conflict ("threadId","externalMessageId") do nothing` (Review Focus #5), updates `commsThreads.lastMessageAt`.
- [ ] **Step 2b:** Add `"lastPolledUid" text` column to `commsAccounts` via a small addition to `schema_v35.sql` (Task 1's file, edit before it's been run by Humayun - if already run, add as `schema_v36.sql` instead, check `git log`/ask before assuming).
- [ ] **Step 3:** Add `POST /send` handler: loads the account + thread + contact, calls `smtpSendThreadedReply`, then writes the sent message + `externalMessageId` into `commsMessages` directly from the Worker (so the reply appears immediately without waiting for the next poll cycle).
- [ ] **Step 4:** `npx wrangler dev` locally against a real `.dev.vars` (Humayun's already-proven test account from Spike 3) - manually POST to `/poll` and confirm a message lands in `commsMessages` via a Supabase query, matching Spike 3's verification depth (real live test, not just "no error").
- [ ] **Step 5:** Deploy: `cd worker-comms-gmail && npx wrangler deploy`, then `npx wrangler secret put SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / the per-account app-password secret.
- [ ] **Step 6:** Commit.

---

### Task 4: Admin UI - connect a Gmail account, grant access

**Files:**
- Create: `src/react/comms/AccountsAdmin.jsx`
- Modify: `src/react/CommsPage.jsx` (admin-only "Manage accounts" entry point)

- [ ] **Step 1:** A simple admin-only screen: list connected accounts (from `commsAccounts`), a form to add one (label + which Worker secret name it maps to - the app never sees the app password itself, matching the "never enter credentials" rule; Humayun sets the actual secret via `wrangler secret put` himself, the app just records the account row), and per-account a multi-select of employees to grant (writes `commsAccountGrants` rows).
- [ ] **Step 2:** Verify Review Focus #1 live: log in as an employee with zero grants, navigate directly to `#/comms` by typing the URL - must show an empty/"no access" state, not an error or someone else's data (RLS will return empty rows regardless, but the UI should say something sensible, not silently show a blank confusing screen).
- [ ] **Step 3:** `npm run build`. Commit.

---

### Task 5: Punch list + installer

- [ ] **Step 1:** Add a dated "Phase A, Round 1" entry to `docs/phase-3-punch-list.md`: what shipped (foundation + Gmail Comms), what's data-model-only pending a blocker (Slack cookie bug, WhatsApp number registration), and the exact schema files Humayun needs to run (`schema_v35.sql`, and `schema_v36.sql` if Task 3's column ended up split out).
- [ ] **Step 2:** `npm run build-and-upload`.
- [ ] **Step 3:** Commit the punch list.
