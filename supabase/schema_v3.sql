-- Run this in the Supabase SQL editor after schema.sql and schema_v2.sql.
-- One-time fix for Phase 1: the example clients from seed.sql (and any
-- client created before a real Team existed) were inserted with no teamId
-- at all, which is what made the "Add client" team dropdown look broken —
-- it wasn't; those clients just weren't in any team to show up correctly
-- against. This creates a real "Team A" and backfills every team-less
-- client onto it. Safe to run more than once (idempotent).

insert into public.teams (id, name, "managerId", "createdAt")
values ('team_a', 'Team A', null, now())
on conflict (id) do nothing;

update public.clients
set "teamId" = 'team_a'
where "teamId" is null;

-- ---------------------------------------------------------------------------
-- Phase 1 fix: comments/attachments made by Admin show up as "Someone" with
-- no name/photo to non-admin viewers. Root cause: the "profiles readable"
-- policy (schema_v2.sql) lets you read your own row, any row on your team,
-- or everything if *you're* Admin — but there was no rule letting a regular
-- employee read *Admin's* row specifically, and Admin's profile has no
-- teamId at all (never set at bootstrap), so none of the three conditions
-- matched. Adding "or role = 'admin'" lets any signed-in user resolve
-- Admin's identity, the same way Admin can already resolve everyone else's.
-- ---------------------------------------------------------------------------
drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select using (
  auth.uid() = id or public.is_admin() or role = 'admin'
  or (public.current_team() is not null and "teamId" = public.current_team())
);
