-- Blue Kite Ops - schema v13 (2026-09-28)
--
-- Run this in the Supabase SQL editor BEFORE applying this round's code
-- (src/main.js). Safe to re-run.
--
-- What this is for (Phase 2.5 batch C, item #5's threading bullet):
-- reply-to-comment threading, one level deep (a reply's own "Reply" button
-- is hidden in the UI - replying to a reply just replies to the same
-- top-level comment, Slack-thread style, so this never needs to recurse).
-- Both taskComments and episodeComments get the same "parentId" column,
-- since src/main.js's loadCollab() is the one shared function that renders
-- both - see round 10's write-up in phase-3-punch-list.md.
--
-- "on delete set null" rather than cascade: if a top-level comment is
-- deleted, its replies become ordinary top-level comments instead of being
-- deleted along with it - deleting a comment shouldn't silently destroy
-- other people's replies to it.
--
-- No RLS changes needed: the existing read/insert/update/delete policies
-- on both tables are row-level (author/role/team), not structural, so a
-- new nullable column doesn't need a new policy. Not independently
-- verified against a live Supabase project from here, same caveat as
-- every schema change in this project - flag it if something about
-- posting/reading a reply behaves differently than a normal comment.

alter table public."taskComments" add column if not exists "parentId" text references public."taskComments"(id) on delete set null;
alter table public."episodeComments" add column if not exists "parentId" text references public."episodeComments"(id) on delete set null;

create index if not exists "taskComments_parentId_idx" on public."taskComments" ("parentId");
create index if not exists "episodeComments_parentId_idx" on public."episodeComments" ("parentId");

comment on column public."taskComments"."parentId" is
  'Reply-to-comment threading, one level deep - added 2026-09-28. Null for a top-level comment; set to another comment''s own id for a reply. See src/main.js''s loadCollab().';
comment on column public."episodeComments"."parentId" is
  'Reply-to-comment threading, one level deep - added 2026-09-28. Null for a top-level comment; set to another comment''s own id for a reply. See src/main.js''s loadCollab().';
