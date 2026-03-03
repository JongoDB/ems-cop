-- EMS-COP ClickHouse Schema
-- Migration 003: CTI Transfer Provenance
-- Depends on: init.sql (ems_audit database), 002_classification.sql
--
-- Tracks every data movement between security enclaves via NiFi.
-- Each row represents a NiFi provenance event — capturing the full lineage
-- of how data flows through processors, ports, and remote connections.
--
-- This table is the ClickHouse counterpart to the PostgreSQL cti_transfers
-- and transfer_approvals tables. While PG stores the approval workflow state,
-- ClickHouse stores the granular provenance trail for audit and analysis.
--
-- Populated by the provenance_export NiFi flow (or the CTI relay service)
-- which reads NiFi's provenance repository and batch-inserts here.

-- ════════════════════════════════════════════
--  CTI TRANSFER PROVENANCE
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ems_audit.cti_provenance
(
    id              UUID DEFAULT generateUUIDv4(),
    timestamp       DateTime64(3, 'UTC') DEFAULT now64(3),

    -- Transfer context
    transfer_id     UUID,                           -- links to cti_transfers in PostgreSQL
    flow_file_id    String DEFAULT '',              -- NiFi FlowFile UUID
    component_id    String DEFAULT '',              -- NiFi processor/port that handled this
    component_type  LowCardinality(String),         -- 'INPUT_PORT', 'PROCESSOR', 'OUTPUT_PORT', 'REMOTE_INPUT_PORT'
    component_name  String DEFAULT '',

    -- Event details
    event_type      LowCardinality(String),         -- 'RECEIVE', 'SEND', 'ROUTE', 'TRANSFORM', 'DROP', 'CLONE', 'CONTENT_MODIFIED'
    direction       LowCardinality(String),         -- 'low_to_high', 'high_to_low'

    -- Data classification
    classification  LowCardinality(String) DEFAULT 'UNCLASS',  -- UNCLASS, CUI, SECRET
    entity_type     LowCardinality(String) DEFAULT '',         -- 'ticket', 'finding', 'audit_event', 'telemetry', 'command'
    entity_id       String DEFAULT '',

    -- Content info
    content_size    UInt64 DEFAULT 0,               -- bytes
    content_hash    String DEFAULT '',              -- SHA-256 of content for integrity verification

    -- Policy evaluation
    policy_id       String DEFAULT '',              -- which classification_policy was applied
    policy_action   LowCardinality(String) DEFAULT '',  -- 'auto', 'queued', 'blocked'

    -- Actor (who initiated or approved the transfer)
    actor_id        Nullable(UUID),
    actor_username  String DEFAULT '',

    -- Lineage
    parent_ids      Array(String) DEFAULT [],       -- parent FlowFile IDs for lineage tracking

    -- Metadata
    attributes      String DEFAULT '{}'             -- JSON: NiFi FlowFile attributes
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (direction, classification, event_type, timestamp)
TTL toDateTime(timestamp) + INTERVAL 5 YEAR
SETTINGS index_granularity = 8192;

-- Secondary indexes for common query patterns
ALTER TABLE ems_audit.cti_provenance ADD INDEX idx_transfer (transfer_id) TYPE minmax GRANULARITY 4;
ALTER TABLE ems_audit.cti_provenance ADD INDEX idx_entity (entity_type, entity_id) TYPE minmax GRANULARITY 4;
ALTER TABLE ems_audit.cti_provenance ADD INDEX idx_classification (classification) TYPE set(10) GRANULARITY 4;
ALTER TABLE ems_audit.cti_provenance ADD INDEX idx_flow_file (flow_file_id) TYPE minmax GRANULARITY 4;

-- ════════════════════════════════════════════
--  CTI TRANSFER STATISTICS (Materialized View)
-- ════════════════════════════════════════════
-- Hourly rollup of transfer counts and byte volumes, broken down by
-- direction, classification, entity type, and policy action.
-- Only counts terminal events (SEND/RECEIVE) to avoid double-counting
-- intermediate processing steps.

CREATE MATERIALIZED VIEW IF NOT EXISTS ems_audit.cti_transfer_stats_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, direction, classification, entity_type, policy_action)
AS SELECT
    toStartOfHour(timestamp) AS hour,
    direction,
    classification,
    entity_type,
    policy_action,
    count() AS transfer_count,
    sum(content_size) AS total_bytes
FROM ems_audit.cti_provenance
WHERE event_type IN ('SEND', 'RECEIVE')
GROUP BY hour, direction, classification, entity_type, policy_action;

-- ════════════════════════════════════════════
--  CTI DAILY TRANSFER SUMMARY (Materialized View)
-- ════════════════════════════════════════════
-- Daily rollup for dashboard widgets and reporting.
-- Includes unique transfer count (approximated via uniq) alongside
-- raw event count and byte volume.

CREATE MATERIALIZED VIEW IF NOT EXISTS ems_audit.cti_daily_summary_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (day, direction, policy_action)
AS SELECT
    toDate(timestamp) AS day,
    direction,
    policy_action,
    count() AS transfer_count,
    uniq(transfer_id) AS unique_transfers,
    sum(content_size) AS total_bytes
FROM ems_audit.cti_provenance
WHERE event_type IN ('SEND', 'RECEIVE')
GROUP BY day, direction, policy_action;
