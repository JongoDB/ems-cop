-- EMS-COP ClickHouse Schema
-- Audit events and telemetry — append-only, hash-chained

CREATE DATABASE IF NOT EXISTS ems_audit;

-- ════════════════════════════════════════════
--  AUDIT EVENTS (Core — hash-chained)
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ems_audit.events
(
    id              UUID DEFAULT generateUUIDv4(),
    timestamp       DateTime64(3, 'UTC') DEFAULT now64(3),
    event_type      LowCardinality(String),    -- 'ticket.created', 'task.executed', 'role.modified', etc.
    actor_id        UUID,
    actor_username  String,
    actor_ip        String DEFAULT '',
    session_id      String DEFAULT '',

    resource_type   LowCardinality(String),    -- 'ticket', 'task', 'endpoint', 'role', 'workflow', etc.
    resource_id     UUID,
    operation_id    Nullable(UUID),            -- operation context if applicable

    action          LowCardinality(String),    -- 'create', 'read', 'update', 'delete', 'execute', 'approve', 'reject'
    details         String DEFAULT '{}',       -- JSON string with action-specific data

    before_state    String DEFAULT '',         -- JSON: entity state before mutation
    after_state     String DEFAULT '',         -- JSON: entity state after mutation

    command_input   String DEFAULT '',         -- for terminal/C2 sessions: exact command
    command_output  String DEFAULT '',         -- truncated output (full in MinIO)

    approval_ticket_id Nullable(UUID),         -- which ticket authorized this action

    hash            String DEFAULT '',         -- SHA-256(previous_hash + serialized event)
    previous_hash   String DEFAULT '',         -- hash chain for tamper evidence

    -- Denormalized for fast filtering without joins
    risk_level      UInt8 DEFAULT 0,
    ticket_number   String DEFAULT ''
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (event_type, actor_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 5 YEAR  -- default 5-year retention, configurable
SETTINGS index_granularity = 8192;

-- Secondary indexes for common query patterns
ALTER TABLE ems_audit.events ADD INDEX idx_resource (resource_type, resource_id) TYPE minmax GRANULARITY 4;
ALTER TABLE ems_audit.events ADD INDEX idx_operation (operation_id) TYPE minmax GRANULARITY 4;
ALTER TABLE ems_audit.events ADD INDEX idx_actor (actor_id) TYPE minmax GRANULARITY 4;
ALTER TABLE ems_audit.events ADD INDEX idx_action (action) TYPE set(100) GRANULARITY 4;

-- ════════════════════════════════════════════
--  C2 SESSION TELEMETRY
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ems_audit.c2_telemetry
(
    timestamp       DateTime64(3, 'UTC') DEFAULT now64(3),
    c2_provider     LowCardinality(String),    -- 'sliver', 'mythic', etc.
    implant_id      String,
    session_id      String,
    endpoint_id     UUID,
    event_type      LowCardinality(String),    -- 'checkin', 'task_sent', 'task_result', 'session_open', 'session_close'
    data            String DEFAULT '{}',       -- JSON payload
    operation_id    Nullable(UUID)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (c2_provider, implant_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 2 YEAR
SETTINGS index_granularity = 8192;

-- ════════════════════════════════════════════
--  ENDPOINT HEALTH TELEMETRY
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ems_audit.endpoint_health
(
    timestamp       DateTime64(3, 'UTC') DEFAULT now64(3),
    endpoint_id     UUID,
    hostname        String,
    status          LowCardinality(String),    -- 'online', 'offline', 'degraded'
    cpu_percent     Float32 DEFAULT 0,
    memory_percent  Float32 DEFAULT 0,
    disk_percent    Float32 DEFAULT 0,
    process_count   UInt32 DEFAULT 0,
    open_connections UInt32 DEFAULT 0,
    metadata        String DEFAULT '{}'        -- JSON: additional health metrics
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (endpoint_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;

-- ════════════════════════════════════════════
--  MATERIALIZED VIEWS (Pre-aggregated analytics)
-- ════════════════════════════════════════════

-- Daily command count per user per operation
CREATE MATERIALIZED VIEW IF NOT EXISTS ems_audit.daily_commands_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (day, actor_id, operation_id, event_type)
AS SELECT
    toDate(timestamp) AS day,
    actor_id,
    coalesce(operation_id, toUUID('00000000-0000-0000-0000-000000000000')) AS operation_id,
    event_type,
    count() AS command_count
FROM ems_audit.events
WHERE action = 'execute'
GROUP BY day, actor_id, operation_id, event_type;

-- Hourly approval turnaround metrics
CREATE MATERIALIZED VIEW IF NOT EXISTS ems_audit.approval_metrics_mv
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, action)
AS SELECT
    toStartOfHour(timestamp) AS hour,
    action,
    count() AS approval_count
FROM ems_audit.events
WHERE action IN ('approve', 'reject', 'kickback')
GROUP BY hour, action;
