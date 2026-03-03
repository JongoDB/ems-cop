-- EMS-COP PostgreSQL Schema
-- Migration 010: CTI NiFi Integration — Transfer Approvals & Flow Management
-- Depends on: 009_cti_transfers.sql (cti_transfers table)
--
-- Adds tables to support the NiFi-based Cross-domain Transfer Infrastructure:
--
--   transfer_approvals  — Approval workflow for transfers that require human review
--                         (linked from classification_policies.requires_review = true)
--   nifi_flow_configs   — Tracks deployed NiFi process groups and their operational state
--   transfer_audit_log  — High-level audit trail for transfer lifecycle events
--                         (detailed provenance lives in ClickHouse ems_audit.cti_provenance)

BEGIN;

-- ════════════════════════════════════════════
--  TRANSFER APPROVALS
-- ════════════════════════════════════════════
-- When a classification policy requires review (e.g. CUI high→low), the CTI
-- relay service creates a transfer_approval row in 'pending' state. A reviewer
-- must approve or reject before the NiFi flow releases the data.
-- Pending approvals auto-expire after expires_at to prevent stale queues.

CREATE TABLE IF NOT EXISTS transfer_approvals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id     UUID NOT NULL REFERENCES cti_transfers(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    requested_by    UUID REFERENCES users(id),
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by     UUID REFERENCES users(id),
    reviewed_at     TIMESTAMPTZ,
    review_notes    TEXT NOT NULL DEFAULT '',
    classification  TEXT NOT NULL DEFAULT 'UNCLASS'
                    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET')),
    risk_level      INTEGER DEFAULT 0,
    expires_at      TIMESTAMPTZ,                     -- auto-expire pending approvals after N hours
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_approvals_status ON transfer_approvals(status);
CREATE INDEX IF NOT EXISTS idx_transfer_approvals_transfer ON transfer_approvals(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_approvals_requested_by ON transfer_approvals(requested_by);
CREATE INDEX IF NOT EXISTS idx_transfer_approvals_classification ON transfer_approvals(classification);

-- ════════════════════════════════════════════
--  NIFI FLOW CONFIGURATIONS
-- ════════════════════════════════════════════
-- Each row represents a NiFi process group that EMS-COP manages.
-- The CTI relay service uses this table to track which flows are deployed,
-- their operational status, and flow-specific configuration.

CREATE TABLE IF NOT EXISTS nifi_flow_configs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    flow_type               TEXT NOT NULL
                            CHECK (flow_type IN ('telemetry_relay', 'command_relay', 'transfer', 'provenance_export', 'custom')),
    nifi_process_group_id   TEXT NOT NULL DEFAULT '',   -- NiFi PG ID once deployed
    direction               TEXT CHECK (direction IN ('low_to_high', 'high_to_low', 'bidirectional')),
    enabled                 BOOLEAN NOT NULL DEFAULT true,
    status                  TEXT NOT NULL DEFAULT 'stopped'
                            CHECK (status IN ('running', 'stopped', 'disabled', 'error')),
    config                  JSONB NOT NULL DEFAULT '{}',  -- flow-specific configuration
    last_sync_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nifi_flow_configs_type ON nifi_flow_configs(flow_type);
CREATE INDEX IF NOT EXISTS idx_nifi_flow_configs_status ON nifi_flow_configs(status);

-- ════════════════════════════════════════════
--  TRANSFER AUDIT LOG
-- ════════════════════════════════════════════
-- High-level audit trail for transfer lifecycle events.
-- For granular NiFi provenance (every processor hop), see ClickHouse
-- ems_audit.cti_provenance. This table captures human-meaningful events:
-- requested, approved, rejected, executed, failed, expired.

CREATE TABLE IF NOT EXISTS transfer_audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transfer_id     UUID REFERENCES cti_transfers(id) ON DELETE SET NULL,
    approval_id     UUID REFERENCES transfer_approvals(id) ON DELETE SET NULL,
    event_type      TEXT NOT NULL,                   -- 'requested', 'approved', 'rejected', 'executed', 'failed', 'expired'
    actor_id        UUID REFERENCES users(id),
    actor_username  TEXT NOT NULL DEFAULT '',
    details         JSONB NOT NULL DEFAULT '{}',     -- event-specific details (error message, policy info, etc.)
    classification  TEXT NOT NULL DEFAULT 'UNCLASS'
                    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_audit_log_transfer ON transfer_audit_log(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_audit_log_approval ON transfer_audit_log(approval_id);
CREATE INDEX IF NOT EXISTS idx_transfer_audit_log_type ON transfer_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_transfer_audit_log_actor ON transfer_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_transfer_audit_log_created ON transfer_audit_log(created_at DESC);

-- ════════════════════════════════════════════
--  TRIGGERS
-- ════════════════════════════════════════════
-- Reuse the update_updated_at() function from 001_core_schema.sql

CREATE TRIGGER trg_transfer_approvals_updated_at
    BEFORE UPDATE ON transfer_approvals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_nifi_flow_configs_updated_at
    BEFORE UPDATE ON nifi_flow_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════
--  SEED: Default NiFi Flow Configurations
-- ════════════════════════════════════════════
-- Pre-populate the four core NiFi flows that EMS-COP ships with.
-- All start in 'stopped' state — operator must explicitly start them
-- after verifying NiFi connectivity and enclave network topology.

INSERT INTO nifi_flow_configs (name, description, flow_type, direction, enabled, status, config) VALUES
    (
        'Telemetry Relay',
        'Streams audit events and endpoint telemetry from low to high side',
        'telemetry_relay',
        'low_to_high',
        true,
        'stopped',
        '{"topics": ["audit.*", "endpoint.*", "c2.*"], "batch_size": 100, "interval_ms": 1000}'
    ),
    (
        'Command Relay',
        'Relays approved C2 commands from high to low side',
        'command_relay',
        'high_to_low',
        true,
        'stopped',
        '{"max_risk_level": 3, "require_approval_above": 2}'
    ),
    (
        'Provenance Export',
        'Exports NiFi provenance records to ClickHouse',
        'provenance_export',
        'bidirectional',
        true,
        'stopped',
        '{"clickhouse_table": "ems_audit.cti_provenance", "batch_size": 500, "flush_interval_ms": 5000}'
    ),
    (
        'Finding Transfer',
        'Transfers sanitized findings between enclaves',
        'transfer',
        'bidirectional',
        true,
        'stopped',
        '{"auto_classifications": ["UNCLASS"], "queue_classifications": ["CUI"], "block_classifications": ["SECRET"]}'
    )
ON CONFLICT DO NOTHING;

COMMIT;
