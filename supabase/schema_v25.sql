-- Blue Kite Ops - schema v25 (2026-09-30)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js). Safe to re-run. Independent of every other schema file.
--
-- Phase 9, part 2: Activity Logs, Manager/Admin-only. Two categories -
-- "task" (a task/sub-task marked done) and "social" (comments, replies,
-- file attachments, Connect calls with duration) - browsed on a new
-- Activity page (main.js's renderActivity()), scoped to a Team the same
-- way every other Team-scoped table already is (see public.current_team()/
-- public.is_admin(), schema_v2.sql).
--
-- Append-only by design - no update/delete policy is defined below, so RLS
-- denies both by default once enabled. A log entry always records its own
-- actor (actorUserId) and is only ever inserted by that same person acting
-- on their own behalf (with check below), never "for" someone else - the
-- same upsert-vs-bare-insert RLS lesson from this session's earlier
-- notifications bug doesn't apply here since this is a plain insert of a
-- brand-new row every time, never an update to an existing one.
create table if not exists public."activityLog" (
  id text primary key,
  "teamId" text references public.teams(id) on delete cascade,
  category text not null check (category in ('task', 'social')),
  "eventType" text not null, -- 'task_item_done' | 'episode_completed' | 'comment' | 'reply' | 'attachment' | 'call'
  "actorUserId" uuid references public.profiles(id),
  "actorRole" text,
  "clientId" text,
  "episodeId" text,
  "taskId" text,
  label text not null default '',
  "durationSec" int,
  "createdAt" timestamptz not null default now()
);
create index if not exists activity_log_team_created_idx on public."activityLog" ("teamId", "createdAt" desc);
create index if not exists activity_log_team_category_idx on public."activityLog" ("teamId", category, "createdAt" desc);

alter table public."activityLog" enable row level security;

drop policy if exists "activityLog insertable by the acting user" on public."activityLog";
create policy "activityLog insertable by the acting user" on public."activityLog"
  for insert with check ("actorUserId" = auth.uid());

drop policy if exists "activityLog readable by managers/admin" on public."activityLog";
create policy "activityLog readable by managers/admin" on public."activityLog"
  for select using (
    public.is_admin() or (public.current_role() = 'manager' and "teamId" = public.current_team())
  );
