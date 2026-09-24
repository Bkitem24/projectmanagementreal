-- Blue Kite Ops - schema v24 (2026-09-30)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js). Safe to re-run. Independent of every other schema file.
--
-- Phase 9, part 1: roles scoped per Team. Humayun's ask: task assignment is
-- role-based, not per-named-person, and different Teams can each run their
-- own pool of the same job title (e.g. several Teams each with their own
-- "Outreach VA"s) - one flat, company-wide role list doesn't allow that. A
-- role's "key" (schema_v15/v17.sql) already has to be unique app-wide - it's
-- what's actually stored on profileRoles.role/tasks.role/template step
-- role/invites.roles[] - so keeping keys globally unique and just adding
-- WHICH team a role belongs to as metadata is enough: no existing data,
-- RLS policy, or notification logic needs to change, only which roles show
-- up in which team's dropdowns/checklists (see src/main.js).
--
-- Manager and Admin are NOT scoped (same carve-out schema_v15.sql already
-- made for them) - they're fixed, cross-team access tiers, not a job-title
-- role a Team "owns". Every OTHER already-existing role (the 5 original
-- job titles plus any custom ones created since) is backfilled onto
-- whichever Team was created first, since that's this app's own existing
-- "new stuff defaults to the first team, editable afterward" convention
-- (see schema_v3.sql's client backfill) - there's no way to know from
-- existing data which team a role "should" belong to, so this preserves
-- today's actual behavior (every role visible/usable everywhere) for a
-- single-team setup, while giving a clean path to create a second batch
-- for a second Team going forward.
alter table public.roles add column if not exists "teamId" text references public.teams(id);

do $$
declare
  first_team_id text;
begin
  select id into first_team_id from public.teams order by "createdAt" asc limit 1;
  if first_team_id is not null then
    update public.roles
      set "teamId" = first_team_id
      where "teamId" is null and key not in ('manager', 'admin');
  end if;
end $$;

comment on column public.roles."teamId" is
  'Added 2026-09-30 (schema_v24.sql) - which Team this role belongs to (null for manager/admin, which stay global fixed tiers, same carve-out as schema_v15.sql). A role''s own "key" stays the real, globally-unique identifier everywhere else in the app; teamId only controls which team''s dropdowns/checklists offer it.';
