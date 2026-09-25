-- schema_v34.sql (2026-09-25, Round 39)
--
-- "Employee is still able to click clear past meetings which should be an
-- admin/manager only access." Root cause: schema_v31's DELETE policy let a
-- meeting's HOST delete it, and employees can host meetings. Deleting
-- meeting history is now admin, or a manager of that meeting's own Team.
-- Hosts (including employees) can still CANCEL their own scheduled meeting -
-- that's an UPDATE (status='cancelled'), governed by a different policy,
-- untouched here.
--
-- Safe to run more than once.
drop policy if exists "meetings deletable by host or admin" on public.meetings;
drop policy if exists "meetings deletable by admin or team manager" on public.meetings;
create policy "meetings deletable by admin or team manager" on public.meetings for delete using (
  public.is_admin()
  or (public.is_manager() and "teamId" = public.current_team())
);
