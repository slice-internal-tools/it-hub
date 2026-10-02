-- Postgres full-text search only. No vector embeddings, no external APIs.
-- Migration-safe: ALTERs are idempotent so this can be re-run on existing DBs.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS guides (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT,
  body TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  source_type TEXT NOT NULL DEFAULT 'guide',
  metadata JSONB DEFAULT '{}'::jsonb,
  last_verified_at TIMESTAMPTZ,
  helpful_count INT DEFAULT 0,
  unhelpful_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE guides ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'guide';
ALTER TABLE guides ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS helpful_count INT DEFAULT 0;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS unhelpful_count INT DEFAULT 0;
ALTER TABLE guides ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- Partial index makes "active guides" queries trivial — most rows have deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS guides_active_idx ON guides (updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS guides_trash_idx ON guides (deleted_at DESC) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS guide_chunks (
  id SERIAL PRIMARY KEY,
  guide_id INT REFERENCES guides(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  tsv tsvector
);

-- Drop the legacy vector column if it's still around
ALTER TABLE guide_chunks DROP COLUMN IF EXISTS embedding;

-- Add the tsvector column if missing, populate it from existing content,
-- then keep it in sync via a trigger so writers don't have to think about it.
ALTER TABLE guide_chunks ADD COLUMN IF NOT EXISTS tsv tsvector;

CREATE OR REPLACE FUNCTION guide_chunks_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector('english', coalesce(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guide_chunks_tsv_trigger ON guide_chunks;
CREATE TRIGGER guide_chunks_tsv_trigger
  BEFORE INSERT OR UPDATE OF content ON guide_chunks
  FOR EACH ROW EXECUTE FUNCTION guide_chunks_tsv_update();

UPDATE guide_chunks SET tsv = to_tsvector('english', content) WHERE tsv IS NULL;

CREATE INDEX IF NOT EXISTS guide_chunks_tsv_idx ON guide_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS guide_chunks_guide_id_idx ON guide_chunks (guide_id);

CREATE TABLE IF NOT EXISTS chat_logs (
  id SERIAL PRIMARY KEY,
  query TEXT NOT NULL,
  answer TEXT,
  retrieved_chunk_ids INT[] DEFAULT '{}',
  citations JSONB DEFAULT '[]'::jsonb,
  mode TEXT NOT NULL DEFAULT 'retrieval',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_logs_created_at_idx ON chat_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS chat_feedback (
  id SERIAL PRIMARY KEY,
  chat_log_id INT REFERENCES chat_logs(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_feedback_chat_log_id_idx ON chat_feedback (chat_log_id);

-- ── Status platform ────────────────────────────────────────────────────────
-- Replaces the old localStorage-based mock + StatusGator integration.
-- Service catalog lives in `status_services`, grouped via `status_groups`.
-- Each `status_checks` row is one poll result; the public page renders a
-- 10-day history window and we retain 30 days of samples (see pruneOldChecks).
-- Incidents have a header row + a timeline of updates.

CREATE TABLE IF NOT EXISTS status_groups (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS status_services (
  id SERIAL PRIMARY KEY,
  group_id INT REFERENCES status_groups(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  vendor TEXT,
  domain TEXT,
  icon_url TEXT,
  -- 'manual' = IT toggles state, 'probe' = HTTP poll, 'statuspage' = vendor's
  -- statuspage.io summary.json (Cloudflare/GitHub/Slack/Zoom/Figma all use it).
  source TEXT NOT NULL DEFAULT 'manual',
  source_url TEXT,
  -- Effective state — written by pollers (or by admin when source='manual').
  state TEXT NOT NULL DEFAULT 'operational' CHECK (state IN ('operational','degraded','down')),
  state_note TEXT,
  response_ms INT,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Per-service extras (added after the table shipped — keep idempotent) ──────
-- `source` is intentionally a free-text column (no CHECK) so new poll sources
-- like 'rss', 'page', and 'webhook' don't need a migration to be accepted.
-- links     — admin-curated reference links shown on /status (status page, RSS,
--             help center, etc.): JSON array of { label, url, kind }.
-- webhook_token — unguessable secret embedded in this service's inbound webhook
--             URL. The vendor's Statuspage POSTs incident/component events to
--             /api/status/webhook/<token>; the token IS the auth (Statuspage
--             webhooks aren't signed), so it must stay secret. NULLs are
--             distinct in a UNIQUE index, so most rows leaving it NULL is fine.
-- webhook_last_at — last time we received a valid inbound webhook for this row.
ALTER TABLE status_services ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE status_services ADD COLUMN IF NOT EXISTS webhook_token TEXT;
ALTER TABLE status_services ADD COLUMN IF NOT EXISTS webhook_last_at TIMESTAMPTZ;
-- Optional scope filter for broad/aggregate feeds (e.g. AWS all.rss): a
-- comma-separated list of terms; only feed entries mentioning one of them are
-- considered, so an incident in a region you don't use never fires. NULL/empty
-- = no filter (consider everything).
ALTER TABLE status_services ADD COLUMN IF NOT EXISTS match_filter TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS status_services_webhook_token_idx
  ON status_services (webhook_token) WHERE webhook_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS status_services_group_idx ON status_services (group_id, position);

CREATE TABLE IF NOT EXISTS status_checks (
  id BIGSERIAL PRIMARY KEY,
  service_id INT REFERENCES status_services(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('operational','degraded','down')),
  response_ms INT,
  http_status INT,
  error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS status_checks_service_time_idx ON status_checks (service_id, checked_at DESC);
-- Time-leading index for the window scans in fetchStatusPayload (10-day history
-- + uptime roll-ups) and the retention prune.
CREATE INDEX IF NOT EXISTS status_checks_time_idx ON status_checks (checked_at);

CREATE TABLE IF NOT EXISTS status_incidents (
  id SERIAL PRIMARY KEY,
  service_id INT REFERENCES status_services(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','major','critical')),
  state TEXT NOT NULL DEFAULT 'investigating'
    CHECK (state IN ('investigating','identified','monitoring','resolved')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  -- true when the poller opened this incident automatically; only auto rows are
  -- auto-resolved on recovery, so admin-authored incidents are never touched.
  auto_created BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- Idempotent add for databases created before auto_created existed.
ALTER TABLE status_incidents ADD COLUMN IF NOT EXISTS auto_created BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS status_incidents_open_idx
  ON status_incidents (started_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS status_incidents_recent_idx
  ON status_incidents (resolved_at DESC) WHERE resolved_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS status_incident_updates (
  id SERIAL PRIMARY KEY,
  incident_id INT REFERENCES status_incidents(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS status_incident_updates_incident_idx
  ON status_incident_updates (incident_id, created_at);

-- ── Slack notifications ─────────────────────────────────────────────────────
-- Small key/value bag for status settings (the Slack bot token + event toggles).
-- The token can also come from the SLACK_BOT_TOKEN env var, which takes
-- precedence; this row is the admin-set fallback.
CREATE TABLE IF NOT EXISTS status_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Channels the Hub can post to. channel_id is the Slack channel id (C0…/G0…)
-- or a #name the bot can resolve. is_global channels receive every alert.
CREATE TABLE IF NOT EXISTS status_slack_channels (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  is_global BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Which channels a given service's alerts route to (in addition to globals).
CREATE TABLE IF NOT EXISTS status_service_channels (
  service_id INT REFERENCES status_services(id) ON DELETE CASCADE,
  channel_id INT REFERENCES status_slack_channels(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, channel_id)
);
CREATE INDEX IF NOT EXISTS status_service_channels_svc_idx ON status_service_channels (service_id);

-- ── Portal notifications (server-side, per user) ────────────────────────────
-- Read state used to live in the browser's localStorage. The portal runs in a
-- cross-origin iframe inside the hub, where browsers partition (Chrome) or
-- wipe (Safari, Firefox strict) that storage — so "Mark all as read" was
-- forgotten on the next login and every notification came back. It is kept
-- here instead, keyed by the hub user id, so it holds across logins, devices
-- and browsers.
--
-- portal_ticket_state is the last state we showed each user for each of their
-- tickets. Notifications are generated by diffing the ticket module's current
-- state against it, so only REAL changes notify (a status, approval or
-- priority change, or a new public reply from someone else) — not every bump
-- to updated_at, which the module's automations also make.
CREATE TABLE IF NOT EXISTS portal_ticket_state (
  user_id          TEXT NOT NULL,
  ticket_id        TEXT NOT NULL,
  status           TEXT,
  approval_status  TEXT,
  priority         TEXT,
  ticket_updated_at TIMESTAMPTZ,
  comments_seen_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, ticket_id)
);

-- One row per user once their ticket state has been recorded for the first
-- time. The first sync records everything silently (nothing is "new" to a
-- user we've never tracked) and only later syncs produce notifications.
CREATE TABLE IF NOT EXISTS portal_notification_users (
  user_id    TEXT PRIMARY KEY,
  seeded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portal_notifications (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  ticket_id     TEXT NOT NULL,
  ticket_number TEXT,
  subject       TEXT,
  kind          TEXT NOT NULL,          -- reply | status | approval | priority | created
  actor_name    TEXT,
  excerpt       TEXT,
  old_value     TEXT,
  new_value     TEXT,
  dedupe_key    TEXT NOT NULL,
  event_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at       TIMESTAMPTZ,
  dismissed_at  TIMESTAMPTZ,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS portal_notifications_user_idx
  ON portal_notifications (user_id, event_at DESC) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS portal_notifications_unread_idx
  ON portal_notifications (user_id, ticket_id) WHERE read_at IS NULL AND dismissed_at IS NULL;
