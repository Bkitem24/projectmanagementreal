-- Blue Kite Ops - schema v31 (2026-09-24)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of every
-- other schema file.
--
-- Three fixes for this round's real multi-person Meetings testing:
--
-- 1. "Instant meeting still doesn't appear for the other user." Round 32's
--    client-side fix (subscribing to meetingInvitees to catch a new invite
--    and re-query meetings) could never actually work - meetingInvitees was
--    never added to the supabase_realtime publication in the first place,
--    so no postgres_changes event for it was ever being broadcast to
--    anyone, regardless of RLS. meetings itself WAS added (schema_v27.sql)
--    - this was the one table still missing.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meetingInvitees'
  ) then
    execute 'alter publication supabase_realtime add table public."meetingInvitees"';
  end if;
end $$;

-- 2. "Give me an option to clear past meetings history." meetings never had
--    a DELETE policy at all (only select/insert/update) - RLS denies any
--    action with no matching policy by default, so this was never possible
--    even for a host/admin. Same permission model as the existing UPDATE
--    policy. meetingInvitees and meetingParticipantLogs both reference
--    meetings with `on delete cascade` (schema_v27.sql), so deleting a
--    meeting row already cleans those up with no extra policy needed there.
drop policy if exists "meetings deletable by host or admin" on public.meetings;
create policy "meetings deletable by host or admin" on public.meetings for delete using (
  "hostUserId" = auth.uid() or public.is_admin()
);

-- 3. "A scheduled meeting cannot be cancelled." Reuses the existing status
--    column rather than adding a new one - a genuine 'cancelled' value
--    (not just reusing 'ended', which would misleadingly read as "this
--    meeting happened") so the Past list can say what actually occurred.
alter table public.meetings drop constraint if exists meetings_status_check;
alter table public.meetings add constraint meetings_status_check
  check (status in ('scheduled', 'live', 'ended', 'cancelled'));
