-- EMS-COP PostgreSQL Schema
-- Migration 012: DCO/SOC Features
-- Depends on: 001_core_schema.sql (endpoints, tickets), 004_networks_and_findings.sql
--
-- Adds tables for:
--   alerts           — normalized SIEM/sensor alerts
--   ioc_records      — indicators of compromise
--   playbook_definitions — automated response playbooks
--   playbook_executions  — execution instances of playbooks
--   containment_actions  — incident response containment actions
--
-- Also adds DCO-related columns to the existing tickets table.

BEGIN;

-- ════════════════════════════════════════════
--  ALERTS
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS alerts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id         TEXT,
    source_system       TEXT NOT NULL CHECK (source_system IN ('splunk', 'elastic', 'crowdstrike', 'generic')),
    severity            TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    title               TEXT NOT NULL,
    description         TEXT,
    raw_payload         JSONB,
    mitre_techniques    TEXT[],
    ioc_values          TEXT[],
    endpoint_id         UUID REFERENCES endpoints(id),
    operation_id        UUID,
    status              TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'investigating', 'resolved', 'false_positive')),
    assigned_to         TEXT,
    incident_ticket_id  UUID,
    classification      TEXT NOT NULL DEFAULT 'UNCLASS',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_source_system ON alerts(source_system);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_incident_ticket_id ON alerts(incident_ticket_id);
CREATE INDEX IF NOT EXISTS idx_alerts_external_id ON alerts(external_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_alerts_updated_at'
    ) THEN
        CREATE TRIGGER trg_alerts_updated_at
            BEFORE UPDATE ON alerts
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END
$$;

-- ════════════════════════════════════════════
--  IOC RECORDS
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ioc_records (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ioc_type            TEXT NOT NULL CHECK (ioc_type IN ('ip', 'domain', 'hash_md5', 'hash_sha1', 'hash_sha256', 'url', 'email', 'file_name', 'registry_key', 'mutex')),
    value               TEXT NOT NULL,
    description         TEXT,
    source              TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'siem', 'threat_feed', 'investigation')),
    threat_level        TEXT NOT NULL DEFAULT 'unknown' CHECK (threat_level IN ('critical', 'high', 'medium', 'low', 'unknown')),
    mitre_techniques    TEXT[],
    tags                TEXT[],
    first_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen           TIMESTAMPTZ,
    expiry              TIMESTAMPTZ,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    classification      TEXT NOT NULL DEFAULT 'UNCLASS',
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ioc_records_ioc_type ON ioc_records(ioc_type);
CREATE INDEX IF NOT EXISTS idx_ioc_records_value ON ioc_records(value);
CREATE INDEX IF NOT EXISTS idx_ioc_records_is_active ON ioc_records(is_active);
CREATE INDEX IF NOT EXISTS idx_ioc_records_threat_level ON ioc_records(threat_level);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ioc_records_updated_at'
    ) THEN
        CREATE TRIGGER trg_ioc_records_updated_at
            BEFORE UPDATE ON ioc_records
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END
$$;

-- ════════════════════════════════════════════
--  PLAYBOOK DEFINITIONS
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS playbook_definitions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL UNIQUE,
    description         TEXT,
    trigger_conditions  JSONB,
    workflow_id         UUID,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    priority            INTEGER NOT NULL DEFAULT 100,
    classification      TEXT NOT NULL DEFAULT 'UNCLASS',
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_playbook_definitions_updated_at'
    ) THEN
        CREATE TRIGGER trg_playbook_definitions_updated_at
            BEFORE UPDATE ON playbook_definitions
            FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
END
$$;

-- ════════════════════════════════════════════
--  PLAYBOOK EXECUTIONS
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS playbook_executions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playbook_id         UUID NOT NULL REFERENCES playbook_definitions(id),
    incident_ticket_id  UUID,
    alert_id            UUID REFERENCES alerts(id),
    status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    current_stage_id    TEXT,
    execution_log       JSONB DEFAULT '[]'::jsonb,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════
--  CONTAINMENT ACTIONS
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS containment_actions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_ticket_id      UUID,
    playbook_execution_id   UUID REFERENCES playbook_executions(id),
    action_type             TEXT NOT NULL CHECK (action_type IN ('isolate_host', 'kill_process', 'block_ip', 'disable_account', 'quarantine_file')),
    target                  JSONB NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed', 'rolled_back')),
    result                  JSONB,
    executed_by             TEXT,
    approved_by             TEXT,
    classification          TEXT NOT NULL DEFAULT 'UNCLASS',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at            TIMESTAMPTZ
);

-- ════════════════════════════════════════════
--  TICKETS TABLE: DCO COLUMNS
-- ════════════════════════════════════════════

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS alert_source TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS alert_ids UUID[];
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS mitre_techniques TEXT[];
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS incident_severity TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS containment_status TEXT;

-- ════════════════════════════════════════════
--  SEED: DEFAULT PLAYBOOKS
-- ════════════════════════════════════════════

INSERT INTO playbook_definitions (name, description, trigger_conditions, priority, classification, created_by)
VALUES
    ('Ransomware Response',
     'Automated response for ransomware indicators including file encryption activity and ransom note detection',
     '{"severity": ["critical", "high"], "mitre_techniques": ["T1486", "T1490", "T1489"], "alert_source": ["crowdstrike", "elastic"], "ioc_type": ["hash_sha256", "file_name"]}'::jsonb,
     10, 'UNCLASS', 'system'),
    ('Data Exfiltration',
     'Detect and respond to data exfiltration attempts including large outbound transfers and DNS tunneling',
     '{"severity": ["critical", "high", "medium"], "mitre_techniques": ["T1041", "T1048", "T1567"], "alert_source": ["splunk", "elastic"], "ioc_type": ["ip", "domain", "url"]}'::jsonb,
     20, 'UNCLASS', 'system'),
    ('Unauthorized Access',
     'Respond to unauthorized access attempts including brute force, credential stuffing, and privilege escalation',
     '{"severity": ["critical", "high"], "mitre_techniques": ["T1110", "T1078", "T1548"], "alert_source": ["splunk", "crowdstrike", "elastic"], "ioc_type": ["ip", "email"]}'::jsonb,
     30, 'UNCLASS', 'system'),
    ('Malware Detection',
     'Automated triage and containment for detected malware including trojans, backdoors, and worms',
     '{"severity": ["critical", "high", "medium"], "mitre_techniques": ["T1059", "T1055", "T1105"], "alert_source": ["crowdstrike", "elastic", "generic"], "ioc_type": ["hash_md5", "hash_sha1", "hash_sha256", "file_name"]}'::jsonb,
     40, 'UNCLASS', 'system')
ON CONFLICT (name) DO NOTHING;

COMMIT;
