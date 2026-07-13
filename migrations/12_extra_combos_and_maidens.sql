-- ============================================================
-- Migration 12: no-ball+bye/leg-bye combo extras, maiden-over fix
-- ============================================================
-- A delivery can carry TWO extra categories at once: a no-ball penalty
-- (illegal delivery) plus byes/leg-byes actually run by the batsmen off
-- it. The single `extra_type` column stays the PRIMARY penalty type
-- ('no_ball'); these new columns record the secondary byes/leg-byes
-- component so it can be routed to innings.extras_byes/extras_leg_byes
-- and excluded from the bowler's conceded-runs tally (byes are never
-- charged to the bowler, even on a no-ball).
--
-- A wide is deliberately NOT given a secondary type: any runs the
-- batsmen take off a wide are, by law, scored entirely as more wides
-- (never split out as byes), so extra_type='wide' + runs_extras alone
-- already represents that correctly.

ALTER TABLE balls
  ADD COLUMN IF NOT EXISTS secondary_extra_type extra_type,
  ADD COLUMN IF NOT EXISTS secondary_extra_runs  smallint NOT NULL DEFAULT 0;

ALTER TABLE balls DROP CONSTRAINT IF EXISTS chk_balls_secondary_extra;
ALTER TABLE balls ADD CONSTRAINT chk_balls_secondary_extra
  CHECK (secondary_extra_type IS NULL OR secondary_extra_type IN ('bye', 'leg_bye'));
