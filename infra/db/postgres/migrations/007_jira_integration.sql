-- ════════════════════════════════════════════
--  007: JIRA INTEGRATION TABLES
--  Bidirectional Jira sync: configs, mappings, logs
-- ════════════════════════════════════════════

-- Jira project/instance configurations (per-operation or global)
CREATE TABLE jira_configs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(128)    NOT NULL,
    base_url        VARCHAR(512)    NOT NULL,              -- e.g. https://myorg.atlassian.net
    auth            JSONB           NOT NULL DEFAULT '{}', -- { "type": "api_token", "email": "...", "token": "..." }
    project_key     VARCHAR(32)     NOT NULL,              -- e.g. OPS
    operation_id    UUID            REFERENCES operations(id) ON DELETE SET NULL,  -- NULL = global
    field_mappings  JSONB           NOT NULL DEFAULT '{}', -- status/priority mapping between systems
    sync_direction  VARCHAR(16)     NOT NULL DEFAULT 'both'
                    CHECK (sync_direction IN ('outbound', 'inbound', 'both')),
    webhook_secret  VARCHAR(256),
    is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
    created_by      UUID            REFERENCES users(id),
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jira_configs_operation ON jira_configs(operation_id);
CREATE INDEX idx_jira_configs_active    ON jira_configs(is_active);

-- Links EMS-COP tickets ↔ Jira issues
CREATE TABLE jira_sync_mappings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_id       UUID            NOT NULL REFERENCES jira_configs(id) ON DELETE CASCADE,
    ticket_id       UUID            NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    jira_issue_key  VARCHAR(64)     NOT NULL,              -- e.g. OPS-123
    jira_issue_id   VARCHAR(64),                           -- Jira's internal ID
    sync_status     VARCHAR(16)     NOT NULL DEFAULT 'synced'
                    CHECK (sync_status IN ('synced', 'pending', 'error', 'conflict')),
    last_synced_at  TIMESTAMPTZ,
    ems_version     INTEGER         NOT NULL DEFAULT 1,    -- optimistic lock for EMS side
    jira_version    INTEGER         NOT NULL DEFAULT 1,    -- optimistic lock for Jira side
    error_message   TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_jira_sync_ticket  ON jira_sync_mappings(ticket_id);
CREATE UNIQUE INDEX idx_jira_sync_issue   ON jira_sync_mappings(jira_issue_key);
CREATE INDEX idx_jira_sync_config         ON jira_sync_mappings(config_id);
CREATE INDEX idx_jira_sync_status         ON jira_sync_mappings(sync_status);

-- Audit trail for sync operations
CREATE TABLE jira_sync_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_id       UUID            REFERENCES jira_configs(id) ON DELETE SET NULL,
    mapping_id      UUID            REFERENCES jira_sync_mappings(id) ON DELETE SET NULL,
    direction       VARCHAR(8)      NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    action          VARCHAR(32)     NOT NULL,              -- create_issue, update_issue, transition, add_comment, etc.
    status          VARCHAR(16)     NOT NULL DEFAULT 'success'
                    CHECK (status IN ('success', 'error', 'skipped')),
    details         JSONB           DEFAULT '{}',
    error_message   TEXT,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jira_sync_log_config   ON jira_sync_log(config_id);
CREATE INDEX idx_jira_sync_log_mapping  ON jira_sync_log(mapping_id);
CREATE INDEX idx_jira_sync_log_created  ON jira_sync_log(created_at DESC);

-- Updated_at triggers
CREATE TRIGGER trg_jira_configs_updated_at
    BEFORE UPDATE ON jira_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_jira_sync_mappings_updated_at
    BEFORE UPDATE ON jira_sync_mappings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
