-- ============================================================
-- Migration 03: Formats, venues, teams, players, tournaments,
--               fixtures/scheduling, points table
-- ============================================================

-- ---------- Match formats (the Dynamic Match Format Engine) ----------
-- A format is a versioned JSON rule document. Tournaments reference a format
-- and may override any key. Matches snapshot the resolved rules at start time
-- so historical matches are immune to rule edits.
CREATE TABLE match_formats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, -- NULL = built-in (T20, ODI, Test, T10, sixes)
  name            text NOT NULL,                 -- 'T20', 'ODI', '6-a-side Sixes'
  slug            citext NOT NULL,
  version         integer NOT NULL DEFAULT 1,
  is_builtin      boolean NOT NULL DEFAULT false,
  -- Canonical rule document. Example (T20):
  -- {
  --   "innings_per_side": 1,
  --   "overs_per_innings": 20,             // null = unlimited (Test)
  --   "balls_per_over": 6,
  --   "players_per_side": 11,
  --   "max_overs_per_bowler": 4,           // null = unlimited
  --   "wickets_to_fall": 10,               // 5 for 6-a-side
  --   "powerplays": [
  --     {"type":"mandatory","from_over":1,"to_over":6,"max_fielders_outside_circle":2}
  --   ],
  --   "super_over": {"enabled":true,"max_repeats":1,"balls":6},
  --   "dls": {"enabled":true,"method":"DLS","min_overs_per_side":5},
  --   "follow_on": {"enabled":false,"deficit":null},
  --   "declaration_allowed": false,
  --   "no_ball": {"runs":1,"free_hit":true},
  --   "wide": {"runs":1},
  --   "twelfth_man": {"allowed":true,"can_bat":false,"can_bowl":false},
  --   "duration_days": 1,
  --   "new_ball_after_overs": null,
  --   "drs": {"enabled":false,"reviews_per_innings":0}
  -- }
  rules           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug, version)
);
CREATE TRIGGER trg_formats_updated BEFORE UPDATE ON match_formats FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- Venues & officials ----------
CREATE TABLE venues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  city            text,
  country         text,
  capacity        integer,
  geo             point,
  ends_names      jsonb NOT NULL DEFAULT '["Pavilion End","Far End"]',
  image_url       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_venues_org ON venues (organization_id);

CREATE TABLE officials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  full_name       text NOT NULL,
  official_type   text NOT NULL CHECK (official_type IN ('umpire','tv_umpire','referee','scorer')),
  photo_url       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- Teams & players ----------
CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  short_name      varchar(6) NOT NULL,           -- 'CSK', 'MI'
  slug            citext NOT NULL,
  logo_url        text,
  primary_color   char(7),                       -- '#f9cd05'
  home_venue_id   uuid REFERENCES venues(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, slug)
);
CREATE TRIGGER trg_teams_updated BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE players (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id),     -- player may claim their profile
  full_name       text NOT NULL,
  display_name    text,
  date_of_birth   date,
  batting_style   batting_style,
  bowling_style   bowling_style DEFAULT 'none',
  primary_role    player_role NOT NULL DEFAULT 'batter',
  photo_url       text,
  country         text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE TRIGGER trg_players_updated BEFORE UPDATE ON players FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_players_name_trgm ON players USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_players_org ON players (organization_id);

-- Squad membership over time (a player can move teams between seasons)
CREATE TABLE team_players (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  jersey_number   smallint,
  is_captain      boolean NOT NULL DEFAULT false,
  is_wicket_keeper boolean NOT NULL DEFAULT false,
  active_from     date NOT NULL DEFAULT CURRENT_DATE,
  active_to       date,
  UNIQUE (team_id, player_id, active_from)
);
CREATE INDEX idx_team_players_team ON team_players (team_id) WHERE active_to IS NULL;

-- ---------- Tournaments ----------
CREATE TABLE tournaments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  slug            citext NOT NULL,
  season          text,                          -- '2026', '2026/27'
  format_id       uuid NOT NULL REFERENCES match_formats(id),
  status          tournament_status NOT NULL DEFAULT 'draft',
  start_date      date,
  end_date        date,
  banner_url      text,
  description     text,
  -- Overrides merged over match_formats.rules (deep merge, tournament wins):
  rule_overrides  jsonb NOT NULL DEFAULT '{}',
  -- Points table rules:
  -- {"win":2,"loss":0,"tie":1,"no_result":1,"bonus_point":{"enabled":false},
  --  "tiebreakers":["points","nrr","head_to_head","wins"]}
  points_rules    jsonb NOT NULL DEFAULT '{"win":2,"loss":0,"tie":1,"no_result":1,"tiebreakers":["points","nrr","head_to_head","wins"]}',
  fixture_config  jsonb NOT NULL DEFAULT '{}',   -- {"type":"round_robin","legs":1,"knockout_from":4}
  is_public       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, slug)
);
CREATE TRIGGER trg_tournaments_updated BEFORE UPDATE ON tournaments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_tournaments_status ON tournaments (status) WHERE deleted_at IS NULL;

-- Now that tournaments exists, attach the deferred RBAC scope FK
ALTER TABLE user_role_assignments
  ADD CONSTRAINT fk_ura_tournament FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;

CREATE TABLE tournament_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name            text NOT NULL,                 -- 'Group A'
  sort_order      integer NOT NULL DEFAULT 0,
  UNIQUE (tournament_id, name)
);

CREATE TABLE tournament_teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  group_id        uuid REFERENCES tournament_groups(id) ON DELETE SET NULL,
  seed            integer,
  UNIQUE (tournament_id, team_id)
);
CREATE INDEX idx_tt_group ON tournament_teams (group_id);

-- Registered squad per tournament (superset from which playing XI is picked)
CREATE TABLE tournament_squads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_team_id uuid NOT NULL REFERENCES tournament_teams(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  UNIQUE (tournament_team_id, player_id)
);

-- ---------- Points table (denormalized, recomputed by the standings engine
--            after each result; kept as a table for O(1) public reads) ----------
CREATE TABLE points_table_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id   uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  group_id        uuid REFERENCES tournament_groups(id) ON DELETE CASCADE,
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  played          smallint NOT NULL DEFAULT 0,
  won             smallint NOT NULL DEFAULT 0,
  lost            smallint NOT NULL DEFAULT 0,
  tied            smallint NOT NULL DEFAULT 0,
  no_result       smallint NOT NULL DEFAULT 0,
  points          smallint NOT NULL DEFAULT 0,
  bonus_points    smallint NOT NULL DEFAULT 0,
  runs_for        integer NOT NULL DEFAULT 0,
  overs_faced     numeric(8,1) NOT NULL DEFAULT 0,   -- balls/6 in decimal-over units for NRR
  runs_against    integer NOT NULL DEFAULT 0,
  overs_bowled    numeric(8,1) NOT NULL DEFAULT 0,
  net_run_rate    numeric(6,3) NOT NULL DEFAULT 0,
  rank            smallint,
  form            jsonb NOT NULL DEFAULT '[]',       -- last 5: ["W","L","W","NR","W"]
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, team_id)
);
CREATE INDEX idx_points_table ON points_table_entries (tournament_id, group_id, rank);
