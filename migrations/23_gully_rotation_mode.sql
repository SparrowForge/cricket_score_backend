-- ============================================================
-- Migration 23: Rotation Gully Mode
-- ============================================================
-- One batter at a time, no teams, everyone in the pool bats and bowls.
--
-- Deliberately small. The whole design rests on rotation being a *configuration*
-- of the existing engine rather than a second one, so the append-only ball
-- store, innings, over_summaries, player_match_stats and the entire stats
-- pipeline are untouched. What is added here is only what genuinely has no
-- home in the existing schema: the mode flag, the pool-team escape hatch, and
-- the per-player rotation bookkeeping.
--
-- Everything is idempotent so a partial run can be re-applied.

-- ---------- 1. Match mode -----------------------------------------------
-- Defaults to 'standard', so no backfill and no behaviour change for the
-- ~entire existing table.
DO $$ BEGIN
  CREATE TYPE match_mode AS ENUM ('standard', 'rotation');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS mode match_mode NOT NULL DEFAULT 'standard';

CREATE INDEX IF NOT EXISTS idx_matches_mode ON matches (mode) WHERE mode <> 'standard';

-- ---------- 2. Synthetic pool teams --------------------------------------
-- matches.team_a_id / team_b_id are NOT NULL with CHECK (team_a_id <> team_b_id),
-- and innings.batting_team_id, match_players.team_id and
-- player_match_stats.team_id are NOT NULL as well. Relaxing all four would
-- touch ~40 call sites plus the web and mobile type layers.
--
-- Instead each organization gets two lightweight team rows ("Gully Pool" /
-- "Gully Field") that every rotation match in that org reuses. Every existing
-- NOT NULL and every existing join keeps working; the cost is that these rows
-- must be filtered out of team-facing surfaces, which is what the flag is for.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;

-- Partial index for the common "real teams for this org" listing.
CREATE INDEX IF NOT EXISTS idx_teams_real
  ON teams (organization_id) WHERE NOT is_synthetic;

-- ---------- 3. Per-batter rotation slot ----------------------------------
-- The batting order, each batter's quota, and how their innings ended.
-- Career/tournament stats still roll up through player_match_stats — this is
-- scheduling state, not a stats table.
CREATE TABLE IF NOT EXISTS rotation_slots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_id      uuid REFERENCES innings(id) ON DELETE CASCADE,  -- null until the innings exists
  player_id       uuid NOT NULL REFERENCES players(id),
  bat_order       smallint NOT NULL,          -- 1..N, editable until the slot starts
  balls_allotted  smallint NOT NULL,          -- per batter; a withdrawal or a shortened
                                              -- match can leave these unequal
  balls_faced     smallint NOT NULL DEFAULT 0,
  runs_scored     smallint NOT NULL DEFAULT 0,
  ended_reason    text CHECK (ended_reason IN
                    ('dismissed','quota','voluntary','withdrawn','innings_closed')),
  started_at      timestamptz,
  ended_at        timestamptz,
  UNIQUE (match_id, player_id)
);

-- Deferrable so a reorder can shuffle bat_order within one transaction without
-- tripping the constraint halfway through.
DO $$ BEGIN
  ALTER TABLE rotation_slots
    ADD CONSTRAINT rotation_slots_match_order_key UNIQUE (match_id, bat_order)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_rotation_slots_match ON rotation_slots (match_id, bat_order);

-- ---------- 4. Bowling share ---------------------------------------------
-- So "who should bowl next" is an indexed lookup rather than a scan of balls.
-- legal_balls duplicates what the ball stream knows; it is maintained inside
-- the same scoring transaction, so it can never disagree with it.
CREATE TABLE IF NOT EXISTS rotation_bowl_quota (
  match_id         uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id        uuid NOT NULL REFERENCES players(id),
  overs_allotted   smallint NOT NULL DEFAULT 0,
  legal_balls      integer  NOT NULL DEFAULT 0,
  last_over_number smallint,
  PRIMARY KEY (match_id, player_id)
);

-- ---------- 5. Career stats family ---------------------------------------
-- Gully results are real, but they should not sit in the same career bucket as
-- competitive cricket — a 2-over innings against a tape ball is not a T20 knock.
ALTER TABLE player_career_stats
  DROP CONSTRAINT IF EXISTS player_career_stats_format_family_check;

ALTER TABLE player_career_stats
  ADD CONSTRAINT player_career_stats_format_family_check
  CHECK (format_family IN ('t10','t20','one_day','test','sixes','custom','gully'));
