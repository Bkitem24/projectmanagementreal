-- Blue Kite Ops - schema v27 (2026-09-30)
--
-- Run this in the Supabase SQL editor BEFORE pulling the Meetings feature's
-- code. Safe to re-run. Independent of every other schema file.
--
-- Meetings (video calls with screen share + host-side recording) - a
-- separate feature from Connect (audio-only huddles, src/lib/connect.js /
-- worker-realtime/), which this does NOT touch or depend on. Meetings gets
-- its own Worker (worker-meetings/) and its own signaling, deliberately
-- kept fully independent so nothing here can ever regress Connect.
--
-- Meeting ids are real UUIDs (crypto.randomUUID(), not the short uid8()
-- ids used elsewhere in this app) - a meeting's id doubles as its live
-- signaling "room name" (Supabase Realtime presence channel, same pattern
-- Connect's call rooms already use), so it needs to be genuinely
-- unguessable, not just unique.
create table if not exists public.meetings (
  id uuid primary key,
  title text not null,
  "hostUserId" uuid not null references public.profiles(id),
  "teamId" text references public.teams(id),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended')),
  "isInstant" boolean not null default false,
  "scheduledAt" timestamptz,
  "startedAt" timestamptz,
  "endedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create table if not exists public."meetingInvitees" (
  id text primary key,
  "meetingId" uuid not null references public.meetings(id) on delete cascade,
  "userId" uuid not null references public.profiles(id),
  "createdAt" timestamptz not null default now()
);
create index if not exists meeting_invitees_meeting_idx on public."meetingInvitees" ("meetingId");
create index if not exists meeting_invitees_user_idx on public."meetingInvitees" ("userId");

-- Cost-guardrail usage tracking (Phase 5's ask): one row per person per
-- time they're actually in a meeting's live room, so total participant-
-- minutes (and a rough GB-egress estimate from it) can be shown to Admin.
-- Not exact byte-for-byte billing - Cloudflare bills on real egress bytes,
-- this is an approximation from known quality settings, good enough for
-- an early-warning usage meter.
create table if not exists public."meetingParticipantLogs" (
  id text primary key,
  "meetingId" uuid not null references public.meetings(id) on delete cascade,
  "userId" uuid not null references public.profiles(id),
  "joinedAt" timestamptz not null default now(),
  "leftAt" timestamptz
);
create index if not exists meeting_participant_logs_meeting_idx on public."meetingParticipantLogs" ("meetingId");

alter table public.meetings enable row level security;
alter table public."meetingInvitees" enable row level security;
alter table public."meetingParticipantLogs" enable row level security;

-- meetings: readable by its host, anyone invited to it, or Admin/Manager of
-- its own Team. Writable (create/update status/end) by the host or Admin.
drop policy if exists "meetings readable" on public.meetings;
create policy "meetings readable" on public.meetings for select using (
  "hostUserId" = auth.uid()
  -- Explicitly qualified as meetings.id, not the bare "id" - inside this
  -- subquery an unqualified "id" resolves to meetingInvitees' OWN id
  -- column (text) instead of the outer meetings.id (uuid), which is
  -- exactly what threw "operator does not exist: uuid = text" the first
  -- time this ran.
  or exists (select 1 from public."meetingInvitees" mi where mi."meetingId" = meetings.id and mi."userId" = auth.uid())
  or public.is_admin()
  or (public.current_role() = 'manager' and "teamId" = public.current_team())
);
drop policy if exists "meetings insertable by the host" on public.meetings;
create policy "meetings insertable by the host" on public.meetings for insert with check ("hostUserId" = auth.uid());
drop policy if exists "meetings updatable by host or admin" on public.meetings;
create policy "meetings updatable by host or admin" on public.meetings for update using (
  "hostUserId" = auth.uid() or public.is_admin()
) with check (
  "hostUserId" = auth.uid() or public.is_admin()
);

-- meetingInvitees: the invitee can read their own invite; the host/admin
-- can read and manage the whole list.
drop policy if exists "meeting invitees readable" on public."meetingInvitees";
create policy "meeting invitees readable" on public."meetingInvitees" for select using (
  "userId" = auth.uid()
  or public.is_admin()
  or exists (select 1 from public.meetings m where m.id = "meetingId" and m."hostUserId" = auth.uid())
);
drop policy if exists "meeting invitees writable by host or admin" on public."meetingInvitees";
create policy "meeting invitees writable by host or admin" on public."meetingInvitees" for all using (
  public.is_admin() or exists (select 1 from public.meetings m where m.id = "meetingId" and m."hostUserId" = auth.uid())
) with check (
  public.is_admin() or exists (select 1 from public.meetings m where m.id = "meetingId" and m."hostUserId" = auth.uid())
);

-- meetingParticipantLogs: everyone logs their OWN join/leave (bare insert/
-- update of their own row, never on behalf of someone else - same pattern
-- as insertNotification()); Admin/Manager (own Team) can read the totals
-- for the usage meter.
drop policy if exists "meeting participant logs insertable by self" on public."meetingParticipantLogs";
create policy "meeting participant logs insertable by self" on public."meetingParticipantLogs" for insert with check ("userId" = auth.uid());
drop policy if exists "meeting participant logs updatable by self" on public."meetingParticipantLogs";
create policy "meeting participant logs updatable by self" on public."meetingParticipantLogs" for update using ("userId" = auth.uid()) with check ("userId" = auth.uid());
drop policy if exists "meeting participant logs readable" on public."meetingParticipantLogs";
create policy "meeting participant logs readable" on public."meetingParticipantLogs" for select using (
  "userId" = auth.uid()
  or public.is_admin()
  or (public.current_role() = 'manager' and exists (
    select 1 from public.meetings m where m.id = "meetingId" and m."teamId" = public.current_team()
  ))
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meetings'
  ) then
    execute 'alter publication supabase_realtime add table public.meetings';
  end if;
end $$;
