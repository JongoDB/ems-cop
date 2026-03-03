-- EMS-COP PostgreSQL Schema
-- Migration 011: Cross-Domain Findings Support
-- Depends on: 001_core_schema.sql (findings), 004_networks_and_findings.sql, 008_data_classification.sql
--
-- Adds origin tracking columns to findings for copy-on-transfer:
--   origin_finding_id — links an enriched/redacted copy to its source finding
--   origin_enclave    — which enclave the original finding came from
--   redacted_summary  — sanitized description safe for cross-domain transfer
--
-- Also adds a cti_finding_sync_state table to track sync watermarks.

BEGIN;

-- ════════════════════════════════════════════
--  FINDINGS: CROSS-DOMAIN ORIGIN TRACKING
-- ════════════════════════════════════════════

ALTER TABLE findings ADD COLUMN IF NOT EXISTS origin_finding_id UUID;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS origin_enclave TEXT
    CHECK (origin_enclave IN ('low', 'high'));
ALTER TABLE findings ADD COLUMN IF NOT EXISTS redacted_summary TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_findings_origin ON findings(origin_finding_id)
    WHERE origin_finding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_findings_origin_enclave ON findings(origin_enclave)
    WHERE origin_enclave IS NOT NULL;

-- Apply updated_at trigger (the function update_updated_at() is created in migration 001)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_findings_updated_at'
    ) THEN
        CREATE TRIGGER trg_findings_updated_at
            BEFORE UPDATE ON findings
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END$$;

-- ════════════════════════════════════════════
--  CTI FINDING SYNC STATE
-- ════════════════════════════════════════════
-- Tracks the last successful sync watermark per direction.

CREATE TABLE IF NOT EXISTS cti_finding_sync_state (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction       TEXT NOT NULL UNIQUE
                    CHECK (direction IN ('low_to_high', 'high_to_low')),
    last_sync_at    TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
    findings_synced INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default sync state entries
INSERT INTO cti_finding_sync_state (direction) VALUES ('low_to_high')
    ON CONFLICT (direction) DO NOTHING;
INSERT INTO cti_finding_sync_state (direction) VALUES ('high_to_low')
    ON CONFLICT (direction) DO NOTHING;

COMMIT;
