-- Blue Kite Ops - schema v18 (2026-09-28)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js). Safe to re-run. Independent of every other pending
-- schema file (v12-v17) - doesn't touch any table they touch.
--
-- What this is for (Phase 4's last two items: "@mentions in comments/chat
-- with popup notification + sound" and "general UI sound effects" - the
-- punch list already narrowed that second one down to notification sounds
-- specifically, everything else deferred to Phase 5's UI/UX overhaul).
--
-- Two pieces:
--   1. "mentions" - a plain array of mentioned user ids - added to both
--      taskComments and episodeComments (the same two tables loadCollab()
--      in main.js already writes comments into).
--   2. A real "notifications" table - a proper inbox, not just a
--      same-session toast, because the whole point of a mention is
--      reaching someone who ISN'T currently looking at that comment
--      thread. Kept deliberately generic (a "type" column) so a future
--      notification kind (not just mentions) can reuse the same table
--      instead of needing its own.

alter table public."taskComments" add column if not exists "mentions" jsonb not null default '[]';
alter table public."episodeComments" add column if not exists "mentions" jsonb not null default '[]';

create table if not exists public.notifications (
  id text primary key,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  type text not null default 'mention',
  message text not null,
  link text,
  "fromUserId" uuid references public.profiles(id),
  "readAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications ("userId","createdAt");

alter table public.notifications enable row level security;

-- You read/mark-read only your own. Insert is gated to "signed in" rather
-- than "userId = auth.uid()" on purpose - a mention notification is
-- written FOR the mentioned person BY whoever mentioned them, same shape
-- as every other "write into someone else's related data as part of
-- normal collaboration" policy already in this schema (e.g. reactions,
-- comments on someone else's task).
drop policy if exists "notifications readable" on public.notifications;
create policy "notifications readable" on public.notifications for select using ("userId" = auth.uid());
drop policy if exists "notifications insertable" on public.notifications;
create policy "notifications insertable" on public.notifications for insert with check (auth.uid() is not null);
drop policy if exists "notifications updatable" on public.notifications;
create policy "notifications updatable" on public.notifications for update using ("userId" = auth.uid()) with check ("userId" = auth.uid());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end $$;
