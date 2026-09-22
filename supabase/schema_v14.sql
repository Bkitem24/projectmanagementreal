-- Blue Kite Ops - schema v14 (2026-09-28)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js). Safe to re-run.
--
-- What this is for (Phase 2.5 batch D, item #8): a third clock state,
-- "Standby" - confirmed scope from Humayun's 2026-09-26 decision: a manual
-- toggle next to clock-in/out for whenever someone's kicked off something
-- external they're waiting on (a Premiere render, an AI job) that the app
-- has no way to detect automatically. NOT a clock-out - they're still on
-- the clock/being paid for this time, just not actively at the keyboard -
-- so unlike the idle-detector force-pause (which IS a clock-out, see
-- src/lib/timelog.js's design comment), Standby does not touch
-- "timeEntries".clockOutAt at all. It DOES pause screenshot/activity
-- capture for as long as it's on, same as being clocked out would, so a
-- Manager reviewing someone's TimeLog session sees an honest gap - which
-- is exactly why this needs its own real record, not just a client-side
-- flag: a gap in screenshots/activity with no explanation could otherwise
-- read as something broke, or worse.
--
-- A separate table (not just a flag on the current open timeEntries row)
-- because someone can go on and off Standby more than once within the
-- same clocked-in session (render now, it finishes, another one later) -
-- same "start/end timestamp, null end = currently open" shape as
-- timeEntries itself.

create table if not exists public."standbyPeriods" (
  id text primary key,
  "timeEntryId" text not null references public."timeEntries"(id) on delete cascade,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "startedAt" timestamptz not null default now(),
  "endedAt" timestamptz
);
create index if not exists standby_periods_entry_idx on public."standbyPeriods" ("timeEntryId");
create index if not exists standby_periods_user_idx on public."standbyPeriods" ("userId","startedAt");

alter table public."standbyPeriods" enable row level security;

-- Same read/write shape as timeEntries itself (schema_v2.sql): you manage
-- your own, your Team's Manager or Admin can read for oversight, nobody
-- can delete. Uses public.is_manager() (round 8.8/schema_v10, not in this
-- repo but live - see phase-3-punch-list.md's "gap" note) rather than the
-- older inline current_role()='manager' check schema_v2.sql's own
-- policies still use, since this is new code and is_manager() is the
-- current, multi-role-correct way to ask "does this person hold Manager."
drop policy if exists "standbyPeriods insertable" on public."standbyPeriods";
create policy "standbyPeriods insertable" on public."standbyPeriods" for insert with check ("userId" = auth.uid());
drop policy if exists "standbyPeriods updatable" on public."standbyPeriods";
create policy "standbyPeriods updatable" on public."standbyPeriods" for update using ("userId" = auth.uid()) with check ("userId" = auth.uid());
drop policy if exists "standbyPeriods readable" on public."standbyPeriods";
create policy "standbyPeriods readable" on public."standbyPeriods" for select using (
  "userId" = auth.uid() or public.is_admin()
  or (public.is_manager() and public.team_of_user("userId") = public.current_team())
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'standbyPeriods'
  ) then
    execute 'alter publication supabase_realtime add table public."standbyPeriods"';
  end if;
end $$;
