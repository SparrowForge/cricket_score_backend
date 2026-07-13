-- ============================================================
-- Migration 11: Google OAuth login
-- Stores the Google account's stable subject id so a user can sign in
-- with Google and be matched/linked to their existing account by email.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;
