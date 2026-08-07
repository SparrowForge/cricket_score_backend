-- ============================================================
-- Migration 20: Add milestone counters for leaderboards
-- ============================================================
-- Add batting milestones (twenties, thirties, ducks already present)
-- and bowling haul breakdowns (2, 3, 4-wkt already implicitly; add explicit columns)

ALTER TABLE player_tournament_stats
  ADD COLUMN IF NOT EXISTS thirties smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twenties smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS two_wkt_hauls smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS four_wkt_hauls smallint NOT NULL DEFAULT 0;

-- Re-create view to expose overs as a computed column (balls_bowled / 6)
DROP VIEW IF EXISTS v_player_tournament_leaderboard CASCADE;

CREATE VIEW v_player_tournament_leaderboard AS
SELECT
  pts.*,
  p.full_name,
  p.photo_url,
  t.short_name AS team_short_name,
  CASE WHEN (pts.innings_batted - pts.not_outs) > 0
       THEN round(pts.runs_scored::numeric / (pts.innings_batted - pts.not_outs), 2) END AS batting_average,
  CASE WHEN pts.balls_faced > 0
       THEN round(pts.runs_scored::numeric * 100 / pts.balls_faced, 2) END AS strike_rate,
  (pts.balls_bowled / 6.0)::numeric(5,1) AS overs_bowled,
  CASE WHEN pts.balls_bowled > 0
       THEN round(pts.runs_conceded::numeric * 6 / pts.balls_bowled, 2) END AS economy,
  CASE WHEN pts.wickets_taken > 0
       THEN round(pts.runs_conceded::numeric / pts.wickets_taken, 2) END AS bowling_average
FROM player_tournament_stats pts
JOIN players p ON p.id = pts.player_id
JOIN teams t   ON t.id = pts.team_id;
