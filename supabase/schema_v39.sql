-- Blue Kite Ops - schema v39 (2026-09-26)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of every
-- other schema file. Run after schema_v38.sql.
--
-- Phase B follow-up: a "fully functional" messaging system needs a way for
-- someone to leave a group chat themselves, not just have admin/manager
-- delete the whole thing for everyone. No delete policy existed at all for
-- messagingParticipants before this (schema_v36.sql only had select/insert/
-- update) - this adds a narrow one: you may only ever delete your OWN
-- participant row, never someone else's (removing someone else stays an
-- admin/manager job, unchanged, via the whole-conversation delete in
-- schema_v38.sql).
drop policy if exists "messagingParticipants deletable by self" on public."messagingParticipants";
create policy "messagingParticipants deletable by self" on public."messagingParticipants" for delete using (
  "userId" = auth.uid()
);
