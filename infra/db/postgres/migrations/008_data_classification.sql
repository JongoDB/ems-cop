-- EMS-COP PostgreSQL Schema
-- Migration 008: Data Classification Taxonomy
-- Depends on: 001_core_schema.sql, 003_command_presets.sql, 004_networks_and_findings.sql
--
-- Adds a UNCLASS/CUI/SECRET classification column to all primary data entities.
-- Classification levels control data flow between security enclaves:
--   UNCLASS — Unclassified; can flow freely between enclaves
--   CUI     — Controlled Unclassified Information; flows with policy via CTI (Cross-domain Transfer Infrastructure)
--   SECRET  — High-side only; never crosses CTI boundary
--
-- Also introduces:
--   classification_policies — Configurable transfer rules per classification & entity type
--   finding_links          — Cross-domain finding relationships for enrichment and dedup

BEGIN;

-- ════════════════════════════════════════════
--  ADD CLASSIFICATION COLUMN TO DATA ENTITIES
-- ════════════════════════════════════════════

ALTER TABLE tickets
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

ALTER TABLE operations
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

ALTER TABLE findings
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

ALTER TABLE endpoints
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

ALTER TABLE networks
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

ALTER TABLE network_nodes
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

ALTER TABLE command_presets
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

ALTER TABLE workflows
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

ALTER TABLE workflow_runs
    ADD COLUMN classification TEXT NOT NULL DEFAULT 'UNCLASS'
    CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET'));

-- ════════════════════════════════════════════
--  INDEXES ON CLASSIFICATION COLUMNS
-- ════════════════════════════════════════════
-- Enable fast filtering by classification across all entities

CREATE INDEX idx_tickets_classification ON tickets(classification);
CREATE INDEX idx_operations_classification ON operations(classification);
CREATE INDEX idx_findings_classification ON findings(classification);
CREATE INDEX idx_endpoints_classification ON endpoints(classification);
CREATE INDEX idx_networks_classification ON networks(classification);
CREATE INDEX idx_network_nodes_classification ON network_nodes(classification);
CREATE INDEX idx_command_presets_classification ON command_presets(classification);
CREATE INDEX idx_workflows_classification ON workflows(classification);
CREATE INDEX idx_workflow_runs_classification ON workflow_runs(classification);

-- ════════════════════════════════════════════
--  CLASSIFICATION POLICIES
-- ════════════════════════════════════════════
-- Configurable rules governing how data at each classification level
-- may be transferred between enclaves (low-side ↔ high-side).

CREATE TABLE classification_policies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    classification      TEXT NOT NULL
                        CHECK (classification IN ('UNCLASS', 'CUI', 'SECRET')),
    entity_type         TEXT NOT NULL,  -- 'ticket', 'finding', 'operation', 'endpoint', 'network', 'network_node', 'command_preset', 'workflow', 'workflow_run'
    transfer_direction  TEXT NOT NULL
                        CHECK (transfer_direction IN ('low_to_high', 'high_to_low', 'blocked')),
    auto_approve        BOOLEAN NOT NULL DEFAULT false,
    requires_review     BOOLEAN NOT NULL DEFAULT false,
    max_risk_level      INTEGER CHECK (max_risk_level BETWEEN 1 AND 5),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_classification_policies_class ON classification_policies(classification);
CREATE INDEX idx_classification_policies_entity ON classification_policies(entity_type);

-- Apply updated_at trigger
CREATE TRIGGER trg_classification_policies_updated_at
    BEFORE UPDATE ON classification_policies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════
--  FINDING LINKS (Cross-domain relationships)
-- ════════════════════════════════════════════
-- Links findings across enclaves for enrichment, deduplication, and correlation.
-- source_enclave tracks which enclave originated the link.

CREATE TABLE finding_links (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_finding_id   UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    linked_finding_id   UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    link_type           TEXT NOT NULL DEFAULT 'enrichment'
                        CHECK (link_type IN ('enrichment', 'duplicate', 'related')),
    source_enclave      TEXT NOT NULL
                        CHECK (source_enclave IN ('low', 'high')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_finding_id, linked_finding_id)
);

CREATE INDEX idx_finding_links_source ON finding_links(source_finding_id);
CREATE INDEX idx_finding_links_linked ON finding_links(linked_finding_id);
CREATE INDEX idx_finding_links_type ON finding_links(link_type);

-- ════════════════════════════════════════════
--  SEED: Default Classification Policies
-- ════════════════════════════════════════════
-- Sensible defaults:
--   UNCLASS: auto_approve for both directions (data flows freely)
--   CUI:     auto_approve low→high, requires_review high→low (downgrading needs human review)
--   SECRET:  blocked in both directions (stays on high side, never crosses CTI)

INSERT INTO classification_policies (classification, entity_type, transfer_direction, auto_approve, requires_review, max_risk_level) VALUES
    -- UNCLASS: free flow
    ('UNCLASS', 'ticket',         'low_to_high', true,  false, 5),
    ('UNCLASS', 'ticket',         'high_to_low', true,  false, 5),
    ('UNCLASS', 'finding',        'low_to_high', true,  false, 5),
    ('UNCLASS', 'finding',        'high_to_low', true,  false, 5),
    ('UNCLASS', 'operation',      'low_to_high', true,  false, 5),
    ('UNCLASS', 'operation',      'high_to_low', true,  false, 5),
    ('UNCLASS', 'endpoint',       'low_to_high', true,  false, 5),
    ('UNCLASS', 'endpoint',       'high_to_low', true,  false, 5),
    ('UNCLASS', 'network',        'low_to_high', true,  false, 5),
    ('UNCLASS', 'network',        'high_to_low', true,  false, 5),
    ('UNCLASS', 'network_node',   'low_to_high', true,  false, 5),
    ('UNCLASS', 'network_node',   'high_to_low', true,  false, 5),
    ('UNCLASS', 'command_preset', 'low_to_high', true,  false, 5),
    ('UNCLASS', 'command_preset', 'high_to_low', true,  false, 5),
    ('UNCLASS', 'workflow',       'low_to_high', true,  false, 5),
    ('UNCLASS', 'workflow',       'high_to_low', true,  false, 5),
    ('UNCLASS', 'workflow_run',   'low_to_high', true,  false, 5),
    ('UNCLASS', 'workflow_run',   'high_to_low', true,  false, 5),

    -- CUI: auto-approve upward (low→high), requires review downward (high→low)
    ('CUI', 'ticket',         'low_to_high', true,  false, 5),
    ('CUI', 'ticket',         'high_to_low', false, true,  3),
    ('CUI', 'finding',        'low_to_high', true,  false, 5),
    ('CUI', 'finding',        'high_to_low', false, true,  3),
    ('CUI', 'operation',      'low_to_high', true,  false, 5),
    ('CUI', 'operation',      'high_to_low', false, true,  3),
    ('CUI', 'endpoint',       'low_to_high', true,  false, 5),
    ('CUI', 'endpoint',       'high_to_low', false, true,  3),
    ('CUI', 'network',        'low_to_high', true,  false, 5),
    ('CUI', 'network',        'high_to_low', false, true,  3),
    ('CUI', 'network_node',   'low_to_high', true,  false, 5),
    ('CUI', 'network_node',   'high_to_low', false, true,  3),
    ('CUI', 'command_preset', 'low_to_high', true,  false, 5),
    ('CUI', 'command_preset', 'high_to_low', false, true,  3),
    ('CUI', 'workflow',       'low_to_high', true,  false, 5),
    ('CUI', 'workflow',       'high_to_low', false, true,  3),
    ('CUI', 'workflow_run',   'low_to_high', true,  false, 5),
    ('CUI', 'workflow_run',   'high_to_low', false, true,  3),

    -- SECRET: blocked in both directions (never leaves high-side enclave)
    ('SECRET', 'ticket',         'blocked', false, false, NULL),
    ('SECRET', 'finding',        'blocked', false, false, NULL),
    ('SECRET', 'operation',      'blocked', false, false, NULL),
    ('SECRET', 'endpoint',       'blocked', false, false, NULL),
    ('SECRET', 'network',        'blocked', false, false, NULL),
    ('SECRET', 'network_node',   'blocked', false, false, NULL),
    ('SECRET', 'command_preset', 'blocked', false, false, NULL),
    ('SECRET', 'workflow',       'blocked', false, false, NULL),
    ('SECRET', 'workflow_run',   'blocked', false, false, NULL);

COMMIT;
