-- Blue Kite Ops - schema v28 (2026-09-30)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Fixes a real bug in
-- schema_v27.sql - run this whether or not v27 already ran cleanly.
--
-- Bug: "insufficient recursion detected in policy for relation meetings"
-- when scheduling or starting a meeting. Root cause: the `meetings` SELECT
-- policy checks `meetingInvitees` (to see if you're invited to it), and
-- `meetingInvitees`'s OWN policies check back into `meetings` (to see if
-- you're its host) - each table's policy needs the OTHER table's policy to
-- finish first, which Postgres correctly refuses to do forever.
--
-- Fix: the exact same pattern this schema already uses elsewhere for this
-- exact problem (see schema_v2.sql's client_team()/task_team() etc.) - a
-- small `security definer` helper function does the cross-table lookup
-- itself, which runs as the function's OWNER rather than the querying
-- user, so it never re-triggers the OTHER table's RLS policy at all. No
-- more cycle.
create or replace function public.meeting_host_id(mid uuid) returns uuid as $$
  select "hostUserId" from public.meetings where id = mid;
$$ language sql stable security definer set search_path = public;

create or replace function public.meeting_team_id(mid uuid) returns text as $$
  select "teamId" from public.meetings where id = mid;
$$ language sql stable security definer set search_path = public;

create or replace function public.is_meeting_invitee(mid uuid, uid uuid) returns boolean as $$
  select exists (select 1 from public."meetingInvitees" where "meetingId" = mid and "userId" = uid);
$$ language sql stable security definer set search_path = public;

drop policy if exists "meetings readable" on public.meetings;
create policy "meetings readable" on public.meetings for select using (
  "hostUserId" = auth.uid()
  or public.is_meeting_invitee(id, auth.uid())
  or public.is_admin()
  or (public.current_role() = 'manager' and "teamId" = public.current_team())
);

drop policy if exists "meeting invitees readable" on public."meetingInvitees";
create policy "meeting invitees readable" on public."meetingInvitees" for select using (
  "userId" = auth.uid()
  or public.is_admin()
  or public.meeting_host_id("meetingId") = auth.uid()
);
drop policy if exists "meeting invitees writable by host or admin" on public."meetingInvitees";
create policy "meeting invitees writable by host or admin" on public."meetingInvitees" for all using (
  public.is_admin() or public.meeting_host_id("meetingId") = auth.uid()
) with check (
  public.is_admin() or public.meeting_host_id("meetingId") = auth.uid()
);

drop policy if exists "meeting participant logs readable" on public."meetingParticipantLogs";
create policy "meeting participant logs readable" on public."meetingParticipantLogs" for select using (
  "userId" = auth.uid()
  or public.is_admin()
  or (public.current_role() = 'manager' and public.meeting_team_id("meetingId") = public.current_team())
);
