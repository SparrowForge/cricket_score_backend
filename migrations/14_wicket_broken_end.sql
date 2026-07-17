-- Add wicket_broken_end column for deterministic run-out logic
ALTER TABLE balls ADD COLUMN wicket_broken_end text
  CHECK (wicket_broken_end IN ('striker_end', 'non_striker_end'));
