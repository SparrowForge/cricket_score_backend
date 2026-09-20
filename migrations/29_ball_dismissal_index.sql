-- ============================================================
-- Migration 29: index dismissed_player_id on balls
-- ============================================================
-- The head-to-head matchup query (`catalog.service.ts playerMatchups`) starts
-- by collecting every innings the player took part in. Striker and bowler are
-- already indexed (idx_balls_batter / idx_balls_bowler), but the third case —
-- a batter run out at the NON-striker's end without ever facing a ball — is
-- only reachable through dismissed_player_id, and without this index that
-- branch seq-scans the whole ball stream on every profile view.
--
-- Partial on the same predicate as the existing ball indexes so superseded
-- correction rows stay out of it.

CREATE INDEX IF NOT EXISTS idx_balls_dismissed
  ON balls (dismissed_player_id)
  WHERE NOT is_superseded AND dismissed_player_id IS NOT NULL;
