CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(128) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'execution_status') THEN
    CREATE TYPE execution_status AS ENUM ('ready', 'queued', 'running', 'paused', 'completed', 'failed', 'timeout');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_status') THEN
    CREATE TYPE event_status AS ENUM ('observed', 'ignored', 'flagged');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'warning_type') THEN
    CREATE TYPE warning_type AS ENUM ('captcha', 'cookie_blocked', 'adblocker', 'csp', 'spa_router', 'field_ignored');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS audits (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  objective TEXT NOT NULL,
  urls JSONB NOT NULL,
  template_id UUID,
  config_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS executions (
  id UUID PRIMARY KEY,
  audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status execution_status NOT NULL DEFAULT 'ready',
  platform VARCHAR(64) NOT NULL DEFAULT 'web',
  environment VARCHAR(64) NOT NULL DEFAULT 'local',
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  config_snapshot JSONB NOT NULL,
  pause_checkpoint JSONB,
  results JSONB,
  ignored_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (audit_id, version)
);

CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  data JSONB NOT NULL,
  parent_template_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255) NOT NULL,
  archived_at TIMESTAMPTZ,
  UNIQUE (name, version),
  CONSTRAINT fk_templates_parent
    FOREIGN KEY (parent_template_id) REFERENCES templates(id) ON DELETE SET NULL
);

ALTER TABLE audits
  ADD CONSTRAINT fk_audits_template
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS actions (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  action_type VARCHAR(64) NOT NULL,
  target_selector TEXT,
  state_before TEXT,
  state_after TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (execution_id, sequence)
);

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL,
  action_id UUID REFERENCES actions(id) ON DELETE SET NULL,
  event_type VARCHAR(128) NOT NULL,
  technology VARCHAR(64) NOT NULL,
  url TEXT NOT NULL,
  state_name TEXT,
  event_name VARCHAR(255),
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent_state VARCHAR(32) NOT NULL DEFAULT 'unknown',
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status event_status NOT NULL DEFAULT 'observed',
  correlation_confidence VARCHAR(16) NOT NULL DEFAULT 'low',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS warnings (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  type warning_type NOT NULL,
  message TEXT NOT NULL,
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 1)
);
