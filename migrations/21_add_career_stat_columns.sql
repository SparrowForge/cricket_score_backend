-- ============================================================
-- Migration 21: Add missing columns to player_career_stats
-- ============================================================
-- Add milestone counters and bowling statistics to match player_tournament_stats

ALTER TABLE player_career_stats
  ADD COLUMN IF NOT EXISTS ducks smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thirties smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twenties smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS maidens smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS two_wkt_hauls smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS three_wkt_hauls smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS four_wkt_hauls smallint NOT NULL DEFAULT 0;
