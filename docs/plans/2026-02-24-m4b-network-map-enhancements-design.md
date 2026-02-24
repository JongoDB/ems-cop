# M4b+ Network Map Enhancements — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the network topology map from a basic Nmap viewer into a full-featured ops planning surface with proper device icons, editable metadata, vulnerability drill-down, and admin-configurable import parsers.

**Architecture:** Extend the existing endpoint-service (Go) with richer import logic and a parser engine. Extend the frontend NetworksTab with SVG-based node rendering, tabbed detail panel, inline editing, and a three-panel visual parser workbench. Store parser definitions and display schemas in PostgreSQL.

**Tech Stack:** Cytoscape.js (SVG background images), React 18, Go 1.22+, PostgreSQL JSONB, YAML/JSON schema definitions.

---

## 1. Node Visual System — SVG Icons + OS Logos

### 1.1 Device Type SVG Icons

Monochrome SVG icons rendered as Cytoscape `background-image` via data URIs. Stroke-style, designed for dark backgrounds. Each icon is 48x48 viewBox, single color (parameterized so we can tint by status).

| node_type | Icon | Visual |
|-----------|------|--------|
| `server` | Rack server | Tower with horizontal drive bays |
| `router` | Router | Box with four directional arrows |
| `firewall` | Firewall | Brick wall with shield overlay |
| `workstation` | Desktop | Monitor with keyboard base |
| `switch` | Network switch | Rectangular box with port row |
| `access_point` | Wireless AP | Antenna with radiating waves |
| `vpn` | VPN gateway | Padlock with tunnel/pipe |
| `printer` | Printer | Printer with paper tray |
| `iot` | IoT device | Microchip/sensor icon |
| `host` | Generic host | Circle with computer silhouette |
| `unknown` | Unknown | Question mark in dashed circle |

**Cytoscape node style:**
```js
{
  'background-image': getDeviceSvgDataUri(nodeType, statusColor),
  'background-fit': 'contain',
  'background-clip': 'none',
  'background-color': '#0d1117',
  'border-width': 2,
  'border-color': statusColor,   // green=alive, red=compromised, gray=offline
  'width': 50,
  'height': 50,
  'shape': 'roundrectangle',
}
```

### 1.2 OS Logo Badge

A secondary background image in the bottom-right corner showing the detected OS logo (16x16).

| OS Match | Logo |
|----------|------|
| `linux`, `ubuntu`, `debian`, `centos`, `rhel`, `fedora`, `kali` | Tux (Linux penguin) |
| `windows`, `win32`, `win64` | Windows logo |
| `macos`, `darwin`, `mac os x`, `osx` | Apple logo |
| `freebsd`, `openbsd`, `netbsd` | BSD daemon |
| `android` | Android robot |
| `ios`, `iphone`, `ipad` | Apple logo (mobile) |
| `cisco ios`, `cisco` | Cisco bridge icon |
| `junos`, `juniper` | Juniper leaf |
| (no match) | No badge |

**Detection:** Case-insensitive substring match against `os` and `os_version` fields.

**Cytoscape multi-image:**
```js
{
  'background-image': [deviceIconUri, osLogoUri],
  'background-position-x': ['50%', '85%'],
  'background-position-y': ['50%', '85%'],
  'background-width': ['60%', '22%'],
  'background-height': ['60%', '22%'],
}
```

### 1.3 Schema Migration — New Node Types

Add `switch`, `access_point`, `vpn`, `printer`, `iot` to `network_nodes.node_type` CHECK constraint.

```sql
ALTER TABLE network_nodes DROP CONSTRAINT IF EXISTS network_nodes_node_type_check;
ALTER TABLE network_nodes ADD CONSTRAINT network_nodes_node_type_check
  CHECK (node_type IN ('host', 'router', 'firewall', 'server', 'workstation',
                        'switch', 'access_point', 'vpn', 'printer', 'iot', 'unknown'));
```

---

## 2. Enriched Detail Panel — Tabbed Device View

### 2.1 Panel Structure

Replace the current single-section detail panel (320px sidebar) with a **tabbed panel** (380px) that supports deep device inspection and inline editing.

**Tabs:**

| Tab | Icon | Content |
|-----|------|---------|
| **Overview** | `Info` | Identity, status, node type, OS, MAC, discovery source/time |
| **Services** | `Network` | Full port/service table with product versions |
| **Vulns** | `ShieldAlert` | CVE list with severity, CVSS, exploit availability |
| **Interfaces** | `Cable` | Network interfaces: name, MAC, IPs, VLAN, state |
| **Notes** | `StickyNote` | Operator free-text notes (markdown) |

### 2.2 Overview Tab — Inline Editing

Each field in the Overview tab is editable:

- **hostname, os, os_version, mac_address:** Click the value → inline text input → Enter to save, Escape to cancel.
- **status:** Click → dropdown: `discovered`, `alive`, `compromised`, `offline`.
- **node_type:** Click → dropdown with all 11 types, each showing its icon.
- Save triggers `PATCH /api/v1/nodes/{id}` and publishes `network.node_updated` NATS event.
- Visual indicator: pencil icon on hover, brief green flash on successful save.

### 2.3 Services Tab

Sortable table with columns: Port, Protocol, State, Service, Product, Version.

- **Add service:** "+" button at bottom opens inline row with empty fields.
- **Edit service:** Click any cell to edit in place.
- **Remove service:** X button per row (with confirm).
- Changes update the `services` JSONB array via `PATCH /api/v1/nodes/{id}`.

### 2.4 Vulnerabilities Tab

Table with columns: CVE ID (linked), Severity (badge), CVSS, Exploit Available (boolean badge), Status.

- **Add vulnerability:** "+" button → form: CVE ID, title, severity dropdown, CVSS, exploit checkbox, notes.
- **Click CVE row → drill-down view** (see Section 4).
- **Status dropdown** per vuln: `unverified`, `confirmed`, `exploited`, `mitigated`, `accepted_risk`.
- Data stored in `metadata.vulnerabilities` JSONB array.

### 2.5 Interfaces Tab

Table: Interface Name, MAC, IPs (multi-value), VLAN, Link State.

- Editable per row. Add/remove interfaces.
- Data stored in `metadata.interfaces` JSONB array.

### 2.6 Notes Tab

Markdown editor (simple textarea with preview toggle). Auto-saves on blur.
Stored in `metadata.notes` (string).

---

## 3. Auto-Edge Generation + Enrichment

### 3.1 Subnet-Based Auto-Edges

After any import, run edge generation:

1. Parse all nodes' IP addresses.
2. For each CIDR range in the network's `cidr_ranges`, group nodes belonging to that subnet.
3. Within each subnet group:
   - If a node is identified as `router` or `firewall`, create edges from it to all other nodes in the group (`edge_type: 'network_adjacency'`, `confidence: 0.9`, `discovered_by: 'import'`).
   - If no router/firewall found, create a star topology with the first alive node as hub, or a mesh if < 6 nodes (`confidence: 0.6`).
4. Avoid duplicate edges (check existence before insert).

### 3.2 Traceroute-Based Edge Inference

If Nmap scan includes `<trace>` data (from `nmap --traceroute`):

1. Parse `<trace>` → `<hop>` elements per host.
2. Each hop pair `(hop[n] → hop[n+1])` becomes an edge (`edge_type: 'network_adjacency'`, `confidence: 0.95`, `discovered_by: 'import'`).
3. Intermediate hops that don't match existing nodes get created as `router` type with `status: 'discovered'`.
4. This produces a much more accurate topology than subnet grouping.

**Priority:** Traceroute edges override subnet-inferred edges (higher confidence).

### 3.3 Node Type Heuristics (Improved)

Upgrade the import handler's node classification:

```
BGP (179) or OSPF (89) or RIP (520)                    → router
Cisco ASA/pfSense/Palo Alto vendor match + mgmt ports   → firewall
SNMP (161) + multiple interfaces in metadata             → switch
Wireless mgmt ports (Ubiquiti/Ruckus/Aruba vendor)       → access_point
CUPS (631) or IPP (631) or LPD (515) or JetDirect (9100) → printer
RDP (3389) or VNC (5900) + desktop OS keyword            → workstation
HTTP/HTTPS/SSH + server OS keyword                        → server
VPN ports (1194, 500/4500 IKE, WireGuard 51820)          → vpn
MQTT (1883) or CoAP (5683) or Zigbee                     → iot
Default                                                   → host
```

### 3.4 Enrichment Source Tracking

Track which scans contributed to each node's data:

```json
// stored in metadata.enrichment_sources
[
  { "source": "nmap", "file": "scan-2026-02-24.xml", "imported_at": "2026-02-24T12:00:00Z", "fields_updated": ["ip_address", "hostname", "os", "services"] },
  { "source": "nessus", "file": "vuln-scan.nessus", "imported_at": "2026-02-24T14:00:00Z", "fields_updated": ["metadata.vulnerabilities"] }
]
```

---

## 4. Vulnerability Drill-Down — Exploit Mapping

### 4.1 Drill-Down View

Clicking a CVE row in the Vulnerabilities tab opens a **slide-over panel** (or replaces the detail panel content) with:

| Section | Content |
|---------|---------|
| **CVE Summary** | CVE ID, title, description, published date |
| **Severity** | CVSS score, vector string, severity badge (Critical/High/Medium/Low/Info) |
| **Affected Services** | Which services on this node match the vuln (port + product + version) |
| **Known Exploits** | List of exploit references: Metasploit module path, ExploitDB ID, PoC URL, custom |
| **Attack Notes** | Free-text: approach, prerequisites, estimated difficulty (1-5), tools needed, OPSEC considerations |
| **Status** | Dropdown: `unverified` → `confirmed` → `exploited` → `mitigated` → `accepted_risk` |
| **Timeline** | Auto-logged: when discovered, when confirmed, when exploited, by whom |

### 4.2 Exploit Entry

Each exploit reference is a structured object:
```json
{
  "type": "metasploit",       // metasploit | exploitdb | poc_url | custom
  "reference": "exploit/linux/http/apache_mod_cgi_bash_env_exec",
  "url": "https://...",       // optional
  "verified": false,
  "notes": "Requires HTTP access to cgi-bin"
}
```

Operators add exploit references manually via a form. Future: auto-populate from Nessus plugin data or ExploitDB API.

### 4.3 Vulnerability Data Schema

Stored in `metadata.vulnerabilities[]`:
```json
{
  "cve_id": "CVE-2024-1234",
  "title": "Apache HTTP Server RCE via mod_cgi",
  "description": "...",
  "severity": "critical",
  "cvss": 9.8,
  "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
  "exploit_available": true,
  "exploits": [...],           // array of exploit references
  "affected_services": [22, 80],  // port numbers
  "status": "confirmed",
  "attack_notes": "...",
  "detected_at": "2026-02-24T12:00:00Z",
  "detected_by": "nessus",
  "timeline": [
    { "event": "detected", "at": "...", "by": "import" },
    { "event": "confirmed", "at": "...", "by": "user:admin" }
  ]
}
```

---

## 5. Customizable Node Display Schema

### 5.1 Display Schema Format

Admins configure how node data appears in the detail panel via a YAML/JSON schema document.

**Storage:** `display_schemas` table:
```sql
CREATE TABLE display_schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  schema_type VARCHAR(32) NOT NULL CHECK (schema_type IN ('node_detail', 'node_tooltip', 'edge_detail')),
  definition JSONB NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Schema definition (JSONB, authored as YAML in the editor):**
```yaml
version: 1
name: "Default Node Detail"
sections:
  - key: identity
    label: "Identity"
    icon: "info"
    fields:
      - key: hostname
        label: "Hostname"
        source: "hostname"
        editable: true
        type: text
      - key: ip_address
        label: "IP Address"
        source: "ip_address"
        editable: false
        type: text
      - key: os_display
        label: "Operating System"
        source: "os"
        format: "os_with_logo"
        editable: true
        type: text
      - key: mac_address
        label: "MAC Address"
        source: "mac_address"
        editable: true
        type: text
        show_when: "value != null"

  - key: classification
    label: "Classification"
    fields:
      - key: status
        label: "Status"
        source: "status"
        editable: true
        type: select
        options: ["discovered", "alive", "compromised", "offline"]
        format: "status_badge"
      - key: node_type
        label: "Device Type"
        source: "node_type"
        editable: true
        type: select
        options: ["server", "router", "firewall", "workstation", "switch",
                  "access_point", "vpn", "printer", "iot", "host", "unknown"]
        format: "device_type_icon"

  - key: services
    label: "Services"
    source: "services"
    type: table
    editable: true
    columns:
      - { key: port, label: "Port", width: 60, type: integer }
      - { key: protocol, label: "Proto", width: 50, type: text }
      - { key: state, label: "State", width: 60, type: text }
      - { key: service, label: "Service", type: text }
      - { key: product, label: "Product", type: text }
      - { key: version, label: "Version", type: text }

  - key: vulnerabilities
    label: "Vulnerabilities"
    source: "metadata.vulnerabilities"
    type: table
    editable: true
    columns:
      - { key: cve_id, label: "CVE", format: "cve_link" }
      - { key: severity, label: "Severity", format: "severity_badge" }
      - { key: cvss, label: "CVSS", type: number }
      - { key: exploit_available, label: "Exploit?", format: "boolean_badge" }
      - { key: status, label: "Status", type: select,
          options: ["unverified", "confirmed", "exploited", "mitigated", "accepted_risk"] }

  - key: interfaces
    label: "Interfaces"
    source: "metadata.interfaces"
    type: table
    editable: true
    columns:
      - { key: name, label: "Name", type: text }
      - { key: mac, label: "MAC", type: text }
      - { key: ips, label: "IPs", type: text_array }
      - { key: vlan, label: "VLAN", type: integer }
      - { key: state, label: "State", type: text }

  - key: notes
    label: "Notes"
    source: "metadata.notes"
    type: markdown
    editable: true
```

### 5.2 Admin Schema Editor

Accessible from Admin > Display Schemas. Split-pane view:

- **Left:** YAML editor (Monaco or CodeMirror with YAML syntax highlighting, validation, autocomplete for known field types/formats).
- **Right:** Live preview — renders a mock node detail panel using the current schema + sample node data.
- **Top bar:** Schema name, save button, "Reset to Default" button, version indicator.
- Validation on save: checks all `source` paths resolve, all `type` values are valid, all `format` values have registered renderers.

### 5.3 Format Renderers (Extensible)

Built-in format renderers:
- `os_with_logo` — OS text + small logo icon
- `status_badge` — Colored pill badge
- `device_type_icon` — Icon + text
- `severity_badge` — Color-coded severity (Critical=red, High=orange, Med=yellow, Low=blue, Info=gray)
- `boolean_badge` — Green check / red X
- `cve_link` — Clickable link opening drill-down
- `timestamp` — Formatted date/time

---

## 6. Visual Parser Workbench

### 6.1 Overview

Full-page admin tool for creating and editing import parser definitions. Three-panel layout with drag-and-drop field mapping.

### 6.2 Data Model

**`import_parsers` table:**
```sql
CREATE TABLE import_parsers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  description TEXT,
  format VARCHAR(32) NOT NULL CHECK (format IN ('xml', 'json', 'csv', 'tsv', 'custom')),
  version INTEGER DEFAULT 1,
  definition JSONB NOT NULL,
  sample_data TEXT,
  is_default BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.3 Parser Definition Schema

```yaml
name: "Nmap XML"
format: xml
version: 1

# How to find host entries in the source
root_path: "nmaprun.host"
skip_when:
  - field: "status.state"
    operator: "!="
    value: "up"

# Field mappings: source path → target node field
field_mappings:
  - target: ip_address
    source: "address"
    filter: { field: "addrtype", value: "ipv4" }
    extract: "addr"
    required: true

  - target: mac_address
    source: "address"
    filter: { field: "addrtype", value: "mac" }
    extract: "addr"

  - target: hostname
    source: "hostnames.hostname"
    filter: { field: "type", value: "PTR" }
    extract: "name"

  - target: os
    source: "os.osmatch"
    extract: "name"
    select: first    # first = highest accuracy

  - target: services
    source: "ports.port"
    type: array
    sub_mappings:
      - { target: port, source: "portid", transform: to_integer }
      - { target: protocol, source: "protocol" }
      - { target: state, source: "state.state" }
      - { target: service, source: "service.name" }
      - { target: product, source: "service.product" }
      - { target: version, source: "service.version" }

# Traceroute edge inference (optional)
edge_mappings:
  - source: "trace.hop"
    type: sequential_pairs    # hop[n] → hop[n+1] = edge
    node_field: "ipaddr"
    create_intermediate: true  # create router nodes for hops not in existing nodes
    edge_type: network_adjacency
    confidence: 0.95

# Node type classification rules (evaluated in order)
node_type_rules:
  - condition: "services.any(s => [179, 89, 520].includes(s.port))"
    type: router
  - condition: "os.match(/cisco|pfsense|palo alto|fortinet/i)"
    type: firewall
  - condition: "services.any(s => [631, 515, 9100].includes(s.port))"
    type: printer
  - condition: "services.any(s => [3389, 5900].includes(s.port)) && os.match(/windows|mac/i)"
    type: workstation
  - condition: "services.any(s => [80, 443, 3306, 5432, 27017].includes(s.port))"
    type: server
  - default: host
```

### 6.4 Three-Panel Workbench UI

#### Left Panel: Source Inspector
- **Upload area** at top: drag file or click to browse. Accepts XML, JSON, CSV, TSV.
- File parsed and displayed as an **expandable tree view**:
  - XML: tag hierarchy with attributes shown inline
  - JSON: object/array hierarchy
  - CSV/TSV: column headers as fields, first 5 rows as sample
- Each leaf field is **draggable** (HTML5 drag).
- Fields already mapped show a green dot + target field name.
- Array elements show `[N items]` badge; expand to see first item's structure.
- Search/filter box at top to find fields by name.

#### Center Panel: Mapping Canvas
- **SVG overlay** drawing Bezier curves from source fields (left) to target fields (right).
- Line color indicates mapping type: green=direct, blue=filtered, orange=transformed.
- **Click a line** → popover with:
  - Transform dropdown: `as_is`, `to_integer`, `to_lowercase`, `to_uppercase`, `regex_extract(pattern)`, `map_each` (for arrays), `first`, `join(separator)`.
  - Filter: field + operator + value (for selecting from arrays, e.g., `addrtype == 'ipv4'`).
  - Extract: sub-field to pull from filtered result.
  - Live preview: shows the transform output using sample data.
- **Delete mapping:** X button on the line.
- **Node type rules** section at bottom: list of condition → type rules. Add/edit/reorder/delete. Drag to reorder priority.
- **Skip conditions** section: list of filter rules for skipping entries.

#### Right Panel: Target Schema + Preview
- **Target fields** list: all node fields (ip_address, hostname, mac_address, os, os_version, status, node_type, services, metadata.*).
- Each field shows:
  - Field name + expected type
  - Drop target indicator (dashed border when dragging)
  - Current mapping summary (if mapped)
  - Required indicator (red asterisk for ip_address)
- **Live Preview** section at bottom:
  - Renders a mock node card using current mappings applied to the first host in sample data.
  - Shows: device icon, hostname, IP, OS logo, services list, node type badge.
  - Updates in real-time as mappings change.
- **"Test Import" button:** Runs the full parser on the sample file. Shows results table: how many nodes would be created, any parsing errors, field coverage stats.

### 6.5 Default Parsers (Seed Data)

| Parser | Format | Extracts |
|--------|--------|----------|
| **Nmap XML** | XML | Hosts, IPs, MACs, hostnames, OS, services, traceroute → edges |
| **Nessus XML (.nessus)** | XML | Hosts, IPs, OS, services, vulnerabilities (CVE, CVSS, severity, plugin data) |
| **Masscan JSON** | JSON | IPs, ports (fast scan, minimal metadata) |
| **Zeek conn.log** | TSV | Connection pairs → edges (source IP:port → dest IP:port), protocol, duration, bytes |

Each default parser includes a sample file for the workbench preview.

### 6.6 Parser Engine (Backend)

The Go endpoint-service import handler changes from hardcoded Nmap parsing to a **generic parser engine**:

1. Receive file upload + parser ID (or auto-detect format).
2. Load parser definition from database.
3. Parse file according to format (xml.Decoder, json.Decoder, csv.Reader).
4. Navigate to `root_path` to find host entries.
5. Apply `skip_when` filters.
6. For each host entry, apply `field_mappings` to extract node fields.
7. Apply `node_type_rules` to classify.
8. Apply `edge_mappings` if present.
9. Upsert nodes and edges.
10. Return import result with stats.

The existing hardcoded Nmap parser becomes the seed data for the "Nmap XML" parser definition. The engine replaces it.

---

## 7. API Additions

### New Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET /api/v1/display-schemas` | List display schemas |
| `GET /api/v1/display-schemas/{id}` | Get schema |
| `POST /api/v1/display-schemas` | Create schema |
| `PATCH /api/v1/display-schemas/{id}` | Update schema |
| `DELETE /api/v1/display-schemas/{id}` | Delete (non-default only) |
| `GET /api/v1/import-parsers` | List parsers |
| `GET /api/v1/import-parsers/{id}` | Get parser with definition |
| `POST /api/v1/import-parsers` | Create parser |
| `PATCH /api/v1/import-parsers/{id}` | Update parser |
| `DELETE /api/v1/import-parsers/{id}` | Delete (non-default only) |
| `POST /api/v1/import-parsers/{id}/test` | Test parser against uploaded file (dry run) |

### Modified Endpoints

| Method | Path | Change |
|--------|------|--------|
| `POST /api/v1/networks/{id}/import` | Accepts optional `parser_id` query param. If absent, auto-detects format and uses default parser. |
| `PATCH /api/v1/nodes/{id}` | Now supports patching `metadata.vulnerabilities`, `metadata.interfaces`, `metadata.notes`, and `metadata.enrichment_sources`. |

---

## 8. Database Migration

**File:** `infra/db/postgres/migrations/005_network_enhancements.sql`

```sql
-- Extend node_type CHECK constraint
ALTER TABLE network_nodes DROP CONSTRAINT IF EXISTS network_nodes_node_type_check;
ALTER TABLE network_nodes ADD CONSTRAINT network_nodes_node_type_check
  CHECK (node_type IN ('host', 'router', 'firewall', 'server', 'workstation',
                        'switch', 'access_point', 'vpn', 'printer', 'iot', 'unknown'));

-- Display schemas table
CREATE TABLE display_schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  schema_type VARCHAR(32) NOT NULL CHECK (schema_type IN ('node_detail', 'node_tooltip', 'edge_detail')),
  definition JSONB NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Import parsers table
CREATE TABLE import_parsers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  description TEXT,
  format VARCHAR(32) NOT NULL CHECK (format IN ('xml', 'json', 'csv', 'tsv', 'custom')),
  version INTEGER DEFAULT 1,
  definition JSONB NOT NULL,
  sample_data TEXT,
  is_default BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default display schema (node_detail)
INSERT INTO display_schemas (name, schema_type, definition, is_default) VALUES (
  'Default Node Detail', 'node_detail', '{ ... }', true
);

-- Seed default parsers
INSERT INTO import_parsers (name, description, format, definition, is_default) VALUES
  ('Nmap XML', 'Standard Nmap XML output (-oX)', 'xml', '{ ... }', true),
  ('Nessus XML', 'Tenable Nessus .nessus export', 'xml', '{ ... }', true),
  ('Masscan JSON', 'Masscan JSON output (-oJ)', 'json', '{ ... }', true),
  ('Zeek conn.log', 'Zeek/Bro connection log (TSV)', 'tsv', '{ ... }', true);
```

---

## 9. Implementation Phases

### Phase 1: SVG Icons + Improved Node Types (Frontend + Migration)
- Create SVG icon set for all 11 device types
- Create OS logo SVG set
- Update Cytoscape stylesheet to use background-image approach
- Run migration 005 for expanded node_type constraint
- Update node type heuristics in import handler

### Phase 2: Enriched Detail Panel (Frontend)
- Tabbed panel with Overview, Services, Vulns, Interfaces, Notes
- Inline editing for all fields
- PATCH API integration
- Vulnerability drill-down view with exploit mapping

### Phase 3: Auto-Edge Generation + Traceroute (Backend)
- Subnet-based edge auto-generation after import
- Traceroute parsing from Nmap XML
- Enrichment source tracking in metadata

### Phase 4: Display Schema System (Backend + Frontend)
- `display_schemas` table + CRUD API
- Schema-driven detail panel renderer
- Admin schema editor with YAML editor + live preview

### Phase 5: Parser Workbench (Backend + Frontend)
- `import_parsers` table + CRUD API
- Generic parser engine replacing hardcoded Nmap parser
- Three-panel visual workbench UI
- Default parser seed data (Nmap, Nessus, Masscan, Zeek)
- Test import (dry run) endpoint

---

## 10. File Inventory

### New Files
- `frontend/src/components/network-map/DeviceIcons.tsx` — SVG icon components + data URI generators
- `frontend/src/components/network-map/OsLogos.tsx` — OS logo SVGs + detection logic
- `frontend/src/components/network-map/NodeDetailPanel.tsx` — Tabbed detail panel
- `frontend/src/components/network-map/VulnDrillDown.tsx` — Vulnerability drill-down view
- `frontend/src/components/network-map/InlineEditor.tsx` — Reusable inline edit components
- `frontend/src/pages/admin/DisplaySchemaEditor.tsx` — Schema YAML editor + preview
- `frontend/src/pages/admin/ParserWorkbench.tsx` — Three-panel parser builder
- `frontend/src/pages/admin/ParserWorkbench/SourceInspector.tsx` — Left panel: file tree
- `frontend/src/pages/admin/ParserWorkbench/MappingCanvas.tsx` — Center panel: SVG lines
- `frontend/src/pages/admin/ParserWorkbench/TargetSchema.tsx` — Right panel: drop targets + preview
- `infra/db/postgres/migrations/005_network_enhancements.sql`

### Modified Files
- `frontend/src/pages/operation-tabs/NetworksTab.tsx` — Use new icon system, new detail panel component
- `services/endpoint/main.go` — Generic parser engine, auto-edge generation, traceroute parsing, new API endpoints
- `infra/traefik/dynamic.yml` — Routes for display-schemas and import-parsers
- `frontend/src/App.tsx` — Admin routes for schema editor and parser workbench
