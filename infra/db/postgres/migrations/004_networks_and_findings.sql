-- EMS-COP Migration 004: Networks, Nodes, Edges + Findings enhancements
-- Supports M4 Operations & Network Maps feature

-- ════════════════════════════════════════════
--  OPERATION MEMBERS
-- ════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS operation_members (
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_in_operation VARCHAR(32) NOT NULL DEFAULT 'member',
    added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (operation_id, user_id)
);

-- ════════════════════════════════════════════
--  NETWORKS
-- ════════════════════════════════════════════

CREATE TABLE networks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id    UUID         NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    cidr_ranges     TEXT[]       NOT NULL DEFAULT '{}',
    import_source   VARCHAR(32),
    metadata        JSONB        NOT NULL DEFAULT '{}',
    created_by      UUID         REFERENCES users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_networks_operation ON networks(operation_id);

-- ════════════════════════════════════════════
--  NETWORK NODES
-- ════════════════════════════════════════════

CREATE TABLE network_nodes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    network_id      UUID         NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    endpoint_id     UUID         REFERENCES endpoints(id) ON DELETE SET NULL,
    ip_address      VARCHAR(45)  NOT NULL,
    hostname        VARCHAR(255) NOT NULL DEFAULT '',
    mac_address     VARCHAR(17),
    os              VARCHAR(128) NOT NULL DEFAULT 'unknown',
    os_version      VARCHAR(128) NOT NULL DEFAULT '',
    status          VARCHAR(32)  NOT NULL DEFAULT 'discovered'
                    CHECK (status IN ('discovered', 'alive', 'compromised', 'offline')),
    node_type       VARCHAR(32)  NOT NULL DEFAULT 'unknown'
                    CHECK (node_type IN ('host', 'router', 'firewall', 'server', 'workstation', 'unknown')),
    position_x      DOUBLE PRECISION,
    position_y      DOUBLE PRECISION,
    services        JSONB        NOT NULL DEFAULT '[]',
    metadata        JSONB        NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(network_id, ip_address)
);

CREATE INDEX idx_network_nodes_network ON network_nodes(network_id);
CREATE INDEX idx_network_nodes_endpoint ON network_nodes(endpoint_id) WHERE endpoint_id IS NOT NULL;
CREATE INDEX idx_network_nodes_status ON network_nodes(status);

-- ════════════════════════════════════════════
--  NETWORK EDGES
-- ════════════════════════════════════════════

CREATE TABLE network_edges (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    network_id      UUID         NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
    source_node_id  UUID         NOT NULL REFERENCES network_nodes(id) ON DELETE CASCADE,
    target_node_id  UUID         NOT NULL REFERENCES network_nodes(id) ON DELETE CASCADE,
    edge_type       VARCHAR(32)  NOT NULL DEFAULT 'network_adjacency'
                    CHECK (edge_type IN ('network_adjacency', 'c2_callback', 'c2_pivot',
                                         'lateral_movement', 'tunnel', 'port_forward')),
    label           VARCHAR(255),
    confidence      DOUBLE PRECISION NOT NULL DEFAULT 1.0
                    CHECK (confidence >= 0.0 AND confidence <= 1.0),
    discovered_by   VARCHAR(32)  NOT NULL DEFAULT 'manual'
                    CHECK (discovered_by IN ('import', 'scan', 'c2_activity', 'manual')),
    metadata        JSONB        NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_network_edges_network ON network_edges(network_id);
CREATE INDEX idx_network_edges_source ON network_edges(source_node_id);
CREATE INDEX idx_network_edges_target ON network_edges(target_node_id);

-- ════════════════════════════════════════════
--  FINDINGS ENHANCEMENTS
-- ════════════════════════════════════════════

ALTER TABLE findings ADD COLUMN IF NOT EXISTS cve_id VARCHAR(32);
ALTER TABLE findings ADD COLUMN IF NOT EXISTS cvss_score DOUBLE PRECISION;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS network_node_id UUID REFERENCES network_nodes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_findings_cve ON findings(cve_id) WHERE cve_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_findings_node ON findings(network_node_id) WHERE network_node_id IS NOT NULL;

-- ════════════════════════════════════════════
--  SEED: Default Training Operation
-- ════════════════════════════════════════════

-- Only insert if no operations exist yet (idempotent)
INSERT INTO operations (name, objective, risk_level, status, created_by)
SELECT 'Training Exercise', 'Default training operation for POC testing', 2, 'in_progress',
       (SELECT id FROM users WHERE username = 'admin')
WHERE NOT EXISTS (SELECT 1 FROM operations WHERE name = 'Training Exercise');

-- Link existing endpoint groups to the training operation
INSERT INTO operation_endpoint_groups (operation_id, group_id)
SELECT o.id, eg.id FROM operations o, endpoint_groups eg
WHERE o.name = 'Training Exercise'
  AND NOT EXISTS (
    SELECT 1 FROM operation_endpoint_groups oeg
    WHERE oeg.operation_id = o.id AND oeg.group_id = eg.id
  );

-- Add admin as operation lead
INSERT INTO operation_members (operation_id, user_id, role_in_operation)
SELECT o.id, u.id, 'lead'
FROM operations o, users u
WHERE o.name = 'Training Exercise' AND u.username = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM operation_members om
    WHERE om.operation_id = o.id AND om.user_id = u.id
  );

-- Create two networks for the training operation
INSERT INTO networks (operation_id, name, description, cidr_ranges, import_source, created_by)
SELECT o.id, 'Corp LAN', 'Corporate workstation segment', ARRAY['10.101.1.0/24'], 'manual',
       (SELECT id FROM users WHERE username = 'admin')
FROM operations o WHERE o.name = 'Training Exercise'
  AND NOT EXISTS (SELECT 1 FROM networks n WHERE n.operation_id = o.id AND n.name = 'Corp LAN');

INSERT INTO networks (operation_id, name, description, cidr_ranges, import_source, created_by)
SELECT o.id, 'DMZ', 'DMZ server segment', ARRAY['10.101.2.0/24'], 'manual',
       (SELECT id FROM users WHERE username = 'admin')
FROM operations o WHERE o.name = 'Training Exercise'
  AND NOT EXISTS (SELECT 1 FROM networks n WHERE n.operation_id = o.id AND n.name = 'DMZ');

-- Populate network nodes from existing endpoints
INSERT INTO network_nodes (network_id, endpoint_id, ip_address, hostname, os, os_version, status, node_type, services)
SELECT n.id, e.id,
       (e.ip_addresses->0->>'address'),
       e.hostname, e.os, e.os_version, 'alive',
       CASE WHEN e.tags @> ARRAY['webserver'] THEN 'server'
            WHEN e.tags @> ARRAY['database'] THEN 'server'
            WHEN e.tags @> ARRAY['workstation'] THEN 'workstation'
            ELSE 'host' END,
       e.open_ports
FROM networks n
JOIN operations o ON n.operation_id = o.id
JOIN endpoint_group_members egm ON TRUE
JOIN endpoint_groups eg ON egm.group_id = eg.id
JOIN endpoints e ON egm.endpoint_id = e.id
WHERE o.name = 'Training Exercise'
  AND ((n.name = 'Corp LAN' AND eg.name = 'Corp Network - Segment A')
    OR (n.name = 'DMZ' AND eg.name = 'DMZ - Segment B'))
  AND NOT EXISTS (
    SELECT 1 FROM network_nodes nn WHERE nn.network_id = n.id AND nn.endpoint_id = e.id
  );
