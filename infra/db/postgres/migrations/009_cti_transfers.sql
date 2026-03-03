-- Migration 009: CTI transfer records table
-- Used by the CTI relay service to track cross-enclave transfers.
-- In dual-enclave deployments, this table exists on both postgres-low and postgres-high.

CREATE TABLE IF NOT EXISTS cti_transfers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    direction       VARCHAR(16) NOT NULL CHECK (direction IN ('low_to_high', 'high_to_low')),
    entity_type     VARCHAR(32) NOT NULL,
    entity_ids      TEXT[]      NOT NULL DEFAULT '{}',
    classification  VARCHAR(16) NOT NULL DEFAULT 'UNCLASS',
    status          VARCHAR(16) NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('accepted', 'queued', 'rejected', 'completed', 'failed')),
    reason          TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for listing transfers by status and date
CREATE INDEX IF NOT EXISTS idx_cti_transfers_status ON cti_transfers (status);
CREATE INDEX IF NOT EXISTS idx_cti_transfers_created_at ON cti_transfers (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cti_transfers_direction ON cti_transfers (direction);
