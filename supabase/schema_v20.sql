-- Blue Kite Ops - schema v20 (2026-09-29)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of
-- every other schema file.
--
-- Adds a real, admin-editable Home page hero banner (2026-09-29 ask: "I
-- want the hero banner image on the homepage fully editable... admin only
-- privilege"). A single-row settings table, same shape as `spotlights`
-- (one fixed id, not per-user/per-team) - the app falls back to the
-- built-in /hero-banner.webp at its default position if this row doesn't
-- exist yet or has no imageUrl set, so nothing breaks before an admin
-- actually customizes it.
create table if not exists public."appSettings" (
  id text primary key,
  "heroImageUrl" text,
  "heroPosX" numeric not null default 53,
  "heroPosY" numeric not null default 56,
  "updatedBy" uuid references public.profiles(id),
  "updatedAt" timestamptz not null default now()
);
alter table public."appSettings" enable row level security;

-- Everyone signed in needs to READ this (it drives what every employee's
-- Home page shows) - only an admin can WRITE it.
drop policy if exists "appSettings readable" on public."appSettings";
create policy "appSettings readable" on public."appSettings" for select using (auth.uid() is not null);
drop policy if exists "appSettings insertable" on public."appSettings";
create policy "appSettings insertable" on public."appSettings" for insert with check (public.is_admin());
drop policy if exists "appSettings updatable" on public."appSettings";
create policy "appSettings updatable" on public."appSettings" for update using (public.is_admin()) with check (public.is_admin());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'appSettings'
  ) then
    execute 'alter publication supabase_realtime add table public."appSettings"';
  end if;
end $$;
