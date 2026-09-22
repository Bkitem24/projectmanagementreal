-- Blue Kite Ops - schema v16 (2026-09-28)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js, src/lib/music.js). Safe to re-run. Independent of
-- schema_v15.sql (the roles table) - neither depends on the other, so
-- either order is fine if you're running both in the same sitting.
--
-- What this is for (Phase 4): "Multi-select music moods at signup;
-- playback shuffles across all selected moods by default, with ability to
-- pick one specific category or continue mixed shuffle." profiles used to
-- carry a single "musicMood" text value - this adds "musicMoods", a real
-- array, alongside it. The old "musicMood" column is left in place, unused
-- going forward, same pattern as every other superseded column in this
-- project (dependsOnStepId, dependsOnLabel, ...) - the app falls back to
-- wrapping it in a one-item array for anyone who signed up before this
-- column existed, so nobody's existing mood choice is lost.

alter table public.profiles add column if not exists "musicMoods" jsonb not null default '[]';

comment on column public.profiles."musicMoods" is
  'Every music mood/genre this person picked at signup (Phase 4, 2026-09-28) - superseded the single-value "musicMood" column, left in place unused. src/main.js''s profileMoods() reads this, falling back to musicMood wrapped in a one-item array for anyone who signed up before this column existed.';
