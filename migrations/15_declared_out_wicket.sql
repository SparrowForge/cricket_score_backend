-- Adds a "declared out" dismissal to the wicket_type enum. Used when a batter
-- is given out by declaration/administrative decision rather than off the
-- bowling — so it counts as a fall of wicket and needs a new batter, but is
-- never credited to a bowler (handled in scoring.service.ts, same class as
-- retired_out).
--
-- Additive and irreversible: Postgres enum values cannot be dropped. Safe to
-- run inside the migration runner's transaction on PG 12+ (the value is only
-- added here, never referenced in this same transaction).
ALTER TYPE wicket_type ADD VALUE IF NOT EXISTS 'declared_out';
