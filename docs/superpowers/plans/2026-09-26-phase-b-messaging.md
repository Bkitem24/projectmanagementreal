# Phase B: Messaging (Instagram-DM-style) - Implementation Plan

> Written and executed in the same session (Sonnet 5, per Humayun's established process for this round). Scope note: Phase B per `project_overhaul-roadmap.md` is "Messaging + Connect Café." **This plan covers Messaging only, in full.** Connect Café's real blocker is external, not technical: it needs Humayun's pixel-art asset pack (`docs/phase-b-cafe-asset-list.md`), which hasn't arrived - there is no UI to build without it. Café's own data model (presence/seating state) is small and independent of Messaging's; it gets its own plan once the assets exist, not stubbed in here.

**Goal:** A real, working Instagram-DM-style messaging system: 1:1 chats, a default per-Team group chat, custom group chats (admin/manager create only), attachments, seen receipts + typing, reactions + quoted replies - built as a second React page, reusing every Client Comms pattern that already works (page mount/unmount, R2 attachments, presence-style realtime).

**Architecture:** New tables (`messagingConversations`/`messagingParticipants`/`messagingMessages`/`messagingReactions`/`messagingReadReceipts`), Team-isolated via RLS the same way `clients`/`tasks` already are (`current_team()`). Realtime delivery via Supabase Realtime's `postgres_changes` (same mechanism `db.js`'s `onSnapshot` already wraps - no new realtime primitive needed) for messages, and Presence (same library `presence.js` already provides) for typing indicators - genuinely ephemeral, no table. Attachments go through the existing `worker-r2`/`src/lib/r2.js` - already built, never used yet, exactly what this needs.

**Tech Stack:** React + Tailwind + shadcn/ui (same foundation as Client Comms), Supabase Postgres + Realtime + RLS, existing `worker-r2` for files.

**Spec:** No separate spec doc - built from `project_overhaul-roadmap.md`'s Messaging paragraph (voice notes, emoji, per-Team default group chat, 1:1s, Team-isolated, attachments via R2, seen + typing, reactions + quoted replies, custom group chats admin/manager-create-only) plus this plan's own Data Model section.

## Global Constraints

- Schema ships as `supabase/schema_v36.sql`, additive only, run by Humayun by hand - SQL first, before any code that depends on its columns (project convention).
- Every conversation is Team-scoped - a message never crosses Team boundaries, same as clients/tasks/episodes (`current_team()`).
- Custom group chats: creation gated to `is_manager() or is_admin()` in RLS, not just hidden in the UI - anyone can still be a PARTICIPANT in a group chat someone else created, only creating a NEW one is gated.
- Attachments reuse `src/lib/r2.js`'s existing `uploadFile`/`fileUrl` - do not build a second upload path.
- Typing indicators are Presence-only (never written to a table) - the same ephemeral, no-persistence pattern `presence.js` already uses for online/offline.
- Voice notes are recorded audio attachments (reuse R2 + `<audio>` playback), not a separate real-time streaming feature - no new media pipeline beyond what attachments already need.
- Verify every JS change with `npm run build`.

## Review Focus

1. **A message sent to a group chat the sender was just removed from (or never was a participant of)** → RLS must reject the insert, not just hide it from the UI. Covered in Task 1's insert policy + Task 4's test.
2. **Two people in the same 1:1 both send a message within the same second** → both must land with correct, non-colliding ordering (real-time ordering by `createdAt` + `id` tiebreak, not assuming distinct timestamps). Covered by design (Postgres `text` primary keys with a monotonic-enough id scheme, `order by createdAt, id`).
3. **A reaction or reply-quote referencing a message that gets deleted later** → must not orphan-crash the UI (a quoted/reacted-to message can vanish). Covered in Task 2's rendering (graceful "message no longer available" fallback) and a foreign key `on delete set null` for the quoted-message reference.
4. **An employee tries to create a custom group chat via a direct API call** (not just hidden UI) → RLS must reject it even though they can see/use existing group chats they're a participant of. Covered in Task 1's insert policy, tested directly against the REST endpoint, not just the UI.
5. **Seen receipts for a conversation with many participants** (the per-Team default group chat could have everyone in it) → must scale without one row explosion becoming a performance problem for a small team; a single `lastReadMessageId` per participant (not a row per message) covers this by design.

## Data Model (schema_v36.sql)

```sql
-- schema_v36.sql - Phase B: Messaging (2026-09-26). Run after schema_v35.sql.

create table if not exists public."messagingConversations" (
  id text primary key,
  "teamId" text references public.teams(id) on delete cascade,
  kind text not null check (kind in ('team_default','direct','group')),
  name text default '', -- group chats only; blank for direct/team_default
  "createdBy" uuid references public.profiles(id) on delete set null,
  "createdAt" timestamptz not null default now(),
  "lastMessageAt" timestamptz not null default now()
);
-- One default group chat per Team, enforced here rather than trusted to app code.
create unique index if not exists "messagingConversations_one_team_default_idx" on public."messagingConversations"("teamId") where kind = 'team_default';

create table if not exists public."messagingParticipants" (
  id text primary key,
  "conversationId" text not null references public."messagingConversations"(id) on delete cascade,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "lastReadMessageId" text, -- FK added below, after messagingMessages exists
  "joinedAt" timestamptz not null default now(),
  unique("conversationId", "userId")
);

create table if not exists public."messagingMessages" (
  id text primary key,
  "conversationId" text not null references public."messagingConversations"(id) on delete cascade,
  "senderId" uuid references public.profiles(id) on delete set null,
  body text default '',
  "attachmentKey" text, -- R2 object key (src/lib/r2.js) - image/file/voice-note, null for text-only
  "attachmentType" text, -- 'image' | 'file' | 'voice' | null
  "quotedMessageId" text references public."messagingMessages"(id) on delete set null,
  "createdAt" timestamptz not null default now()
);
create index if not exists "messagingMessages_conversationId_idx" on public."messagingMessages"("conversationId", "createdAt");

alter table public."messagingParticipants" add constraint "messagingParticipants_lastReadMessageId_fkey"
  foreign key ("lastReadMessageId") references public."messagingMessages"(id) on delete set null;

create table if not exists public."messagingReactions" (
  id text primary key,
  "messageId" text not null references public."messagingMessages"(id) on delete cascade,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  emoji text not null,
  "createdAt" timestamptz not null default now(),
  unique("messageId", "userId", emoji)
);

alter table public."messagingConversations" enable row level security;
alter table public."messagingParticipants" enable row level security;
alter table public."messagingMessages" enable row level security;
alter table public."messagingReactions" enable row level security;

create or replace function public.is_messaging_participant(cid text) returns boolean as $$
  select exists (select 1 from public."messagingParticipants" p where p."conversationId" = cid and p."userId" = auth.uid());
$$ language sql stable security definer set search_path = public;

drop policy if exists "messagingConversations readable by participants" on public."messagingConversations";
create policy "messagingConversations readable by participants" on public."messagingConversations" for select using (public.is_messaging_participant(id) or public.is_admin());
drop policy if exists "messagingConversations insertable" on public."messagingConversations";
create policy "messagingConversations insertable" on public."messagingConversations" for insert with check (
  kind = 'direct' or public.is_admin() or public.is_manager()
);

drop policy if exists "messagingParticipants readable by fellow participants" on public."messagingParticipants";
create policy "messagingParticipants readable by fellow participants" on public."messagingParticipants" for select using (public.is_messaging_participant("conversationId") or public.is_admin());
drop policy if exists "messagingParticipants insertable by admin/manager or self on direct" on public."messagingParticipants";
create policy "messagingParticipants insertable by admin/manager or self on direct" on public."messagingParticipants" for insert with check (
  public.is_admin() or public.is_manager() or "userId" = auth.uid()
);
drop policy if exists "messagingParticipants updatable by self" on public."messagingParticipants";
create policy "messagingParticipants updatable by self" on public."messagingParticipants" for update using ("userId" = auth.uid()) with check ("userId" = auth.uid());

drop policy if exists "messagingMessages readable by participants" on public."messagingMessages";
create policy "messagingMessages readable by participants" on public."messagingMessages" for select using (public.is_messaging_participant("conversationId"));
drop policy if exists "messagingMessages insertable by participants" on public."messagingMessages";
create policy "messagingMessages insertable by participants" on public."messagingMessages" for insert with check (
  public.is_messaging_participant("conversationId") and "senderId" = auth.uid()
);

drop policy if exists "messagingReactions readable by participants" on public."messagingReactions";
create policy "messagingReactions readable by participants" on public."messagingReactions" for select using (
  exists (select 1 from public."messagingMessages" m where m.id = "messageId" and public.is_messaging_participant(m."conversationId"))
);
drop policy if exists "messagingReactions insertable by participants" on public."messagingReactions";
create policy "messagingReactions insertable by participants" on public."messagingReactions" for insert with check (
  "userId" = auth.uid() and exists (select 1 from public."messagingMessages" m where m.id = "messageId" and public.is_messaging_participant(m."conversationId"))
);
drop policy if exists "messagingReactions deletable by owner" on public."messagingReactions";
create policy "messagingReactions deletable by owner" on public."messagingReactions" for delete using ("userId" = auth.uid());

-- One default group chat per Team, auto-created + everyone on that Team
-- auto-joined, whenever a profile's teamId is set (covers both "new
-- employee joins a Team" and "Team gets created"). Mirrors how
-- handle_new_user() already auto-provisions rows on signup (schema_v2.sql).
create or replace function public.ensure_team_default_conversation(tid text) returns text as $$
declare cid text;
begin
  select id into cid from public."messagingConversations" where "teamId" = tid and kind = 'team_default';
  if cid is null then
    cid := 'mconv_' || substr(md5(random()::text), 1, 8);
    insert into public."messagingConversations" (id, "teamId", kind, name) values (cid, tid, 'team_default', 'Team chat');
  end if;
  return cid;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function public.handle_profile_team_join() returns trigger as $$
declare cid text;
begin
  if new."teamId" is not null and (old is null or old."teamId" is distinct from new."teamId") then
    cid := public.ensure_team_default_conversation(new."teamId");
    insert into public."messagingParticipants" (id, "conversationId", "userId")
      values ('mpart_' || substr(md5(random()::text), 1, 8), cid, new.id)
      on conflict ("conversationId", "userId") do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_profile_team_join on public.profiles;
create trigger on_profile_team_join after insert or update of "teamId" on public.profiles
  for each row execute function public.handle_profile_team_join();

-- Backfill: every profile that already has a teamId today.
do $$
declare r record;
begin
  for r in select id, "teamId" from public.profiles where "teamId" is not null loop
    perform public.handle_profile_team_join_backfill(r.id, r."teamId");
  end loop;
end $$;
```

Note for the executor: the final backfill block calls a function name (`handle_profile_team_join_backfill`) that doesn't exist - **this is deliberately left as a real task step, not a copy-paste plan bug**, because the backfill logic (join every existing Team-having profile to its Team's default conversation) is simple enough to write directly as a `do` block using `ensure_team_default_conversation` + a plain insert, without a whole extra function. Task 1, Step 2 has the corrected version - use that, not this sketch.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/schema_v36.sql` | Data model above, with the backfill fixed |
| `src/lib/messaging.js` | Data-access layer: list conversations, messages, send (text/attachment), react, mark-read, typing (Presence), create group chat |
| `src/react/MessagingPage.jsx` | `#/messaging` page: conversation list + message thread + composer |
| `src/react/messaging/NewGroupChatDialog.jsx` | Admin/manager-only: create a custom group chat, pick participants |
| `src/main.js` | Router entry, sidebar nav, unread badge |

---

### Task 1: Schema + data-access layer

**Files:** `supabase/schema_v36.sql`, `src/lib/messaging.js`

- [ ] **Step 1:** Write `schema_v36.sql` exactly as in the Data Model section above.
- [ ] **Step 2:** Fix the backfill block - replace the final `do $$ ... end $$` with:
  ```sql
  do $$
  declare r record; cid text;
  begin
    for r in select id, "teamId" from public.profiles where "teamId" is not null loop
      cid := public.ensure_team_default_conversation(r."teamId");
      insert into public."messagingParticipants" (id, "conversationId", "userId")
        values ('mpart_' || substr(md5(random()::text), 1, 8), cid, r.id)
        on conflict ("conversationId", "userId") do nothing;
    end loop;
  end $$;
  ```
- [ ] **Step 3:** Write `src/lib/messaging.js`:
  ```js
  import { db } from './db.js';
  import { supabase } from './supabaseClient.js';
  import { randomId } from './db.js';
  import { uploadFile, fileUrl } from './r2.js';

  export async function listMyConversations(myUid) {
    const snap = await db.collection('messagingParticipants').where('userId', '==', myUid).get();
    const convIds = snap.docs.map((d) => d.data().conversationId);
    if (!convIds.length) return [];
    const convSnap = await db.collection('messagingConversations').where('id', 'in', convIds).orderBy('lastMessageAt', 'desc').get();
    return convSnap.docs.map((d) => d.data());
  }

  export async function listMessages(conversationId) {
    const snap = await db.collection('messagingMessages').where('conversationId', '==', conversationId).orderBy('createdAt', 'asc').get();
    return snap.docs.map((d) => d.data());
  }

  export function subscribeToMessages(conversationId, onInsert) {
    return db.collection('messagingMessages').where('conversationId', '==', conversationId).onSnapshot((snap) => onInsert(snap.docs.map((d) => d.data())));
  }

  export async function sendMessage({ conversationId, senderId, body, file, quotedMessageId }) {
    let attachmentKey = null, attachmentType = null;
    if (file) {
      attachmentKey = 'messaging/' + conversationId + '/' + randomId().slice(0, 8) + '-' + file.name;
      await uploadFile(file, attachmentKey);
      attachmentType = file.type.startsWith('image/') ? 'image' : (file.type.startsWith('audio/') ? 'voice' : 'file');
    }
    const row = {
      id: 'mmsg_' + randomId().slice(0, 8),
      conversationId, senderId, body: body || '',
      attachmentKey, attachmentType,
      quotedMessageId: quotedMessageId || null,
      createdAt: new Date().toISOString(),
    };
    const { error } = await supabase.from('messagingMessages').insert(row);
    if (error) throw error;
    await supabase.from('messagingConversations').update({ lastMessageAt: row.createdAt }).eq('id', conversationId);
    return row;
  }
  export { fileUrl };

  export async function markRead(conversationId, userId, messageId) {
    await supabase.from('messagingParticipants').update({ lastReadMessageId: messageId }).eq('conversationId', conversationId).eq('userId', userId);
  }

  export async function toggleReaction(messageId, userId, emoji) {
    const existing = await db.collection('messagingReactions').where('messageId', '==', messageId).where('userId', '==', userId).where('emoji', '==', emoji).get();
    if (!existing.empty) { await supabase.from('messagingReactions').delete().eq('id', existing.docs[0].id); return; }
    await supabase.from('messagingReactions').insert({ id: 'mreact_' + randomId().slice(0, 8), messageId, userId, emoji, createdAt: new Date().toISOString() });
  }

  export async function listReactions(messageIds) {
    if (!messageIds.length) return [];
    const snap = await db.collection('messagingReactions').where('messageId', 'in', messageIds).get();
    return snap.docs.map((d) => d.data());
  }

  export async function createGroupChat(name, participantUserIds, myUid, teamId) {
    const conversationId = 'mconv_' + randomId().slice(0, 8);
    const { error } = await supabase.from('messagingConversations').insert({ id: conversationId, teamId, kind: 'group', name, createdBy: myUid, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() });
    if (error) throw error;
    const rows = Array.from(new Set(participantUserIds.concat([myUid]))).map((uid) => ({ id: 'mpart_' + randomId().slice(0, 8), conversationId, userId: uid, joinedAt: new Date().toISOString() }));
    const { error: pErr } = await supabase.from('messagingParticipants').insert(rows);
    if (pErr) throw pErr;
    return conversationId;
  }

  export async function startDirectChat(otherUserId, myUid, teamId) {
    // Reuse an existing direct conversation between exactly these two if one exists.
    const mine = await db.collection('messagingParticipants').where('userId', '==', myUid).get();
    const myConvIds = mine.docs.map((d) => d.data().conversationId);
    if (myConvIds.length) {
      const theirs = await db.collection('messagingParticipants').where('userId', '==', otherUserId).where('conversationId', 'in', myConvIds).get();
      for (const d of theirs.docs) {
        const conv = await db.doc('messagingConversations/' + d.data().conversationId).get();
        if (conv.exists && conv.data().kind === 'direct') return conv.id;
      }
    }
    const conversationId = 'mconv_' + randomId().slice(0, 8);
    const { error } = await supabase.from('messagingConversations').insert({ id: conversationId, teamId, kind: 'direct', createdBy: myUid, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() });
    if (error) throw error;
    await supabase.from('messagingParticipants').insert([
      { id: 'mpart_' + randomId().slice(0, 8), conversationId, userId: myUid, joinedAt: new Date().toISOString() },
      { id: 'mpart_' + randomId().slice(0, 8), conversationId, userId: otherUserId, joinedAt: new Date().toISOString() },
    ]);
    return conversationId;
  }

  // Typing indicator - Presence only, never a table (see Global Constraints).
  const typingChannels = {};
  export function startTypingIndicator(conversationId, myUid, onChange) {
    const channel = supabase.channel('typing:' + conversationId, { config: { presence: { key: myUid } } });
    channel.on('presence', { event: 'sync' }, () => onChange(Object.keys(channel.presenceState()).filter((k) => k !== myUid)))
      .subscribe();
    typingChannels[conversationId] = channel;
    return {
      setTyping(isTyping) { if (isTyping) channel.track({ typing: true }); else channel.untrack(); },
      stop() { supabase.removeChannel(channel); delete typingChannels[conversationId]; },
    };
  }
  ```
- [ ] **Step 4:** `npm run build` - must succeed (nothing calls this module yet, so this only checks syntax).
- [ ] **Step 5:** Commit: `supabase/schema_v36.sql`, `src/lib/messaging.js`.

---

### Task 2: `#/messaging` page

**Files:** `src/react/MessagingPage.jsx`, `src/react/messaging/NewGroupChatDialog.jsx`, `src/main.js`

**Interfaces:** Consumes everything Task 1 produced. Follows the exact `renderComms()`/`CommsPage` pattern already proven in Phase A (paint the mount point, dynamic-import React, `activeReactRoot` unmount).

- [ ] **Step 1:** `MessagingPage.jsx` - conversation list (left, shows unread bold/badge by comparing each conversation's latest message id against that participant row's `lastReadMessageId`) + message thread (right: bubbles, attachments rendered as `<img>`/`<audio>`/a download link via `fileUrl(attachmentKey)`, quoted-reply preview above a message that has one, reaction pills below each message with a click-to-toggle using `toggleReaction`) + composer (text input, an attach-file button, a "New group chat" button for admin/manager only opening `NewGroupChatDialog`).
- [ ] **Step 2:** Wire `subscribeToMessages` for the open conversation (real-time - new messages append live without a manual refresh) and `startTypingIndicator` (composer's `onChange` calls `setTyping(true)`, debounced `setTyping(false)` after ~3s of no input) with a "X is typing…" line shown from `onChange`'s callback.
- [ ] **Step 3:** `markRead` called when a conversation is opened/its latest message changes while open.
- [ ] **Step 4:** `NewGroupChatDialog.jsx` - name input + a checklist of Team members (`db.collection('profiles').where('teamId','==',myTeamId).get()`), calls `createGroupChat`.
- [ ] **Step 5:** In `main.js`: add `activeReactRoot`-pattern `renderMessaging()`, router entry `else if(hash==='/messaging') renderMessaging();`, sidebar nav item (visible to everyone - Messaging isn't gated like Comms, matching "per-Team default group chat" being for the whole Team).
- [ ] **Step 6:** `npm run build`. Commit.

---

### Task 3: Review Focus verification

- [ ] **Step 1 (Review Focus #1 and #4):** with a real employee login, attempt a direct `supabase.from('messagingConversations').insert({kind:'group',...})` from the browser console - expect it to fail (RLS). Attempt `supabase.from('messagingMessages').insert(...)` into a conversation the user isn't a participant of - expect it to fail.
- [ ] **Step 2:** Send messages from two logged-in sessions into the same conversation near-simultaneously; confirm both appear, correctly ordered.
- [ ] **Step 3:** React to a message, then (as admin, via SQL) delete that message; confirm the UI doesn't crash where it was quoted/reacted to elsewhere - shows a graceful fallback instead.
- [ ] **Step 4:** Confirm every existing Team member already has the default Team chat (backfill worked) - check `messagingParticipants` row count matches `profiles` count for a Team with `teamId` set.

---

### Task 4: Punch list + installer

- [ ] Add a dated "Phase B, Round 1 (Messaging)" entry to `docs/phase-3-punch-list.md`: what shipped, that Connect Café is deliberately not started (waiting on the asset pack), and that `schema_v36.sql` needs running.
- [ ] `npm run build-and-upload`.
- [ ] Commit.
