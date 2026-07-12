-- ============================================================
-- Migration 08: child-match (super over) lineage lookups
-- (innings.is_follow_on and matches.parent_match_id/is_super_over
--  already exist from migration 04 — this adds the read-path index)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_matches_parent
  ON matches (parent_match_id) WHERE parent_match_id IS NOT NULL;
