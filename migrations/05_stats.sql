-- ============================================================
-- Migration 05: Stats engine — per-match facts + rolled-up
--               tournament/career aggregates
-- ============================================================
-- Pattern: player_match_stats is the fact table written once when a match
-- finalizes (idempotent upsert from the balls event store). Tournament and
-- career tables are pure rollups of it, recomputed incrementally by the
-- stats worker (BullMQ job on match.completed). Nothing here is computed
-- at request time.

CREATE TABLE player_match_stats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  tournament_id   uuid REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES teams(id),
  -- Batting
  batted          boolean NOT NULL DEFAULT false,
  runs_scored     integer NOT NULL DEFAULT 0,
  balls_faced     integer NOT NULL DEFAULT 0,
  fours           smallint NOT NULL DEFAULT 0,
  sixes           smallint NOT NULL DEFAULT 0,
  is_out          boolean NOT NULL DEFAULT false,
  dismissal_type  wicket_type,
  dismissal_detail jsonb,                        -- {"bowler":uuid,"fielder":uuid,"text":"c Dhoni b Jadeja"}
  batting_position smallint,
  -- Bowling
  bowled          boolean NOT NULL DEFAULT false,
  balls_bowled    integer NOT NULL DEFAULT 0,    -- legal deliveries
  runs_conceded   integer NOT NULL DEFAULT 0,
  wickets_taken   smallint NOT NULL DEFAULT 0,
  maidens         smallint NOT NULL DEFAULT 0,
  wides_bowled    smallint NOT NULL DEFAULT 0,
  no_balls_bowled smallint NOT NULL DEFAULT 0,
  dot_balls       integer NOT NULL DEFAULT 0,
  -- Fielding
  catches         smallint NOT NULL DEFAULT 0,
  stumpings       smallint NOT NULL DEFAULT 0,
  run_outs        smallint NOT NULL DEFAULT 0,
  -- MVP
  mvp_points      numeric(7,2) NOT NULL DEFAULT 0,
  UNIQUE (match_id, player_id)
);
CREATE INDEX idx_pms_player ON player_match_stats (player_id);
CREATE INDEX idx_pms_tournament ON player_match_stats (tournament_id, player_id);

-- ---------- Tournament-level rollup (leaderboards: orange/purple cap) ----------
CREATE TABLE player_tournament_stats (
  tournament_id   uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES teams(id),
  matches_played  smallint NOT NULL DEFAULT 0,
  -- Batting
  innings_batted  smallint NOT NULL DEFAULT 0,
  runs_scored     integer NOT NULL DEFAULT 0,
  balls_faced     integer NOT NULL DEFAULT 0,
  not_outs        smallint NOT NULL DEFAULT 0,
  highest_score   integer NOT NULL DEFAULT 0,
  highest_score_not_out boolean NOT NULL DEFAULT false,
  fifties         smallint NOT NULL DEFAULT 0,
  hundreds        smallint NOT NULL DEFAULT 0,
  fours           integer NOT NULL DEFAULT 0,
  sixes           integer NOT NULL DEFAULT 0,
  ducks           smallint NOT NULL DEFAULT 0,
  -- Bowling
  innings_bowled  smallint NOT NULL DEFAULT 0,
  balls_bowled    integer NOT NULL DEFAULT 0,
  runs_conceded   integer NOT NULL DEFAULT 0,
  wickets_taken   smallint NOT NULL DEFAULT 0,
  best_bowling    jsonb,                          -- {"wickets":5,"runs":24}
  three_wkt_hauls smallint NOT NULL DEFAULT 0,
  five_wkt_hauls  smallint NOT NULL DEFAULT 0,
  maidens         smallint NOT NULL DEFAULT 0,
  -- Fielding
  catches         smallint NOT NULL DEFAULT 0,
  stumpings       smallint NOT NULL DEFAULT 0,
  run_outs        smallint NOT NULL DEFAULT 0,
  mvp_points      numeric(9,2) NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, player_id)
);
CREATE INDEX idx_pts_runs ON player_tournament_stats (tournament_id, runs_scored DESC);
CREATE INDEX idx_pts_wickets ON player_tournament_stats (tournament_id, wickets_taken DESC);
CREATE INDEX idx_pts_mvp ON player_tournament_stats (tournament_id, mvp_points DESC);

-- ---------- Career rollup, partitioned by format family ----------
CREATE TABLE player_career_stats (
  player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  format_family   text NOT NULL CHECK (format_family IN ('t10','t20','one_day','test','sixes','custom')),
  matches_played  integer NOT NULL DEFAULT 0,
  innings_batted  integer NOT NULL DEFAULT 0,
  runs_scored     integer NOT NULL DEFAULT 0,
  balls_faced     integer NOT NULL DEFAULT 0,
  not_outs        integer NOT NULL DEFAULT 0,
  highest_score   integer NOT NULL DEFAULT 0,
  fifties         integer NOT NULL DEFAULT 0,
  hundreds        integer NOT NULL DEFAULT 0,
  fours           integer NOT NULL DEFAULT 0,
  sixes           integer NOT NULL DEFAULT 0,
  innings_bowled  integer NOT NULL DEFAULT 0,
  balls_bowled    integer NOT NULL DEFAULT 0,
  runs_conceded   integer NOT NULL DEFAULT 0,
  wickets_taken   integer NOT NULL DEFAULT 0,
  best_bowling    jsonb,
  five_wkt_hauls  integer NOT NULL DEFAULT 0,
  catches         integer NOT NULL DEFAULT 0,
  stumpings       integer NOT NULL DEFAULT 0,
  run_outs        integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, format_family)
);

-- ---------- Team head-to-head rollup ----------
CREATE TABLE team_head_to_head (
  team_a_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,  -- invariant: team_a_id < team_b_id
  team_b_id       uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  matches_played  integer NOT NULL DEFAULT 0,
  team_a_wins     integer NOT NULL DEFAULT 0,
  team_b_wins     integer NOT NULL DEFAULT 0,
  ties            integer NOT NULL DEFAULT 0,
  no_results      integer NOT NULL DEFAULT 0,
  last_five       jsonb NOT NULL DEFAULT '[]',    -- [{"match_id":…,"winner":…,"summary":…}]
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_a_id, team_b_id),
  CHECK (team_a_id < team_b_id)
);

-- ---------- Derived read views ----------
-- Batting average / SR / economy are computed in views so they can never
-- drift from the counters.
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
  CASE WHEN pts.balls_bowled > 0
       THEN round(pts.runs_conceded::numeric * 6 / pts.balls_bowled, 2) END AS economy,
  CASE WHEN pts.wickets_taken > 0
       THEN round(pts.runs_conceded::numeric / pts.wickets_taken, 2) END AS bowling_average
FROM player_tournament_stats pts
JOIN players p ON p.id = pts.player_id
JOIN teams t   ON t.id = pts.team_id;
