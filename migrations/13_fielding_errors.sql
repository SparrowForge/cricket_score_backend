-- Track which bowling-side fielder is associated with a manual commentary entry
-- (dropped catch, missed run-out, misfield) so MVP can apply negative fielding points.
ALTER TABLE commentary_entries
  ADD COLUMN IF NOT EXISTS fielder_player_id uuid REFERENCES players(id);

-- Auto-link manual comments to the live innings even when no ball_id is supplied
-- (fielding events are logged between deliveries, not tied to a specific ball).
-- Nothing to back-fill: historical entries have fielder_player_id = NULL and are
-- simply ignored by the MVP negative-points query.
