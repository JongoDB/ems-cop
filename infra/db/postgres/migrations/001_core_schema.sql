-- EMS-COP PostgreSQL Schema
-- Migration 001: Core tables
-- All UUIDs use gen_random_uuid() (PG 13+)

-- ════════════════════════════════════════════
--  EXTENSIONS
-- ════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- trigram fuzzy search

-- ════════════════════════════════════════════
--  IDENTITY & ACCESS
-- ════════════════════════════════════════════

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(64)  NOT NULL UNIQUE,
    display_name    VARCHAR(128) NOT NULL,
    email           VARCHAR(256) NOT NULL UNIQUE,
    password_hash   TEXT,                          -- NULL if OIDC/SAML only
    auth_provider   VARCHAR(16)  NOT NULL DEFAULT 'local'
                    CHECK (auth_provider IN ('local', 'oidc', 'saml')),
    status          VARCHAR(16)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'disabled', 'locked')),
    mfa_enabled     BOOLEAN      NOT NULL DEFAULT FALSE,
    avatar_url      TEXT,
    preferences     JSONB        NOT NULL DEFAULT '{}',  -- UI prefs, notification prefs
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(64)  NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    permissions     JSONB        NOT NULL DEFAULT '[]',
    -- permissions: [{ "resource": "ticket", "actions": ["create","read"], "conditions": {} }]
    scope           VARCHAR(16)  NOT NULL DEFAULT 'global'
                    CHECK (scope IN ('global', 'operation', 'team')),
    is_system       BOOLEAN      NOT NULL DEFAULT FALSE,  -- built-in roles can't be deleted
    created_by      UUID         REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(name, scope)
);

CREATE TABLE role_bindings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         UUID         NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    scope_type      VARCHAR(16)  NOT NULL DEFAULT 'global'
                    CHECK (scope_type IN ('global', 'operation', 'team')),
    scope_id        UUID,           -- NULL for global scope; operation or team ID otherwise
    granted_by      UUID         REFERENCES users(id),
    granted_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,
    UNIQUE(user_id, role_id, scope_type, scope_id)
);

CREATE INDEX idx_role_bindings_user   ON role_bindings(user_id);
CREATE INDEX idx_role_bindings_scope  ON role_bindings(scope_type, scope_id);

-- ════════════════════════════════════════════
--  TEAMS (optional organizational grouping)
-- ════════════════════════════════════════════

CREATE TABLE teams (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(128) NOT NULL UNIQUE,
    description     TEXT         NOT NULL DEFAULT '',
    created_by      UUID         REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE team_members (
    team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

-- ════════════════════════════════════════════
--  WORKFLOWS & APPROVAL CHAINS
-- ════════════════════════════════════════════

CREATE TABLE workflows (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(128) NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    version         INTEGER      NOT NULL DEFAULT 1,
    is_template     BOOLEAN      NOT NULL DEFAULT FALSE,
    is_default      BOOLEAN      NOT NULL DEFAULT FALSE,  -- default workflow for new operations
    created_by      UUID         REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE workflow_stages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID         NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    name            VARCHAR(128) NOT NULL,
    stage_order     INTEGER      NOT NULL,  -- linear ordering (default execution path)
    stage_type      VARCHAR(16)  NOT NULL
                    CHECK (stage_type IN ('action', 'approval', 'notification', 'condition', 'timer', 'terminal')),
    config          JSONB        NOT NULL DEFAULT '{}',
    -- approval config: { "required_role": "mission_commander", "min_approvals": 1,
    --                     "approval_mode": "any", "auto_approve_conditions": {...},
    --                     "escalation_timeout_minutes": 60, "escalation_target_role": "supervisor" }
    -- condition config: { "expression": "risk_level > 3", "true_stage_id": "...", "false_stage_id": "..." }
    -- timer config: { "duration_minutes": 30, "timeout_action": "escalate" | "auto_approve" | "reject" }
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(workflow_id, stage_order)
);

CREATE TABLE workflow_transitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID         NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    from_stage_id   UUID         NOT NULL REFERENCES workflow_stages(id) ON DELETE CASCADE,
    to_stage_id     UUID         NOT NULL REFERENCES workflow_stages(id) ON DELETE CASCADE,
    trigger         VARCHAR(32)  NOT NULL
                    CHECK (trigger IN ('on_approve', 'on_reject', 'on_complete', 'on_condition_true',
                                       'on_condition_false', 'on_timeout', 'on_escalate', 'on_kickback')),
    condition_expr  TEXT,           -- optional expression evaluated at runtime
    label           VARCHAR(64),   -- human-readable label for UI display
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transitions_from ON workflow_transitions(from_stage_id);
CREATE INDEX idx_transitions_workflow ON workflow_transitions(workflow_id);

-- Workflow run instance (one per ticket flowing through a workflow)
CREATE TABLE workflow_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID         NOT NULL REFERENCES workflows(id),
    ticket_id       UUID,           -- set after ticket creation (circular dep resolved at app layer)
    current_stage_id UUID         REFERENCES workflow_stages(id),
    status          VARCHAR(16)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'completed', 'aborted')),
    context         JSONB        NOT NULL DEFAULT '{}',  -- runtime variables for condition evaluation
    started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE TABLE workflow_run_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID         NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    stage_id        UUID         NOT NULL REFERENCES workflow_stages(id),
    action          VARCHAR(32)  NOT NULL,  -- 'entered', 'approved', 'rejected', 'kickback', 'escalated', 'timed_out'
    actor_id        UUID         REFERENCES users(id),
    comment         TEXT,
    metadata        JSONB        NOT NULL DEFAULT '{}',
    occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_run_history_run ON workflow_run_history(run_id, occurred_at);

-- ════════════════════════════════════════════
--  OPERATIONS
-- ════════════════════════════════════════════

CREATE TABLE operations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(256) NOT NULL,
    objective       TEXT         NOT NULL,
    scope_description TEXT       NOT NULL DEFAULT '',
    rules_of_engagement TEXT     NOT NULL DEFAULT '',
    risk_level      SMALLINT     NOT NULL DEFAULT 3 CHECK (risk_level BETWEEN 1 AND 5),
    status          VARCHAR(24)  NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'pending_approval', 'approved', 'in_progress',
                                      'paused', 'completed', 'aborted')),
    workflow_id     UUID         REFERENCES workflows(id),
    planned_start   TIMESTAMPTZ,
    planned_end     TIMESTAMPTZ,
    actual_start    TIMESTAMPTZ,
    actual_end      TIMESTAMPTZ,
    tags            TEXT[]       NOT NULL DEFAULT '{}',
    metadata        JSONB        NOT NULL DEFAULT '{}',
    created_by      UUID         NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- NOTE: operation_endpoint_groups moved below endpoint_groups to resolve FK ordering

CREATE TABLE phases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id    UUID         NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    name            VARCHAR(128) NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    phase_order     INTEGER      NOT NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'in_progress', 'completed', 'skipped')),
    planned_start   TIMESTAMPTZ,
    planned_end     TIMESTAMPTZ,
    actual_start    TIMESTAMPTZ,
    actual_end      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(operation_id, phase_order)
);

CREATE TABLE tasks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phase_id        UUID         NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
    operation_id    UUID         NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    name            VARCHAR(256) NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    task_type       VARCHAR(16)  NOT NULL DEFAULT 'manual'
                    CHECK (task_type IN ('manual', 'c2_command', 'automated')),
    c2_command      JSONB,       -- { "provider": "sliver", "command": "shell", "arguments": {...} }
    risk_level      SMALLINT     NOT NULL DEFAULT 1 CHECK (risk_level BETWEEN 1 AND 5),
    approval_required BOOLEAN    NOT NULL DEFAULT FALSE,
    ticket_id       UUID,        -- approval ticket if applicable
    assigned_to     UUID         REFERENCES users(id),
    target_endpoints UUID[]      NOT NULL DEFAULT '{}',
    status          VARCHAR(24)  NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'pending_approval', 'approved', 'in_progress',
                                      'completed', 'failed', 'cancelled')),
    result          JSONB,       -- { "output": "...", "exit_code": 0, "artifacts": [...], "findings": [...] }
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_tasks_operation ON tasks(operation_id);
CREATE INDEX idx_tasks_phase     ON tasks(phase_id);
CREATE INDEX idx_tasks_assigned  ON tasks(assigned_to);

-- ════════════════════════════════════════════
--  ENDPOINTS
-- ════════════════════════════════════════════

CREATE TABLE endpoints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hostname        VARCHAR(256) NOT NULL,
    fqdn            VARCHAR(512),
    ip_addresses    JSONB        NOT NULL DEFAULT '[]',
    -- [{ "address": "10.101.1.10", "version": 4, "interface": "eth0" }]
    os              VARCHAR(64)  NOT NULL DEFAULT 'unknown',
    os_version      VARCHAR(64)  NOT NULL DEFAULT '',
    architecture    VARCHAR(16)  NOT NULL DEFAULT 'amd64',
    environment     VARCHAR(16)  NOT NULL DEFAULT 'docker'
                    CHECK (environment IN ('docker', 'vm', 'bare_metal', 'cloud')),
    cloud_provider  VARCHAR(32),
    cloud_region    VARCHAR(64),
    status          VARCHAR(16)  NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('online', 'offline', 'degraded', 'unknown')),
    compliance_status VARCHAR(16) NOT NULL DEFAULT 'unknown'
                    CHECK (compliance_status IN ('compliant', 'non_compliant', 'unknown', 'exempt')),
    services        JSONB        NOT NULL DEFAULT '[]',
    -- [{ "name": "sshd", "port": 22, "protocol": "tcp", "state": "running" }]
    open_ports      JSONB        NOT NULL DEFAULT '[]',
    -- [{ "port": 22, "protocol": "tcp", "service": "ssh", "state": "open" }]
    implants        JSONB        NOT NULL DEFAULT '[]',
    -- [{ "id": "sliver-abc123", "c2_provider": "sliver", "type": "session", "status": "active", ... }]
    tags            TEXT[]       NOT NULL DEFAULT '{}',
    metadata        JSONB        NOT NULL DEFAULT '{}',
    first_seen      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_endpoints_hostname ON endpoints(hostname);
CREATE INDEX idx_endpoints_status   ON endpoints(status);
CREATE INDEX idx_endpoints_tags     ON endpoints USING GIN(tags);

CREATE TABLE endpoint_groups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(128) NOT NULL UNIQUE,
    description     TEXT         NOT NULL DEFAULT '',
    group_type      VARCHAR(8)   NOT NULL DEFAULT 'static'
                    CHECK (group_type IN ('static', 'dynamic')),
    dynamic_query   TEXT,        -- filter expression for dynamic membership
    tags            TEXT[]       NOT NULL DEFAULT '{}',
    created_by      UUID         REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE endpoint_group_members (
    group_id        UUID NOT NULL REFERENCES endpoint_groups(id) ON DELETE CASCADE,
    endpoint_id     UUID NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, endpoint_id)
);

-- Junction table: operations ↔ endpoint groups (moved here to resolve FK ordering)
CREATE TABLE operation_endpoint_groups (
    operation_id    UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    group_id        UUID NOT NULL REFERENCES endpoint_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (operation_id, group_id)
);

-- ════════════════════════════════════════════
--  TICKETING
-- ════════════════════════════════════════════

CREATE SEQUENCE ticket_number_seq START 1;

CREATE TABLE tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_number   VARCHAR(32)  NOT NULL UNIQUE,
    ticket_type     VARCHAR(24)  NOT NULL DEFAULT 'general'
                    CHECK (ticket_type IN ('operation_proposal', 'task_request', 'approval_request',
                                           'finding_report', 'incident', 'general')),
    title           VARCHAR(512) NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    priority        VARCHAR(12)  NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    status          VARCHAR(16)  NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'submitted', 'in_review', 'approved', 'rejected',
                                      'in_progress', 'completed', 'cancelled')),
    workflow_run_id UUID         REFERENCES workflow_runs(id),
    current_stage_id UUID        REFERENCES workflow_stages(id),
    created_by      UUID         NOT NULL REFERENCES users(id),
    assigned_to     UUID         REFERENCES users(id),
    watchers        UUID[]       NOT NULL DEFAULT '{}',
    operation_id    UUID         REFERENCES operations(id),
    task_id         UUID         REFERENCES tasks(id),
    linked_tickets  UUID[]       NOT NULL DEFAULT '{}',
    sla_deadline    TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    tags            TEXT[]       NOT NULL DEFAULT '{}',
    metadata        JSONB        NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tickets_status     ON tickets(status);
CREATE INDEX idx_tickets_created_by ON tickets(created_by);
CREATE INDEX idx_tickets_assigned   ON tickets(assigned_to);
CREATE INDEX idx_tickets_operation  ON tickets(operation_id);
CREATE INDEX idx_tickets_type       ON tickets(ticket_type);
CREATE INDEX idx_tickets_search     ON tickets USING GIN(to_tsvector('english', title || ' ' || description));

CREATE TABLE ticket_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       UUID         NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    parent_id       UUID         REFERENCES ticket_comments(id),  -- threading
    author_id       UUID         NOT NULL REFERENCES users(id),
    body            TEXT         NOT NULL,
    attachments     JSONB        NOT NULL DEFAULT '[]',
    -- [{ "id": "...", "filename": "...", "mime_type": "...", "size_bytes": 1024, "storage_key": "..." }]
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comments_ticket ON ticket_comments(ticket_id, created_at);

-- Auto-generate ticket_number on INSERT (NEXTVAL in DEFAULT with concatenation is not valid PG syntax)
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ticket_number IS NULL OR NEW.ticket_number = '' THEN
        NEW.ticket_number := 'EMS-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(NEXTVAL('ticket_number_seq')::TEXT, 5, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ticket_number
    BEFORE INSERT ON tickets
    FOR EACH ROW
    EXECUTE FUNCTION generate_ticket_number();

-- ════════════════════════════════════════════
--  FINDINGS (Red Team Outputs)
-- ════════════════════════════════════════════

CREATE TABLE findings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         UUID         REFERENCES tasks(id),
    operation_id    UUID         NOT NULL REFERENCES operations(id),
    endpoint_id     UUID         REFERENCES endpoints(id),
    finding_type    VARCHAR(24)  NOT NULL
                    CHECK (finding_type IN ('vulnerability', 'misconfiguration', 'credential',
                                            'loot', 'observation')),
    severity        VARCHAR(12)  NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    title           VARCHAR(512) NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    evidence        TEXT         NOT NULL DEFAULT '',  -- reference to artifact or inline
    remediation     TEXT,
    tags            TEXT[]       NOT NULL DEFAULT '{}',
    metadata        JSONB        NOT NULL DEFAULT '{}',
    created_by      UUID         NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_findings_operation ON findings(operation_id);
CREATE INDEX idx_findings_severity  ON findings(severity);

-- ════════════════════════════════════════════
--  DASHBOARDS
-- ════════════════════════════════════════════

CREATE TABLE dashboards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(128) NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    owner_id        UUID         NOT NULL REFERENCES users(id),
    is_template     BOOLEAN      NOT NULL DEFAULT FALSE,
    echelon_default VARCHAR(16)
                    CHECK (echelon_default IN ('e1', 'e2', 'e3', 'operator', 'planner')),
    shared_with     JSONB        NOT NULL DEFAULT '[]',
    -- [{ "entity_type": "user"|"role"|"team", "entity_id": "...", "permission": "view"|"edit" }]
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE dashboard_tabs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID         NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    name            VARCHAR(64)  NOT NULL,
    tab_order       INTEGER      NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(dashboard_id, tab_order)
);

CREATE TABLE dashboard_widgets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tab_id          UUID         NOT NULL REFERENCES dashboard_tabs(id) ON DELETE CASCADE,
    widget_type     VARCHAR(64)  NOT NULL,
    -- 'network_topology', 'terminal', 'remote_desktop', 'notes', 'ticket_queue',
    -- 'operation_timeline', 'sliver_c2_panel', 'audit_log', 'plugin_iframe',
    -- 'metrics_chart', 'endpoint_table', 'command_palette'
    config          JSONB        NOT NULL DEFAULT '{}',  -- widget-specific config
    position_x      INTEGER      NOT NULL DEFAULT 0,
    position_y      INTEGER      NOT NULL DEFAULT 0,
    width           INTEGER      NOT NULL DEFAULT 4,     -- grid columns (12-col grid)
    height          INTEGER      NOT NULL DEFAULT 4,     -- grid rows
    data_source     JSONB,       -- { "type": "api"|"websocket"|"static", "endpoint": "...", "filters": {...}, "refresh_interval_seconds": 30 }
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_widgets_tab ON dashboard_widgets(tab_id);

-- ════════════════════════════════════════════
--  NOTIFICATION PREFERENCES
-- ════════════════════════════════════════════

CREATE TABLE notification_channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_type    VARCHAR(16)  NOT NULL
                    CHECK (channel_type IN ('in_app', 'email', 'slack', 'teams', 'webhook')),
    config          JSONB        NOT NULL DEFAULT '{}',
    -- email: { "address": "..." }
    -- slack: { "webhook_url": "..." }
    -- webhook: { "url": "...", "headers": {...} }
    enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           VARCHAR(256) NOT NULL,
    body            TEXT         NOT NULL DEFAULT '',
    notification_type VARCHAR(32) NOT NULL,  -- 'ticket_update', 'approval_required', 'operation_status', etc.
    reference_type  VARCHAR(32),  -- 'ticket', 'operation', 'task'
    reference_id    UUID,
    is_read         BOOLEAN      NOT NULL DEFAULT FALSE,
    snoozed_until   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user    ON notifications(user_id, is_read, created_at DESC);

-- ════════════════════════════════════════════
--  UPDATED_AT TRIGGER
-- ════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT table_name FROM information_schema.columns
        WHERE column_name = 'updated_at' AND table_schema = 'public'
    LOOP
        EXECUTE format('CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t);
    END LOOP;
END;
$$;

-- ════════════════════════════════════════════
--  SEED DATA (POC Defaults)
-- ════════════════════════════════════════════

-- System roles
INSERT INTO roles (name, description, permissions, scope, is_system) VALUES
('planner', 'Operation planners who draft and submit operation proposals', '[
    {"resource":"operation","actions":["create","read","update"]},
    {"resource":"ticket","actions":["create","read","update"]},
    {"resource":"endpoint","actions":["read"]},
    {"resource":"dashboard","actions":["create","read","update"]},
    {"resource":"finding","actions":["read"]},
    {"resource":"workflow","actions":["read"]}
]'::jsonb, 'global', TRUE),

('mission_commander', 'E3 - Tactical mission commanders with full operational visibility', '[
    {"resource":"operation","actions":["read","update"]},
    {"resource":"ticket","actions":["create","read","update","approve","reject"]},
    {"resource":"task","actions":["create","read","update","approve","reject"]},
    {"resource":"endpoint","actions":["read"]},
    {"resource":"dashboard","actions":["create","read","update"]},
    {"resource":"finding","actions":["create","read"]},
    {"resource":"workflow","actions":["read"]},
    {"resource":"c2","actions":["read"]},
    {"resource":"audit","actions":["read"]}
]'::jsonb, 'global', TRUE),

('supervisor', 'E2 - Supervisors overseeing multiple operations', '[
    {"resource":"operation","actions":["read","update","approve","reject"]},
    {"resource":"ticket","actions":["create","read","update","approve","reject"]},
    {"resource":"task","actions":["read","approve","reject"]},
    {"resource":"endpoint","actions":["read"]},
    {"resource":"dashboard","actions":["create","read","update"]},
    {"resource":"finding","actions":["read"]},
    {"resource":"workflow","actions":["create","read","update"]},
    {"resource":"c2","actions":["read"]},
    {"resource":"audit","actions":["read"]},
    {"resource":"role","actions":["read"]}
]'::jsonb, 'global', TRUE),

('senior_leadership', 'E1 - Senior leaders with strategic oversight and final approval authority', '[
    {"resource":"operation","actions":["read","update","approve","reject"]},
    {"resource":"ticket","actions":["read","approve","reject"]},
    {"resource":"task","actions":["read"]},
    {"resource":"endpoint","actions":["read"]},
    {"resource":"dashboard","actions":["create","read","update"]},
    {"resource":"finding","actions":["read"]},
    {"resource":"workflow","actions":["create","read","update","delete"]},
    {"resource":"c2","actions":["read"]},
    {"resource":"audit","actions":["read","export"]},
    {"resource":"role","actions":["create","read","update","delete"]},
    {"resource":"user","actions":["read","update"]}
]'::jsonb, 'global', TRUE),

('operator', 'Red team operators who execute approved tasks against endpoints', '[
    {"resource":"operation","actions":["read"]},
    {"resource":"ticket","actions":["create","read","update"]},
    {"resource":"task","actions":["read","update","execute"]},
    {"resource":"endpoint","actions":["read"]},
    {"resource":"dashboard","actions":["create","read","update"]},
    {"resource":"finding","actions":["create","read","update"]},
    {"resource":"c2","actions":["read","execute"]},
    {"resource":"audit","actions":["read"]}
]'::jsonb, 'global', TRUE),

('admin', 'System administrator with full access', '[
    {"resource":"*","actions":["*"]}
]'::jsonb, 'global', TRUE);

-- Default workflow: Linear approval chain
INSERT INTO workflows (name, description, is_template, is_default) VALUES
('Standard Red Team Approval', 'Default linear approval chain: Planner → E3 → E2 → E1 → Operator', TRUE, TRUE);

-- Insert stages for the default workflow
WITH wf AS (SELECT id FROM workflows WHERE name = 'Standard Red Team Approval')
INSERT INTO workflow_stages (workflow_id, name, stage_order, stage_type, config)
SELECT wf.id, s.name, s.stage_order, s.stage_type, s.config::jsonb
FROM wf, (VALUES
    ('Plan Drafting',    1, 'action',   '{"required_role":"planner","description":"Planner drafts the operation plan"}'),
    ('E3 Review',        2, 'approval', '{"required_role":"mission_commander","min_approvals":1,"approval_mode":"any","escalation_timeout_minutes":120}'),
    ('E2 Review',        3, 'approval', '{"required_role":"supervisor","min_approvals":1,"approval_mode":"any","escalation_timeout_minutes":240}'),
    ('E1 Review',        4, 'approval', '{"required_role":"senior_leadership","min_approvals":1,"approval_mode":"any","auto_approve_conditions":{"risk_level":{"lte":2}}}'),
    ('Execution',        5, 'action',   '{"required_role":"operator","description":"Operator executes approved tasks"}'),
    ('Completed',        6, 'terminal', '{}')
) AS s(name, stage_order, stage_type, config);

-- Default transitions (linear + kickbacks)
-- This is done at app layer during workflow instantiation for flexibility

-- Seed users (passwords are bcrypt hashes of 'changeme' — CHANGE IN PROD)
-- Password for all seed users: changeme
INSERT INTO users (username, display_name, email, password_hash) VALUES
('planner1',  'Alex Planner',       'planner1@ems.local',  '$2b$12$sTO/l5dvFqlelmerbkPToudfrP1/.2zr4gooHEZprRIxHDFLq66rK'),
('mc1',       'Jordan Commander',   'mc1@ems.local',       '$2b$12$sTO/l5dvFqlelmerbkPToudfrP1/.2zr4gooHEZprRIxHDFLq66rK'),
('sup1',      'Morgan Supervisor',  'sup1@ems.local',      '$2b$12$sTO/l5dvFqlelmerbkPToudfrP1/.2zr4gooHEZprRIxHDFLq66rK'),
('lead1',     'Taylor Leader',      'lead1@ems.local',     '$2b$12$sTO/l5dvFqlelmerbkPToudfrP1/.2zr4gooHEZprRIxHDFLq66rK'),
('op1',       'Casey Operator',     'op1@ems.local',       '$2b$12$sTO/l5dvFqlelmerbkPToudfrP1/.2zr4gooHEZprRIxHDFLq66rK'),
('op2',       'Riley Operator',     'op2@ems.local',       '$2b$12$sTO/l5dvFqlelmerbkPToudfrP1/.2zr4gooHEZprRIxHDFLq66rK'),
('admin',     'System Admin',       'admin@ems.local',     '$2b$12$sTO/l5dvFqlelmerbkPToudfrP1/.2zr4gooHEZprRIxHDFLq66rK');

-- Bind users to roles
INSERT INTO role_bindings (user_id, role_id, granted_by)
SELECT u.id, r.id, (SELECT id FROM users WHERE username = 'admin')
FROM users u, roles r
WHERE (u.username, r.name) IN (
    ('planner1', 'planner'),
    ('mc1',      'mission_commander'),
    ('sup1',     'supervisor'),
    ('lead1',    'senior_leadership'),
    ('op1',      'operator'),
    ('op2',      'operator'),
    ('admin',    'admin')
);

-- Seed endpoint groups
INSERT INTO endpoint_groups (name, description, group_type) VALUES
('Corp Network - Segment A', 'Corporate workstation segment', 'static'),
('DMZ - Segment B', 'DMZ servers segment', 'static');

-- Seed endpoints
INSERT INTO endpoints (hostname, ip_addresses, os, os_version, architecture, environment, status, tags) VALUES
('corp-ws-001', '[{"address":"10.101.1.10","version":4,"interface":"eth0"}]'::jsonb,
    'Ubuntu', '22.04', 'amd64', 'docker', 'online', ARRAY['workstation', 'corp-a']),
('corp-ws-002', '[{"address":"10.101.1.11","version":4,"interface":"eth0"}]'::jsonb,
    'Ubuntu', '22.04', 'amd64', 'docker', 'online', ARRAY['workstation', 'corp-a']),
('dmz-web-001', '[{"address":"10.101.2.10","version":4,"interface":"eth0"}]'::jsonb,
    'Alpine', '3.19', 'amd64', 'docker', 'online', ARRAY['webserver', 'dmz-b']),
('dmz-db-001', '[{"address":"10.101.2.11","version":4,"interface":"eth0"}]'::jsonb,
    'Alpine', '3.19', 'amd64', 'docker', 'online', ARRAY['database', 'dmz-b']);

-- Bind endpoints to groups
INSERT INTO endpoint_group_members (group_id, endpoint_id)
SELECT eg.id, e.id FROM endpoint_groups eg, endpoints e
WHERE (eg.name = 'Corp Network - Segment A' AND e.hostname LIKE 'corp-%')
   OR (eg.name = 'DMZ - Segment B' AND e.hostname LIKE 'dmz-%');
