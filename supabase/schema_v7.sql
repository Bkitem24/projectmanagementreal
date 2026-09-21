-- Blue Kite Ops - schema v7 (2026-09-21)
--
-- Run this AFTER schema.sql through schema_v6.sql, in the same Supabase
-- project: Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to
-- re-run.
--
-- What this is for: the task-dependency redesign. Dependencies used to be
-- a free-text "waiting on" label, typed by hand onto every single
-- generated task ("Waiting on (optional)" on each workflow step, plus an
-- editable copy on every task instance) - purely cosmetic, enforced
-- nothing, and had to be re-entered per client/template. Now a workflow
-- STEP can point at another step in the same template
-- (steps[].dependsOnStepId, inside templates.steps - already a jsonb
-- column, so no migration needed there), and every task generated from it
-- inherits that link automatically. A task whose prerequisite isn't done
-- yet is now genuinely locked (checkbox disabled), not just labeled.
--
-- This needs one new column on public.tasks to carry that link onto each
-- generated task (see generateEpisodesForRule in src/main.js). The old
-- "dependsOnLabel" column is left in place, unused going forward, rather
-- than dropped - nothing reads it anymore after this update, and keeping
-- it costs nothing while avoiding a destructive column drop.

alter table public.tasks add column if not exists "dependsOnStepId" text;

comment on column public.tasks."dependsOnStepId" is
  'Copied from the generating template step''s steps[].dependsOnStepId at episode-generation time. The prerequisite task''s row id is always <this task''s episodeId>_<dependsOnStepId> (same deterministic id scheme as the task''s own id, <episodeId>_<stepId>) - looked up directly rather than stored, so it can never drift out of sync with the prerequisite''s own done state.';

comment on column public.tasks."dependsOnLabel" is
  'Superseded 2026-09-21 by "dependsOnStepId" - no longer written or read by the app. Left in place rather than dropped to avoid a destructive migration.';
round 6 fixes
