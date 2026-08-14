-- ============================================================
-- Migration 22: Schedule requests on the contact form
-- ============================================================
-- The public contact form now asks what the enquiry is about and, for a
-- schedule request, for a phone number and the dates they want to play. Both
-- were previously lost in the free-text message (or not asked at all).

ALTER TABLE contact_submissions
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS preferred_date text;

-- `kind` drives the subject line and lets the admin list separate a schedule
-- request from a general message. The old two values stay valid.
ALTER TABLE contact_submissions
  DROP CONSTRAINT IF EXISTS contact_submissions_kind_check;
ALTER TABLE contact_submissions
  ADD CONSTRAINT contact_submissions_kind_check
  CHECK (kind IN ('contact', 'demo_request', 'schedule_request', 'pricing', 'support'));
