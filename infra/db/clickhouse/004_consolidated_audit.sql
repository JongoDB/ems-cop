-- EMS-COP ClickHouse Schema
-- Migration 004: Consolidated Audit Dashboard
-- Depends on: init.sql, 002_classification.sql, 003_cti_provenance.sql
--
-- Adds source_enclave tracking to audit events so the high-side enclave can
-- present a unified timeline of events from both enclaves. Events originating
-- on the local enclave are tagged with the ENCLAVE env var value (e.g. 'high'),
-- while events relayed via CTI from the low side are tagged 'low'.
--
-- Also creates materialized views for:
--   1. Hourly event counts by source_enclave and event_type (timeline charts)
--   2. Cross-enclave operation correlation (events grouped by operation_id)

-- ════════════════════════════════════════════
--  SOURCE ENCLAVE COLUMN
-- ════════════════════════════════════════════
-- Tracks which enclave originated each audit event.
-- Values: 'low', 'high', or 'local' (default for pre-migration events).

ALTER TABLE ems_audit.events ADD COLUMN IF NOT EXISTS source_enclave String DEFAULT 'local';

-- ════════════════════════════════════════════
--  CONSOLIDATED HOURLY MATERIALIZED VIEW
-- ════════════════════════════════════════════
-- Pre-aggregated hourly event counts broken down by source enclave and event type.
-- Used by the /api/v1/audit/consolidated/stats endpoint for timeline charts
-- showing event volume from each enclave over the last 24 hours.

CREATE MATERIALIZED VIEW IF NOT EXISTS ems_audit.consolidated_hourly_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, source_enclave, event_type)
AS SELECT
    toStartOfHour(timestamp) AS hour,
    source_enclave,
    event_type,
    count() AS event_count
FROM ems_audit.events
GROUP BY hour, source_enclave, event_type;

-- ════════════════════════════════════════════
--  CROSS-ENCLAVE OPERATION CORRELATION VIEW
-- ════════════════════════════════════════════
-- Pre-aggregated daily counts of events per operation per source enclave.
-- Used by the /api/v1/audit/consolidated/correlation endpoint to quickly
-- identify which operations have activity spanning both enclaves.

CREATE MATERIALIZED VIEW IF NOT EXISTS ems_audit.cross_enclave_ops_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (day, operation_id, source_enclave)
AS SELECT
    toDate(timestamp) AS day,
    coalesce(operation_id, toUUID('00000000-0000-0000-0000-000000000000')) AS operation_id,
    source_enclave,
    count() AS event_count,
    uniq(actor_id) AS unique_actors
FROM ems_audit.events
WHERE operation_id IS NOT NULL
GROUP BY day, operation_id, source_enclave;
