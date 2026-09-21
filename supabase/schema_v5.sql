-- Blue Kite Ops - schema v5 ("Phase 1 final fixes", 2026-09-21)
--
-- Run this AFTER schema.sql, schema_v2.sql, schema_v3.sql and schema_v4.sql,
-- in the same Supabase project: Dashboard -> SQL Editor -> New query ->
-- paste -> Run. Safe to re-run, same as the earlier schema files.
--
-- What's in here:
--   Edit + delete for comments and links (task-level and episode-level),
--   plus delete for attachments. Previously these tables only had a single
--   "for all" RLS policy that let anyone on the Team read/insert/update/
--   delete anything - fine while there was no UI for editing or deleting,
--   but wrong now that there is: an employee could otherwise edit or
--   delete a teammate's comment. This splits each table's policy into:
--     - select/insert: unchanged, still just "anyone on the Team" (or Admin)
--     - update: author-only (same convention as Slack/WhatsApp - editing
--       someone else's words on their behalf would be misleading, "(edited)"
--       tag or not)
--     - delete: the author, or a Manager/Admin on that Team (moderation -
--       matches how removing a message works in those same apps)
--   "editedAt" columns are added so the UI can show "(edited)" - only ever
--   set by the author's own update, never touched by a delete.

-- ---------------------------------------------------------------------------
-- editedAt columns - comments and links only. Attachments aren't edited in
-- place (there's nothing to edit on a file besides replacing it, which is
-- just a delete + re-upload), so they get no editedAt column, just the
-- narrower delete policy below.
-- ---------------------------------------------------------------------------
alter table public."taskComments" add column if not exists "editedAt" timestamptz;
alter table public."episodeComments" add column if not exists "editedAt" timestamptz;
alter table public."taskLinks" add column if not exists "editedAt" timestamptz;
alter table public."episodeLinks" add column if not exists "editedAt" timestamptz;

-- ---------------------------------------------------------------------------
-- taskComments: select/insert stays Team-scoped for everyone; update/delete
-- is author-or-Manager/Admin.
-- ---------------------------------------------------------------------------
drop policy if exists "taskComments rw" on public."taskComments";
drop policy if exists "taskComments select" on public."taskComments";
create policy "taskComments select" on public."taskComments" for select using (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);
drop policy if exists "taskComments insert" on public."taskComments";
create policy "taskComments insert" on public."taskComments" for insert with check (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);
drop policy if exists "taskComments update" on public."taskComments";
create policy "taskComments update" on public."taskComments" for update using (
  "authorId" = auth.uid()
) with check (
  "authorId" = auth.uid()
);
drop policy if exists "taskComments delete" on public."taskComments";
create policy "taskComments delete" on public."taskComments" for delete using (
  "authorId" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.task_team("taskId") = public.current_team())
);

-- ---------------------------------------------------------------------------
-- episodeComments: same shape as taskComments above.
-- ---------------------------------------------------------------------------
drop policy if exists "episodeComments rw" on public."episodeComments";
drop policy if exists "episodeComments select" on public."episodeComments";
create policy "episodeComments select" on public."episodeComments" for select using (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);
drop policy if exists "episodeComments insert" on public."episodeComments";
create policy "episodeComments insert" on public."episodeComments" for insert with check (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);
drop policy if exists "episodeComments update" on public."episodeComments";
create policy "episodeComments update" on public."episodeComments" for update using (
  "authorId" = auth.uid()
) with check (
  "authorId" = auth.uid()
);
drop policy if exists "episodeComments delete" on public."episodeComments";
create policy "episodeComments delete" on public."episodeComments" for delete using (
  "authorId" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.episode_team("episodeId") = public.current_team())
);

-- ---------------------------------------------------------------------------
-- taskLinks: author field is "addedBy", not "authorId".
-- ---------------------------------------------------------------------------
drop policy if exists "taskLinks rw" on public."taskLinks";
drop policy if exists "taskLinks select" on public."taskLinks";
create policy "taskLinks select" on public."taskLinks" for select using (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);
drop policy if exists "taskLinks insert" on public."taskLinks";
create policy "taskLinks insert" on public."taskLinks" for insert with check (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);
drop policy if exists "taskLinks update" on public."taskLinks";
create policy "taskLinks update" on public."taskLinks" for update using (
  "addedBy" = auth.uid()
) with check (
  "addedBy" = auth.uid()
);
drop policy if exists "taskLinks delete" on public."taskLinks";
create policy "taskLinks delete" on public."taskLinks" for delete using (
  "addedBy" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.task_team("taskId") = public.current_team())
);

-- ---------------------------------------------------------------------------
-- episodeLinks
-- ---------------------------------------------------------------------------
drop policy if exists "episodeLinks rw" on public."episodeLinks";
drop policy if exists "episodeLinks select" on public."episodeLinks";
create policy "episodeLinks select" on public."episodeLinks" for select using (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);
drop policy if exists "episodeLinks insert" on public."episodeLinks";
create policy "episodeLinks insert" on public."episodeLinks" for insert with check (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);
drop policy if exists "episodeLinks update" on public."episodeLinks";
create policy "episodeLinks update" on public."episodeLinks" for update using (
  "addedBy" = auth.uid()
) with check (
  "addedBy" = auth.uid()
);
drop policy if exists "episodeLinks delete" on public."episodeLinks";
create policy "episodeLinks delete" on public."episodeLinks" for delete using (
  "addedBy" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.episode_team("episodeId") = public.current_team())
);

-- ---------------------------------------------------------------------------
-- taskAttachments / episodeAttachments: no edit (nothing to edit on a
-- file), just a narrower delete than "anyone on the Team".
-- ---------------------------------------------------------------------------
drop policy if exists "taskAttachments rw" on public."taskAttachments";
drop policy if exists "taskAttachments select" on public."taskAttachments";
create policy "taskAttachments select" on public."taskAttachments" for select using (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);
drop policy if exists "taskAttachments insert" on public."taskAttachments";
create policy "taskAttachments insert" on public."taskAttachments" for insert with check (
  public.is_admin() or public.task_team("taskId") is null or public.task_team("taskId") = public.current_team()
);
drop policy if exists "taskAttachments delete" on public."taskAttachments";
create policy "taskAttachments delete" on public."taskAttachments" for delete using (
  "uploadedBy" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.task_team("taskId") = public.current_team())
);

drop policy if exists "episodeAttachments rw" on public."episodeAttachments";
drop policy if exists "episodeAttachments select" on public."episodeAttachments";
create policy "episodeAttachments select" on public."episodeAttachments" for select using (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);
drop policy if exists "episodeAttachments insert" on public."episodeAttachments";
create policy "episodeAttachments insert" on public."episodeAttachments" for insert with check (
  public.is_admin() or public.episode_team("episodeId") is null or public.episode_team("episodeId") = public.current_team()
);
drop policy if exists "episodeAttachments delete" on public."episodeAttachments";
create policy "episodeAttachments delete" on public."episodeAttachments" for delete using (
  "uploadedBy" = auth.uid() or public.is_admin()
  or (public.current_role() = 'manager' and public.episode_team("episodeId") = public.current_team())
);
