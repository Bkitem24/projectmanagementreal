-- Blue Kite Ops — schema v2 (Teams, Admin tier, invite-only signup, service
-- vocabulary, task collaboration, TimeLog, presence, spotlight).
--
-- Run this AFTER schema.sql (and after seed.sql, if you used it) in the same
-- Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run, same as schema.sql.
--
-- What changes vs. v1:
--   * Signup is now invite-only. The very first account ever created on a
--     fresh project becomes "admin" automatically (that's you, Humayun) —
--     every account after that MUST match a pending row in `invites`, or
--     the signup is rejected outright at the database level (not just
--     hidden in the UI). This replaces v1's "anyone can pick Manager for
--     themselves" model.
--   * Teams: a Team has one Manager and a roster of clients + employees.
--     A Manager only sees/edits their own Team; Admin sees everything.
--   * Services are now a controlled vocabulary (public.services) instead of
--     free-typed text, with a scope of 'global' (every team can use it) or
--     'team' (only one team can use it, and only that team's Manager — or
--     Admin — can create it).

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
create table if not exists public.teams (
  id text primary key,
  name text not null,
  "managerId" uuid references public.profiles(id) on delete set null,
  "createdAt" timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles: add Team, admin role, avatar, music taste, presence timestamp.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists "teamId" text references public.teams(id) on delete set null;
alter table public.profiles add column if not exists "avatarUrl" text;
alter table public.profiles add column if not exists "musicMood" text;
alter table public.profiles add column if not exists "lastSeenAt" timestamptz;

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('outreach_va','sr_video_editor','jr_video_editor','packaging_expert','seo_specialist','manager','admin'));

-- clients now belong to exactly one Team (nullable only for pre-v2 rows —
-- assign these from the Admin panel after upgrading).
alter table public.clients add column if not exists "teamId" text references public.teams(id) on delete set null;
alter table public.clients add column if not exists "imageUrl" text;

-- ---------------------------------------------------------------------------
-- Invites — the only way (besides the very first account) to get a login.
-- ---------------------------------------------------------------------------
create table if not exists public.invites (
  id text primary key default encode(gen_random_bytes(6), 'hex'), -- the invite "code"
  email text not null,
  role text not null check (role in ('outreach_va','sr_video_editor','jr_video_editor','packaging_expert','seo_specialist','manager')),
  "teamId" text references public.teams(id) on delete cascade,
  "invitedBy" uuid references public.profiles(id),
  "usedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "expiresAt" timestamptz not null default (now() + interval '14 days')
);
create index if not exists invites_email_idx on public.invites (lower(email));

-- ---------------------------------------------------------------------------
-- handle_new_user (replaces the v1 version): bootstrap-admin-or-require-invite.
--
-- Matching is by INVITE CODE, not email alone — the code is the secret. If
-- it only matched by email, anyone who learned or guessed a teammate's
-- email address (e.g. firstname@bluekitemedia.com — not hard, at a small
-- company) could sign up first and steal that role/Team before the real
-- person does. The code is a short random string the Manager/Admin who
-- created the invite hands the new hire directly (Slack, WhatsApp, in
-- person) — it's the thing standing in for a clickable emailed invite link,
-- which this desktop app has no way to generate on its own.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
declare
  inv record;
  is_bootstrap boolean;
  supplied_code text;
begin
  select not exists(select 1 from public.profiles) into is_bootstrap;

  if is_bootstrap then
    -- First account on a fresh project. This is you — becomes Admin.
    insert into public.profiles (id, email, "displayName", role)
    values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', new.email), 'admin');
    return new;
  end if;

  supplied_code := new.raw_user_meta_data->>'invite_code';
  if supplied_code is null or length(trim(supplied_code)) = 0 then
    raise exception 'An invite code is required to sign up. Ask your manager or admin for one.';
  end if;

  select * into inv from public.invites
    where id = lower(trim(supplied_code))
      and "usedAt" is null
      and "expiresAt" > now()
      and lower(email) = lower(new.email);

  if inv.id is null then
    raise exception 'That invite code is invalid, expired, or already used, or does not match this email. Ask your manager or admin for a fresh invite.';
  end if;

  insert into public.profiles (id, email, "displayName", role, "teamId")
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', new.email), inv.role, inv."teamId");

  update public.invites set "usedAt" = now() where id = inv.id;

  return new;
end;
$$ language plpgsql security definer set search_path = public;
-- (the trigger itself, on_auth_user_created, already exists from schema.sql
-- and just picks up this new function body — no need to redefine it.)

-- Lock role/teamId against self-editing — only Admin (via the admin panel,
-- which runs as the signed-in admin, still subject to this) or the trigger
-- above (security definer, bypasses this) can set them.
create or replace function public.protect_profile_fields()
returns trigger as $$
begin
  if coalesce((select role from public.profiles where id = auth.uid()), '') <> 'admin' then
    new.role := old.role;
    new."teamId" := old."teamId";
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists protect_profile_fields_trg on public.profiles;
create trigger protect_profile_fields_trg
  before update on public.profiles
  for each row execute procedure public.protect_profile_fields();

-- ---------------------------------------------------------------------------
-- Services — controlled vocabulary. scope='global' (every team) or
-- scope='team' (one team only). Each service can carry its own sub-tasks,
-- which a client's workflow template can be seeded from.
-- ---------------------------------------------------------------------------
create table if not exists public.services (
  id text primary key,
  name text not null,
  scope text not null default 'global' check (scope in ('global','team')),
  "teamId" text references public.teams(id) on delete cascade,
  "subTasks" jsonb not null default '[]', -- [{stepId, label, role}, ...]
  "createdBy" uuid references public.profiles(id),
  "createdAt" timestamptz not null default now(),
  constraint services_team_scope_chk check (
    (scope = 'global' and "teamId" is null) or (scope = 'team' and "teamId" is not null)
  )
);

-- ---------------------------------------------------------------------------
-- Task collaboration — comments, links, attachments.
-- ---------------------------------------------------------------------------
create table if not exists public."taskComments" (
  id text primary key,
  "taskId" text not null references public.tasks(id) on delete cascade,
  "authorId" uuid references public.profiles(id),
  body text not null,
  "createdAt" timestamptz not null default now()
);
create table if not exists public."taskLinks" (
  id text primary key,
  "taskId" text not null references public.tasks(id) on delete cascade,
  "addedBy" uuid references public.profiles(id),
  url text not null,
  label text default '',
  "createdAt" timestamptz not null default now()
);
create table if not exists public."taskAttachments" (
  id text primary key,
  "taskId" text not null references public.tasks(id) on delete cascade,
  "uploadedBy" uuid references public.profiles(id),
  "r2Key" text not null,
  "fileName" text not null,
  "fileType" text,
  "fileSize" int,
  "createdAt" timestamptz not null default now()
);
create index if not exists task_comments_idx on public."taskComments" ("taskId","createdAt");
create index if not exists task_links_idx on public."taskLinks" ("taskId");
create index if not exists task_attachments_idx on public."taskAttachments" ("taskId");

-- ---------------------------------------------------------------------------
-- TimeLog — clock-in sessions, screenshots, activity samples.
-- NOTE on "keyLog": per Humayun's explicit decision this stores actual
-- keystroke content, not just counts. Practical heads-up left in code: this
-- machine-wide hook can't distinguish "work" typing from a personal
-- password typed into the same PC, so anything typed while clocked in gets
-- captured, no field-level exclusions. Worth knowing going in.
-- Nothing here is ever deleted by employees — only the 6-month retention
-- job (see worker-r2/) removes old rows + their R2 objects.
-- ---------------------------------------------------------------------------
create table if not exists public."timeEntries" (
  id text primary key,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "clockInAt" timestamptz not null default now(),
  "clockOutAt" timestamptz
);
create table if not exists public.screenshots (
  id text primary key,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "timeEntryId" text references public."timeEntries"(id) on delete set null,
  "r2Key" text not null,
  "takenAt" timestamptz not null default now()
);
create table if not exists public."activitySamples" (
  id text primary key,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "timeEntryId" text references public."timeEntries"(id) on delete set null,
  "windowStart" timestamptz not null,
  "windowEnd" timestamptz not null,
  "keyCount" int default 0,
  "mouseDistance" int default 0,
  "keyLog" text default '',
  "createdAt" timestamptz not null default now()
);
create index if not exists time_entries_user_idx on public."timeEntries" ("userId","clockInAt");
create index if not exists screenshots_user_idx on public.screenshots ("userId","takenAt");
create index if not exists activity_user_idx on public."activitySamples" ("userId","windowStart");

-- ---------------------------------------------------------------------------
-- Spotlight — "Employee of the Month" banner, one row per month.
-- ---------------------------------------------------------------------------
create table if not exists public.spotlights (
  id text primary key,          -- the month, e.g. '2026-09'
  "employeeId" uuid references public.profiles(id),
  note text default '',
  "setBy" uuid references public.profiles(id),
  "updatedAt" timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Helper functions used throughout RLS below.
-- ---------------------------------------------------------------------------
create or replace function public.current_role() returns text as $$
  select role from public.profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

create or replace function public.current_team() returns text as $$
  select "teamId" from public.profiles where id = auth.uid();
$$ language sql stable security definer set search_path = public;

create or replace function public.is_admin() returns boolean as $$
  select public.current_role() = 'admin';
$$ language sql stable;

create or replace function public.client_team(cid text) returns text as $$
  select "teamId" from public.clients where id = cid;
$$ language sql stable security definer set search_path = public;

create or replace function public.task_team(tid text) returns text as $$
  select public.client_team("clientId") from public.tasks where id = tid;
$$ language sql stable security definer set search_path = public;

create or replace function public.team_of_user(uid uuid) returns text as $$
  select "teamId" from public.profiles where id = uid;
$$ language sql stable security definer set search_path = public;

-- ---------------------------------------------------------------------------
-- RLS — replace the v1 "any authenticated user can do anything" policies
-- with Team-scoped ones, now that separate Teams need real separation.
-- ---------------------------------------------------------------------------
alter table public.teams enable row level security;
alter table public.invites enable row level security;
alter table public.services enable row level security;
alter table public."taskComments" enable row level security;
alter table public."taskLinks" enable row level security;
alter table public."taskAttachments" enable row level security;
alter table public."timeEntries" enable row level security;
alter table public.screenshots enable row level security;
alter table public."activitySamples" enable row level security;
alter table public.spotlights enable row level security;

-- profiles: everyone can read their own row + their teammates' + Admin sees all.
drop policy if exists "profiles readable by any signed-in user" on public.profiles;
drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select using (
  auth.uid() = id or public.is_admin()
  or (public.current_team() is not null and "teamId" = public.current_team())
);
-- (the existing "profiles writable by owner" update policy from schema.sql
-- still applies; protect_profile_fields_trg above stops role/teamId from
-- being changed by anyone except Admin, regardless of that policy.)

-- clients: readable within your Team (or by Admin); writable by that Team's
-- Manager (or Admin).
drop policy if exists "clients readable" on public.clients;
create policy "clients readable" on public.clients for select using (
  public.is_admin() or "teamId" is null or "teamId" = public.current_team()
);
drop policy if exists "clients writable" on public.clients;
create policy "clients writable" on public.clients for all using (
  public.is_admin() or (public.current_role() = 'manager' and "teamId" = public.current_team())
) with check (
  public.is_admin() or (public.current_role() = 'manager' and "teamId" = public.current_team())
);

drop policy if exists "templates readable" on public.templates;
create policy "templates readable" on public.templates for select using (
  public.is_admin() or public.client_team("clientId") is null or public.client_team("clientId") = public.current_team()
);
drop policy if exists "templates writable" on public.templates;
create policy "templates writable" on public.templates for all using (
  public.is_admin() or (public.current_role() = 'manager' and public.client_team("clientId") = public.current_team())
) with check (
  public.is_admin() or (public.current_role() = 'manager' and public.client_team("clientId") = public.current_team())
);

drop policy if exists "scheduleRules readable" on public."scheduleRules";
create policy "scheduleRules readable" on public."scheduleRules" for select using (
  public.is_admin() or public.client_team("clientId") is null or public.client_team("clientId") = public.current_team()
);
drop policy if exists "scheduleRules writable" on public."scheduleRules";
create policy "scheduleRules writable" on public."scheduleRules" for all using (
  public.is_admin() or (public.current_role() = 'manager' and public.client_team("clientId") = public.current_team())
) with check (
  public.is_admin() or (public.current_role() = 'manager' and public.client_team("clientId") = public.current_team())
);

drop policy if exists "episodes readable" on public.episodes;
create policy "episodes readable" on public.episodes for select using (
  public.is_admin() or public.client_team("clientId") is null or public.client_team("clientId") = public.current_team()
);
drop policy if exists "episodes writable" on public.episodes;
create policy "episodes writable" on public.episodes for all using (
  public.is_admin() or (public.current_role() = 'manager' and public.client_team("clientId") = public.current_team())
) with check (
  public.is_admin() or (public.current_role() = 'manager' and public.client_team("clientId") = public.current_team())
);

-- tasks: readable within your Team; writable by that Team's Manager/Admin,
-- OR by the employee who owns that task's role (checking it off) — same
-- rule the UI already enforces, now also enforced server-side.
drop policy if exists "tasks readable" on public.tasks;
create policy "tasks readable" on public.tasks for select using (
  public.is_admin() or public.client_team("clientId") is null or public.client_team("clientId") = public.current_team()
);
drop policy if exists "tasks writable" on public.tasks;
create policy "tasks writable" on public.tasks for all using (
  public.is_admin()
  or (public.current_role() = 'manager' and public.client_team("clientId") = public.current_team())
  or (role = public.current_role() and public.client_team("clientId") = public.current_team())
) with check (
  public.is_admin()
  or (public.current_role() = 'manager' and public.client_team("clientId") = public.current_team())
  or (role = public.current_role() and public.client_team("clientId") = public.current_team())
);

-- teams: everyone signed in can read the list (names, for nav/labels);
-- only Admin creates/edits Teams or assigns a Manager to one.
drop policy if exists "teams readable" on public.teams;
create policy "teams readable" on public.teams for select using (auth.role() = 'authenticated');
drop policy if exists "teams writable" on public.teams;
create policy "teams writable" on public.teams for all using (public.is_admin()) with check (public.is_admin());

-- invites: Admin sees/creates all; a Manager sees/creates only their own
-- Team's, and can never invite someone in as 'manager' (Admin assigns
-- Managers directly on the Team, not via invite).
drop policy if exists "invites readable" on public.invites;
create policy "invites readable" on public.invites for select using (
  public.is_admin() or (public.current_role() = 'manager' and "teamId" = public.current_team())
);
drop policy if exists "invites insertable" on public.invites;
create policy "invites insertable" on public.invites for insert with check (
  public.is_admin()
  or (public.current_role() = 'manager' and "teamId" = public.current_team() and role <> 'manager')
);

-- services: global ones readable by everyone; team ones only by that team
-- (+ Admin). A Manager can only create/edit/delete their own Team's
-- services; only Admin can touch global ones or another Team's.
drop policy if exists "services readable" on public.services;
create policy "services readable" on public.services for select using (
  scope = 'global' or public.is_admin() or "teamId" = public.current_team()
);
drop policy if exists "services writable" on public.services;
create policy "services writable" on public.services for all using (
  public.is_admin() or (public.current_role() = 'manager' and scope = 'team' and "teamId" = public.current_team())
) with check (
  public.is_admin() or (public.current_role() = 'manager' and scope = 'team' and "teamId" = public.current_team())
);

-- task comments/links/attachments: same Team-scoping as the task they hang off.
drop policy if exists "taskComments rw" on public."taskComments";
create policy "taskComments rw" on public."taskComments" for all using (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
) with check (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);
drop policy if exists "taskLinks rw" on public."taskLinks";
create policy "taskLinks rw" on public."taskLinks" for all using (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
) with check (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);
drop policy if exists "taskAttachments rw" on public."taskAttachments";
create policy "taskAttachments rw" on public."taskAttachments" for all using (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
) with check (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);

-- timeEntries: you manage your own clock-in/out; your Team's Manager (or
-- Admin) can read them for oversight. No delete policy for anyone.
drop policy if exists "timeEntries insertable" on public."timeEntries";
create policy "timeEntries insertable" on public."timeEntries" for insert with check ("userId" = auth.uid());
drop policy if exists "timeEntries updatable" on public."timeEntries";
create policy "timeEntries updatable" on public."timeEntries" for update using ("userId" = auth.uid()) with check ("userId" = auth.uid());
drop policy if exists "timeEntries readable" on public."timeEntries";
create policy "timeEntries readable" on public."timeEntries" for select using (
  "userId" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.team_of_user("userId") = public.current_team())
);

-- screenshots / activitySamples: insert-your-own, read-your-own-or-your-
-- Team's-Manager-or-Admin. No update/delete policy at all for anyone —
-- that's what makes them undeletable by employees (matches the ask).
drop policy if exists "screenshots insertable" on public.screenshots;
create policy "screenshots insertable" on public.screenshots for insert with check ("userId" = auth.uid());
drop policy if exists "screenshots readable" on public.screenshots;
create policy "screenshots readable" on public.screenshots for select using (
  "userId" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.team_of_user("userId") = public.current_team())
);
drop policy if exists "activitySamples insertable" on public."activitySamples";
create policy "activitySamples insertable" on public."activitySamples" for insert with check ("userId" = auth.uid());
drop policy if exists "activitySamples readable" on public."activitySamples";
create policy "activitySamples readable" on public."activitySamples" for select using (
  "userId" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.team_of_user("userId") = public.current_team())
);

-- spotlights: everyone reads; Admin or any Manager can set it.
drop policy if exists "spotlights readable" on public.spotlights;
create policy "spotlights readable" on public.spotlights for select using (auth.role() = 'authenticated');
drop policy if exists "spotlights writable" on public.spotlights;
create policy "spotlights writable" on public.spotlights for all using (
  public.current_role() in ('admin','manager')
) with check (
  public.current_role() in ('admin','manager')
);

-- ---------------------------------------------------------------------------
-- Realtime — add the new tables that benefit from live UI updates. Screenshots
-- and activitySamples are deliberately left off realtime (no reason to push
-- keystroke content over a live channel to anyone subscribed).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['teams','services','invites','taskComments','taskLinks','taskAttachments','spotlights','timeEntries']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
