-- Blue Kite Ops - schema v38 (2026-09-26)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of every
-- other schema file. Run after schema_v37.sql.
--
-- Phase B follow-up: schema_v36.sql shipped with no delete policy at all on
-- Messaging - not even the sender or an admin could delete a message via
-- the API (confirmed live this session: a DELETE from an authenticated
-- admin session against messagingMessages was silently rejected by RLS,
-- 0 rows affected). This also meant the "quoted/reacted-to message gets
-- deleted, does the UI show a graceful fallback" code path (MessagingPage's
-- "Message no longer available") could never actually be exercised in
-- production - dead code until this ships.

-- A message can be deleted by whoever sent it, or by an admin/manager
-- (moderation) - never by an arbitrary other participant.
drop policy if exists "messagingMessages deletable by sender or admin/manager" on public."messagingMessages";
create policy "messagingMessages deletable by sender or admin/manager" on public."messagingMessages" for delete using (
  "senderId" = auth.uid() or public.is_admin() or public.is_manager()
);

-- Real bug found in live testing: a plain employee starting a 1:1 (self-
-- serve, no admin/manager needed - schema_v36.sql's messagingConversations
-- insert policy already allows this for kind='direct') could never actually
-- finish - startDirectChat() inserts BOTH participant rows (self + the
-- other person) in one statement, and Postgres validates every row's WITH
-- CHECK, so the other person's row (userId != auth.uid(), and a plain
-- employee is neither admin nor manager) failed the whole insert. Never
-- caught before now because no UI ever actually called startDirectChat()
-- until this round's "New chat" picker.
drop policy if exists "messagingParticipants insertable by admin/manager or self on direct" on public."messagingParticipants";
create policy "messagingParticipants insertable by admin/manager, self, or into your own new direct chat" on public."messagingParticipants" for insert with check (
  public.is_admin() or public.is_manager() or "userId" = auth.uid()
  or exists (
    select 1 from public."messagingConversations" c
    where c.id = "conversationId" and c.kind = 'direct' and c."createdBy" = auth.uid()
  )
);

-- A whole conversation can only be deleted if it's a custom 'group' chat
-- (never 'team_default' - that one is structural/auto-managed - and never
-- someone else's 1:1 'direct' chat) and only by admin/manager, matching the
-- same admin/manager-only gate group CREATION already has. Deleting the
-- conversation row cascades to its participants/messages/reactions for
-- free (all three already declared "on delete cascade" against
-- messagingConversations/messagingMessages in schema_v36.sql).
drop policy if exists "messagingConversations group chats deletable by admin/manager" on public."messagingConversations";
create policy "messagingConversations group chats deletable by admin/manager" on public."messagingConversations" for delete using (
  kind = 'group' and (public.is_admin() or public.is_manager())
);
