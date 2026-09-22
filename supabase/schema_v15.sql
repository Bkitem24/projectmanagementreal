-- Blue Kite Ops - schema v15 (2026-09-28)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js). Safe to re-run.
--
-- What this is for (Phase 3): "Fully dynamic role system: Admin can
-- create/rename/delete roles from the Admin panel, no code changes needed
-- for future roster changes" - confirmed design from 2026-09-21, not built
-- until now. The 5 job-title roles (Outreach Expert/VA, Sr. Video Editor,
-- Jr. Video Editor, Packaging Expert, SEO Content Specialist) were a
-- hardcoded JS array (ROLES in src/main.js) with per-role colors as CSS
-- variables (--r-outreach_va etc. in style.css) - neither can be touched
-- without a code change and a new build, which is exactly what this phase
-- asked to remove.
--
-- Admin and Manager are NOT part of this - they're deeply load-bearing
-- (is_admin()/is_manager() RLS functions, hardcoded access-tier logic
-- throughout the app) and were never in scope for "create/rename/delete" -
-- the confirmed permissions matrix lists them as fixed tiers, only the
-- job-title roster underneath them was ever meant to be admin-editable.
-- They're still seeded as rows here (below) so every role - including
-- Admin/Manager - has one consistent source for its display label/color,
-- but the app's own Admin-panel UI simply never offers to edit or delete
-- those two rows.
--
-- "Rename" only ever changes a role's label/color, never its own `key` -
-- `key` is what's actually stored on profileRoles.role, tasks.role,
-- invites.roles[], and every template step's role field, so keeping it
-- stable means renaming a role can never orphan anything that already
-- references it.

create table if not exists public.roles (
  key text primary key,
  label text not null,
  color text not null default '#5b6472',
  "sortOrder" int not null default 0,
  "createdAt" timestamptz not null default now()
);

alter table public.roles enable row level security;

-- Everyone signed in needs to read the full role list (to render role
-- chips, dropdowns, etc. for ANY employee, not just themselves) - only
-- Admin can create/rename/delete.
drop policy if exists "roles readable" on public.roles;
create policy "roles readable" on public.roles for select using (auth.uid() is not null);
drop policy if exists "roles writable" on public.roles;
create policy "roles writable" on public.roles for all using (public.is_admin()) with check (public.is_admin());

-- One-time seed of the 5 existing job-title roles PLUS Admin/Manager (see
-- header note) - same keys and colors the hardcoded JS/CSS versions
-- already used, so nothing already stored against these keys anywhere
-- else in the database needs to change. "on conflict do nothing" makes
-- this safe to re-run and safe to run after an Admin has already
-- renamed/recolored one of these (won't stomp their edit back to the
-- original).
insert into public.roles (key, label, color, "sortOrder") values
  ('outreach_va', 'Outreach Expert/VA', '#b9740f', 1),
  ('sr_video_editor', 'Sr. Video Editor', '#0d1c6e', 2),
  ('jr_video_editor', 'Jr. Video Editor', '#3f7bd1', 3),
  ('packaging_expert', 'Packaging Expert', '#7a5ea8', 4),
  ('seo_specialist', 'SEO Content Specialist', '#4f8f6b', 5),
  ('manager', 'Manager', '#55606e', 100),
  ('admin', 'Admin', '#232b45', 101)
on conflict (key) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'roles'
  ) then
    execute 'alter publication supabase_realtime add table public.roles';
  end if;
end $$;
