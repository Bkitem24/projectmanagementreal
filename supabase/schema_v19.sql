-- Blue Kite Ops - schema v19 (2026-09-29)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of every
-- other schema file.
--
-- Fixes a real bug: mentioning someone in a comment failed with "new row
-- violates row-level security policy for table notifications." Postgres
-- shows exactly that message whenever row-level security is turned on for
-- a table but no policy actually grants the attempted operation - which is
-- what happens if the `notifications` table's RLS got enabled (from
-- schema_v18.sql's `create table` + `enable row level security` lines)
-- without its three policy statements landing correctly (e.g. the SQL
-- editor only ran part of that file, or an earlier partial version of the
-- table already existed with different/no policies before schema_v18.sql
-- was written). This re-issues the exact same three policies schema_v18.sql
-- already intended, so it's a safety net regardless of which of those
-- happened - if they're already correct, these statements are no-ops.
drop policy if exists "notifications readable" on public.notifications;
create policy "notifications readable" on public.notifications for select using ("userId" = auth.uid());
drop policy if exists "notifications insertable" on public.notifications;
create policy "notifications insertable" on public.notifications for insert with check (auth.uid() is not null);
drop policy if exists "notifications updatable" on public.notifications;
create policy "notifications updatable" on public.notifications for update using ("userId" = auth.uid()) with check ("userId" = auth.uid());

-- Belt-and-suspenders: confirms RLS is actually on (a no-op if it already is).
alter table public.notifications enable row level security;
