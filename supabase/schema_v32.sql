-- Blue Kite Ops - schema v32 (2026-09-24)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of every
-- other schema file.
--
-- Activity Log request: "show me which client/episode this is for,
-- alongside the deadline." Denormalized directly onto the row at write
-- time (clientName, episodeTitle, dueDate) rather than looked up at read
-- time - the same established pattern this app already uses for tasks
-- rows themselves (tasks.clientName/episodeTitle/dueDate, baked in at
-- generation time), so the Activity list can render without extra queries
-- per row. Also adds 'task_item_undone' as a real eventType (unmarking a
-- task now gets its own logged entry, not just marking it done) - no
-- column change needed for that, eventType is already a free-text column.
alter table public."activityLog" add column if not exists "clientName" text;
alter table public."activityLog" add column if not exists "episodeTitle" text;
alter table public."activityLog" add column if not exists "dueDate" timestamptz;
