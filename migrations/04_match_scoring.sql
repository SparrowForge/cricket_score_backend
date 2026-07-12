-- ============================================================
-- Migration 04: Matches, squads, innings, ball-by-ball event
--               store (append-only), partnerships, commentary
-- ============================================================

CREATE TABLE matches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   uuid REFERENCES tournaments(id) ON DELETE CASCADE,  -- NULL = standalone friendly
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  match_number    integer,                       -- 'Match 17'
  stage           fixture_stage NOT NULL DEFAULT 'league',
  stage_label     text,                          -- 'Qualifier 2'
  group_id        uuid REFERENCES tournament_groups(id) ON DELETE SET NULL,
  team_a_id       uuid NOT NULL REFERENCES teams(id),
  team_b_id       uuid NOT NULL REFERENCES teams(id),
  venue_id        uuid REFERENCES venues(id),
  scheduled_start timestamptz NOT NULL,
  actual_start    timestamptz,
  completed_at    timestamptz,
  status          match_status NOT NULL DEFAULT 'scheduled',
  -- Resolved rules snapshot = deep_merge(format.rules, tournament.rule_overrides, match overrides).
  -- Frozen at toss; every scoring decision reads from here, never from the format tables.
  rules_snapshot  jsonb,
  toss_winner_id  uuid REFERENCES teams(id),
  toss_decision   toss_decision,
  -- Result
  winner_team_id  uuid REFERENCES teams(id),
  result_type     text CHECK (result_type IN ('win','tie','no_result','abandoned','forfeit','draw')),
  win_margin      jsonb,                         -- {"by":"runs","value":24} | {"by":"wickets","value":6,"balls_remaining":11} | {"by":"super_over"}
  result_summary  text,                          -- 'CSK won by 24 runs'
  player_of_match_id uuid REFERENCES players(id),
  -- DLS / interruptions
  dls_applied     boolean NOT NULL DEFAULT false,
  dls_info        jsonb,                         -- {"revised_target":178,"revised_overs":17,"par_scores":[...]}
  is_super_over   boolean NOT NULL DEFAULT false,
  parent_match_id uuid REFERENCES matches(id),   -- super over rows point at the tied parent
  -- Live-state checkpoint (mirror of Redis, written every over + on innings/match events;
  -- used to rebuild Redis after a cache loss)
  live_state      jsonb,
  live_state_seq  bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (team_a_id <> team_b_id)
);
CREATE TRIGGER trg_matches_updated BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_matches_tournament ON matches (tournament_id, scheduled_start);
CREATE INDEX idx_matches_live ON matches (status) WHERE status IN ('live','innings_break','rain_delay','toss');
CREATE INDEX idx_matches_upcoming ON matches (scheduled_start) WHERE status = 'scheduled';
CREATE INDEX idx_matches_team ON matches (team_a_id, team_b_id);

ALTER TABLE user_role_assignments
  ADD CONSTRAINT fk_ura_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE;

CREATE TABLE match_officials (
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  official_id     uuid NOT NULL REFERENCES officials(id) ON DELETE CASCADE,
  duty            text NOT NULL CHECK (duty IN ('field_umpire_1','field_umpire_2','tv_umpire','reserve_umpire','referee','scorer')),
  PRIMARY KEY (match_id, duty)
);

-- ---------- Match squad (playing XI + bench, IPL-style toggles) ----------
CREATE TABLE match_players (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES teams(id),
  player_id       uuid NOT NULL REFERENCES players(id),
  is_playing_xi   boolean NOT NULL DEFAULT true,
  is_twelfth      boolean NOT NULL DEFAULT false,
  can_bat         boolean NOT NULL DEFAULT true,   -- for 12th man / impact player: format rules decide defaults
  can_bowl        boolean NOT NULL DEFAULT true,
  is_captain      boolean NOT NULL DEFAULT false,
  is_wicket_keeper boolean NOT NULL DEFAULT false,
  batting_order   smallint,
  substituted_in_at  timestamptz,                  -- substitution audit trail
  substituted_out_at timestamptz,
  substitution_reason text,                        -- 'impact_player','concussion','injury'
  replaced_player_id uuid REFERENCES players(id),
  UNIQUE (match_id, player_id)
);
CREATE INDEX idx_match_players ON match_players (match_id, team_id);

-- ---------- Innings ----------
CREATE TABLE innings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  seq             smallint NOT NULL,               -- 1..4 (Test), 1..2 (limited overs)
  batting_team_id uuid NOT NULL REFERENCES teams(id),
  bowling_team_id uuid NOT NULL REFERENCES teams(id),
  status          innings_status NOT NULL DEFAULT 'not_started',
  is_follow_on    boolean NOT NULL DEFAULT false,
  target_runs     integer,                         -- chasing side only (DLS-revised value lands here)
  max_overs       numeric(5,1),                    -- effective overs (rain-reduced), null in Tests
  -- Denormalized totals maintained by the scoring engine (single writer per match):
  total_runs      integer NOT NULL DEFAULT 0,
  total_wickets   smallint NOT NULL DEFAULT 0,
  legal_balls     integer NOT NULL DEFAULT 0,      -- source of truth for overs display
  extras_wides    smallint NOT NULL DEFAULT 0,
  extras_no_balls smallint NOT NULL DEFAULT 0,
  extras_byes     smallint NOT NULL DEFAULT 0,
  extras_leg_byes smallint NOT NULL DEFAULT 0,
  extras_penalty  smallint NOT NULL DEFAULT 0,
  started_at      timestamptz,
  ended_at        timestamptz,
  UNIQUE (match_id, seq)
);
CREATE INDEX idx_innings_match ON innings (match_id, seq);

-- ---------- Ball-by-ball events (APPEND-ONLY event store) ----------
-- Corrections never mutate rows: a correction appends a new row with
-- supersedes_ball_id set, and the old row gets is_superseded=true.
-- The full match can be replayed from this table alone.
CREATE TABLE balls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  innings_id      uuid NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  seq             integer NOT NULL,                -- monotonic per innings, includes illegal deliveries
  over_number     smallint NOT NULL,               -- 0-based
  ball_in_over    smallint NOT NULL,               -- legal-ball counter within the over (1..balls_per_over)
  striker_id      uuid NOT NULL REFERENCES players(id),
  non_striker_id  uuid NOT NULL REFERENCES players(id),
  bowler_id       uuid NOT NULL REFERENCES players(id),
  is_legal        boolean NOT NULL DEFAULT true,   -- false for wide/no-ball
  runs_batter     smallint NOT NULL DEFAULT 0,
  runs_extras     smallint NOT NULL DEFAULT 0,
  extra_type      extra_type,
  is_boundary_four boolean NOT NULL DEFAULT false,
  is_boundary_six  boolean NOT NULL DEFAULT false,
  is_free_hit     boolean NOT NULL DEFAULT false,
  -- Wicket
  is_wicket       boolean NOT NULL DEFAULT false,
  wicket_type     wicket_type,
  dismissed_player_id uuid REFERENCES players(id), -- can be non-striker (run out)
  fielder_id      uuid REFERENCES players(id),
  -- Analytics payloads (optional, from scorer taps on wagon wheel / pitch map)
  wagon           jsonb,                           -- {"angle_deg":135,"distance_pct":80,"region":"deep_midwicket"}
  pitch           jsonb,                           -- {"line":"off_stump","length":"good"}
  shot_type       text,                            -- 'cover_drive','pull',…
  -- Correction chain
  is_superseded   boolean NOT NULL DEFAULT false,
  supersedes_ball_id uuid REFERENCES balls(id),
  -- Offline-sync idempotency: mobile scorer generates this UUID locally;
  -- retries and replays are deduped on it.
  client_event_id uuid NOT NULL,
  scored_by       uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (innings_id, client_event_id)
);
CREATE UNIQUE INDEX idx_balls_seq ON balls (innings_id, seq) WHERE NOT is_superseded;
CREATE INDEX idx_balls_over ON balls (innings_id, over_number) WHERE NOT is_superseded;
CREATE INDEX idx_balls_batter ON balls (striker_id) WHERE NOT is_superseded;
CREATE INDEX idx_balls_bowler ON balls (bowler_id) WHERE NOT is_superseded;

-- ---------- Per-over rollup (powers Manhattan + over comparison without scanning balls) ----------
CREATE TABLE over_summaries (
  innings_id      uuid NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  over_number     smallint NOT NULL,
  bowler_id       uuid NOT NULL REFERENCES players(id),
  runs            smallint NOT NULL DEFAULT 0,
  wickets         smallint NOT NULL DEFAULT 0,
  extras          smallint NOT NULL DEFAULT 0,
  is_maiden       boolean NOT NULL DEFAULT false,
  cumulative_runs integer NOT NULL DEFAULT 0,
  cumulative_wickets smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (innings_id, over_number)
);

-- ---------- Partnerships ----------
CREATE TABLE partnerships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  innings_id      uuid NOT NULL REFERENCES innings(id) ON DELETE CASCADE,
  wicket_number   smallint NOT NULL,               -- partnership for the Nth wicket
  batter1_id      uuid NOT NULL REFERENCES players(id),
  batter2_id      uuid NOT NULL REFERENCES players(id),
  runs            integer NOT NULL DEFAULT 0,
  balls           integer NOT NULL DEFAULT 0,
  is_unbeaten     boolean NOT NULL DEFAULT false,
  UNIQUE (innings_id, wicket_number)
);

-- ---------- Match interruptions (rain / light — feeds DLS) ----------
CREATE TABLE match_interruptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_id      uuid REFERENCES innings(id),
  reason          text NOT NULL,                   -- 'rain','bad_light','wet_outfield'
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  overs_lost      numeric(5,1),
  state_at_stop   jsonb                            -- score/overs/wickets when play stopped
);

-- ---------- Commentary (manual + AI-ready) ----------
CREATE TABLE commentary_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  innings_id      uuid REFERENCES innings(id),
  ball_id         uuid REFERENCES balls(id),       -- null for milestone/color commentary
  author_id       uuid REFERENCES users(id),       -- null when source='ai'
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','auto')),
  body            text NOT NULL,
  is_highlight    boolean NOT NULL DEFAULT false,  -- WICKET / SIX / FIFTY pins
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_commentary_updated BEFORE UPDATE ON commentary_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_commentary_match ON commentary_entries (match_id, created_at DESC);

-- ---------- MVP points per match (configurable weights in tournament rules) ----------
CREATE TABLE match_mvp_points (
  match_id        uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  batting_points  numeric(7,2) NOT NULL DEFAULT 0,
  bowling_points  numeric(7,2) NOT NULL DEFAULT 0,
  fielding_points numeric(7,2) NOT NULL DEFAULT 0,
  total_points    numeric(7,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, player_id)
);
