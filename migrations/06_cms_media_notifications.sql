-- ============================================================
-- Migration 06: CMS (marketing site), news, media assets,
--               notifications & devices
-- ============================================================

-- ---------- CMS: block-based pages ----------
CREATE TABLE cms_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            citext NOT NULL UNIQUE,        -- 'home','features','pricing','demo','contact'
  title           text NOT NULL,
  status          page_status NOT NULL DEFAULT 'draft',
  -- Ordered block document rendered by the Next.js block renderer:
  -- [{"id":"blk_1","type":"hero","props":{"heading":"…","cta":{"label":"…","href":"…"},"image":"…"}},
  --  {"id":"blk_2","type":"feature_grid","props":{"columns":3,"items":[…]}},
  --  {"id":"blk_3","type":"pricing_table","props":{"plan_slugs":["free","club","league"]}},
  --  {"id":"blk_4","type":"faq","props":{"items":[…]}}]
  blocks          jsonb NOT NULL DEFAULT '[]',
  seo             jsonb NOT NULL DEFAULT '{}',   -- {"title":…,"description":…,"og_image":…}
  published_at    timestamptz,
  published_by    uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_cms_pages_updated BEFORE UPDATE ON cms_pages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every publish snapshots the page; rollback = re-publish an old revision.
CREATE TABLE cms_page_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         uuid NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  title           text NOT NULL,
  blocks          jsonb NOT NULL,
  seo             jsonb NOT NULL,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, revision_number)
);

-- Global site settings + feature toggles (key-value, cached in Redis)
CREATE TABLE site_settings (
  key             text PRIMARY KEY,              -- 'site.name','site.logo','nav.items','footer.links','feature.signup_enabled'
  value           jsonb NOT NULL,
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Contact/demo form submissions
CREATE TABLE contact_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL DEFAULT 'contact' CHECK (kind IN ('contact','demo_request')),
  name            text NOT NULL,
  email           citext NOT NULL,
  organization    text,
  message         text,
  handled_at      timestamptz,
  handled_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- Media assets (S3-backed) ----------
CREATE TABLE media_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  uploader_id     uuid REFERENCES users(id),
  kind            text NOT NULL CHECK (kind IN ('image','video','document')),
  storage_key     text NOT NULL,                 -- S3 object key
  cdn_url         text NOT NULL,
  mime_type       text NOT NULL,
  size_bytes      bigint NOT NULL,
  width           integer,
  height          integer,
  duration_seconds numeric(8,2),                 -- future: video highlights
  alt_text        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_org ON media_assets (organization_id, created_at DESC);

-- ---------- News ----------
CREATE TABLE news_articles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = platform-wide news
  tournament_id   uuid REFERENCES tournaments(id) ON DELETE SET NULL,
  match_id        uuid REFERENCES matches(id) ON DELETE SET NULL,
  author_id       uuid NOT NULL REFERENCES users(id),
  title           text NOT NULL,
  slug            citext NOT NULL UNIQUE,
  excerpt         text,
  body            jsonb NOT NULL,                -- rich-text block document (portable across web/mobile)
  cover_asset_id  uuid REFERENCES media_assets(id),
  tags            text[] NOT NULL DEFAULT '{}',
  status          page_status NOT NULL DEFAULT 'draft',
  is_auto_generated boolean NOT NULL DEFAULT false, -- AI match reports
  published_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_news_updated BEFORE UPDATE ON news_articles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_news_published ON news_articles (published_at DESC) WHERE status = 'published';
CREATE INDEX idx_news_tags ON news_articles USING gin (tags);

-- ---------- Devices & notifications ----------
CREATE TABLE user_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        text NOT NULL CHECK (platform IN ('ios','android','web')),
  push_token      text NOT NULL,                 -- FCM/APNs token
  app_version     text,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, push_token)
);

-- What a user follows → drives fan-out targeting
CREATE TABLE user_follows (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type     text NOT NULL CHECK (entity_type IN ('team','tournament','match','player')),
  entity_id       uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entity_type, entity_id)
);
CREATE INDEX idx_follows_entity ON user_follows (entity_type, entity_id);

CREATE TABLE notification_preferences (
  user_id         uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- {"wickets":{"push":true,"email":false},"match_start":{"push":true},
  --  "innings_end":{"push":true},"result":{"push":true,"email":true},
  --  "news":{"push":false,"email":true},"milestones":{"push":true}}
  preferences     jsonb NOT NULL DEFAULT '{}',
  quiet_hours     jsonb,                         -- {"from":"22:00","to":"07:00","tz":"Asia/Dhaka"}
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel         notification_channel NOT NULL,
  event_type      text NOT NULL,                 -- 'match.wicket','match.result','news.published'…
  title           text NOT NULL,
  body            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}',   -- deep-link payload {"match_id":…}
  sent_at         timestamptz,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_inbox ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
