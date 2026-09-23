-- Blue Kite Ops - schema v22 (2026-09-29)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of
-- every other schema file.
--
-- Two fixes:
--
-- 1. "Could not find the 'heroZoom' column of 'appSettings' in the schema
--    cache" - the hero-image editor's zoom slider (added after
--    schema_v20.sql created the table) needs a column schema_v20.sql never
--    knew to create.
alter table public."appSettings" add column if not exists "heroZoom" numeric not null default 100;

-- 2. Invite-to-a-custom-role still failing with "violates check constraint
--    invites_role_check" even after schema_v21.sql. That file's dynamic
--    scan (drop any check constraint mentioning the old fixed role list)
--    SHOULD have caught this - if it's still happening, the safest fix is
--    to name the confirmed-broken constraints directly rather than trust
--    the scan a second time. Belt-and-suspenders: both the explicit drops
--    AND the same dynamic scan again, in case something else still has it.
alter table public.invites drop constraint if exists invites_role_check;
alter table public.profiles drop constraint if exists profiles_role_check;

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
