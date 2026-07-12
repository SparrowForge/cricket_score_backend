-- ============================================================
-- Migration 07: Seed data — permissions, system roles,
--               built-in match formats, default plans, CMS pages
-- ============================================================

-- ---------- Permissions matrix ----------
INSERT INTO permissions (resource, action, description) VALUES
  ('organization','manage','Full org administration'),
  ('user','create','Invite users'), ('user','read','View users'), ('user','update','Edit users'), ('user','delete','Remove users'),
  ('role','create','Create custom roles'), ('role','read','View roles'), ('role','update','Edit roles'), ('role','delete','Delete roles'),
  ('tournament','create','Create tournaments'), ('tournament','read','View tournaments'), ('tournament','update','Edit tournaments'), ('tournament','delete','Delete tournaments'),
  ('team','create','Create teams'), ('team','read','View teams'), ('team','update','Edit teams'), ('team','delete','Delete teams'),
  ('player','create','Create players'), ('player','read','View players'), ('player','update','Edit players'), ('player','delete','Delete players'),
  ('match','create','Schedule matches'), ('match','read','View matches'), ('match','update','Edit match setup'), ('match','delete','Delete matches'),
  ('scoring','score','Enter ball-by-ball events'), ('scoring','correct','Correct scored balls'), ('scoring','finalize','Finalize match result'),
  ('commentary','create','Write commentary'), ('commentary','update','Edit commentary'), ('commentary','delete','Delete commentary'),
  ('news','create','Write news'), ('news','publish','Publish news'), ('news','update','Edit news'), ('news','delete','Delete news'),
  ('cms','read','View CMS'), ('cms','update','Edit CMS pages'), ('cms','publish','Publish CMS pages'),
  ('plan','create','Create plans'), ('plan','read','View plans'), ('plan','update','Edit plans'), ('plan','delete','Retire plans'),
  ('stats','read','View stats'), ('media','create','Upload media'), ('media','delete','Delete media');

-- ---------- System roles ----------
INSERT INTO roles (id, organization_id, name, slug, is_system, description) VALUES
  ('00000000-0000-0000-0000-000000000001', NULL, 'Super Admin',      'super_admin',      true, 'Platform owner: everything, everywhere'),
  ('00000000-0000-0000-0000-000000000002', NULL, 'Tournament Admin', 'tournament_admin', true, 'Manages tournaments, teams, fixtures within scope'),
  ('00000000-0000-0000-0000-000000000003', NULL, 'Scorer',           'scorer',           true, 'Ball-by-ball scoring for assigned matches'),
  ('00000000-0000-0000-0000-000000000004', NULL, 'Commentator',      'commentator',      true, 'Commentary for assigned matches'),
  ('00000000-0000-0000-0000-000000000005', NULL, 'Viewer',           'viewer',           true, 'Read-only public access');

-- Super admin: every permission
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000001', id FROM permissions;

-- Tournament admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000002', id FROM permissions
WHERE (resource, action) NOT IN (('organization','manage'),('plan','create'),('plan','update'),('plan','delete'),('cms','update'),('cms','publish'),('role','delete'));

-- Scorer
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000003', id FROM permissions
WHERE resource IN ('scoring') OR (resource, action) IN (('match','read'),('player','read'),('team','read'),('stats','read'));

-- Commentator
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000004', id FROM permissions
WHERE resource = 'commentary' OR (resource, action) IN (('match','read'),('stats','read'));

-- Viewer
INSERT INTO role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-000000000005', id FROM permissions WHERE action = 'read';

-- ---------- Built-in match formats ----------
INSERT INTO match_formats (organization_id, name, slug, is_builtin, rules) VALUES
(NULL, 'T20', 't20', true, '{
  "innings_per_side": 1, "overs_per_innings": 20, "balls_per_over": 6,
  "players_per_side": 11, "max_overs_per_bowler": 4, "wickets_to_fall": 10,
  "powerplays": [{"type":"mandatory","from_over":1,"to_over":6,"max_fielders_outside_circle":2}],
  "super_over": {"enabled": true, "max_repeats": 1, "balls": 6},
  "dls": {"enabled": true, "method": "DLS", "min_overs_per_side": 5},
  "follow_on": {"enabled": false}, "declaration_allowed": false,
  "no_ball": {"runs": 1, "free_hit": true}, "wide": {"runs": 1},
  "twelfth_man": {"allowed": true, "can_bat": false, "can_bowl": false},
  "duration_days": 1, "drs": {"enabled": false}
}'),
(NULL, 'ODI (50 overs)', 'odi', true, '{
  "innings_per_side": 1, "overs_per_innings": 50, "balls_per_over": 6,
  "players_per_side": 11, "max_overs_per_bowler": 10, "wickets_to_fall": 10,
  "powerplays": [
    {"type":"mandatory","from_over":1,"to_over":10,"max_fielders_outside_circle":2},
    {"type":"middle","from_over":11,"to_over":40,"max_fielders_outside_circle":4},
    {"type":"death","from_over":41,"to_over":50,"max_fielders_outside_circle":5}],
  "super_over": {"enabled": true, "max_repeats": 1, "balls": 6},
  "dls": {"enabled": true, "method": "DLS", "min_overs_per_side": 20},
  "follow_on": {"enabled": false}, "declaration_allowed": false,
  "no_ball": {"runs": 1, "free_hit": true}, "wide": {"runs": 1},
  "twelfth_man": {"allowed": true, "can_bat": false, "can_bowl": false},
  "duration_days": 1, "drs": {"enabled": false}
}'),
(NULL, 'T10', 't10', true, '{
  "innings_per_side": 1, "overs_per_innings": 10, "balls_per_over": 6,
  "players_per_side": 11, "max_overs_per_bowler": 2, "wickets_to_fall": 10,
  "powerplays": [{"type":"mandatory","from_over":1,"to_over":3,"max_fielders_outside_circle":2}],
  "super_over": {"enabled": true, "max_repeats": 1, "balls": 6},
  "dls": {"enabled": true, "method": "DLS", "min_overs_per_side": 3},
  "follow_on": {"enabled": false}, "declaration_allowed": false,
  "no_ball": {"runs": 1, "free_hit": true}, "wide": {"runs": 1},
  "twelfth_man": {"allowed": true, "can_bat": false, "can_bowl": false},
  "duration_days": 1, "drs": {"enabled": false}
}'),
(NULL, '6-a-side Sixes', 'sixes', true, '{
  "innings_per_side": 1, "overs_per_innings": 5, "balls_per_over": 6,
  "players_per_side": 6, "max_overs_per_bowler": 1, "wickets_to_fall": 5,
  "powerplays": [],
  "super_over": {"enabled": true, "max_repeats": 1, "balls": 6},
  "dls": {"enabled": false},
  "follow_on": {"enabled": false}, "declaration_allowed": false,
  "no_ball": {"runs": 2, "free_hit": true}, "wide": {"runs": 2},
  "twelfth_man": {"allowed": false},
  "duration_days": 1, "drs": {"enabled": false},
  "retire_at_runs": 31
}'),
(NULL, 'Test (2 innings)', 'test', true, '{
  "innings_per_side": 2, "overs_per_innings": null, "balls_per_over": 6,
  "players_per_side": 11, "max_overs_per_bowler": null, "wickets_to_fall": 10,
  "powerplays": [],
  "super_over": {"enabled": false},
  "dls": {"enabled": false},
  "follow_on": {"enabled": true, "deficit": 200},
  "declaration_allowed": true,
  "no_ball": {"runs": 1, "free_hit": false}, "wide": {"runs": 1},
  "twelfth_man": {"allowed": true, "can_bat": false, "can_bowl": false},
  "duration_days": 5, "new_ball_after_overs": 80, "drs": {"enabled": false}
}');

-- ---------- Default subscription plans ----------
INSERT INTO subscription_plans (slug, name, description, price_cents, currency, billing_interval, trial_days, features, sort_order) VALUES
('free', 'Free', 'For casual matches and trying the platform', 0, 'USD', 'month', 0,
 '{"max_tournaments":1,"max_teams":8,"max_concurrent_matches":1,"live_scoring":true,"dls":false,"advanced_stats":false,"custom_branding":false,"api_access":false,"commentary":false,"push_notifications":true}', 1),
('club', 'Club', 'For clubs running regular leagues', 2900, 'USD', 'month', 14,
 '{"max_tournaments":5,"max_teams":32,"max_concurrent_matches":3,"live_scoring":true,"dls":true,"advanced_stats":true,"custom_branding":false,"api_access":false,"commentary":true,"push_notifications":true}', 2),
('league', 'League', 'For serious league operators', 9900, 'USD', 'month', 14,
 '{"max_tournaments":25,"max_teams":128,"max_concurrent_matches":10,"live_scoring":true,"dls":true,"advanced_stats":true,"custom_branding":true,"api_access":true,"commentary":true,"push_notifications":true}', 3),
('pro', 'Pro / Enterprise', 'Unlimited everything + SLA', 29900, 'USD', 'month', 0,
 '{"max_tournaments":null,"max_teams":null,"max_concurrent_matches":null,"live_scoring":true,"dls":true,"advanced_stats":true,"custom_branding":true,"api_access":true,"commentary":true,"push_notifications":true,"sla":true,"dedicated_support":true}', 4);

-- ---------- Marketing site: default pages ----------
INSERT INTO cms_pages (slug, title, status, blocks, seo, published_at) VALUES
('home', 'CricLive — Live Cricket Scoring for Every League', 'published',
 '[{"id":"hero","type":"hero","props":{"heading":"Score every ball. Share every moment.","subheading":"Professional live scoring, stats and streaming-grade scorecards for clubs, schools and leagues.","cta":{"label":"Start free","href":"/register"},"secondary_cta":{"label":"Watch demo","href":"/demo"}}},
   {"id":"features","type":"feature_grid","props":{"columns":3,"items":[{"icon":"radio","title":"Real-time scoring","body":"Sub-second ball-by-ball updates to every fan."},{"icon":"settings","title":"Any format","body":"T20, ODI, Test, sixes — or invent your own rules."},{"icon":"bar-chart","title":"Pro stats","body":"Wagon wheels, Manhattans, career records out of the box."}]}},
   {"id":"pricing_preview","type":"pricing_table","props":{"plan_slugs":["free","club","league"]}},
   {"id":"cta","type":"cta_banner","props":{"heading":"Your league deserves better than a paper scorebook.","cta":{"label":"Create your first tournament","href":"/register"}}}]',
 '{"title":"CricLive — Live Cricket Scoring Platform","description":"Real-time cricket scoring, stats and tournament management for clubs and leagues."}', now()),
('features', 'Features', 'published', '[]', '{}', now()),
('pricing',  'Pricing',  'published', '[{"id":"plans","type":"pricing_table","props":{"plan_slugs":["free","club","league","pro"],"show_comparison":true}}]', '{}', now()),
('demo',     'Demo',     'published', '[]', '{}', now()),
('contact',  'Contact',  'published', '[{"id":"form","type":"contact_form","props":{"kinds":["contact","demo_request"]}}]', '{}', now());

INSERT INTO site_settings (key, value) VALUES
('site.name', '"CricLive"'),
('site.nav', '[{"label":"Features","href":"/features"},{"label":"Pricing","href":"/pricing"},{"label":"Demo","href":"/demo"},{"label":"Contact","href":"/contact"}]'),
('feature.signup_enabled', 'true'),
('feature.ai_commentary', 'false');
