-- Blue Kite Ops - schema v26 (2026-09-30)
--
-- Run this in the Supabase SQL editor. Safe to re-run. Independent of
-- every other schema file.
--
-- Episode-level description box - separate from tasks.description
-- (schema_v23.sql, the per-checklist-item notes/links field, left exactly
-- as it was). This one is for the episode as a whole.
alter table public.episodes add column if not exists description text;
