-- Blue Kite Ops - schema v29 (2026-09-30)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of
-- every other schema file.
--
-- Multi-role workflow steps/tasks (Humayun's ask: "I should be able to
-- assign multiple roles to a single workflow step"). `tasks.role` (a
-- single text column) stays exactly as it was - it's read all over this
-- app (board filtering, role chips, notifications) and keeps holding the
-- FIRST picked role so anything not yet updated still gets a sane single
-- answer. This adds a new `roles` array column alongside it holding the
-- FULL set - see taskRoleKeys()/stepRoleKeys() in main.js for the actual
-- read pattern (falls back to wrapping the old singular `role` in a
-- one-item array for any task created before this).
alter table public.tasks add column if not exists roles text[];

-- Lets "does this task's roles overlap the ones I hold" be a real, fast
-- server-side filter (My Board's own query) instead of only ever a client-
-- side scan.
create index if not exists tasks_roles_gin_idx on public.tasks using gin (roles);
