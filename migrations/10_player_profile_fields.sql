-- ============================================================
-- Migration 10: player profile fields (height, major teams, bio)
-- date_of_birth already existed (migration 03); these round out the
-- public player profile page.
-- ============================================================

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS height_cm    SMALLINT,
  ADD COLUMN IF NOT EXISTS major_teams  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS bio          TEXT;
