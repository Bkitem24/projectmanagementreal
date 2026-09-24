-- Blue Kite Ops - schema v30 (2026-09-24)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js). Safe to re-run. Independent of every other schema file.
--
-- "Collapsible discussion box with real unread + unread-@mention tracking
-- and jump-to-unread" - explicitly the EPISODE-level "Discussion" panel
-- (main.js's #epCollab, loadCollab('episode', ...)), not the per-task
-- "Comments, links & files" boxes, which are staying exactly as they are.
--
-- One tiny table: each person's own "I've seen this discussion up to here"
-- marker, one row per (person, thread). Generic on threadType/threadId
-- (not just "episodeId") so a future thread kind could reuse it, but only
-- 'episode' is actually wired up this round. A person only ever reads or
-- writes their OWN marker - never "for" someone else - so a plain upsert
-- (main.js's db.doc(...).set()) is safe here, unlike the notifications
-- pitfall documented in CLAUDE.md (that one failed because the row being
-- upserted belonged to someone OTHER than the person doing the writing).
create table if not exists public."discussionReads" (
  id text primary key, -- deterministic: "<userId>:<threadType>:<threadId>"
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "threadType" text not null,
  "threadId" text not null,
  "lastReadAt" timestamptz not null default now()
);
create unique index if not exists discussion_reads_user_thread_idx on public."discussionReads" ("userId", "threadType", "threadId");

alter table public."discussionReads" enable row level security;

drop policy if exists "discussionReads own rows only" on public."discussionReads";
create policy "discussionReads own rows only" on public."discussionReads"
  for all using ("userId" = auth.uid()) with check ("userId" = auth.uid());
