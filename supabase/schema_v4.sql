-- Blue Kite Ops — schema v4 ("Additional Fixes Phase 1", 2026-09-21)
--
-- Run this AFTER schema.sql, schema_v2.sql and schema_v3.sql, in the same
-- Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run, same as the earlier schema files.
--
-- What's in here:
--   1. Episode-level discussion (episodeComments/Links/Attachments) — the
--      new general chat/comment box for a whole episode, separate from the
--      existing per-subtask comment/link/attachment threads (taskComments
--      etc. from schema_v2.sql).
--   2. A trigger that keeps profiles.email in sync after someone changes
--      their email via the new "Edit profile" screen. Supabase Auth only
--      actually changes auth.users.email once the confirmation link in
--      that flow is clicked, so this only fires (and profiles.email only
--      updates) once the change is real — never for an unconfirmed request.

-- ---------------------------------------------------------------------------
-- Episode-level discussion
-- ---------------------------------------------------------------------------
create or replace function public.episode_team(eid text) returns text as $$
  select public.client_team("clientId") from public.episodes where id = eid;
$$ language sql stable security definer set search_path = public;

create table if not exists public."episodeComments" (
  id text primary key,
  "episodeId" text not null references public.episodes(id) on delete cascade,
  "authorId" uuid references public.profiles(id),
  body text not null,
  "createdAt" timestamptz not null default now()
);
create table if not exists public."episodeLinks" (
  id text primary key,
  "episodeId" text not null references public.episodes(id) on delete cascade,
  "addedBy" uuid references public.profiles(id),
  url text not null,
  label text default '',
  "createdAt" timestamptz not null default now()
);
create table if not exists public."episodeAttachments" (
  id text primary key,
  "episodeId" text not null references public.episodes(id) on delete cascade,
  "uploadedBy" uuid references public.profiles(id),
  "r2Key" text not null,
  "fileName" text not null,
  "fileType" text,
  "fileSize" int,
  "createdAt" timestamptz not null default now()
);
create index if not exists episode_comments_idx on public."episodeComments" ("episodeId","createdAt");
create index if not exists episode_links_idx on public."episodeLinks" ("episodeId");
create index if not exists episode_attachments_idx on public."episodeAttachments" ("episodeId");

alter table public."episodeComments" enable row level security;
alter table public."episodeLinks" enable row level security;
alter table public."episodeAttachments" enable row level security;

-- Same Team-scoping rule as taskComments/taskLinks/taskAttachments — anyone
-- on the episode's Team (or Admin) can read and post.
drop policy if exists "episodeComments rw" on public."episodeComments";
create policy "episodeComments rw" on public."episodeComments" for all using (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
) with check (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);
drop policy if exists "episodeLinks rw" on public."episodeLinks";
create policy "episodeLinks rw" on public."episodeLinks" for all using (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
) with check (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);
drop policy if exists "episodeAttachments rw" on public."episodeAttachments";
create policy "episodeAttachments rw" on public."episodeAttachments" for all using (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
) with check (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);

do $$
declare t text;
begin
  foreach t in array array['episodeComments','episodeLinks','episodeAttachments']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Keep profiles.email in sync with auth.users.email after a self-service
-- email change (the new "Edit profile" screen calls supabase.auth.updateUser
-- with a new email, which only actually takes effect in auth.users once the
-- confirmation link is clicked).
-- ---------------------------------------------------------------------------
create or replace function public.sync_profile_email()
returns trigger as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists sync_profile_email_trg on auth.users;
create trigger sync_profile_email_trg
  after update of email on auth.users
  for each row execute procedure public.sync_profile_email();
