-- Blue Kite Ops - schema v12 (2026-09-28)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js). Safe to re-run (every statement is "if not exists").
--
-- NOTE ON GAPS IN THIS FOLDER: schema_v8.sql through schema_v11.sql (the
-- "custom" column on tasks, "archived" on clients/episodes, "groupOrder"
-- on templates, "profileRoles"/has_role()/is_manager(), "invites.roles",
-- and the taskComments/episodeComments delete policies) were delivered as
-- zips during the pre-git delivery workflow (see CLAUDE.md) and applied
-- directly to the live Supabase project by hand - they were never
-- committed to this git repo, so they don't exist as files here even
-- though the columns they add are already live in the real database and
-- already relied on by the current app code. This migration is written to
-- layer safely on top of whatever's already there (every ADD COLUMN below
-- is "if not exists") regardless of that gap. Worth reconstructing those
-- missing files into this folder at some point so the repo matches the
-- live schema, but that's a separate, lower-urgency cleanup from this
-- round's actual feature work below.
--
-- What this is for (Phase 2.5 batch B): an episode's "due date" used to
-- BE its publish/air date - the one date field drove both "when does this
-- air" and "when is it due," which is why they were identical. Humayun
-- asked for a real deadline that's a configurable number of days BEFORE
-- the actual publish date (default 2), not the same day. This adds:
--   - episodes."publishDate": the real air/publish date (what "dueDate"
--     used to mean). "dueDate" keeps its existing meaning and column -
--     it's now computed as publishDate minus an offset at the moment an
--     episode is generated, and continues to be what drives overdue
--     badges/sorting/"waiting on" urgency exactly as before, see
--     src/main.js's generateEpisodesForRule and the one-off episode
--     modal.
--   - "scheduleRules"."daysBeforePublish": that offset, per schedule
--     rule, defaulting to 2. One-off episodes carry no persistent rule
--     record, so their offset is only used once at creation time to
--     compute dueDate - nothing to store for them beyond the resulting
--     dueDate/publishDate on the episode itself.
--
-- Existing episodes are backfilled so publishDate is never null for an
-- episode that predates this column - same value as their current
-- dueDate (the only value that was ever meant by "the date" before this
-- round), so nothing about an existing episode's displayed date changes
-- until it's regenerated or edited.

alter table public.episodes add column if not exists "publishDate" date;
update public.episodes set "publishDate" = "dueDate" where "publishDate" is null;

alter table public."scheduleRules" add column if not exists "daysBeforePublish" int not null default 2;

comment on column public.episodes."publishDate" is
  'The real air/publish date. "dueDate" is a separate, computed deadline (publishDate minus the generating rule''s daysBeforePublish, or the one-off episode modal''s own offset) - added 2026-09-28, see schema_v12.sql header.';

comment on column public."scheduleRules"."daysBeforePublish" is
  'How many days before publishDate an episode generated from this rule is considered due - added 2026-09-28. Baked into each generated episode''s own dueDate at generation time (not looked up live), same as every other generation-time field on episodes (paid, amount, taskCount, ...).';
