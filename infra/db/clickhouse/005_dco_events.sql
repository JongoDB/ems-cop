-- EMS-COP ClickHouse Schema
-- Migration 005: DCO/SOC Event Tables
-- Depends on: init.sql (ems_audit database)
--
-- Adds tables for DCO alert analytics and IOC hit tracking:
--   dco_alerts          — normalized alert events for time-series analysis
--   dco_ioc_hits        — IOC match events for threat correlation
--
-- Materialized views for pre-aggregated dashboards:
--   dco_alert_stats_hourly  — hourly alert counts by source_system and severity
--   dco_ioc_hits_daily      — daily IOC hit counts by type and threat level

-- ════════════════════════════════════════════
--  DCO ALERTS
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ems_audit.dco_alerts
(
    id              UUID DEFAULT generateUUIDv4(),
    external_id     String DEFAULT '',
    source_system   LowCardinality(String),         -- 'splunk', 'elastic', 'crowdstrike', 'generic'
    severity        LowCardinality(String),         -- 'critical', 'high', 'medium', 'low', 'info'
    title           String DEFAULT '',
    mitre_techniques Array(String) DEFAULT [],
    ioc_values      Array(String) DEFAULT [],
    endpoint_id     Nullable(UUID),
    status          LowCardinality(String) DEFAULT 'new',
    classification  LowCardinality(String) DEFAULT 'UNCLASSIFIED',
    timestamp       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (source_system, severity, toDateTime(timestamp))
TTL toDateTime(timestamp) + INTERVAL 5 YEAR
SETTINGS index_granularity = 8192;

-- Secondary indexes for common query patterns
ALTER TABLE ems_audit.dco_alerts ADD INDEX idx_dco_alerts_status (status) TYPE set(10) GRANULARITY 4;
ALTER TABLE ems_audit.dco_alerts ADD INDEX idx_dco_alerts_endpoint (endpoint_id) TYPE minmax GRANULARITY 4;
ALTER TABLE ems_audit.dco_alerts ADD INDEX idx_dco_alerts_external (external_id) TYPE minmax GRANULARITY 4;

-- ════════════════════════════════════════════
--  DCO IOC HITS
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ems_audit.dco_ioc_hits
(
    id              UUID DEFAULT generateUUIDv4(),
    ioc_id          UUID,
    ioc_type        LowCardinality(String),         -- 'ip', 'domain', 'hash_md5', etc.
    ioc_value       String DEFAULT '',
    threat_level    LowCardinality(String) DEFAULT 'unknown',
    source_alert_id Nullable(UUID),
    matched_at      DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(matched_at)
ORDER BY (ioc_type, ioc_value, toDateTime(matched_at))
TTL toDateTime(matched_at) + INTERVAL 5 YEAR
SETTINGS index_granularity = 8192;

-- Secondary indexes
ALTER TABLE ems_audit.dco_ioc_hits ADD INDEX idx_ioc_hits_ioc_id (ioc_id) TYPE minmax GRANULARITY 4;
ALTER TABLE ems_audit.dco_ioc_hits ADD INDEX idx_ioc_hits_alert (source_alert_id) TYPE minmax GRANULARITY 4;

-- ════════════════════════════════════════════
--  DCO ALERT STATS HOURLY (Materialized View)
-- ════════════════════════════════════════════
-- Pre-aggregated hourly alert counts broken down by source_system and severity.
-- Used by DCO dashboards for alert volume trend analysis.

CREATE MATERIALIZED VIEW IF NOT EXISTS ems_audit.dco_alert_stats_hourly
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, source_system, severity)
AS SELECT
    toStartOfHour(timestamp) AS hour,
    source_system,
    severity,
    count() AS alert_count
FROM ems_audit.dco_alerts
GROUP BY hour, source_system, severity;

-- ════════════════════════════════════════════
--  DCO IOC HITS DAILY (Materialized View)
-- ════════════════════════════════════════════
-- Daily rollup of IOC hit counts by type and threat level.
-- Used by threat intelligence dashboards for IOC activity tracking.

CREATE MATERIALIZED VIEW IF NOT EXISTS ems_audit.dco_ioc_hits_daily
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (day, ioc_type, threat_level)
AS SELECT
    toDate(matched_at) AS day,
    ioc_type,
    threat_level,
    count() AS hit_count,
    uniq(ioc_id) AS unique_iocs
FROM ems_audit.dco_ioc_hits
GROUP BY day, ioc_type, threat_level;
