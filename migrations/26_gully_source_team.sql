-- ============================================================
-- Migration 26: the squad a gully match draws its pool from
-- ============================================================
-- Creating a rotation match used to ask only for a club, and the roster screen
-- then listed every player in that club. For any club with more than one squad
-- that is a wall of names with no way to tell who turned up for THIS game.
--
-- A gully match is now created against exactly one team, and that team's squad
-- is what the roster picker offers.
--
-- This is deliberately NOT team_a_id. Migration 23 gave every org two synthetic
-- teams ("Gully Pool" / "Gully Field") precisely so a pickup game never lands in
-- team standings, head-to-head or a team's recent form; putting a real team on
-- team_a_id would undo all of that. The column below records where the players
-- came from and nothing else — no innings, no result and no rollup reads it.
--
-- Nullable, because the rows written before this migration have no answer, and
-- because a NOT NULL would also bind every standard match. The API requires it
-- for new rotation matches instead.

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS rotation_team_id uuid REFERENCES teams(id);

COMMENT ON COLUMN matches.rotation_team_id IS
  'Rotation (gully) mode only: the real team whose squad supplies the player pool. '
  'Never a playing side — team_a_id/team_b_id stay synthetic so gully results are '
  'excluded from team standings, form and head-to-head.';

CREATE INDEX IF NOT EXISTS idx_matches_rotation_team
  ON matches (rotation_team_id) WHERE rotation_team_id IS NOT NULL;
