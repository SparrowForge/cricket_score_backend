-- ============================================================
-- Migration 28: player of the tournament
-- ============================================================
-- The mirror of `matches.player_of_match_id` one level up: the award an admin
-- settles when a tournament is marked completed.
--
-- Deliberately a stored pick, not a query over `mvp_points`. The MVP board is
-- recomputed whenever a match is re-finalised or the MVP formula changes, so a
-- derived winner could silently change months after the trophy was handed out.
-- The admin's pick is seeded FROM the MVP board and then frozen.
--
-- Idempotent so a partial run can be re-applied.

ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS player_of_tournament_id uuid REFERENCES players(id);

-- Backs the per-player award count on the profile page, which filters on this
-- column across every tournament.
CREATE INDEX IF NOT EXISTS idx_tournaments_player_of_tournament
  ON tournaments (player_of_tournament_id)
  WHERE player_of_tournament_id IS NOT NULL;
