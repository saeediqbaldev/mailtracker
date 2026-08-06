const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject TEXT NOT NULL DEFAULT '',
  recipients TEXT[] NOT NULL DEFAULT '{}',
  sender TEXT,
  sender_ip TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'sent', -- sent | opened | clicked
  open_count INT NOT NULL DEFAULT 0,
  click_count INT NOT NULL DEFAULT 0,
  first_opened_at TIMESTAMPTZ,
  last_opened_at TIMESTAMPTZ
);

-- Columns added after the initial release — safe to re-run on an existing DB.
ALTER TABLE emails ADD COLUMN IF NOT EXISTS sender_ip TEXT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

-- Which mail client the email was composed/sent from. Defaults every
-- existing row (and every request from an extension build that predates
-- Gmail support and never sends this field) to 'zoho', so nothing that
-- already exists gets miscategorized or hidden when the Gmail tab ships.
-- (Validated in the API layer, not a CHECK constraint, so this ALTER is
-- safe to re-run every boot without an "already exists" error.)
ALTER TABLE emails ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'zoho';
CREATE INDEX IF NOT EXISTS idx_emails_provider ON emails(provider);

CREATE TABLE IF NOT EXISTS opens (
  id BIGSERIAL PRIMARY KEY,
  email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS clicks (
  id BIGSERIAL PRIMARY KEY,
  email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_opens_email_id ON opens(email_id);
CREATE INDEX IF NOT EXISTS idx_clicks_email_id ON clicks(email_id);
CREATE INDEX IF NOT EXISTS idx_emails_created_at ON emails(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_opens_opened_at ON opens(opened_at);
CREATE INDEX IF NOT EXISTS idx_clicks_clicked_at ON clicks(clicked_at);

-- One row per event that should surface in the Notifications page: the
-- first genuine open of an email, and every link click.
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  email_id UUID NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'open' | 'click'
  url TEXT,
  message TEXT NOT NULL DEFAULT '',
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email_sent BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_email_id ON notifications(email_id);

-- Single-row table of dashboard-editable settings (auto-refresh interval,
-- notification preferences). id is pinned to 1 so there is always exactly
-- one row to read/update.
CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1,
  refresh_interval_seconds INT NOT NULL DEFAULT 15,
  notify_email_enabled BOOLEAN NOT NULL DEFAULT false,
  notify_email_to TEXT,
  CONSTRAINT settings_singleton CHECK (id = 1)
);

INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- SMTP creds, editable from the dashboard Settings page instead of only
-- via .env. When set, these take priority over the SMTP_* env vars.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_host TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_port INT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_user TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_pass TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_from TEXT;
`;

async function initDb() {
  await pool.query(SCHEMA);
}

module.exports = { pool, initDb };
