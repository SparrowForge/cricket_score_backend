-- ============================================================
-- Migration 27: organization (club) profile
-- ============================================================
-- `organizations` carried only name/slug/logo_url/settings — enough to be a
-- SaaS tenant, not enough to be a club anyone can look up. This adds the full
-- club profile behind the public /clubs pages and the admin Profile tab.
--
-- Split deliberately: a real column for anything the directory filters, sorts
-- or indexes on, a jsonb group for the long tail that is only ever read back
-- whole on one profile screen. A 50-column table would be neither queryable
-- nor honest about which fields matter.
--
-- Nothing here is required. Club creation stays Name + Logo + City; every
-- column below is nullable or defaulted so the ~existing rows are valid as-is
-- and the form can be filled in later from Edit Profile.
--
-- Everything is idempotent so a partial run can be re-applied.

-- ---------- 1. Enums ------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE org_type AS ENUM ('club', 'academy', 'association', 'corporate', 'school', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE org_status AS ENUM ('active', 'inactive', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE org_visibility AS ENUM ('public', 'private');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- 2. Profile columns -------------------------------------------
ALTER TABLE organizations
  -- Basic information
  ADD COLUMN IF NOT EXISTS short_name          text,
  ADD COLUMN IF NOT EXISTS org_type            org_type NOT NULL DEFAULT 'club',
  ADD COLUMN IF NOT EXISTS banner_url          text,
  ADD COLUMN IF NOT EXISTS established_year    smallint,
  ADD COLUMN IF NOT EXISTS description         text,
  -- Address & location
  ADD COLUMN IF NOT EXISTS country             text,
  ADD COLUMN IF NOT EXISTS division            text,
  ADD COLUMN IF NOT EXISTS city                text,
  ADD COLUMN IF NOT EXISTS address_line        text,
  ADD COLUMN IF NOT EXISTS postal_code         text,
  ADD COLUMN IF NOT EXISTS latitude            numeric(9,6),
  ADD COLUMN IF NOT EXISTS longitude           numeric(9,6),
  ADD COLUMN IF NOT EXISTS home_ground         text,
  -- Contact
  ADD COLUMN IF NOT EXISTS contact_name        text,
  ADD COLUMN IF NOT EXISTS contact_designation text,
  ADD COLUMN IF NOT EXISTS contact_phone       text,
  ADD COLUMN IF NOT EXISTS contact_phone_alt   text,
  ADD COLUMN IF NOT EXISTS contact_email       citext,
  ADD COLUMN IF NOT EXISTS website_url         text,
  -- System / app
  ADD COLUMN IF NOT EXISTS status              org_status     NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS visibility          org_visibility NOT NULL DEFAULT 'public',
  -- Long tail (see COMMENTs below for the shape of each)
  ADD COLUMN IF NOT EXISTS registration        jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cricket_details     jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS facilities          jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS achievements        jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS social              jsonb NOT NULL DEFAULT '{}';

-- 1700 is arbitrary but keeps a fat-fingered "20255" out of the directory.
DO $$ BEGIN
  ALTER TABLE organizations
    ADD CONSTRAINT chk_orgs_established_year
    CHECK (established_year IS NULL OR established_year BETWEEN 1700 AND 2100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Both halves of a map pin, or neither — a lone latitude cannot be plotted.
DO $$ BEGIN
  ALTER TABLE organizations
    ADD CONSTRAINT chk_orgs_geo_pair
    CHECK ((latitude IS NULL) = (longitude IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- 3. jsonb group shapes ----------------------------------------
COMMENT ON COLUMN organizations.registration IS
  'Registration & legal. { number, authority, date (ISO yyyy-mm-dd), tax_id, certificate_url }';

COMMENT ON COLUMN organizations.cricket_details IS
  'Cricket profile. { team_category: senior|junior|women|corporate|mixed, '
  'formats: text[] of format slugs, skill_level: amateur|semi_pro|professional, '
  'default_squad_size: int, jersey_colors: text[], kit_details: text }';

COMMENT ON COLUMN organizations.facilities IS
  'Facilities & infrastructure. { ground_ownership: own|rented|shared, '
  'practice: text[] subset of nets|indoor|bowling_machine, dressing_room: bool, '
  'flood_lights: bool, seating_capacity: int }';

COMMENT ON COLUMN organizations.achievements IS
  'History. { titles: text[], recent_results: text[], notable_players: text[], awards: text[] }';

COMMENT ON COLUMN organizations.social IS
  'Social & media. { facebook, youtube, instagram, twitter, gallery: text[] of '
  'CDN urls, videos: text[] of urls }';

COMMENT ON COLUMN organizations.settings IS
  'App settings that are not profile fields: { default_match: { overs_per_innings, '
  'players_per_side, format_id }, scoring_permission: admin_only|assigned_scorer }. '
  'Default match settings seed the create-match form only — a match freezes its own '
  'rules_snapshot at toss and never re-reads this.';

COMMENT ON COLUMN organizations.visibility IS
  'private hides the club from the public /clubs directory and profile page. '
  'It does NOT hide its matches — those follow their tournament.';

-- ---------- 4. Indexes ----------------------------------------------------
-- The public directory lists active+public clubs, usually filtered by city.
CREATE INDEX IF NOT EXISTS idx_orgs_public
  ON organizations (status, visibility)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orgs_city
  ON organizations (lower(city))
  WHERE deleted_at IS NULL AND city IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orgs_country
  ON organizations (lower(country))
  WHERE deleted_at IS NULL AND country IS NOT NULL;
