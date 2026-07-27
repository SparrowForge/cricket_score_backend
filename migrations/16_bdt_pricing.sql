-- ============================================================
-- Migration 16: Update pricing to BDT
-- ============================================================

-- Update subscription plans to use BDT pricing
UPDATE subscription_plans
SET
  currency = 'BDT',
  price_cents = CASE
    WHEN slug = 'free' THEN 0
    WHEN slug = 'club' THEN 10000      -- 100 BDT
    WHEN slug = 'league' THEN 20000    -- 200 BDT
    WHEN slug = 'pro' THEN 50000       -- 500 BDT
    ELSE price_cents
  END,
  description = CASE
    WHEN slug = 'free' THEN 'For casual matches and trying the platform'
    WHEN slug = 'club' THEN 'Perfect for local cricket clubs'
    WHEN slug = 'league' THEN 'For serious league operators'
    WHEN slug = 'pro' THEN 'Unlimited everything + dedicated support'
    ELSE description
  END
WHERE slug IN ('free', 'club', 'league', 'pro');
