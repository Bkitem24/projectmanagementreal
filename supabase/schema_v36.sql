-- schema_v36.sql - Phase B: Messaging (2026-09-26). Run after schema_v35.sql.
-- Additive only, safe to run more than once.

create table if not exists public."messagingConversations" (
  id text primary key,
  "teamId" text references public.teams(id) on delete cascade,
  kind text not null check (kind in ('team_default','direct','group')),
  name text default '',
  "createdBy" uuid references public.profiles(id) on delete set null,
  "createdAt" timestamptz not null default now(),
  "lastMessageAt" timestamptz not null default now()
);
create unique index if not exists "messagingConversations_one_team_default_idx" on public."messagingConversations"("teamId") where kind = 'team_default';

create table if not exists public."messagingParticipants" (
  id text primary key,
  "conversationId" text not null references public."messagingConversations"(id) on delete cascade,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "lastReadMessageId" text,
  "joinedAt" timestamptz not null default now(),
  unique("conversationId", "userId")
);

create table if not exists public."messagingMessages" (
  id text primary key,
  "conversationId" text not null references public."messagingConversations"(id) on delete cascade,
  "senderId" uuid references public.profiles(id) on delete set null,
  body text default '',
  "attachmentKey" text,
  "attachmentType" text,
  "quotedMessageId" text,
  "createdAt" timestamptz not null default now()
);
create index if not exists "messagingMessages_conversationId_idx" on public."messagingMessages"("conversationId", "createdAt");

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messagingMessages_quotedMessageId_fkey') then
    alter table public."messagingMessages" add constraint "messagingMessages_quotedMessageId_fkey"
      foreign key ("quotedMessageId") references public."messagingMessages"(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messagingParticipants_lastReadMessageId_fkey') then
    alter table public."messagingParticipants" add constraint "messagingParticipants_lastReadMessageId_fkey"
      foreign key ("lastReadMessageId") references public."messagingMessages"(id) on delete set null;
  end if;
end $$;

create table if not exists public."messagingReactions" (
  id text primary key,
  "messageId" text not null references public."messagingMessages"(id) on delete cascade,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  emoji text not null,
  "createdAt" timestamptz not null default now(),
  unique("messageId", "userId", emoji)
);

alter table public."messagingConversations" enable row level security;
alter table public."messagingParticipants" enable row level security;
alter table public."messagingMessages" enable row level security;
alter table public."messagingReactions" enable row level security;

create or replace function public.is_messaging_participant(cid text) returns boolean as $$
  select exists (select 1 from public."messagingParticipants" p where p."conversationId" = cid and p."userId" = auth.uid());
$$ language sql stable security definer set search_path = public;

drop policy if exists "messagingConversations readable by participants" on public."messagingConversations";
create policy "messagingConversations readable by participants" on public."messagingConversations" for select using (public.is_messaging_participant(id) or public.is_admin());
drop policy if exists "messagingConversations insertable" on public."messagingConversations";
-- 'direct' conversations are self-serve (anyone can start a 1:1); 'group'
-- (custom group chats) and 'team_default' require admin/manager - the
-- 2026-09-25 roadmap's "custom group chats (admin/manager create only)".
-- team_default is normally only ever created by ensure_team_default_conversation()
-- (a security definer function, bypasses RLS entirely) - included in the
-- admin/manager check here only as defense in depth, not the primary gate.
create policy "messagingConversations insertable" on public."messagingConversations" for insert with check (
  kind = 'direct' or public.is_admin() or public.is_manager()
);

drop policy if exists "messagingParticipants readable by fellow participants" on public."messagingParticipants";
create policy "messagingParticipants readable by fellow participants" on public."messagingParticipants" for select using (public.is_messaging_participant("conversationId") or public.is_admin());
drop policy if exists "messagingParticipants insertable by admin/manager or self on direct" on public."messagingParticipants";
create policy "messagingParticipants insertable by admin/manager or self on direct" on public."messagingParticipants" for insert with check (
  public.is_admin() or public.is_manager() or "userId" = auth.uid()
);
drop policy if exists "messagingParticipants updatable by self" on public."messagingParticipants";
create policy "messagingParticipants updatable by self" on public."messagingParticipants" for update using ("userId" = auth.uid()) with check ("userId" = auth.uid());

drop policy if exists "messagingMessages readable by participants" on public."messagingMessages";
create policy "messagingMessages readable by participants" on public."messagingMessages" for select using (public.is_messaging_participant("conversationId"));
drop policy if exists "messagingMessages insertable by participants" on public."messagingMessages";
create policy "messagingMessages insertable by participants" on public."messagingMessages" for insert with check (
  public.is_messaging_participant("conversationId") and "senderId" = auth.uid()
);

drop policy if exists "messagingReactions readable by participants" on public."messagingReactions";
create policy "messagingReactions readable by participants" on public."messagingReactions" for select using (
  exists (select 1 from public."messagingMessages" m where m.id = "messageId" and public.is_messaging_participant(m."conversationId"))
);
drop policy if exists "messagingReactions insertable by participants" on public."messagingReactions";
create policy "messagingReactions insertable by participants" on public."messagingReactions" for insert with check (
  "userId" = auth.uid() and exists (select 1 from public."messagingMessages" m where m.id = "messageId" and public.is_messaging_participant(m."conversationId"))
);
drop policy if exists "messagingReactions deletable by owner" on public."messagingReactions";
create policy "messagingReactions deletable by owner" on public."messagingReactions" for delete using ("userId" = auth.uid());

-- One default group chat per Team, auto-created + everyone on that Team
-- auto-joined, whenever a profile's teamId is set (covers both "new
-- employee joins a Team" and "Team gets created"). Mirrors how
-- handle_new_user() already auto-provisions rows on signup (schema_v2.sql).
-- security definer so it bypasses messagingConversations' own RLS (a
-- brand-new employee joining a Team is not an admin/manager themselves).
create or replace function public.ensure_team_default_conversation(tid text) returns text as $$
declare cid text;
begin
  select id into cid from public."messagingConversations" where "teamId" = tid and kind = 'team_default';
  if cid is null then
    cid := 'mconv_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
    insert into public."messagingConversations" (id, "teamId", kind, name) values (cid, tid, 'team_default', 'Team chat');
  end if;
  return cid;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function public.handle_profile_team_join() returns trigger as $$
declare cid text;
begin
  if new."teamId" is not null and (tg_op = 'INSERT' or old."teamId" is distinct from new."teamId") then
    cid := public.ensure_team_default_conversation(new."teamId");
    insert into public."messagingParticipants" (id, "conversationId", "userId")
      values ('mpart_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8), cid, new.id)
      on conflict ("conversationId", "userId") do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_profile_team_join on public.profiles;
create trigger on_profile_team_join after insert or update of "teamId" on public.profiles
  for each row execute function public.handle_profile_team_join();

-- Backfill: every profile that already has a teamId today.
do $$
declare r record; cid text;
begin
  for r in select id, "teamId" from public.profiles where "teamId" is not null loop
    cid := public.ensure_team_default_conversation(r."teamId");
    insert into public."messagingParticipants" (id, "conversationId", "userId")
      values ('mpart_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8), cid, r.id)
      on conflict ("conversationId", "userId") do nothing;
  end loop;
end $$;
