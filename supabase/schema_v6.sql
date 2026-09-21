-- Blue Kite Ops - schema v6 (2026-09-21, third pass - confirmed bug fix)
--
-- Run this AFTER schema.sql through schema_v5.sql, in the same Supabase
-- project: Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to
-- re-run.
--
-- What this fixes: Admin changing an employee's Team (or role) from the
-- Admin page's "All employees" roster editor showed a success toast but
-- never actually stuck - confirmed by checking the row directly in
-- Supabase's Table Editor, where teamId came back null right after the
-- "successful" update.
--
-- Root cause: the "profiles writable by owner" policy, created all the way
-- back in schema.sql and never revisited when the Admin roster editor was
-- built, is:
--
--     create policy "profiles writable by owner" on public.profiles
--       for update using (auth.uid() = id);
--
-- That USING clause only lets someone update their OWN row (auth.uid()
-- must equal the row's id). When Admin tries to update a DIFFERENT
-- employee's row, that condition is false for that row, so Postgres Row
-- Level Security simply excludes it from the UPDATE - zero rows match,
-- zero rows change, and PostgREST returns a plain success response (no
-- error) because nothing about "0 rows matched" is itself an error. The
-- app's code only checks for an error before showing "Updated", so this
-- looked like it worked every time. The protect_profile_fields_trg trigger
-- (schema_v2.sql) was a red herring - it only fires on rows RLS actually
-- lets through, and RLS was rejecting the row before the trigger ever ran.
--
-- This same gap is also why assignTeamManager() (src/lib/teams.js) only
-- ever worked when Admin assigned THEMSELVES as a team's point of contact
-- (auth.uid() happened to equal the target row's id) and silently failed
-- for every other employee - and very likely the whole reason an employee
-- could stay stuck on the wrong Team no matter how many times Admin
-- "moved" them: they were never actually being moved.
--
-- Fix: let Admin's update reach ANY profile row, while everyone else keeps
-- update rights only to their own row (self-service profile editing keeps
-- working exactly as before) - protect_profile_fields_trg still stops a
-- non-admin from smuggling role/teamId changes through their own
-- self-update, as a second layer, unchanged.

drop policy if exists "profiles writable by owner" on public.profiles;
create policy "profiles writable" on public.profiles
  for update using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

-- ---------------------------------------------------------------------------
-- Em-dash cleanup - existing DATA, not app code.
--
-- The app's own interface text (buttons, labels, toasts) was already swept
-- clean in an earlier batch, but that could never touch text that's
-- already sitting in the database as data - confirmed example: the
-- "Example client" row from seed.sql has "Example client — edit this
-- overview..." baked into its tagline column, since that row was already
-- inserted before the sweep existed. seed.sql itself is fixed separately
-- (only matters for a brand new project); this is the one-time cleanup for
-- a database that already has rows in it. Turns " — " into ", " (reads
-- naturally in most sentences) and any stray "—" with no surrounding
-- spaces into a plain comma, across every free-text column anyone (or the
-- seed data) could plausibly have typed one into. Safe to re-run - a
-- second pass over already-cleaned text is a no-op.
-- ---------------------------------------------------------------------------
update public.clients set tagline = replace(replace(tagline, ' — ', ', '), '—', ',') where tagline like '%—%';
update public.clients set "hostName" = replace(replace("hostName", ' — ', ', '), '—', ',') where "hostName" like '%—%';
update public.tasks set label = replace(replace(label, ' — ', ', '), '—', ',') where label like '%—%';
update public.tasks set "dependsOnLabel" = replace(replace("dependsOnLabel", ' — ', ', '), '—', ',') where "dependsOnLabel" like '%—%';
update public.episodes set title = replace(replace(title, ' — ', ', '), '—', ',') where title like '%—%';
update public.services set name = replace(replace(name, ' — ', ', '), '—', ',') where name like '%—%';
update public.teams set name = replace(replace(name, ' — ', ', '), '—', ',') where name like '%—%';
update public.profiles set "displayName" = replace(replace("displayName", ' — ', ', '), '—', ',') where "displayName" like '%—%';
update public."taskComments" set body = replace(replace(body, ' — ', ', '), '—', ',') where body like '%—%';
update public."episodeComments" set body = replace(replace(body, ' — ', ', '), '—', ',') where body like '%—%';
update public."taskLinks" set label = replace(replace(label, ' — ', ', '), '—', ',') where label like '%—%';
update public."episodeLinks" set label = replace(replace(label, ' — ', ', '), '—', ',') where label like '%—%';

-- ---------------------------------------------------------------------------
-- TimeLog: detect a session left open by a force-kill or uninstall.
--
-- Reported 2026-09-21: clocking out manually works fine, but force-killing
-- or uninstalling the app while clocked in leaves that timeEntries row open
-- forever (clockOutAt stays null) - there was never any code path that
-- could run when the process itself is the thing that's gone, so trying to
-- literally "catch" the kill event isn't possible. The fix instead infers
-- abandonment from a heartbeat going stale, from two directions:
--
--   1. Client-side (src/lib/timelog.js): while clocked in, the app now
--      writes lastHeartbeatAt every 2 minutes. On next launch, if the most
--      recent open session's heartbeat is more than 10 minutes stale, that
--      launch auto-closes it (clockOutAt = the last real heartbeat, not
--      "just now") instead of resuming it - this catches force-kill,
--      crash, or an unclean close, the moment the app is next opened.
--
--   2. Server-side (worker-r2's scheduled() - see its "abandoned session
--      sweep" cron, added alongside the existing daily retention job):
--      catches the case the client-side fix can't - an UNINSTALL, where the
--      app is never opened again to run that check at all. Runs every 15
--      minutes and closes out anything whose heartbeat has gone stale,
--      independent of whether anyone ever launches the app again.
--
-- autoClosedReason is purely informational (surfaced back to the person the
-- next time they open the app, and visible to Admin/Manager on that
-- person's TimeLog history) - it's never used to gate any permission.
alter table public."timeEntries" add column if not exists "lastHeartbeatAt" timestamptz;
alter table public."timeEntries" add column if not exists "autoClosedReason" text;
update public."timeEntries" set "lastHeartbeatAt" = "clockInAt" where "lastHeartbeatAt" is null;

-- ---------------------------------------------------------------------------
-- Messaging composer overhaul.
--
-- 1) An attachment can now belong to a specific message (commentId), so
--    "type something, attach a file, hit Send" posts ONE message instead of
--    a message plus a separately-floating file. Old attachments (from
--    before this change) simply have no commentId and keep showing in the
--    existing flat attachment grid at the bottom of the thread - nothing
--    to migrate. on delete cascade: deleting a message also removes the
--    attachment ROW that belonged only to it (the underlying R2 file
--    itself isn't touched here - same as every other attachment delete
--    path, cleanup is worker-r2's existing 6-month retention job).
alter table public."taskAttachments" add column if not exists "commentId" text references public."taskComments"(id) on delete cascade;
alter table public."episodeAttachments" add column if not exists "commentId" text references public."episodeComments"(id) on delete cascade;

-- 2) Emoji reactions on a message - one shared table for both task and
--    episode comments (kind + commentId identifies which), rather than two
--    near-identical tables. comment_team() dispatches to the right
--    Team-scoping helper (task_team/episode_team) based on kind, since a
--    reaction row can't use a normal foreign key into "whichever comments
--    table" to drive RLS the way task_team(taskId) already does for
--    taskComments itself.
create or replace function public.comment_team(kind text, comment_id text) returns text as $$
  select case kind
    when 'task' then (select public.task_team("taskId") from public."taskComments" where id = comment_id)
    when 'episode' then (select public.episode_team("episodeId") from public."episodeComments" where id = comment_id)
    else null
  end;
$$ language sql stable security definer set search_path = public;

create table if not exists public."commentReactions" (
  id text primary key,
  kind text not null check (kind in ('task','episode')),
  "commentId" text not null,
  "userId" uuid not null references public.profiles(id),
  emoji text not null,
  "createdAt" timestamptz not null default now(),
  unique (kind, "commentId", "userId", emoji)
);
create index if not exists comment_reactions_idx on public."commentReactions" (kind, "commentId");
alter table public."commentReactions" enable row level security;

drop policy if exists "commentReactions select" on public."commentReactions";
create policy "commentReactions select" on public."commentReactions" for select using (
  public.is_admin() or public.comment_team(kind, "commentId") is null or public.comment_team(kind, "commentId") = public.current_team()
);
drop policy if exists "commentReactions insert" on public."commentReactions";
create policy "commentReactions insert" on public."commentReactions" for insert with check (
  "userId" = auth.uid()
  and (public.is_admin() or public.comment_team(kind, "commentId") is null or public.comment_team(kind, "commentId") = public.current_team())
);
drop policy if exists "commentReactions delete" on public."commentReactions";
create policy "commentReactions delete" on public."commentReactions" for delete using (
  "userId" = auth.uid() or public.is_admin()
);
