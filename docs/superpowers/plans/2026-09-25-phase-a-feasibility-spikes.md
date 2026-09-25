# Phase A Feasibility Spikes (Tests 1-5) - Protocols

> **For agentic workers:** these are SPIKES - throwaway experiments whose output is an ANSWER, not code to keep. Each runs on its own git branch `spike/<name>` created from `main`, and the branch is deleted (not merged) afterwards. Record every result in `docs/superpowers/specs/2026-09-25-phase-a-spike-results.md` (create it; one section per spike: question, what was tried, result, evidence, recommendation). Do not start Phase A work until Humayun has read the results.

**Context:** Phase A = React + Tailwind CSS + shadcn/ui foundation (inside the existing Tauri app, page-by-page migration) with Windows 11 Mica, plus Client Communications (unified inbox: several Gmail accounts, several Slack workspaces, one WhatsApp Business number; only contacts attached to a client show up; employees never see the nav item at all; admins see everything; managers only see accounts an admin granted them). Decisions are recorded in memory file `project_overhaul-roadmap.md` and summarized here where needed.

**Global rules for all spikes**
- Never type a password, app password, token, or cookie into any field or file yourself. Humayun enters secrets himself (e.g. into a `.dev.vars` file or a login window). Never print tokens to logs or screenshots - log only lengths/prefixes like `xoxc-…(len 92)`.
- `.dev.vars`, `*.local`, and any spike secret file must be gitignored before Humayun fills them in - check with `git check-ignore -v <file>`.
- Nothing from a spike ships. Delete spike Workers after (`npx wrangler delete`) and delete branches.
- Report results to Humayun in plain language.

---

## Spike 1 - Mica glass on our window (no help needed)

**Question:** Can our elevated Tauri v2 app on Windows 11 show the Mica material behind a React/HTML UI, in both light and dark theme, without flicker or performance problems?

**Steps**
1. `git switch -c spike/mica`
2. In `src-tauri/tauri.conf.json`, on the main window: `"transparent": true` and `"windowEffects": { "effects": ["mica"] }`. (If the config key names differ in the installed Tauri version, check `node_modules/@tauri-apps/cli/config.schema.json` for `windowEffects` / `Effect` enum values - also note whether `micaDark` / `micaLight` exist.)
3. In `src/style.css` set `html, body { background: transparent; }` and make the sidebar background semi-transparent (e.g. `color-mix(in srgb, var(--surface) 55%, transparent)`); leave the main content solid.
4. `npm run tauri dev` → screenshot light theme and dark theme (toggle Windows theme: Settings → Personalization → Colors).
5. Try switching effect at runtime from JS: `getCurrentWindow().setEffects({ effects: ['mica'] })` (needs `core:window:allow-set-effects` in capabilities) - does it follow the app's own light/dark toggle, or only Windows' theme?
6. Resize/maximize/drag between monitors; watch for black flashes. Note CPU/GPU in Task Manager at idle.
7. Confirm TimeLog and a Meetings call still work (transparency must not break video elements).

**Pass:** Mica visible behind the sidebar in both themes, no flashes, idle GPU ≈ unchanged, calls fine. **Record:** config used, screenshots, whether light/dark can be forced per app theme.

---

## Spike 2 - React + Tailwind + shadcn/ui living alongside the current pages (no help needed)

**Question:** Can one React page run inside the current vanilla-JS app (same Vite build, same hash router, same `paint()` back-button convention) without changing how any existing page looks, and cleanly unmount when you navigate away?

**Steps**
1. `git switch -c spike/react-island`
2. Install: `npm i react react-dom` and `npm i -D @vitejs/plugin-react tailwindcss @tailwindcss/vite`; add both plugins to `vite.config.js` (keep the existing `server.watch.ignored` for `src-tauri`).
3. Initialise shadcn/ui (`npx shadcn@latest init`), add `button`, `dialog`, `dropdown-menu`, `tabs`. Note every file it creates/changes (components.json, path aliases, CSS).
4. **The key risk: Tailwind's base reset ("preflight") restyles plain `h1`, `button`, lists etc. across the WHOLE app.** Test two setups and screenshot Home, My Board, an episode checklist, Meetings, Admin before and after each:
   - A: full `@import "tailwindcss";` (with preflight)
   - B: `@import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities);` (no preflight) with shadcn components still rendering correctly
5. Add route `#/react-spike` in the router in `src/main.js` (next to `else if(hash==='/connect')`): `paint('<div id="reactRoot"></div>')`, then dynamically `import('./react/SpikePage.jsx')` and `createRoot(...).render(...)`. The page shows a shadcn Button that opens a Dialog, reads live data through the existing `db` shim (e.g. list of clients via `db.collection('clients').get()`), and uses the app's CSS tokens (`var(--blue)`) inside Tailwind classes (`bg-[var(--blue)]`).
6. On every route change, the previous React root must `unmount()` - add the hook in the router and prove it (a `useEffect` cleanup `console.log`).
7. Check: back button works, dark theme applies to the React page, `npm run build` size delta (report KB before/after), dev hot-reload works, and a Tauri build runs it.

**Pass:** at least one setup (A or B) leaves every old page visually identical, React page works and unmounts. **Record:** which setup, the exact config, size delta, anything that broke.

---

## Spike 3 - Reading and sending Gmail via app password over IMAP/SMTP from our server (Humayun: one app password)

**Question:** Can a Cloudflare Worker (like our existing ones) log in to Gmail with an app password over IMAP, list recent mail, and send a reply over SMTP - for both an @gmail.com and a Google Workspace address?

**Humayun's part:** on a TEST Gmail account: turn on 2-Step Verification, create an app password (Google Account → Security → App passwords), and paste it into the spike's `.dev.vars` himself. Same for one company-domain account if available.

**Steps**
1. `git switch -c spike/imap`; create `spike-imap/` with a minimal Worker (`wrangler.toml` with `compatibility_flags = ["nodejs_compat"]`). Create `spike-imap/.dev.vars.example` with `GMAIL_USER=` and `GMAIL_APP_PASSWORD=`; gitignore `spike-imap/.dev.vars`; ask Humayun to copy and fill it.
2. Use `connect()` from `cloudflare:sockets` with `{ secureTransport: 'on' }` to `imap.gmail.com:993`. Speak minimal IMAP by hand (tagged commands): `LOGIN`, `SELECT INBOX`, `UID SEARCH SINCE <date>`, `UID FETCH <uids> (ENVELOPE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)])`. Print the latest 5 subjects + From addresses only.
3. SMTP: `connect('smtp.gmail.com:465', { secureTransport: 'on' })`, `EHLO`, `AUTH PLAIN`, send one email from the account to itself with `In-Reply-To`/`References` set to one of the fetched Message-IDs. Confirm in Gmail it threads under the original conversation.
4. Run with `npx wrangler dev` (local) first, then `--remote` (Cloudflare's real network - port rules can differ). Note whether port 465 is allowed from Workers.
5. Measure: how long a poll takes (login → fetch new since last UID). Plan is polling every ~1 minute via Cron Trigger - confirm Cron Triggers are available on the account's Workers plan.
6. If raw sockets fail: repeat step 2-3 in a Supabase Edge Function (Deno, `Deno.connectTls`) as the fallback host, and record which works.

**Pass:** read + threaded reply work from at least one host (Worker preferred). **Record:** host, ports, timings, Workspace vs @gmail.com differences, any Google security emails received ("new sign-in").

---

## Spike 4 - WhatsApp Business "coexistence" for a self-built app (research first, no help needed until the end)

**Question:** Can Humayun keep using his WhatsApp Business app on his phone AND connect the same number to our app (Cloud API), receiving every incoming message by webhook (we keep only allowlisted client numbers) and seeing messages he sends from his phone - as a business building its own app, not a Meta partner?

**Research (web, Meta's official developer docs only - cite URLs):**
1. Coexistence onboarding ("WhatsApp Business app users" / Embedded Signup): is it available to a business onboarding ITS OWN number via its own Meta app, or only via Tech Providers / Solution Partners? What exactly must be set up (Meta Business portfolio, business verification, app review, Embedded Signup config)?
2. Country availability - **ask Humayun which country his WhatsApp Business number is registered in**, then check it against Meta's supported/unsupported list.
3. What stops working on the phone app once connected (e.g. broadcast lists, disappearing/view-once messages, linked devices), and the "open the app at least every N days" rule.
4. Webhooks: incoming messages (`messages`), messages sent from the phone (`smb_message_echoes`), history sync on onboarding (how far back), and status updates.
5. Pricing today (per-message model): what's free (replying within 24h of a client message) vs paid (business-initiated templates), in his country's rate card.
6. Fallback if coexistence is out: a second, API-only number - what that costs and what clients would see.

**If research says GO:** ask Humayun to create a Meta developer account + app himself; build a throwaway Worker webhook (`spike-wa/`) that verifies the webhook challenge and logs sender number + message type only (not content), send it a test message from another phone, and send one reply via the Cloud API.

**Record:** go / no-go, step-by-step setup Humayun would do, costs, phone-app limitations, fallback.

---

## Spike 5 - Slack login-as-yourself on this computer (Humayun: logs in himself)

**Decision already made (Humayun, informed of the risks - Slack terms of use, breakage when Slack changes its web app):** because he's a guest in clients' workspaces and won't ask clients to approve an app, Slack uses his own browser-style session. The session is stored ONLY on each person's own computer (Windows Credential Manager), never on our server; each admin/manager logs in themselves.

**Question:** Can our app open a Slack login window, capture the resulting session for every workspace he's signed into, then list conversations, read history, and send a message through Slack's web API - reliably, as a guest?

**Steps**
1. `git switch -c spike/slack-session`
2. Add a Rust command that opens a separate `WebviewWindow` at `https://app.slack.com/` (label `slack-login`). Humayun signs in himself (including 2FA/SSO) and opens each client workspace once.
3. Capture, without printing values:
   - the `d` cookie for `.slack.com` - try Tauri's webview cookie API (`cookies_for_url` / `cookies`, check the installed `tauri` crate version's docs), else WebView2's `CoreWebView2CookieManager` via `with_webview`;
   - the per-workspace `xoxc-` tokens from the page's `localStorage` key `localConfig_v2` (`teams[<id>].token`). Reading page storage needs either an `initialization_script` that posts back through a capability scoped ONLY to that window + `https://app.slack.com` with ONLY one command allowed, or `eval` + a one-shot event. Document which worked and keep the remote-IPC scope as narrow as possible.
4. Store them with the `keyring` crate (Windows Credential Manager, service `BlueKiteOps.Slack`) and prove they survive an app restart.
5. From Rust (`reqwest`, header `Authorization: Bearer xoxc-…` + `Cookie: d=…`), per workspace: `auth.test`, `users.conversations` (types `im,mpim,private_channel,public_channel`), `conversations.history` (limit 20) for one DM with a client, and `chat.postMessage` to Humayun's OWN self-DM only (never to a client during the spike).
6. Real-time: measure polling cost (how many conversations × rate limits) vs. opening Slack's websocket; recommend one.
7. Sign out in the Slack window → confirm our stored session stops working and the app detects it (`invalid_auth`) and asks to log in again.

**Pass:** read + self-send work in at least one CLIENT workspace where he's a guest. **Record:** capture method, what a guest can and can't list, rate-limit notes, how an expired session shows up.

---

## Later - Spike 6 (Phase D prep): current app on a Mac

When Humayun has his Mac access ready: build an unsigned macOS `.app`/`.dmg` via GitHub Actions (`macos-latest` runner) and test on the Mac: first-launch Gatekeeper flow (System Settings → Privacy & Security → Open Anyway), login, Connect call, Meetings camera + mic, screen share (does `getDisplayMedia` work in WKWebView at all? system audio?), recording to disk (`MediaRecorder` mp4 in WebKit), TimeLog permissions (Accessibility, Input Monitoring, Screen Recording), music player. Record what works / breaks. Needs a separate plan when the time comes.
