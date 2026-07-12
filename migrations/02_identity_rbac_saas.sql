-- ============================================================
-- Migration 02: Users, RBAC (dynamic roles + CRUD permissions),
--               Organizations (SaaS tenants), Subscriptions
-- ============================================================

-- ---------- Users ----------
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  phone           text,
  password_hash   text,                          -- null for social-login-only accounts
  full_name       text NOT NULL,
  avatar_url      text,
  status          user_status NOT NULL DEFAULT 'pending_verification',
  email_verified_at timestamptz,
  last_login_at   timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}',   -- locale, timezone, marketing consent…
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz                    -- soft delete; email freed via trigger in app layer
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh tokens (rotated, one row per device session)
CREATE TABLE auth_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,              -- sha256 of the opaque token
  device_name     text,
  ip_address      inet,
  user_agent      text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_auth_sessions_token ON auth_sessions (refresh_token_hash);

-- ---------- Organizations (SaaS tenant = cricket club / league operator) ----------
CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            citext NOT NULL UNIQUE,
  logo_url        text,
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  settings        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE TRIGGER trg_orgs_updated BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          org_member_status NOT NULL DEFAULT 'invited',
  invited_by      uuid REFERENCES users(id),
  joined_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

-- ---------- RBAC: dynamic roles, CRUD-level permissions, scoped grants ----------
-- Permission = resource + action, e.g. ('match', 'score'), ('tournament', 'update').
CREATE TABLE permissions (
  id              serial PRIMARY KEY,
  resource        text NOT NULL,                 -- 'tournament','match','scoring','commentary','news','cms','plan','user','stats'
  action          text NOT NULL,                 -- 'create','read','update','delete','score','publish','manage'
  description     text,
  UNIQUE (resource, action)
);

-- Roles: system roles are seeded and locked; org admins create custom roles.
CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = global system role
  name            text NOT NULL,
  slug            text NOT NULL,                 -- 'super_admin','tournament_admin','scorer','commentator','viewer'
  description     text,
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);
CREATE UNIQUE INDEX idx_roles_system_slug ON roles (slug) WHERE organization_id IS NULL;

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id   int  NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- A role grant can be global, org-wide, tournament-scoped, or match-scoped.
-- Match-scoped grants are how a scorer gets access to exactly one match.
CREATE TABLE user_role_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  tournament_id   uuid,                          -- FK added in migration 03 (table order)
  match_id        uuid,                          -- FK added in migration 04
  granted_by      uuid REFERENCES users(id),
  expires_at      timestamptz,                   -- temp scorer access auto-expires
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, organization_id, tournament_id, match_id)
);
CREATE INDEX idx_ura_user ON user_role_assignments (user_id);
CREATE INDEX idx_ura_scope ON user_role_assignments (tournament_id, match_id);

-- ---------- SaaS: plans, subscriptions, payment-ready ledger ----------
CREATE TABLE subscription_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            citext NOT NULL UNIQUE,        -- 'free','club','league','pro'
  name            text NOT NULL,
  description     text,
  price_cents     integer NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'USD',
  billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month','year','one_time')),
  duration_days   integer,                       -- for one_time plans
  trial_days      integer NOT NULL DEFAULT 0,
  -- Feature entitlements consumed by the access-control layer:
  -- {"max_tournaments":5,"max_teams":32,"live_scoring":true,"dls":true,
  --  "custom_branding":false,"api_access":false,"max_concurrent_matches":3,"video_highlights":false}
  features        jsonb NOT NULL DEFAULT '{}',
  is_active       boolean NOT NULL DEFAULT true,
  is_public       boolean NOT NULL DEFAULT true, -- hidden plans for enterprise deals
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_plans_updated BEFORE UPDATE ON subscription_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id         uuid NOT NULL REFERENCES subscription_plans(id),
  status          subscription_status NOT NULL DEFAULT 'trialing',
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at    timestamptz,
  -- Payment-gateway-ready placeholders (Stripe/Razorpay/etc. wired later):
  external_customer_id     text,
  external_subscription_id text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_subs_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- One live subscription per org
CREATE UNIQUE INDEX idx_subs_active_per_org ON subscriptions (organization_id)
  WHERE status IN ('trialing','active','past_due');
CREATE INDEX idx_subs_period_end ON subscriptions (current_period_end) WHERE status IN ('trialing','active');

CREATE TABLE payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  amount_cents    integer NOT NULL,
  currency        char(3) NOT NULL,
  status          payment_status NOT NULL DEFAULT 'pending',
  external_payment_id text,
  invoice_number  text UNIQUE,
  paid_at         timestamptz,
  raw_gateway_payload jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_sub ON payments (subscription_id);

-- ---------- Audit log (security-critical actions) ----------
CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  user_id         uuid REFERENCES users(id),
  organization_id uuid,
  action          text NOT NULL,                 -- 'match.score.correct','role.grant','plan.update'…
  entity_type     text,
  entity_id       uuid,
  changes         jsonb,
  ip_address      inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX idx_audit_user_time ON audit_logs (user_id, created_at DESC);
