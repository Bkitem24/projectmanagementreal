-- Blue Kite Ops - schema v37 (2026-09-26)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of every
-- other schema file. Run after schema_v36.sql.
--
-- Real bug found in live testing: a message sent in Messaging never
-- appeared in the thread without a manual page reload. Root cause is the
-- exact same class of bug schema_v31.sql already fixed once for
-- meetingInvitees - schema_v36.sql created messagingConversations/
-- messagingParticipants/messagingMessages/messagingReactions with RLS, but
-- never added any of them to the supabase_realtime publication, so no
-- postgres_changes event for them was ever being broadcast to anyone,
-- regardless of RLS or the client's subscription code being correct.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messagingConversations'
  ) then
    execute 'alter publication supabase_realtime add table public."messagingConversations"';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messagingParticipants'
  ) then
    execute 'alter publication supabase_realtime add table public."messagingParticipants"';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messagingMessages'
  ) then
    execute 'alter publication supabase_realtime add table public."messagingMessages"';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messagingReactions'
  ) then
    execute 'alter publication supabase_realtime add table public."messagingReactions"';
  end if;
end $$;
