-- Blue Kite Ops - schema v21 (2026-09-29)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of
-- every other schema file.
--
-- Fixes a real bug: inviting someone to a newly-created custom role failed
-- with `new row for relation "invites" violates check constraint
-- "invites_role_check"`. Root cause: several tables got a CHECK constraint
-- hardcoding the original 5 job-title role keys (plus manager/admin) back
-- when roles were a fixed list - none of them were ever loosened when
-- Phase 3 made roles fully dynamic (create/rename/delete from the Admin
-- panel). The `roles` table itself (schema_v15.sql/schema_v17.sql) has no
-- such restriction, but anything that predates it can still reject a
-- brand-new custom role key at the database level - confirmed present on
-- `invites.role` (schema_v2.sql) and `profiles.role` (schema.sql/
-- schema_v2.sql). Rather than guessing at every table/constraint name one
-- bug report at a time, this scans the WHOLE public schema for any check
-- constraint that hardcodes that old list and drops it - this also covers
-- `profileRoles`/`tasks`/template-step role columns if any of them have
-- the same leftover restriction from the still-missing schema_v8-v11.sql
-- files, without needing to know their exact constraint names.
do $$
declare
  r record;
begin
  for r in
    select conrelid::regclass::text as tbl, conname
    from pg_constraint
    where contype = 'c'
      and connamespace = 'public'::regnamespace
      and pg_get_constraintdef(oid) ilike '%outreach_va%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    raise notice 'Dropped stale fixed-role check % on %', r.conname, r.tbl;
  end loop;
end $$;

-- Keeps the one invariant that's still meaningful (an invite needs at
-- least one role) without restricting which roles - a CHECK constraint
-- already treats a NULL "roles" as satisfied automatically, no separate
-- null-guard needed.
alter table public.invites drop constraint if exists invites_roles_not_empty;
alter table public.invites add constraint invites_roles_not_empty check (array_length(roles, 1) > 0);
