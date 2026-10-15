ALTER TABLE audits
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'configured';

CREATE INDEX IF NOT EXISTS idx_audits_status ON audits(status);
