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
        "node_selector": "host",
        "field_mappings": {
            "ip_address": {
                "xpath": "address[@addrtype=''ipv4'']/@addr",
                "required": true,
                "type": "string"
            },
            "mac_address": {
                "xpath": "address[@addrtype=''mac'']/@addr",
                "required": false,
                "type": "string"
            },
            "hostname": {
                "xpath": "hostnames/hostname[@type=''user'']/@name | hostnames/hostname[@type=''PTR'']/@name",
                "required": false,
                "type": "string",
                "default": ""
            },
            "os": {
                "xpath": "os/osmatch[1]/@name",
                "required": false,
                "type": "string",
                "default": "unknown",
                "transform": "first_match"
            },
            "os_version": {
                "xpath": "os/osmatch[1]/osclass[1]/@osgen",
                "required": false,
                "type": "string",
                "default": ""
            },
            "status": {
                "xpath": "status/@state",
                "required": false,
                "type": "string",
                "value_map": { "up": "alive", "down": "offline", "unknown": "discovered" },
                "default": "discovered"
            },
            "services": {
                "xpath": "ports/port",
                "required": false,
                "type": "array",
                "item_mappings": {
                    "port":     { "xpath": "@portid",             "type": "integer" },
                    "protocol": { "xpath": "@protocol",           "type": "string"  },
                    "state":    { "xpath": "state/@state",        "type": "string"  },
                    "service":  { "xpath": "service/@name",       "type": "string"  },
                    "version":  { "xpath": "service/@version",    "type": "string"  },
                    "product":  { "xpath": "service/@product",    "type": "string"  },
                    "banner":   { "xpath": "script[@id=''banner'']/@output", "type": "string" }
                }
            }
        },
        "edge_mappings": {
            "traceroute": {
                "xpath": "trace/hop",
                "type": "sequential",
                "edge_type": "network_adjacency",
                "discovered_by": "import",
                "item_mappings": {
                    "ip_address": { "xpath": "@ipaddr", "type": "string" },
                    "ttl":        { "xpath": "@ttl",    "type": "integer" },
                    "rtt":        { "xpath": "@rtt",    "type": "float" },
                    "hostname":   { "xpath": "@host",   "type": "string" }
                },
                "confidence": 0.9,
                "metadata_fields": ["ttl", "rtt"]
            }
        },
        "node_type_rules": [
            { "condition": "services.any(s => s.service == ''domain'')",              "node_type": "server"       },
            { "condition": "services.any(s => s.service == ''http'' || s.service == ''https'')", "node_type": "server" },
            { "condition": "services.any(s => s.service == ''mysql'' || s.service == ''postgresql'')", "node_type": "server" },
            { "condition": "services.any(s => s.port == 161)",                        "node_type": "switch"       },
            { "condition": "services.any(s => s.port == 631)",                        "node_type": "printer"      },
            { "condition": "os.match(/router|cisco ios|junos/i)",                     "node_type": "router"       },
            { "condition": "os.match(/firewall|pfsense|fortios|palo alto/i)",         "node_type": "firewall"     },
            { "condition": "os.match(/windows.*workstation|windows 1[01]/i)",         "node_type": "workstation"  },
            { "condition": "os.match(/windows.*server/i)",                            "node_type": "server"       },
            { "condition": "os.match(/linux|ubuntu|debian|centos|rhel/i)",            "node_type": "server"       },
            { "condition": "os.match(/openwrt|dd-wrt|mikrotik/i)",                    "node_type": "access_point" },
            { "condition": "true",                                                    "node_type": "unknown"      }
        ],
        "dedup_key": "ip_address",
        "merge_strategy": "update_if_newer"
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
        "node_selector": "Report/ReportHost",
        "field_mappings": {
            "ip_address": {
                "xpath": "HostProperties/tag[@name=''host-ip'']",
                "required": true,
                "type": "string"
            },
            "mac_address": {
                "xpath": "HostProperties/tag[@name=''mac-address'']",
                "required": false,
                "type": "string"
            },
            "hostname": {
                "xpath": "HostProperties/tag[@name=''host-fqdn''] | HostProperties/tag[@name=''hostname''] | @name",
                "required": false,
                "type": "string",
                "default": ""
            },
            "os": {
                "xpath": "HostProperties/tag[@name=''operating-system'']",
                "required": false,
                "type": "string",
                "default": "unknown"
            },
            "status": {
                "constant": "alive",
                "type": "string"
            },
            "services": {
                "xpath": "ReportItem[@pluginFamily=''Service detection'']",
                "required": false,
                "type": "array",
                "item_mappings": {
                    "port":     { "xpath": "@port",     "type": "integer" },
                    "protocol": { "xpath": "@protocol", "type": "string"  },
                    "service":  { "xpath": "@svc_name", "type": "string"  },
                    "banner":   { "xpath": "plugin_output", "type": "string" }
                }
            }
        },
        "finding_mappings": {
            "selector": "ReportItem[severity!=''0'']",
            "fields": {
                "title":       { "xpath": "@pluginName",      "type": "string" },
                "severity":    { "xpath": "@severity",         "type": "string", "value_map": { "4": "critical", "3": "high", "2": "medium", "1": "low", "0": "info" } },
                "cve_id":      { "xpath": "cve",              "type": "string" },
                "cvss_score":  { "xpath": "cvss3_base_score | cvss_base_score", "type": "float" },
                "description": { "xpath": "description",      "type": "string" },
                "solution":    { "xpath": "solution",          "type": "string" },
                "plugin_id":   { "xpath": "@pluginID",         "type": "string" }
            }
        },
        "node_type_rules": [
            { "condition": "os.match(/windows.*server/i)",                   "node_type": "server"      },
            { "condition": "os.match(/windows/i)",                           "node_type": "workstation"  },
            { "condition": "os.match(/linux|ubuntu|debian|centos|rhel/i)",   "node_type": "server"      },
            { "condition": "os.match(/cisco|juniper/i)",                     "node_type": "router"      },
            { "condition": "os.match(/printer|jetdirect/i)",                 "node_type": "printer"     },
            { "condition": "true",                                           "node_type": "unknown"     }
        ],
        "dedup_key": "ip_address",
        "merge_strategy": "update_if_newer"
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
        "root_path": "$[*]",
        "group_by": "ip",
        "field_mappings": {
            "ip_address": {
                "json_path": "$.ip",
                "required": true,
                "type": "string"
            },
            "status": {
                "constant": "alive",
                "type": "string"
            },
            "services": {
                "json_path": "$.ports[*]",
                "required": false,
                "type": "array",
                "item_mappings": {
                    "port":     { "json_path": "$.port",     "type": "integer" },
                    "protocol": { "json_path": "$.proto",    "type": "string"  },
                    "state":    { "json_path": "$.status",   "type": "string"  },
                    "service":  { "json_path": "$.service.name",    "type": "string" },
                    "banner":   { "json_path": "$.service.banner",  "type": "string" }
                }
            }
        },
        "node_type_rules": [
            { "condition": "services.any(s => s.port == 80 || s.port == 443)", "node_type": "server"  },
            { "condition": "services.any(s => s.port == 3389)",                "node_type": "workstation" },
            { "condition": "services.any(s => s.port == 9100)",                "node_type": "printer" },
            { "condition": "true",                                             "node_type": "unknown" }
        ],
        "dedup_key": "ip_address",
        "merge_strategy": "merge_services"
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
        "node_extraction": {
            "source": {
                "ip_address": { "column": "id.orig_h", "type": "string" },
                "status":     { "constant": "alive", "type": "string" }
            },
            "destination": {
                "ip_address": { "column": "id.resp_h", "type": "string" },
                "status":     { "constant": "alive", "type": "string" },
                "services":   {
                    "type": "array",
                    "item_from_row": {
                        "port":     { "column": "id.resp_p", "type": "integer" },
                        "protocol": { "column": "proto",     "type": "string"  },
                        "service":  { "column": "service",   "type": "string"  }
                    }
                }
            }
        },
        "edge_extraction": {
            "source_ip":      { "column": "id.orig_h", "type": "string" },
            "destination_ip": { "column": "id.resp_h", "type": "string" },
            "edge_type": "network_adjacency",
            "discovered_by": "import",
            "confidence": 0.7,
            "metadata_fields": {
                "protocol":     { "column": "proto",       "type": "string"  },
                "dest_port":    { "column": "id.resp_p",   "type": "integer" },
                "service":      { "column": "service",     "type": "string"  },
                "duration":     { "column": "duration",    "type": "float"   },
                "orig_bytes":   { "column": "orig_bytes",  "type": "integer" },
                "resp_bytes":   { "column": "resp_bytes",  "type": "integer" },
                "conn_state":   { "column": "conn_state",  "type": "string"  }
            },
            "aggregate": true,
            "aggregate_key": ["source_ip", "destination_ip", "dest_port"]
        },
        "node_type_rules": [
            { "condition": "services.any(s => s.service == ''dns'')",   "node_type": "server" },
            { "condition": "services.any(s => s.service == ''http'')",  "node_type": "server" },
            { "condition": "services.any(s => s.service == ''ssl'')",   "node_type": "server" },
            { "condition": "true",                                     "node_type": "unknown" }
        ],
        "dedup_key": "ip_address",
        "merge_strategy": "merge_services"
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
