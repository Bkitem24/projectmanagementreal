-- Optional example data — the same Men's Therapy Online example the first
-- prototype shipped with. Run this once, after schema.sql, if you want to
-- start from real working examples instead of an empty app.
-- Safe to re-run: it upserts on the fixed ids below.

insert into public.clients (id, name, "hostName", tagline, services, color, example, "createdAt")
values (
  '11111111-1111-1111-1111-111111111111',
  'Men''s Therapy Online', 'Marc Azoulay',
  'Men''s mental health & personal development, coach-led.',
  array['Full episode production','Thumbnail & title packaging','Show notes & SEO','Social clipping'],
  '#c9862e', false, now()
)
on conflict (id) do nothing;

insert into public.clients (id, name, "hostName", tagline, services, color, example, "createdAt")
values (
  '22222222-2222-2222-2222-222222222222',
  'American Masculinity Podcast', 'Timothy Wienecke',
  'Example client — edit this overview and add a real publishing schedule.',
  array['Full episode production','Thumbnail & title packaging'],
  '#3f6b8a', true, now() + interval '1 second'
)
on conflict (id) do nothing;

insert into public.templates (id, "clientId", name, steps) values (
  '33333333-3333-3333-3333-333333333331', '11111111-1111-1111-1111-111111111111',
  'Guest Episode Workflow',
  '[
    {"stepId":"s1","order":1,"role":"outreach_va","group":"Pre-production","label":"Book guest for this episode"},
    {"stepId":"s2","order":2,"role":"outreach_va","group":"Pre-production","label":"Send prep doc & confirm recording time"},
    {"stepId":"s3","order":3,"role":"sr_video_editor","group":"Editing","label":"Extract trailer content from raw recording","dependsOnLabel":"Guest booked & recorded"},
    {"stepId":"s4","order":4,"role":"sr_video_editor","group":"Editing","label":"Edit trailer"},
    {"stepId":"s5","order":5,"role":"jr_video_editor","group":"Editing","label":"Edit full episode body"},
    {"stepId":"s6","order":6,"role":"jr_video_editor","group":"Editing","label":"Color grade"},
    {"stepId":"s7","order":7,"role":"jr_video_editor","group":"Editing","label":"Cut unwanted / off-topic sections"},
    {"stepId":"s8","order":8,"role":"packaging_expert","group":"Packaging","label":"Design thumbnail options","dependsOnLabel":"Trailer content extracted"},
    {"stepId":"s9","order":9,"role":"packaging_expert","group":"Packaging","label":"Write episode title options","dependsOnLabel":"Trailer content extracted"},
    {"stepId":"s10","order":10,"role":"seo_specialist","group":"Publishing","label":"Write YouTube description & show notes","dependsOnLabel":"Full episode edited"},
    {"stepId":"s11","order":11,"role":"seo_specialist","group":"Publishing","label":"Write SEO blog post (optional)"},
    {"stepId":"s12","order":12,"role":"jr_video_editor","group":"Social","label":"Clip highlight reels for social","dependsOnLabel":"Trailer content extracted"}
  ]'::jsonb
) on conflict (id) do nothing;

insert into public.templates (id, "clientId", name, steps) values (
  '33333333-3333-3333-3333-333333333332', '11111111-1111-1111-1111-111111111111',
  'Solo Episode Workflow',
  '[
    {"stepId":"s1","order":1,"role":"jr_video_editor","group":"Editing","label":"Edit full episode body"},
    {"stepId":"s2","order":2,"role":"jr_video_editor","group":"Editing","label":"Color grade"},
    {"stepId":"s3","order":3,"role":"jr_video_editor","group":"Editing","label":"Cut unwanted / off-topic sections"},
    {"stepId":"s4","order":4,"role":"packaging_expert","group":"Packaging","label":"Design thumbnail","dependsOnLabel":"Episode edited"},
    {"stepId":"s5","order":5,"role":"packaging_expert","group":"Packaging","label":"Write title options"},
    {"stepId":"s6","order":6,"role":"seo_specialist","group":"Publishing","label":"Write description & show notes"},
    {"stepId":"s7","order":7,"role":"jr_video_editor","group":"Social","label":"Clip highlight reels for social"}
  ]'::jsonb
) on conflict (id) do nothing;

insert into public.templates (id, "clientId", name, steps) values (
  '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
  'Roundtable Episode Workflow',
  '[
    {"stepId":"s1","order":1,"role":"outreach_va","group":"Pre-production","label":"Book roundtable panelists"},
    {"stepId":"s2","order":2,"role":"outreach_va","group":"Pre-production","label":"Confirm recording time with all panelists"},
    {"stepId":"s3","order":3,"role":"sr_video_editor","group":"Editing","label":"Extract trailer content","dependsOnLabel":"Panelists booked & recorded"},
    {"stepId":"s4","order":4,"role":"sr_video_editor","group":"Editing","label":"Edit trailer"},
    {"stepId":"s5","order":5,"role":"jr_video_editor","group":"Editing","label":"Edit full multi-speaker episode"},
    {"stepId":"s6","order":6,"role":"jr_video_editor","group":"Editing","label":"Color grade & audio-balance speakers"},
    {"stepId":"s7","order":7,"role":"packaging_expert","group":"Packaging","label":"Design thumbnail (group shot)","dependsOnLabel":"Trailer content extracted"},
    {"stepId":"s8","order":8,"role":"packaging_expert","group":"Packaging","label":"Write title options"},
    {"stepId":"s9","order":9,"role":"seo_specialist","group":"Publishing","label":"Write description & show notes"},
    {"stepId":"s10","order":10,"role":"jr_video_editor","group":"Social","label":"Clip highlight reels for social"}
  ]'::jsonb
) on conflict (id) do nothing;

insert into public."scheduleRules" (id, "clientId", "templateId", label, "weekOfMonth", weekday, paid, amount, active) values
  ('44444444-4444-4444-4444-444444444441','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333331','Guest Episode',1,1,false,null,true),
  ('44444444-4444-4444-4444-444444444442','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333331','Paid Guest Episode',2,1,true,200,true),
  ('44444444-4444-4444-4444-444444444443','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333332','Solo Episode',2,4,false,null,true),
  ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','Roundtable Episode',4,1,false,null,true)
on conflict (id) do nothing;

-- Episodes and tasks are generated at runtime by the app (Manager role ->
-- "Generate upcoming episodes" on the client page), same as the prototype,
-- because they depend on today's date. Nothing to seed here.
