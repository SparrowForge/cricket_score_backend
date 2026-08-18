-- ============================================================
-- Migration 25: Gully (rotation) as a real built-in format
-- ============================================================
-- Migration 23 shipped rotation mode, but its rules were computed entirely in
-- TypeScript (RotationService.buildRules) and frozen straight into
-- matches.rules_snapshot. That worked, but it left three things wrong:
--
--   1. GET /formats did not list Gully, so it was invisible to every format
--      picker — while the home page (migration 24) advertises it alongside T20
--      and The Hundred.
--   2. Its defaults and house rules were the only ones in the product that
--      lived in code rather than data, contradicting the stated architecture:
--      formats are JSON rule documents, so new rules need no deployment.
--   3. Nobody could tune the gully defaults without a backend release.
--
-- This row is a TEMPLATE. The roster-dependent numbers — batter_count,
-- balls_per_batter, players_per_side, wickets_to_fall, overs_per_innings and
-- max_overs_per_bowler — are still derived per match from the pool size and the
-- overs-per-batter the scorer picks, because they cannot be known in advance.
-- Everything else (house rules, extras, the solo_batting switches) now comes
-- from here and can be edited without touching the engine.
--
-- The defaults below describe a typical pickup game: 8 players, 2 overs each.

INSERT INTO match_formats (organization_id, name, slug, version, is_builtin, rules)
SELECT NULL, 'Gully (rotation)', 'gully', 1, true, '{
  "innings_per_side": 1,
  "overs_per_innings": 16,
  "balls_per_over": 6,
  "players_per_side": 9,
  "wickets_to_fall": 8,
  "max_overs_per_bowler": 2,
  "duration_days": 1,
  "powerplays": [],
  "super_over": {"enabled": false},
  "dls": {"enabled": false},
  "drs": {"enabled": false},
  "follow_on": {"enabled": false},
  "declaration_allowed": false,
  "no_ball": {"runs": 1, "free_hit": false},
  "wide": {"runs": 1},
  "twelfth_man": {"allowed": false},
  "solo_batting": {
    "enabled": true,
    "batter_count": 8,
    "balls_per_batter": 12,
    "retire_on_quota": true,
    "bowler_may_be_batter": false
  },
  "gully": {
    "one_tip_one_hand": true,
    "lbw_enabled": false,
    "last_batter_doubles": false,
    "boundary_out": false
  },
  "mvp_profile": "gully_v1"
}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM match_formats WHERE slug = 'gully' AND organization_id IS NULL
);
