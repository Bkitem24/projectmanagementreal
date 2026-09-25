-- schema_v35.sql - Phase A: Client Communications (2026-09-25)
--
-- Run AFTER schema_v34.sql. Additive only, safe to run more than once
-- (every create is `if not exists`, every policy is dropped-then-created).
--
-- Design notes (see docs/superpowers/plans/2026-09-25-phase-a-foundation-
-- and-comms.md for the full plan this schema implements):
--   - "commsAccounts" is one row per connected external inbox (a Gmail
--     address, a Slack workspace, the WhatsApp number) - just metadata,
--     never a real credential (those live only as Cloudflare Worker
--     secrets, set by hand via `wrangler secret put`).
--   - "commsAccountGrants" is the single mechanism behind BOTH halves of
--     the 2026-09-25 requirement: admin/manager get access by default
--     (checked in app code via is_admin()/is_manager(), no row needed),
--     and admin can ALSO grant an individual employee access to a specific
--     account - one grant row, same table, same RLS check either way. This
--     also covers "admin can withhold one specific account from a
--     manager" for free, since a manager who's simply never been granted
--     that account's row sees nothing from it either.
--   - "commsContacts" is the privacy boundary: nothing from any channel is
--     ever stored/shown unless the sender matches a contact explicitly
--     tied to a client here.

create table if not exists public."commsAccounts" (
  id text primary key,
  channel text not null check (channel in ('gmail','slack','whatsapp')),
  "externalId" text not null,
  label text not null,
  "teamId" text references public.teams(id) on delete set null,
  "connectedBy" uuid references public.profiles(id) on delete set null,
  "connectedAt" timestamptz not null default now(),
  "lastPolledUid" text, -- Gmail only: last IMAP UID successfully polled, for incremental sync
  active boolean not null default true,
  unique(channel, "externalId")
);

create table if not exists public."commsAccountGrants" (
  id text primary key,
  "accountId" text not null references public."commsAccounts"(id) on delete cascade,
  "userId" uuid not null references public.profiles(id) on delete cascade,
  "grantedBy" uuid references public.profiles(id) on delete set null,
  "grantedAt" timestamptz not null default now(),
  unique("accountId", "userId")
);

create table if not exists public."commsContacts" (
  id text primary key,
  "clientId" text not null references public.clients(id) on delete cascade,
  channel text not null check (channel in ('gmail','slack','whatsapp')),
  "externalAddress" text not null,
  name text default '',
  "createdAt" timestamptz not null default now(),
  unique(channel, "externalAddress")
);

create table if not exists public."commsThreads" (
  id text primary key,
  "accountId" text not null references public."commsAccounts"(id) on delete cascade,
  "contactId" text not null references public."commsContacts"(id) on delete cascade,
  subject text default '',
  "lastMessageAt" timestamptz not null default now(),
  "createdAt" timestamptz not null default now()
);
create index if not exists "commsThreads_contactId_idx" on public."commsThreads"("contactId");
create index if not exists "commsThreads_accountId_idx" on public."commsThreads"("accountId");

create table if not exists public."commsMessages" (
  id text primary key,
  "threadId" text not null references public."commsThreads"(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  body text not null default '',
  "externalMessageId" text,
  "sentAt" timestamptz not null default now(),
  "sentBy" uuid references public.profiles(id) on delete set null,
  "createdAt" timestamptz not null default now()
);
create index if not exists "commsMessages_threadId_idx" on public."commsMessages"("threadId");
create unique index if not exists "commsMessages_dedup_idx" on public."commsMessages"("threadId","externalMessageId") where "externalMessageId" is not null;

alter table public."commsAccounts" enable row level security;
alter table public."commsAccountGrants" enable row level security;
alter table public."commsContacts" enable row level security;
alter table public."commsThreads" enable row level security;
alter table public."commsMessages" enable row level security;

create or replace function public.has_comms_access(aid text) returns boolean as $$
  select public.is_admin() or exists (
    select 1 from public."commsAccountGrants" g where g."accountId" = aid and g."userId" = auth.uid()
  );
$$ language sql stable security definer set search_path = public;

drop policy if exists "commsAccounts readable with access" on public."commsAccounts";
create policy "commsAccounts readable with access" on public."commsAccounts" for select using (public.has_comms_access(id));
drop policy if exists "commsAccounts managed by admin" on public."commsAccounts";
create policy "commsAccounts managed by admin" on public."commsAccounts" for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "commsAccountGrants readable by admin or self" on public."commsAccountGrants";
create policy "commsAccountGrants readable by admin or self" on public."commsAccountGrants" for select using (public.is_admin() or "userId" = auth.uid());
drop policy if exists "commsAccountGrants insertable by admin" on public."commsAccountGrants";
create policy "commsAccountGrants insertable by admin" on public."commsAccountGrants" for insert with check (public.is_admin());
drop policy if exists "commsAccountGrants deletable by admin" on public."commsAccountGrants";
create policy "commsAccountGrants deletable by admin" on public."commsAccountGrants" for delete using (public.is_admin());

drop policy if exists "commsContacts managed by admin" on public."commsContacts";
create policy "commsContacts managed by admin" on public."commsContacts" for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "commsThreads readable with account access" on public."commsThreads";
create policy "commsThreads readable with account access" on public."commsThreads" for select using (public.has_comms_access("accountId"));

drop policy if exists "commsMessages readable with account access" on public."commsMessages";
create policy "commsMessages readable with account access" on public."commsMessages" for select using (
  exists (select 1 from public."commsThreads" t where t.id = "threadId" and public.has_comms_access(t."accountId"))
);
drop policy if exists "commsMessages insertable with account access" on public."commsMessages";
create policy "commsMessages insertable with account access" on public."commsMessages" for insert with check (
  direction = 'outbound' and exists (select 1 from public."commsThreads" t where t.id = "threadId" and public.has_comms_access(t."accountId"))
);
