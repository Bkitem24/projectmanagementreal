-- Blue Kite Ops — database schema for Supabase (Postgres + Auth).
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: every statement is guarded with IF NOT EXISTS / OR REPLACE / DROP-then-CREATE.
--
-- Columns are deliberately camelCase and double-quoted so the JSON that
-- PostgREST (Supabase's API layer) returns matches the app's JS field names
-- exactly — no translation layer needed in the frontend code.
--
-- IDs are plain `text`, not `uuid`: the app mints its own ids client-side
-- (crypto.randomUUID(), or deterministic strings like ep_<rule>_<period> for
-- episodes so "generate upcoming episodes" is idempotent) — see src/lib/db.js.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- profiles: one row per signed-in team member, holding their chosen role.
-- Created automatically for every new auth.users row by the trigger below.
-- This id stays a real uuid — it must match auth.users.id.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  "displayName" text,
  -- NOTE: superseded by schema_v2.sql's alter/constraint below once that's
  -- run (adds admin + the real role slugs) — kept here only so a fresh
  -- schema.sql-only read isn't misleading about the initial shape.
  role text check (role in ('outreach_va','sr_video_editor','jr_video_editor','packaging_expert','seo_specialist','manager')),
  "updatedAt" timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, "displayName")
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- clients / templates / scheduleRules / episodes / tasks
-- Mirrors the data model from the original prototype 1:1.
-- ---------------------------------------------------------------------------
create table if not exists public.clients (
  id text primary key,
  name text not null,
  "hostName" text default '',
  tagline text default '',
  services text[] default '{}',
  color text default '#c9862e',
  example boolean default false,
  "createdAt" timestamptz not null default now()
);

create table if not exists public.templates (
  id text primary key,
  "clientId" text not null references public.clients(id) on delete cascade,
  name text not null,
  steps jsonb not null default '[]'  -- [{stepId,label,role,group,order,dependsOnLabel}, ...]
);

create table if not exists public."scheduleRules" (
  id text primary key,
  "clientId" text not null references public.clients(id) on delete cascade,
  "templateId" text references public.templates(id) on delete set null,
  label text not null,
  "weekOfMonth" int not null,   -- 1-4, or -1 for "last"
  weekday int not null,          -- 0=Sunday .. 6=Saturday
  paid boolean default false,
  amount int,
  active boolean default true
);

create table if not exists public.episodes (
  id text primary key,           -- deterministic id, e.g. ep_<ruleId>_<YYYY-MM>, for idempotent generation
  "clientId" text not null references public.clients(id) on delete cascade,
  "clientName" text not null,
  "templateId" text references public.templates(id) on delete set null,
  "scheduleRuleId" text references public."scheduleRules"(id) on delete set null,
  title text not null,
  "dueDate" date not null,
  period text,
  paid boolean default false,
  amount int,
  "taskCount" int default 0,
  "createdAt" timestamptz not null default now()
);

create table if not exists public.tasks (
  id text primary key,           -- deterministic id, e.g. <episodeId>_<stepId>
  "episodeId" text not null references public.episodes(id) on delete cascade,
  "episodeTitle" text,
  "clientId" text not null references public.clients(id) on delete cascade,
  "clientName" text,
  role text not null,
  label text not null,
  "group" text default '',
  "orderNum" int default 0,
  "dependsOnLabel" text default '',
  "dueDate" date not null,
  done boolean not null default false,
  "doneByUserId" uuid references public.profiles(id),
  "doneAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create index if not exists tasks_role_done_idx on public.tasks (role, done, "dueDate");
create index if not exists tasks_episode_idx on public.tasks ("episodeId", "orderNum");
create index if not exists episodes_client_idx on public.episodes ("clientId", "dueDate");

-- ---------------------------------------------------------------------------
-- Row Level Security — every signed-in team member can read everything and
-- write shared data (mirrors the original small-team, no-hard-permissions
-- model). Only a viewer's own profile row can be written by that viewer.
-- Want it stricter later (e.g. only "manager" role can write templates)?
-- Swap a "writable" policy's USING clause for something like:
--   exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'manager')
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.templates enable row level security;
alter table public."scheduleRules" enable row level security;
alter table public.episodes enable row level security;
alter table public.tasks enable row level security;

drop policy if exists "profiles readable by any signed-in user" on public.profiles;
create policy "profiles readable by any signed-in user" on public.profiles
  for select using (auth.role() = 'authenticated');
drop policy if exists "profiles writable by owner" on public.profiles;
create policy "profiles writable by owner" on public.profiles
  for update using (auth.uid() = id);

drop policy if exists "clients readable" on public.clients;
create policy "clients readable" on public.clients for select using (auth.role() = 'authenticated');
drop policy if exists "clients writable" on public.clients;
create policy "clients writable" on public.clients for all using (auth.role() = 'authenticated');

drop policy if exists "templates readable" on public.templates;
create policy "templates readable" on public.templates for select using (auth.role() = 'authenticated');
drop policy if exists "templates writable" on public.templates;
create policy "templates writable" on public.templates for all using (auth.role() = 'authenticated');

drop policy if exists "scheduleRules readable" on public."scheduleRules";
create policy "scheduleRules readable" on public."scheduleRules" for select using (auth.role() = 'authenticated');
drop policy if exists "scheduleRules writable" on public."scheduleRules";
create policy "scheduleRules writable" on public."scheduleRules" for all using (auth.role() = 'authenticated');

drop policy if exists "episodes readable" on public.episodes;
create policy "episodes readable" on public.episodes for select using (auth.role() = 'authenticated');
drop policy if exists "episodes writable" on public.episodes;
create policy "episodes writable" on public.episodes for all using (auth.role() = 'authenticated');

drop policy if exists "tasks readable" on public.tasks;
create policy "tasks readable" on public.tasks for select using (auth.role() = 'authenticated');
drop policy if exists "tasks writable" on public.tasks;
create policy "tasks writable" on public.tasks for all using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- Realtime — turn on change broadcasts for the tables the app subscribes to.
-- Wrapped so re-running this script never errors on "already a member".
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['clients','templates','scheduleRules','episodes','tasks','profiles']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
