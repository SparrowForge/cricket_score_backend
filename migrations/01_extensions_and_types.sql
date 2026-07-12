-- ============================================================
-- CricLive Platform — PostgreSQL Schema
-- Migration 01: Extensions, enums, shared functions
-- Target: PostgreSQL 15+
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";        -- case-insensitive emails/slugs
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- fuzzy search on names
CREATE EXTENSION IF NOT EXISTS "btree_gin";     -- composite GIN indexes

-- ---------- Enums ----------
-- Enums are used only for values that are truly closed sets in cricket.
-- Anything tournament-configurable lives in JSONB rule documents instead.

CREATE TYPE user_status        AS ENUM ('active', 'suspended', 'pending_verification', 'deleted');
CREATE TYPE org_member_status  AS ENUM ('invited', 'active', 'removed');

CREATE TYPE tournament_status  AS ENUM ('draft', 'published', 'in_progress', 'completed', 'archived', 'cancelled');
CREATE TYPE fixture_stage      AS ENUM ('group', 'league', 'quarter_final', 'semi_final', 'final', 'playoff', 'qualifier', 'eliminator', 'custom');

CREATE TYPE match_status       AS ENUM ('scheduled', 'toss', 'live', 'innings_break', 'rain_delay', 'stumps', 'completed', 'abandoned', 'no_result', 'forfeited', 'cancelled');
CREATE TYPE toss_decision      AS ENUM ('bat', 'bowl');
CREATE TYPE innings_status     AS ENUM ('not_started', 'in_progress', 'completed', 'declared', 'forfeited', 'abandoned');

CREATE TYPE extra_type         AS ENUM ('wide', 'no_ball', 'bye', 'leg_bye', 'penalty');
CREATE TYPE wicket_type        AS ENUM ('bowled', 'caught', 'caught_behind', 'caught_and_bowled', 'lbw', 'run_out', 'stumped', 'hit_wicket', 'retired_hurt', 'retired_out', 'obstructing_field', 'timed_out', 'hit_ball_twice', 'handled_ball');

CREATE TYPE batting_style      AS ENUM ('right_hand', 'left_hand');
CREATE TYPE bowling_style      AS ENUM ('right_arm_fast', 'right_arm_fast_medium', 'right_arm_medium', 'right_arm_off_break', 'right_arm_leg_break', 'left_arm_fast', 'left_arm_fast_medium', 'left_arm_medium', 'left_arm_orthodox', 'left_arm_chinaman', 'none');
CREATE TYPE player_role        AS ENUM ('batter', 'bowler', 'all_rounder', 'wicket_keeper', 'wicket_keeper_batter');

CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'expired');
CREATE TYPE payment_status      AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

CREATE TYPE page_status         AS ENUM ('draft', 'published', 'unpublished', 'archived');
CREATE TYPE notification_channel AS ENUM ('push', 'email', 'in_app');

-- ---------- Shared trigger: updated_at ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
