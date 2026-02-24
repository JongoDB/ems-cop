-- EMS-COP Migration 005: Network Enhancements
-- Extends node_type values, adds display_schemas and import_parsers tables
-- Supports M4b+ Network Map Enhancements

BEGIN;

-- ════════════════════════════════════════════
--  EXTEND node_type CHECK CONSTRAINT
-- ════════════════════════════════════════════

ALTER TABLE network_nodes
    DROP CONSTRAINT network_nodes_node_type_check;

ALTER TABLE network_nodes
    ADD CONSTRAINT network_nodes_node_type_check
    CHECK (node_type IN (
        'host', 'router', 'firewall', 'server', 'workstation',
        'switch', 'access_point', 'vpn', 'printer', 'iot', 'unknown'
    ));

-- ════════════════════════════════════════════
--  DISPLAY SCHEMAS
-- ════════════════════════════════════════════

CREATE TABLE display_schemas (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(128) NOT NULL,
    schema_type VARCHAR(32)  NOT NULL
                CHECK (schema_type IN ('node_detail', 'node_tooltip', 'edge_detail')),
    definition  JSONB        NOT NULL,
    is_default  BOOLEAN      NOT NULL DEFAULT false,
    created_by  UUID         REFERENCES users(id),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_display_schemas_type ON display_schemas(schema_type);

CREATE TRIGGER trg_display_schemas_updated_at
    BEFORE UPDATE ON display_schemas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════
--  IMPORT PARSERS
-- ════════════════════════════════════════════

CREATE TABLE import_parsers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(128) NOT NULL,
    description TEXT,
    format      VARCHAR(32)  NOT NULL
                CHECK (format IN ('xml', 'json', 'csv', 'tsv', 'custom')),
    version     INTEGER      NOT NULL DEFAULT 1,
    definition  JSONB        NOT NULL,
    sample_data TEXT,
    is_default  BOOLEAN      NOT NULL DEFAULT false,
    created_by  UUID         REFERENCES users(id),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_import_parsers_format ON import_parsers(format);

CREATE TRIGGER trg_import_parsers_updated_at
    BEFORE UPDATE ON import_parsers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ════════════════════════════════════════════
--  SEED: Default Display Schema
-- ════════════════════════════════════════════

INSERT INTO display_schemas (name, schema_type, definition, is_default, created_by)
SELECT
    'Default Node Detail',
    'node_detail',
    '{
        "version": 1,
        "sections": [
            {
                "key": "identity",
                "title": "Identity",
                "order": 1,
                "layout": "key-value",
                "fields": [
                    { "key": "hostname",    "label": "Hostname",    "source": "node.hostname",    "type": "text",   "editable": true  },
                    { "key": "ip_address",  "label": "IP Address",  "source": "node.ip_address",  "type": "text",   "editable": false },
                    { "key": "os",          "label": "OS",          "source": "node.os",          "type": "text",   "editable": true  },
                    { "key": "os_version",  "label": "OS Version",  "source": "node.os_version",  "type": "text",   "editable": true  },
                    { "key": "mac_address", "label": "MAC Address", "source": "node.mac_address", "type": "text",   "editable": true  }
                ]
            },
            {
                "key": "classification",
                "title": "Classification",
                "order": 2,
                "layout": "key-value",
                "fields": [
                    { "key": "status",    "label": "Status",    "source": "node.status",    "type": "badge",  "editable": true,
                      "options": ["discovered", "alive", "compromised", "offline"] },
                    { "key": "node_type", "label": "Node Type", "source": "node.node_type", "type": "badge",  "editable": true,
                      "options": ["host", "router", "firewall", "server", "workstation", "switch", "access_point", "vpn", "printer", "iot", "unknown"] }
                ]
            },
            {
                "key": "services",
                "title": "Services",
                "order": 3,
                "layout": "table",
                "source": "node.services",
                "columns": [
                    { "key": "port",     "label": "Port",     "type": "number", "width": 80  },
                    { "key": "protocol", "label": "Protocol", "type": "text",   "width": 80  },
                    { "key": "service",  "label": "Service",  "type": "text",   "width": 120 },
                    { "key": "version",  "label": "Version",  "type": "text",   "width": 120 },
                    { "key": "state",    "label": "State",    "type": "badge",  "width": 80  },
                    { "key": "banner",   "label": "Banner",   "type": "text",   "width": 200 }
                ],
                "sortable": true,
                "defaultSort": { "key": "port", "direction": "asc" }
            },
            {
                "key": "vulnerabilities",
                "title": "Vulnerabilities",
                "order": 4,
                "layout": "table",
                "source": "findings",
                "columns": [
                    { "key": "cve_id",      "label": "CVE",       "type": "link",   "width": 140, "linkTemplate": "https://nvd.nist.gov/vuln/detail/{value}" },
                    { "key": "title",       "label": "Title",     "type": "text",   "width": 200 },
                    { "key": "severity",    "label": "Severity",  "type": "badge",  "width": 90,  "colorMap": { "critical": "red", "high": "orange", "medium": "yellow", "low": "blue", "info": "gray" } },
                    { "key": "cvss_score",  "label": "CVSS",      "type": "number", "width": 60  },
                    { "key": "status",      "label": "Status",    "type": "badge",  "width": 100 }
                ],
                "sortable": true,
                "defaultSort": { "key": "cvss_score", "direction": "desc" },
                "emptyMessage": "No vulnerabilities discovered"
            },
            {
                "key": "interfaces",
                "title": "Interfaces",
                "order": 5,
                "layout": "table",
                "source": "node.metadata.interfaces",
                "columns": [
                    { "key": "name",       "label": "Interface", "type": "text",  "width": 100 },
                    { "key": "ip_address", "label": "IP",        "type": "text",  "width": 140 },
                    { "key": "subnet",     "label": "Subnet",    "type": "text",  "width": 140 },
                    { "key": "mac",        "label": "MAC",       "type": "text",  "width": 140 },
                    { "key": "state",      "label": "State",     "type": "badge", "width": 80  }
                ],
                "emptyMessage": "No interface data available"
            },
            {
                "key": "notes",
                "title": "Notes",
                "order": 6,
                "layout": "markdown",
                "source": "node.metadata.notes",
                "editable": true,
                "placeholder": "Add operator notes about this node..."
            }
        ]
    }'::jsonb,
    true,
    (SELECT id FROM users WHERE username = 'admin')
WHERE NOT EXISTS (
    SELECT 1 FROM display_schemas WHERE name = 'Default Node Detail'
);

-- ════════════════════════════════════════════
--  SEED: Default Import Parsers
-- ════════════════════════════════════════════

-- Nmap XML Parser
INSERT INTO import_parsers (name, description, format, version, definition, sample_data, is_default, created_by)
SELECT
    'Nmap XML',
    'Parses Nmap XML output (-oX). Extracts hosts, services, OS fingerprints, traceroute hops, and MAC addresses.',
    'xml',
    1,
    '{
        "version": 1,
        "root_element": "nmaprun",
        "host_element": "host",
        "field_mappings": [
            {"source": "address@addr", "target": "ip_address", "filter": {"field": "@addrtype", "operator": "equals", "value": "ipv4"}},
            {"source": "address@addr", "target": "mac_address", "filter": {"field": "@addrtype", "operator": "equals", "value": "mac"}},
            {"source": "hostnames.hostname@name", "target": "hostname"},
            {"source": "os.osmatch@name", "target": "os"},
            {"source": "ports.port", "target": "services", "sub_mappings": [
                {"source": "@portid", "target": "port", "transform": "to_integer"},
                {"source": "@protocol", "target": "protocol"},
                {"source": "service@name", "target": "service"},
                {"source": "service@product", "target": "product"},
                {"source": "service@version", "target": "version"}
            ]}
        ],
        "edge_mappings": [
            {"source": "trace.hop", "source_ip": "ipaddr", "target_ip": "ipaddr", "edge_type": "network_adjacency"}
        ],
        "node_type_rules": [
            {"field": "services", "operator": "port_open", "value": "179", "node_type": "router"},
            {"field": "services", "operator": "port_open", "value": "631", "node_type": "printer"},
            {"field": "services", "operator": "port_open", "value": "80", "node_type": "server"},
            {"field": "services", "operator": "port_open", "value": "22", "node_type": "server"},
            {"field": "os", "operator": "contains", "value": "cisco", "node_type": "router"},
            {"field": "os", "operator": "contains", "value": "firewall", "node_type": "firewall"}
        ],
        "creates_edges": true,
        "edge_generation": {"strategy": "subnet"}
    }'::jsonb,
    '<nmaprun scanner="nmap" args="nmap -sV -O -oX scan.xml 10.0.0.0/24" start="1709000000">
  <host starttime="1709000001" endtime="1709000010">
    <status state="up" reason="echo-reply"/>
    <address addr="10.0.0.1" addrtype="ipv4"/>
    <address addr="AA:BB:CC:DD:EE:FF" addrtype="mac" vendor="Cisco"/>
    <hostnames><hostname name="gw.corp.local" type="PTR"/></hostnames>
    <ports>
      <port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH" version="8.9"/></port>
      <port protocol="tcp" portid="80"><state state="open"/><service name="http" product="nginx" version="1.24"/></port>
    </ports>
    <os><osmatch name="Linux 5.15" accuracy="95"><osclass osgen="5.X" osfamily="Linux"/></osmatch></os>
  </host>
</nmaprun>',
    true,
    (SELECT id FROM users WHERE username = 'admin')
WHERE NOT EXISTS (
    SELECT 1 FROM import_parsers WHERE name = 'Nmap XML'
);

-- Nessus XML Parser
INSERT INTO import_parsers (name, description, format, version, definition, sample_data, is_default, created_by)
SELECT
    'Nessus XML',
    'Parses Nessus .nessus XML export. Extracts hosts, OS, services, and vulnerability findings.',
    'xml',
    1,
    '{
        "version": 1,
        "root_element": "NessusClientData_v2",
        "host_element": "Report.ReportHost",
        "field_mappings": [
            {"source": "HostProperties.tag", "target": "ip_address", "filter": {"field": "@name", "operator": "equals", "value": "host-ip"}},
            {"source": "HostProperties.tag", "target": "mac_address", "filter": {"field": "@name", "operator": "equals", "value": "mac-address"}},
            {"source": "HostProperties.tag", "target": "hostname", "filter": {"field": "@name", "operator": "equals", "value": "host-fqdn"}},
            {"source": "HostProperties.tag", "target": "os", "filter": {"field": "@name", "operator": "equals", "value": "operating-system"}}
        ],
        "edge_mappings": [],
        "node_type_rules": [
            {"field": "os", "operator": "contains", "value": "windows server", "node_type": "server"},
            {"field": "os", "operator": "contains", "value": "windows", "node_type": "workstation"},
            {"field": "os", "operator": "contains", "value": "linux", "node_type": "server"},
            {"field": "os", "operator": "contains", "value": "cisco", "node_type": "router"},
            {"field": "os", "operator": "contains", "value": "printer", "node_type": "printer"}
        ]
    }'::jsonb,
    NULL,
    true,
    (SELECT id FROM users WHERE username = 'admin')
WHERE NOT EXISTS (
    SELECT 1 FROM import_parsers WHERE name = 'Nessus XML'
);

-- Masscan JSON Parser
INSERT INTO import_parsers (name, description, format, version, definition, sample_data, is_default, created_by)
SELECT
    'Masscan JSON',
    'Parses Masscan JSON output (-oJ). Fast port-scan results — provides IP, port, protocol, and state.',
    'json',
    1,
    '{
        "version": 1,
        "root_path": "",
        "field_mappings": [
            {"source": "ip", "target": "ip_address"},
            {"source": "ports.port", "target": "services", "sub_mappings": [
                {"source": "port", "target": "port", "transform": "to_integer"},
                {"source": "proto", "target": "protocol"},
                {"source": "service.name", "target": "service"},
                {"source": "service.banner", "target": "product"}
            ]}
        ],
        "edge_mappings": [],
        "node_type_rules": [
            {"field": "services", "operator": "port_open", "value": "80", "node_type": "server"},
            {"field": "services", "operator": "port_open", "value": "443", "node_type": "server"},
            {"field": "services", "operator": "port_open", "value": "3389", "node_type": "workstation"},
            {"field": "services", "operator": "port_open", "value": "9100", "node_type": "printer"}
        ]
    }'::jsonb,
    '[
  { "ip": "10.0.0.1", "timestamp": "1709000001", "ports": [{ "port": 80, "proto": "tcp", "status": "open", "service": { "name": "http", "banner": "nginx/1.24" } }] },
  { "ip": "10.0.0.2", "timestamp": "1709000002", "ports": [{ "port": 22, "proto": "tcp", "status": "open" }, { "port": 3306, "proto": "tcp", "status": "open" }] }
]',
    true,
    (SELECT id FROM users WHERE username = 'admin')
WHERE NOT EXISTS (
    SELECT 1 FROM import_parsers WHERE name = 'Masscan JSON'
);

-- Zeek conn.log Parser
INSERT INTO import_parsers (name, description, format, version, definition, sample_data, is_default, created_by)
SELECT
    'Zeek conn.log',
    'Parses Zeek (Bro) conn.log TSV files. Extracts source/destination pairs and infers edges from observed connections.',
    'tsv',
    1,
    '{
        "version": 1,
        "header_line": "#fields",
        "separator": "\t",
        "comment_prefix": "#",
        "field_mappings": [
            {"source": "id.resp_h", "target": "ip_address"},
            {"source": "id.resp_p", "target": "services", "sub_mappings": [
                {"source": "id.resp_p", "target": "port", "transform": "to_integer"},
                {"source": "proto", "target": "protocol"},
                {"source": "service", "target": "service"}
            ]}
        ],
        "edge_mappings": [],
        "node_type_rules": [
            {"field": "services", "operator": "service_running", "value": "dns", "node_type": "server"},
            {"field": "services", "operator": "service_running", "value": "http", "node_type": "server"},
            {"field": "services", "operator": "service_running", "value": "ssl", "node_type": "server"}
        ],
        "creates_edges": true,
        "edge_generation": {"strategy": "connection_log", "source_ip": "id.orig_h", "dest_ip": "id.resp_h"}
    }'::jsonb,
    '#separator \x09
#set_separator	,
#empty_field	(empty)
#unset_field	-
#fields	ts	uid	id.orig_h	id.orig_p	id.resp_h	id.resp_p	proto	service	duration	orig_bytes	resp_bytes	conn_state
#types	time	string	addr	port	addr	port	enum	string	interval	count	count	string
1709000000.000000	CYz123	10.0.0.50	49152	10.0.0.1	80	tcp	http	1.234	512	2048	SF
1709000001.000000	CYz456	10.0.0.50	49153	10.0.0.2	443	tcp	ssl	0.567	256	1024	SF',
    true,
    (SELECT id FROM users WHERE username = 'admin')
WHERE NOT EXISTS (
    SELECT 1 FROM import_parsers WHERE name = 'Zeek conn.log'
);

COMMIT;
