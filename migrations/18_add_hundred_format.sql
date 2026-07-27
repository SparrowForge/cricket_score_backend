-- ============================================================
-- Migration 18: Add The Hundred (100-ball) cricket format
-- ============================================================

INSERT INTO match_formats (organization_id, name, slug, is_builtin, rules) VALUES
(NULL, 'The Hundred', 'hundred', true, '{
  "innings_per_side": 1, "overs_per_innings": 16.67, "balls_per_over": 6,
  "players_per_side": 11, "max_overs_per_bowler": 2, "wickets_to_fall": 10,
  "total_balls_per_innings": 100,
  "powerplays": [{"type":"mandatory","from_ball":1,"to_ball":25,"max_fielders_outside_circle":2}],
  "super_over": {"enabled": true, "max_repeats": 1, "balls": 10, "balls_per_over": 6},
  "dls": {"enabled": true, "method": "DLS", "min_balls_per_side": 50},
  "follow_on": {"enabled": false}, "declaration_allowed": false,
  "no_ball": {"runs": 1, "free_hit": true}, "wide": {"runs": 1},
  "twelfth_man": {"allowed": true, "can_bat": false, "can_bowl": false},
  "duration_days": 1, "drs": {"enabled": false},
  "strategic_timeout": {"enabled": true, "duration_seconds": 150, "per_side": 2}
}');
