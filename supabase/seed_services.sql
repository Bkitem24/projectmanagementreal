-- Real Blue Kite Media service vocabulary, per Humayun's Sep 21 2026 list.
-- Run this once, AFTER schema_v2.sql (it needs the `services` table). Safe
-- to re-run: it upserts on the fixed ids below.
--
-- All six are seeded as scope='global' (every Team can use them) since
-- Humayun described these as the standard services across all of Blue
-- Kite's clients, not something specific to one Team. Admin or a Team
-- Manager can still edit these, add more, or create Team-specific ones
-- from the in-app "New service type" panel afterward — this is just the
-- starting vocabulary, not a fixed list.
--
-- One judgment call worth flagging: task #1's "Trailer Content Highlight"
-- was listed against a "Scriptwriter" role, which doesn't appear in the
-- final 5-role roster Humayun gave (Outreach Expert/VA, Sr. Video Editor,
-- Jr. Video Editor, Packaging Expert, SEO Content Specialist). Assigned it
-- to Sr. Video Editor here (closest fit — the trailer is the other thing
-- that role owns) but this is a guess, not a confirmed decision — worth
-- checking with Humayun and editing in-app if he meant something else.

insert into public.services (id, name, scope, "teamId", "subTasks", "createdBy", "createdAt") values
(
  'svc_guest_booking',
  'Guest Booking & Management',
  'global', null,
  '[
    {"stepId":"s1","order":1,"role":"outreach_va","label":"Create list of potential guests for the podcast"},
    {"stepId":"s2","order":2,"role":"outreach_va","label":"Create list of potential podcasts for the client to appear on"},
    {"stepId":"s3","order":3,"role":"outreach_va","label":"Reach out to potential guests"},
    {"stepId":"s4","order":4,"role":"outreach_va","label":"Reach out to potential podcasts/clients"},
    {"stepId":"s5","order":5,"role":"outreach_va","label":"Schedule confirmed opportunities on the client''s calendar"},
    {"stepId":"s6","order":6,"role":"outreach_va","label":"Follow up with guests/podcasts"}
  ]'::jsonb,
  null, now()
),
(
  'svc_full_production',
  'Full Audio/Video Production',
  'global', null,
  '[
    {"stepId":"s1","order":1,"role":"sr_video_editor","label":"Trailer content highlight"},
    {"stepId":"s2","order":2,"role":"sr_video_editor","label":"Edit trailer"},
    {"stepId":"s3","order":3,"role":"jr_video_editor","label":"Edit full multicam episode"},
    {"stepId":"s4","order":4,"role":"jr_video_editor","label":"Audio enhancement"},
    {"stepId":"s5","order":5,"role":"jr_video_editor","label":"Color grade"},
    {"stepId":"s6","order":6,"role":"jr_video_editor","label":"Overlays"},
    {"stepId":"s7","order":7,"role":"jr_video_editor","label":"Upload final rendered file to drive"}
  ]'::jsonb,
  null, now() + interval '1 second'
),
(
  'svc_social_clipping',
  'Curated Content for Social Media',
  'global', null,
  '[
    {"stepId":"s1","order":1,"role":"seo_specialist","label":"Highlight content for social"},
    {"stepId":"s2","order":2,"role":"jr_video_editor","label":"Edit the highlighted content"}
  ]'::jsonb,
  null, now() + interval '2 seconds'
),
(
  'svc_packaging',
  'Packaging',
  'global', null,
  '[
    {"stepId":"s1","order":1,"role":"packaging_expert","label":"Design 2 A/B-testing packages (thumbnail + title)"}
  ]'::jsonb,
  null, now() + interval '3 seconds'
),
(
  'svc_writeups',
  'Writeups',
  'global', null,
  '[
    {"stepId":"s1","order":1,"role":"seo_specialist","label":"Write YouTube description"},
    {"stepId":"s2","order":2,"role":"seo_specialist","label":"Timecode the YouTube description","dependsOnLabel":"Full episode edited"},
    {"stepId":"s3","order":3,"role":"seo_specialist","label":"Write show notes"},
    {"stepId":"s4","order":4,"role":"seo_specialist","label":"Write SEO-optimized blog post"}
  ]'::jsonb,
  null, now() + interval '4 seconds'
),
(
  'svc_episode_release',
  'Episode Release',
  'global', null,
  '[
    {"stepId":"s1","order":1,"role":"outreach_va","label":"Schedule the episode"},
    {"stepId":"s2","order":2,"role":"outreach_va","label":"Send episode release email"}
  ]'::jsonb,
  null, now() + interval '5 seconds'
)
on conflict (id) do update set
  name = excluded.name,
  scope = excluded.scope,
  "teamId" = excluded."teamId",
  "subTasks" = excluded."subTasks";
