# M4b+ Network Map Enhancements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the network topology map into a full ops planning surface with SVG device icons, OS logos, editable tabbed detail panel, vulnerability drill-down, auto-edge generation, admin-configurable display schemas, and a visual parser workbench.

**Architecture:** Extend endpoint-service (Go) with improved heuristics, auto-edge generation, traceroute parsing, generic parser engine, and new CRUD APIs for display schemas and import parsers. Extend frontend with SVG-based Cytoscape rendering, tabbed detail panel with inline editing, admin pages for schema editor and parser workbench.

**Tech Stack:** Go 1.22+, pgx/v5, Cytoscape.js (SVG background-image), React 18, TypeScript, PostgreSQL JSONB, YAML/JSON schemas.

**Design doc:** `docs/plans/2026-02-24-m4b-network-map-enhancements-design.md`

---

## Phase 1: SVG Icons + Improved Node Type Heuristics

### Task 1: Database Migration — Extended Node Types + New Tables

**Files:**
- Create: `infra/db/postgres/migrations/005_network_enhancements.sql`

**Step 1: Write the migration**

```sql
-- 005_network_enhancements.sql
-- Extends node_type constraint, adds display_schemas and import_parsers tables

-- Extend node_type CHECK constraint with new device types
ALTER TABLE network_nodes DROP CONSTRAINT IF EXISTS network_nodes_node_type_check;
ALTER TABLE network_nodes ADD CONSTRAINT network_nodes_node_type_check
  CHECK (node_type IN (
    'host', 'router', 'firewall', 'server', 'workstation',
    'switch', 'access_point', 'vpn', 'printer', 'iot', 'unknown'
  ));

-- Display schemas — admin-configurable node/edge detail views
CREATE TABLE IF NOT EXISTS display_schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  schema_type VARCHAR(32) NOT NULL CHECK (schema_type IN ('node_detail', 'node_tooltip', 'edge_detail')),
  definition JSONB NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_display_schemas_type ON display_schemas(schema_type);

-- Import parsers — configurable field-mapping definitions for data sources
CREATE TABLE IF NOT EXISTS import_parsers (
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

CREATE INDEX idx_import_parsers_format ON import_parsers(format);

-- Add updated_at triggers for new tables
CREATE TRIGGER set_display_schemas_updated_at
  BEFORE UPDATE ON display_schemas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_import_parsers_updated_at
  BEFORE UPDATE ON import_parsers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed default display schema for node detail
INSERT INTO display_schemas (name, schema_type, definition, is_default) VALUES (
  'Default Node Detail', 'node_detail', '{
    "version": 1,
    "sections": [
      {
        "key": "identity",
        "label": "Identity",
        "fields": [
          {"key": "hostname", "label": "Hostname", "source": "hostname", "editable": true, "type": "text"},
          {"key": "ip_address", "label": "IP Address", "source": "ip_address", "editable": false, "type": "text"},
          {"key": "os_display", "label": "Operating System", "source": "os", "format": "os_with_logo", "editable": true, "type": "text"},
          {"key": "mac_address", "label": "MAC Address", "source": "mac_address", "editable": true, "type": "text"}
        ]
      },
      {
        "key": "classification",
        "label": "Classification",
        "fields": [
          {"key": "status", "label": "Status", "source": "status", "editable": true, "type": "select", "options": ["discovered", "alive", "compromised", "offline"], "format": "status_badge"},
          {"key": "node_type", "label": "Device Type", "source": "node_type", "editable": true, "type": "select", "options": ["server","router","firewall","workstation","switch","access_point","vpn","printer","iot","host","unknown"], "format": "device_type_icon"}
        ]
      },
      {
        "key": "services",
        "label": "Services",
        "source": "services",
        "type": "table",
        "editable": true,
        "columns": [
          {"key": "port", "label": "Port", "width": 60, "type": "integer"},
          {"key": "protocol", "label": "Proto", "width": 50, "type": "text"},
          {"key": "service", "label": "Service", "type": "text"},
          {"key": "product", "label": "Product", "type": "text"},
          {"key": "version", "label": "Version", "type": "text"}
        ]
      },
      {
        "key": "vulnerabilities",
        "label": "Vulnerabilities",
        "source": "metadata.vulnerabilities",
        "type": "table",
        "editable": true,
        "columns": [
          {"key": "cve_id", "label": "CVE", "format": "cve_link"},
          {"key": "severity", "label": "Severity", "format": "severity_badge"},
          {"key": "cvss", "label": "CVSS", "type": "number"},
          {"key": "exploit_available", "label": "Exploit?", "format": "boolean_badge"},
          {"key": "status", "label": "Status", "type": "select", "options": ["unverified","confirmed","exploited","mitigated","accepted_risk"]}
        ]
      },
      {
        "key": "interfaces",
        "label": "Interfaces",
        "source": "metadata.interfaces",
        "type": "table",
        "editable": true,
        "columns": [
          {"key": "name", "label": "Name", "type": "text"},
          {"key": "mac", "label": "MAC", "type": "text"},
          {"key": "ips", "label": "IPs", "type": "text_array"},
          {"key": "vlan", "label": "VLAN", "type": "integer"},
          {"key": "state", "label": "State", "type": "text"}
        ]
      },
      {
        "key": "notes",
        "label": "Notes",
        "source": "metadata.notes",
        "type": "markdown",
        "editable": true
      }
    ]
  }', true
);

-- Seed default Nmap parser
INSERT INTO import_parsers (name, description, format, definition, is_default) VALUES (
  'Nmap XML', 'Standard Nmap XML output (-oX or -oA)', 'xml', '{
    "version": 1,
    "root_element": "nmaprun",
    "host_element": "host",
    "skip_when": [{"field": "status.state", "operator": "!=", "value": "up"}],
    "field_mappings": [
      {"target": "ip_address", "source": "address", "filter": {"field": "addrtype", "value": "ipv4"}, "extract": "addr", "required": true},
      {"target": "mac_address", "source": "address", "filter": {"field": "addrtype", "value": "mac"}, "extract": "addr"},
      {"target": "hostname", "source": "hostnames.hostname", "filter": {"field": "type", "value": "PTR"}, "extract": "name"},
      {"target": "os", "source": "os.osmatch", "extract": "name", "select": "first"},
      {"target": "services", "source": "ports.port", "type": "array", "sub_mappings": [
        {"target": "port", "source": "portid", "transform": "to_integer"},
        {"target": "protocol", "source": "protocol"},
        {"target": "state", "source": "state.state"},
        {"target": "service", "source": "service.name"},
        {"target": "product", "source": "service.product"},
        {"target": "version", "source": "service.version"}
      ]}
    ],
    "edge_mappings": [
      {"source": "trace.hop", "type": "sequential_pairs", "node_field": "ipaddr", "create_intermediate": true, "edge_type": "network_adjacency", "confidence": 0.95}
    ],
    "node_type_rules": [
      {"condition": "ports_include_any", "ports": [179, 89, 520], "type": "router"},
      {"condition": "vendor_match", "patterns": ["cisco asa", "pfsense", "palo alto", "fortinet", "sonicwall"], "type": "firewall"},
      {"condition": "ports_include_any", "ports": [631, 515, 9100], "type": "printer"},
      {"condition": "ports_include_any", "ports": [3389, 5900], "os_match": "windows|mac", "type": "workstation"},
      {"condition": "ports_include_any", "ports": [1194, 500, 4500, 51820], "type": "vpn"},
      {"condition": "ports_include_any", "ports": [1883, 5683], "type": "iot"},
      {"condition": "ports_include_any", "ports": [80, 443, 22, 3306, 5432, 27017, 6379], "type": "server"},
      {"condition": "default", "type": "host"}
    ]
  }', true
),
(
  'Nessus XML', 'Tenable Nessus .nessus export file', 'xml', '{
    "version": 1,
    "root_element": "NessusClientData_v2",
    "host_element": "Report.ReportHost",
    "field_mappings": [
      {"target": "ip_address", "source": "HostProperties.tag", "filter": {"field": "name", "value": "host-ip"}, "extract": "_text"},
      {"target": "hostname", "source": "HostProperties.tag", "filter": {"field": "name", "value": "hostname"}, "extract": "_text"},
      {"target": "os", "source": "HostProperties.tag", "filter": {"field": "name", "value": "operating-system"}, "extract": "_text"},
      {"target": "mac_address", "source": "HostProperties.tag", "filter": {"field": "name", "value": "mac-address"}, "extract": "_text"},
      {"target": "services", "source": "ReportItem", "type": "array", "filter": {"field": "port", "operator": ">", "value": "0"}, "sub_mappings": [
        {"target": "port", "source": "port", "transform": "to_integer"},
        {"target": "protocol", "source": "protocol"},
        {"target": "service", "source": "svc_name"},
        {"target": "state", "source": "_constant", "value": "open"}
      ]},
      {"target": "metadata.vulnerabilities", "source": "ReportItem", "type": "array", "filter": {"field": "severity", "operator": ">", "value": "0"}, "sub_mappings": [
        {"target": "cve_id", "source": "cve"},
        {"target": "title", "source": "pluginName"},
        {"target": "severity", "source": "risk_factor", "transform": "to_lowercase"},
        {"target": "cvss", "source": "cvss3_base_score", "transform": "to_float"},
        {"target": "description", "source": "description"},
        {"target": "detected_by", "source": "_constant", "value": "nessus"}
      ]}
    ],
    "node_type_rules": [
      {"condition": "default", "type": "host"}
    ]
  }', true
),
(
  'Masscan JSON', 'Masscan JSON output (-oJ)', 'json', '{
    "version": 1,
    "root_path": "$",
    "host_element": "$[*]",
    "field_mappings": [
      {"target": "ip_address", "source": "ip", "required": true},
      {"target": "services", "source": "ports", "type": "array", "sub_mappings": [
        {"target": "port", "source": "port", "transform": "to_integer"},
        {"target": "protocol", "source": "proto"},
        {"target": "state", "source": "status"},
        {"target": "service", "source": "service.name"}
      ]}
    ],
    "node_type_rules": [
      {"condition": "default", "type": "host"}
    ]
  }', true
),
(
  'Zeek conn.log', 'Zeek/Bro connection log (TSV format)', 'tsv', '{
    "version": 1,
    "comment_prefix": "#",
    "separator": "\t",
    "header_line": "#fields",
    "creates_edges": true,
    "field_mappings": [
      {"target": "source_ip", "source": "id.orig_h"},
      {"target": "source_port", "source": "id.orig_p", "transform": "to_integer"},
      {"target": "dest_ip", "source": "id.resp_h"},
      {"target": "dest_port", "source": "id.resp_p", "transform": "to_integer"},
      {"target": "protocol", "source": "proto"},
      {"target": "duration", "source": "duration", "transform": "to_float"},
      {"target": "bytes_sent", "source": "orig_bytes", "transform": "to_integer"},
      {"target": "bytes_recv", "source": "resp_bytes", "transform": "to_integer"}
    ],
    "edge_generation": {
      "source_field": "source_ip",
      "target_field": "dest_ip",
      "edge_type": "network_adjacency",
      "label_template": "{protocol}:{dest_port}",
      "confidence": 0.85,
      "discovered_by": "import"
    },
    "node_type_rules": [
      {"condition": "default", "type": "host"}
    ]
  }', true
);
```

**Step 2: Apply migration**

```bash
docker compose exec postgres psql -U ems_user -d ems_cop -f /docker-entrypoint-initdb.d/005_network_enhancements.sql
```

Note: The migration file needs to be volume-mounted. Simplest approach: copy into running container and execute, or add to docker-compose volumes. The existing pattern mounts `infra/db/postgres/migrations/` to `/docker-entrypoint-initdb.d/`. For an already-running database, run manually:

```bash
docker compose cp infra/db/postgres/migrations/005_network_enhancements.sql postgres:/tmp/
docker compose exec postgres psql -U ems_user -d ems_cop -f /tmp/005_network_enhancements.sql
```

**Step 3: Verify**

```bash
# Check constraint updated
docker compose exec postgres psql -U ems_user -d ems_cop -c "\d network_nodes" | grep node_type

# Check new tables exist
docker compose exec postgres psql -U ems_user -d ems_cop -c "SELECT name, schema_type, is_default FROM display_schemas;"
docker compose exec postgres psql -U ems_user -d ems_cop -c "SELECT name, format, is_default FROM import_parsers;"
```

Expected: 4 parsers (Nmap, Nessus, Masscan, Zeek) and 1 display schema (Default Node Detail).

**Step 4: Commit**

```bash
git add infra/db/postgres/migrations/005_network_enhancements.sql
git commit -m "feat: migration 005 — extended node types, display_schemas, import_parsers with seed data"
```

---

### Task 2: SVG Device Icons + OS Logos Component

**Files:**
- Create: `frontend/src/components/network-map/DeviceIcons.ts`
- Create: `frontend/src/components/network-map/OsLogos.ts`

**Context:** These files export functions that return SVG data URIs for use as Cytoscape `background-image`. Each icon is a monochrome SVG designed for dark backgrounds, with a configurable stroke color parameter.

**Step 1: Create DeviceIcons.ts**

Create `frontend/src/components/network-map/DeviceIcons.ts` with:

- A `getDeviceSvgDataUri(nodeType: string, color?: string): string` function.
- 11 inline SVG strings (one per node_type: server, router, firewall, workstation, switch, access_point, vpn, printer, iot, host, unknown).
- Each SVG: 48x48 viewBox, stroke-based (not fill), using the provided `color` parameter (default: `#8899aa`).
- The function returns a `data:image/svg+xml;utf8,...` URI string with the SVG URL-encoded.
- Export a `DEVICE_TYPES` array with all 11 types for dropdown menus.

Design guidance for each icon:
- `server`: Vertical rectangle with 3 horizontal lines (drive bays), small power LED circle
- `router`: Rectangle with 4 arrows pointing outward (N/S/E/W)
- `firewall`: Brick wall pattern (3 rows of offset rectangles) with a small shield overlay
- `workstation`: Monitor rectangle on a stand/base with a keyboard line
- `switch`: Wide rectangle with a row of small port squares along the bottom
- `access_point`: Triangle/cone shape with curved radio wave arcs above
- `vpn`: Closed padlock with a horizontal tunnel/pipe passing through
- `printer`: Box with paper coming out the top, small tray at bottom
- `iot`: Chip outline (rectangle with small pins on sides)
- `host`: Simple circle with a small desktop silhouette inside
- `unknown`: Dashed circle with a question mark centered

**Step 2: Create OsLogos.ts**

Create `frontend/src/components/network-map/OsLogos.ts` with:

- A `getOsLogoDataUri(os: string): string | null` function.
- A `detectOs(os: string, osVersion?: string): string` function that returns one of: `'linux'`, `'windows'`, `'macos'`, `'freebsd'`, `'cisco'`, `'android'`, `'unknown'`.
- SVG logos (simplified/stylized versions): Tux penguin for Linux, 4-pane window for Windows, apple silhouette for macOS, BSD daemon simplified for FreeBSD, bridge icon for Cisco, robot head for Android.
- Each logo: 24x24 viewBox, fill-based (solid color, not stroke), designed to be small and recognizable at 16x16 rendering.
- Returns `null` for unknown OS (no badge displayed).

OS detection rules (case-insensitive):
- Contains `linux|ubuntu|debian|centos|rhel|fedora|kali|arch|suse|alpine|mint` → `linux`
- Contains `windows|win32|win64|win10|win11|microsoft` → `windows`
- Contains `macos|darwin|mac os|osx|apple` → `macos`
- Contains `freebsd|openbsd|netbsd` → `freebsd`
- Contains `cisco|ios xe|ios xr|nxos|catalyst` → `cisco`
- Contains `android` → `android`
- Else → `unknown`

**Step 3: Verify TypeScript compiles**

```bash
docker compose exec frontend npx tsc --noEmit 2>&1 | head -20
```

Or rebuild frontend:

```bash
docker compose up -d --build frontend
```

Expected: No TypeScript errors.

**Step 4: Commit**

```bash
git add frontend/src/components/network-map/
git commit -m "feat: SVG device icons and OS logo components for network map nodes"
```

---

### Task 3: Cytoscape Stylesheet — SVG Background Images

**Files:**
- Modify: `frontend/src/pages/operation-tabs/NetworksTab.tsx`

**Context:** Replace the current shape-based node rendering (rectangle for server, diamond for router, etc.) with SVG background-image rendering. Import the new icon/logo modules. Update the Cytoscape stylesheet and element data to use the new system.

**Step 1: Update imports and Cytoscape initialization**

At the top of `NetworksTab.tsx`, add:
```typescript
import { getDeviceSvgDataUri } from '../../components/network-map/DeviceIcons'
import { getOsLogoDataUri, detectOs } from '../../components/network-map/OsLogos'
```

**Step 2: Replace the Cytoscape stylesheet (lines ~78-120)**

Replace the existing stylesheet array with a new one that:
- Base node style: `shape: 'roundrectangle'`, `width: 54`, `height: 54`, `background-color: '#0d1117'`, `border-width: 2`, `border-color: '#3a4a5c'`.
- Status-based border colors remain: alive=#40c057, compromised=#ff6b6b (border-width 3), offline=#1e2a3a (opacity 0.5), selected=#4dabf7 (border-width 3).
- Remove all nodeType→shape selectors (no more diamond, hexagon, ellipse).
- The background-image is set PER ELEMENT in the elements data (not in the stylesheet), because each node has a different icon + OS logo combination.

**Step 3: Update element creation**

When building the Cytoscape elements array (currently around line 230-250), update node data to include:
```typescript
...nodes.map((n) => {
  const statusColor = n.status === 'compromised' ? '#ff6b6b'
                    : n.status === 'offline' ? '#1e2a3a'
                    : '#40c057'
  const deviceIcon = getDeviceSvgDataUri(n.node_type, statusColor)
  const osLogo = getOsLogoDataUri(n.os || '')

  return {
    data: {
      id: n.id,
      label: n.hostname || n.ip_address,
      nodeType: n.node_type,
      status: n.status,
      // SVG background images
      deviceIcon,
      osLogo: osLogo || undefined,
    },
    style: {
      'background-image': osLogo ? [deviceIcon, osLogo] : [deviceIcon],
      'background-fit': 'contain',
      'background-clip': 'none',
      ...(osLogo ? {
        'background-position-x': ['50%', '82%'],
        'background-position-y': ['45%', '82%'],
        'background-width': ['55%', '24%'],
        'background-height': ['55%', '24%'],
      } : {
        'background-position-x': '50%',
        'background-position-y': '45%',
        'background-width': '55%',
        'background-height': '55%',
      }),
    },
    position: n.position_x != null && n.position_y != null
      ? { x: n.position_x, y: n.position_y }
      : undefined,
  }
}),
```

**Step 4: Update the detail panel node type icon**

In the `getNodeTypeIcon` helper function and the `renderNodeDetailPanel` function, replace the Lucide icons with the device SVGs rendered as `<img src={getDeviceSvgDataUri(nodeType)} />` for consistency.

**Step 5: Rebuild and test**

```bash
docker compose up -d --build frontend
```

Navigate to Operations → Test Op → Networks → Test LAN. Verify:
- Nodes show SVG device icons (servers should show rack icon)
- OS logos appear in bottom-right corner (Linux Tux for the Linux 5.15 nodes)
- Status border colors still work (green for alive)
- Node selection still works (blue border)

**Step 6: Commit**

```bash
git add frontend/src/pages/operation-tabs/NetworksTab.tsx
git commit -m "feat: SVG device icons and OS logos on Cytoscape network map nodes"
```

---

### Task 4: Improved Node Type Heuristics in Import Handler

**Files:**
- Modify: `services/endpoint/main.go` (around lines 1342-1350)

**Context:** The current heuristic is very basic — any node with http/ssh/mysql gets `server`. Upgrade to a priority-ordered rule set that properly classifies routers, firewalls, printers, workstations, VPNs, and IoT devices.

**Step 1: Replace the node_type heuristic block**

Replace the existing heuristic logic (lines ~1342-1350) with a new `classifyNodeType` function:

```go
func classifyNodeType(services []map[string]any, osName string, vendor string) string {
    portSet := make(map[int]bool)
    serviceSet := make(map[string]bool)
    for _, svc := range services {
        if p, ok := svc["port"].(float64); ok {
            portSet[int(p)] = true
        } else if p, ok := svc["port"].(int); ok {
            portSet[p] = true
        }
        if s, ok := svc["service"].(string); ok {
            serviceSet[strings.ToLower(s)] = true
        }
    }

    osLower := strings.ToLower(osName)
    vendorLower := strings.ToLower(vendor)

    // Router: BGP, OSPF, RIP
    if portSet[179] || portSet[89] || portSet[520] {
        return "router"
    }
    // Firewall: known vendors + management ports
    firewallVendors := []string{"cisco asa", "pfsense", "palo alto", "fortinet", "sonicwall", "checkpoint"}
    for _, fv := range firewallVendors {
        if strings.Contains(osLower, fv) || strings.Contains(vendorLower, fv) {
            return "firewall"
        }
    }
    // Printer
    if portSet[631] || portSet[515] || portSet[9100] || serviceSet["ipp"] || serviceSet["printer"] {
        return "printer"
    }
    // VPN
    if portSet[1194] || (portSet[500] && portSet[4500]) || portSet[51820] {
        return "vpn"
    }
    // IoT
    if portSet[1883] || portSet[5683] || serviceSet["mqtt"] || serviceSet["coap"] {
        return "iot"
    }
    // Workstation: RDP/VNC + desktop OS
    desktopOs := strings.Contains(osLower, "windows") || strings.Contains(osLower, "mac")
    if (portSet[3389] || portSet[5900]) && desktopOs {
        return "workstation"
    }
    // Server: common server services
    serverPorts := []int{80, 443, 22, 3306, 5432, 27017, 6379, 8080, 8443, 9200}
    for _, sp := range serverPorts {
        if portSet[sp] {
            return "server"
        }
    }
    if serviceSet["http"] || serviceSet["https"] || serviceSet["ssh"] {
        return "server"
    }
    return "host"
}
```

Call it from the import handler: `nodeType := classifyNodeType(services, osName, vendor)`

Also update the Nmap struct types to capture the `<trace>` element and MAC vendor for use in heuristics.

**Step 2: Add NmapTrace structs**

Add to the Nmap XML types (around line 170):
```go
type NmapTrace struct {
    Hops []NmapHop `xml:"hop"`
}

type NmapHop struct {
    TTL    int    `xml:"ttl,attr"`
    IPAddr string `xml:"ipaddr,attr"`
    RTT    string `xml:"rtt,attr"`
    Host   string `xml:"host,attr"`
}
```

Add `Trace NmapTrace \`xml:"trace"\`` to the `NmapHost` struct.

**Step 3: Rebuild and test**

```bash
docker compose up -d --build endpoint-service
```

Re-import the test Nmap scan:
```bash
TOKEN=$(curl -s http://localhost:18080/api/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"changeme"}' | jq -r .access_token)
# Get network ID
NETWORK_ID=$(curl -s http://localhost:18080/api/v1/networks?operation_id=<op_id> -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].id')
# Re-import
curl -X POST "http://localhost:18080/api/v1/networks/$NETWORK_ID/import" -H "Authorization: Bearer $TOKEN" -F "file=@test-data/nmap-scan.xml"
```

Check that router-gw.local (which has port 443 with "Cisco IOS") is now classified differently. With the improved heuristics, Cisco vendor → firewall, or HTTPS-only → server (depends on vendor detection from the XML).

**Step 4: Commit**

```bash
git add services/endpoint/main.go
git commit -m "feat: improved node type classification heuristics with router/firewall/printer/VPN/IoT detection"
```

---

## Phase 2: Enriched Detail Panel

### Task 5: Tabbed Detail Panel Component

**Files:**
- Create: `frontend/src/components/network-map/NodeDetailPanel.tsx`
- Modify: `frontend/src/pages/operation-tabs/NetworksTab.tsx`

**Context:** Extract the current inline `renderNodeDetailPanel()` from NetworksTab into a standalone component. Convert it from a single section into a tabbed panel (Overview, Services, Vulns, Interfaces, Notes). Width increases from 320px to 380px.

**Step 1: Create NodeDetailPanel.tsx**

Create `frontend/src/components/network-map/NodeDetailPanel.tsx` with:

- Props: `{ node: NetworkNodeRecord, onClose: () => void, onNodeUpdate: (updated: NetworkNodeRecord) => void }`
- State: `activeTab` (string, default 'overview')
- Tab bar at top with 5 tabs: Overview, Services, Vulns, Interfaces, Notes (use Lucide icons: Info, Network, ShieldAlert, Cable, StickyNote)
- Each tab renders its own section (initially just Overview and Services are fully implemented; Vulns, Interfaces, Notes show placeholder content with "Add" buttons)
- Panel is 380px wide, dark theme matching existing style

**Overview tab content (port from existing renderNodeDetailPanel):**
- Device icon (SVG) + hostname + IP
- Status badge + node type badge (with device icon)
- OS with logo
- MAC address
- Discovery/update timestamps
- Each field has a small edit icon (pencil) that enables inline editing on click

**Services tab content:**
- Table: Port | Proto | Service | Product | Version
- Each row clickable/editable
- "Add Service" button at bottom
- Service count badge on tab

**Step 2: Update NetworksTab.tsx**

- Remove the inline `renderNodeDetailPanel()` function (lines ~547-764) and the style constants at bottom
- Import and use `<NodeDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} onNodeUpdate={handleNodeUpdate} />`
- Add a `handleNodeUpdate` function that calls `PATCH /api/v1/nodes/${node.id}` and refreshes topology

**Step 3: Rebuild and verify**

```bash
docker compose up -d --build frontend
```

Navigate to map view, click a node. Verify:
- Tabbed panel appears with 5 tabs
- Overview tab shows same info as before (hostname, IP, OS, services)
- Services tab shows port table
- Other tabs show placeholders
- Close button (X) works

**Step 4: Commit**

```bash
git add frontend/src/components/network-map/NodeDetailPanel.tsx frontend/src/pages/operation-tabs/NetworksTab.tsx
git commit -m "feat: tabbed node detail panel with Overview and Services tabs"
```

---

### Task 6: Inline Editing for Node Fields

**Files:**
- Create: `frontend/src/components/network-map/InlineEditor.tsx`
- Modify: `frontend/src/components/network-map/NodeDetailPanel.tsx`

**Context:** Add inline editing to the Overview tab fields. Clicking a field's edit icon switches it to edit mode (text input or dropdown). Enter saves via PATCH API, Escape cancels.

**Step 1: Create InlineEditor.tsx**

Create `frontend/src/components/network-map/InlineEditor.tsx` with reusable components:

- `InlineText`: displays value with edit icon. Click → text input. Enter/blur → save callback. Escape → cancel.
- `InlineSelect`: displays value with edit icon. Click → dropdown. Change → save callback.
- Props for both: `{ value, onSave: (newValue) => Promise<void>, options?: string[], disabled?: boolean }`
- Style: monospace font, subtle edit icon on hover, green flash on successful save, red flash on error.

**Step 2: Wire into NodeDetailPanel Overview tab**

- hostname: `<InlineText>` (editable)
- ip_address: plain text (not editable — set by import)
- os: `<InlineText>` (editable)
- mac_address: `<InlineText>` (editable)
- status: `<InlineSelect options={['discovered','alive','compromised','offline']}>`
- node_type: `<InlineSelect options={DEVICE_TYPES}>` with device icon next to each option

Each `onSave` calls: `PATCH /api/v1/nodes/${node.id}` with `{ [field]: newValue }`, then calls `onNodeUpdate` with the updated node.

**Step 3: Wire Services tab editing**

- Click a cell → inline edit
- "Add Service" → new row with empty fields, auto-focuses port field
- Delete (X button per row) → removes from array
- All changes patch the full `services` array via PATCH API

**Step 4: Rebuild and verify**

```bash
docker compose up -d --build frontend
```

- Click a node → Overview tab
- Hover over hostname → pencil icon appears
- Click pencil → text input appears with current value
- Change value, press Enter → saves (green flash)
- Press Escape → cancels
- Change status to "compromised" → node border turns red on map
- Services tab: add/edit/delete services

**Step 5: Commit**

```bash
git add frontend/src/components/network-map/InlineEditor.tsx frontend/src/components/network-map/NodeDetailPanel.tsx
git commit -m "feat: inline editing for node fields (text, select, services table)"
```

---

### Task 7: Vulnerabilities Tab + Drill-Down

**Files:**
- Modify: `frontend/src/components/network-map/NodeDetailPanel.tsx`
- Create: `frontend/src/components/network-map/VulnDrillDown.tsx`

**Context:** Implement the Vulnerabilities tab in the detail panel with a CVE table, add/edit forms, and a drill-down view for exploit mapping.

**Step 1: Implement Vulns tab in NodeDetailPanel**

- Read vulnerabilities from `node.metadata?.vulnerabilities || []`
- Display as table: CVE ID | Severity (colored badge) | CVSS | Exploit? (green check / red X) | Status (dropdown)
- "Add Vulnerability" button → inline form: CVE ID, title, severity dropdown (critical/high/medium/low/info), CVSS number input, exploit available checkbox
- Save adds to the `metadata.vulnerabilities` array, patches node
- Click a CVE row → opens VulnDrillDown

**Step 2: Create VulnDrillDown.tsx**

Create `frontend/src/components/network-map/VulnDrillDown.tsx`:

- Slides in to replace the detail panel content (with a "< Back to Vulnerabilities" button)
- Shows:
  - CVE Summary: ID, title, description, published date, CVSS score + severity badge
  - Affected Services: lists services on the node that match (by port/product)
  - Known Exploits: list with add/edit/delete. Each: type (metasploit/exploitdb/poc_url/custom), reference string, URL, verified checkbox, notes
  - Attack Notes: textarea for operator free-text (approach, prerequisites, difficulty 1-5, tools, OPSEC notes)
  - Status: dropdown (unverified → confirmed → exploited → mitigated → accepted_risk)
  - Timeline: auto-logged events (detected, confirmed, exploited — with timestamps and actor)

- All changes save to the vulnerability object within `metadata.vulnerabilities` array

**Step 3: Severity badge colors**

```typescript
const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ff4444',
  high: '#ff8800',
  medium: '#ffcc00',
  low: '#4488ff',
  info: '#888888',
}
```

**Step 4: Rebuild and verify**

```bash
docker compose up -d --build frontend
```

- Click node → Vulns tab → "Add Vulnerability"
- Enter CVE-2024-1234, severity critical, CVSS 9.8, exploit available
- Saves → appears in table with red "CRITICAL" badge
- Click the CVE row → drill-down view
- Add an exploit reference (type: metasploit, ref: exploit/linux/http/...)
- Add attack notes
- Change status to "confirmed"
- Click "Back" → returns to vuln table

**Step 5: Commit**

```bash
git add frontend/src/components/network-map/NodeDetailPanel.tsx frontend/src/components/network-map/VulnDrillDown.tsx
git commit -m "feat: vulnerability tab with CVE table, drill-down view, exploit mapping, and attack notes"
```

---

### Task 8: Interfaces + Notes Tabs

**Files:**
- Modify: `frontend/src/components/network-map/NodeDetailPanel.tsx`

**Step 1: Implement Interfaces tab**

- Read from `node.metadata?.interfaces || []`
- Table: Name | MAC | IPs (comma-separated) | VLAN | State
- Add/edit/delete rows
- Save patches `metadata.interfaces`

**Step 2: Implement Notes tab**

- Read from `node.metadata?.notes || ''`
- Textarea (full width/height of tab area) with monospace font
- Toggle button: "Edit" / "Preview" (preview renders basic markdown: headers, bold, lists, code blocks — using simple regex, no heavy library)
- Auto-saves on blur (debounced 500ms)
- Patches `metadata.notes`

**Step 3: Rebuild, verify, commit**

```bash
docker compose up -d --build frontend
git add frontend/src/components/network-map/NodeDetailPanel.tsx
git commit -m "feat: interfaces table and operator notes (markdown) tabs in node detail panel"
```

---

## Phase 3: Auto-Edge Generation + Traceroute

### Task 9: Subnet-Based Auto-Edge Generation (Backend)

**Files:**
- Modify: `services/endpoint/main.go`

**Context:** After each import, analyze nodes by subnet and auto-generate `network_adjacency` edges.

**Step 1: Add auto-edge function**

Add a `generateSubnetEdges(ctx context.Context, networkID string)` method to the Server struct:

1. Load network's `cidr_ranges` from database.
2. Load all nodes for this network.
3. For each CIDR range, find nodes whose IP falls within it (use `net.ParseCIDR` and `net.IP.Mask`).
4. Within each subnet group:
   - Identify any node with type `router` or `firewall` → gateway node.
   - If gateway exists: create edges from gateway to all other nodes in subnet.
   - If no gateway: create star topology with first node as center (if < 6 nodes), or no auto-edges (avoid mesh explosion).
5. Before inserting, check edge doesn't already exist: `SELECT id FROM network_edges WHERE network_id=$1 AND source_node_id=$2 AND target_node_id=$3`.
6. Insert with `edge_type='network_adjacency'`, `confidence=0.7`, `discovered_by='import'`.

**Step 2: Call from import handler**

At the end of `importNmapXML` (after all nodes are upserted), call `generateSubnetEdges(ctx, networkID)`.

**Step 3: Rebuild and test**

```bash
docker compose up -d --build endpoint-service
```

Re-import the Nmap scan. Check edges were created:
```bash
curl -s "http://localhost:18080/api/v1/networks/$NETWORK_ID/topology" -H "Authorization: Bearer $TOKEN" | jq '.edges'
```

Expected: edges connecting nodes within the same subnet (the 3 test nodes are all in 10.101.1.0/24).

**Step 4: Commit**

```bash
git add services/endpoint/main.go
git commit -m "feat: subnet-based auto-edge generation after Nmap import"
```

---

### Task 10: Traceroute-Based Edge Inference

**Files:**
- Modify: `services/endpoint/main.go`

**Context:** Parse Nmap's `<trace>` elements to build accurate network paths. Each hop pair becomes an edge.

**Step 1: Add traceroute parsing to import handler**

After all nodes are upserted in `importNmapXML`, iterate hosts again to extract trace data:

```go
for _, host := range nmapRun.Hosts {
    if len(host.Trace.Hops) < 2 {
        continue
    }
    for i := 0; i < len(host.Trace.Hops)-1; i++ {
        srcIP := host.Trace.Hops[i].IPAddr
        dstIP := host.Trace.Hops[i+1].IPAddr
        if srcIP == "" || dstIP == "" || srcIP == "*" || dstIP == "*" {
            continue
        }
        // Find or create source node
        srcNodeID := findOrCreateNode(ctx, networkID, srcIP, "router")
        dstNodeID := findOrCreateNode(ctx, networkID, dstIP, "")
        // Create edge if not exists
        createEdgeIfNotExists(ctx, networkID, srcNodeID, dstNodeID, "network_adjacency", 0.95, "import")
    }
}
```

**Step 2: Add helper functions**

- `findOrCreateNode(ctx, networkID, ip, defaultType)`: queries `SELECT id FROM network_nodes WHERE network_id=$1 AND ip_address=$2`, if not found inserts with `status='discovered'` and the given type.
- `createEdgeIfNotExists(ctx, networkID, srcID, dstID, edgeType, confidence, discoveredBy)`: checks existence, inserts if not found.

**Step 3: Update test data**

Add traceroute data to `test-data/nmap-scan.xml`:
```xml
<trace port="443" proto="tcp">
  <hop ttl="1" ipaddr="10.101.1.1" rtt="0.50" host="gateway.local"/>
  <hop ttl="2" ipaddr="10.101.1.100" rtt="1.20" host="router-gw.local"/>
</trace>
```

Add this inside one of the `<host>` elements (e.g., corp-ws-001.local).

**Step 4: Rebuild, re-import, verify**

```bash
docker compose up -d --build endpoint-service
# Re-import
curl -X POST "http://localhost:18080/api/v1/networks/$NETWORK_ID/import" -H "Authorization: Bearer $TOKEN" -F "file=@test-data/nmap-scan.xml"
# Check for new nodes (gateway) and edges
curl -s "http://localhost:18080/api/v1/networks/$NETWORK_ID/topology" -H "Authorization: Bearer $TOKEN" | jq '.nodes | length, .edges | length'
```

Expected: 4 nodes (3 original + 1 gateway from traceroute) and edges from traceroute hops.

**Step 5: Commit**

```bash
git add services/endpoint/main.go test-data/nmap-scan.xml
git commit -m "feat: traceroute-based edge inference from Nmap trace data"
```

---

### Task 11: Enrichment Source Tracking

**Files:**
- Modify: `services/endpoint/main.go`

**Context:** Track which scans contributed to each node's data by maintaining `metadata.enrichment_sources`.

**Step 1: Update import handler**

After each successful node upsert, append to the node's `metadata.enrichment_sources` array:

```go
// After node upsert, update enrichment_sources
enrichment := map[string]any{
    "source":     "nmap",
    "imported_at": time.Now().UTC().Format(time.RFC3339),
    "fields_updated": []string{"ip_address", "hostname", "os", "services"},
}
enrichmentJSON, _ := json.Marshal(enrichment)

_, _ = s.db.Exec(ctx, `
    UPDATE network_nodes SET
        metadata = jsonb_set(
            COALESCE(metadata, '{}'),
            '{enrichment_sources}',
            COALESCE(metadata->'enrichment_sources', '[]') || $1::jsonb
        )
    WHERE id = $2
`, string(enrichmentJSON), nodeID)
```

**Step 2: Display in Overview tab**

In `NodeDetailPanel.tsx` Overview tab, add an "Enrichment Sources" section at the bottom:
- Show each source as a small card: source name badge + timestamp
- e.g., `[NMAP] 2/24/2026, 10:30 AM`

**Step 3: Rebuild, verify, commit**

```bash
docker compose up -d --build endpoint-service frontend
git add services/endpoint/main.go frontend/src/components/network-map/NodeDetailPanel.tsx
git commit -m "feat: enrichment source tracking on node metadata"
```

---

## Phase 4: Display Schema System

### Task 12: Display Schema CRUD API (Backend)

**Files:**
- Modify: `services/endpoint/main.go`

**Context:** Add CRUD endpoints for display schemas. Admins can list, get, create, update, and delete schemas. Default schemas are read-only (can't be deleted or modified, but can be cloned).

**Step 1: Add handlers**

Add to the Server struct:
- `handleListDisplaySchemas(w, r)` — `GET /api/v1/display-schemas` → returns all schemas
- `handleGetDisplaySchema(w, r)` — `GET /api/v1/display-schemas/{id}`
- `handleCreateDisplaySchema(w, r)` — `POST /api/v1/display-schemas`
- `handleUpdateDisplaySchema(w, r)` — `PATCH /api/v1/display-schemas/{id}` (reject if `is_default`)
- `handleDeleteDisplaySchema(w, r)` — `DELETE /api/v1/display-schemas/{id}` (reject if `is_default`)

**Step 2: Register routes**

Add to the mux in `Start()`:
```go
mux.HandleFunc("GET /api/v1/display-schemas", s.handleListDisplaySchemas)
mux.HandleFunc("GET /api/v1/display-schemas/{id}", s.handleGetDisplaySchema)
mux.HandleFunc("POST /api/v1/display-schemas", s.handleCreateDisplaySchema)
mux.HandleFunc("PATCH /api/v1/display-schemas/{id}", s.handleUpdateDisplaySchema)
mux.HandleFunc("DELETE /api/v1/display-schemas/{id}", s.handleDeleteDisplaySchema)
```

**Step 3: Add Traefik route**

Add to `infra/traefik/dynamic.yml`:
```yaml
display-schemas:
  rule: "PathPrefix(`/api/v1/display-schemas`)"
  entryPoints: [web]
  service: endpoint
  middlewares: [auth-verify, cors-headers]
  priority: 50
```

**Step 4: Rebuild, test, commit**

```bash
docker compose up -d --build endpoint-service
docker compose restart traefik
# Test
curl -s http://localhost:18080/api/v1/display-schemas -H "Authorization: Bearer $TOKEN" | jq '.'
```

```bash
git add services/endpoint/main.go infra/traefik/dynamic.yml
git commit -m "feat: display schema CRUD API with Traefik routing"
```

---

### Task 13: Admin Schema Editor Page (Frontend)

**Files:**
- Create: `frontend/src/pages/admin/DisplaySchemaEditor.tsx`
- Modify: `frontend/src/App.tsx`

**Context:** Admin page with split-pane YAML editor + live preview. Uses a simple textarea with syntax coloring (or just monospace) for the YAML, and renders a mock node detail panel on the right.

**Step 1: Create DisplaySchemaEditor.tsx**

- Route: `/admin/display-schemas`
- Left side (50%): JSON/YAML textarea editor. The schema is stored as JSON but displayed as YAML for readability (use a simple JSON↔YAML converter or just show JSON with nice formatting).
- Right side (50%): Live preview that renders a mock node using the current schema definition. Uses the same rendering logic as NodeDetailPanel but driven by the schema config.
- Top bar: dropdown to select schema (from API), Save button, "Clone Default" button, "Reset" button.
- Validation: on save, check required fields (version, sections array). Display errors inline.

**Step 2: Add route in App.tsx**

```tsx
import DisplaySchemaEditor from './pages/admin/DisplaySchemaEditor'

// Inside Routes, under the protected layout:
<Route path="/admin/display-schemas" element={<DisplaySchemaEditor />} />
```

**Step 3: Add admin nav link**

Add "ADMIN" link to AppLayout navbar (visible only for admin role users). Dropdown with "Display Schemas" and "Import Parsers" links.

**Step 4: Rebuild, verify, commit**

```bash
docker compose up -d --build frontend
git add frontend/src/pages/admin/DisplaySchemaEditor.tsx frontend/src/App.tsx frontend/src/components/AppLayout.tsx
git commit -m "feat: admin display schema editor with JSON editor and live preview"
```

---

## Phase 5: Visual Parser Workbench

### Task 14: Import Parser CRUD API (Backend)

**Files:**
- Modify: `services/endpoint/main.go`

**Context:** CRUD endpoints for import parsers, plus a test endpoint that does a dry-run parse.

**Step 1: Add handlers**

- `handleListImportParsers(w, r)` — `GET /api/v1/import-parsers`
- `handleGetImportParser(w, r)` — `GET /api/v1/import-parsers/{id}`
- `handleCreateImportParser(w, r)` — `POST /api/v1/import-parsers`
- `handleUpdateImportParser(w, r)` — `PATCH /api/v1/import-parsers/{id}`
- `handleDeleteImportParser(w, r)` — `DELETE /api/v1/import-parsers/{id}`
- `handleTestImportParser(w, r)` — `POST /api/v1/import-parsers/{id}/test` — accepts file upload, applies parser definition, returns preview of what nodes/edges would be created (without actually inserting).

**Step 2: Register routes + Traefik**

```go
mux.HandleFunc("GET /api/v1/import-parsers", s.handleListImportParsers)
mux.HandleFunc("GET /api/v1/import-parsers/{id}", s.handleGetImportParser)
mux.HandleFunc("POST /api/v1/import-parsers", s.handleCreateImportParser)
mux.HandleFunc("PATCH /api/v1/import-parsers/{id}", s.handleUpdateImportParser)
mux.HandleFunc("DELETE /api/v1/import-parsers/{id}", s.handleDeleteImportParser)
mux.HandleFunc("POST /api/v1/import-parsers/{id}/test", s.handleTestImportParser)
```

Traefik:
```yaml
import-parsers:
  rule: "PathPrefix(`/api/v1/import-parsers`)"
  entryPoints: [web]
  service: endpoint
  middlewares: [auth-verify, cors-headers]
  priority: 50
```

**Step 3: Update import endpoint**

Modify `handleImportFile` to accept optional `?parser_id=uuid` query param. If provided, load that parser's definition and use the generic engine. If absent, auto-detect format and use the default parser for that format.

**Step 4: Rebuild, test, commit**

```bash
docker compose up -d --build endpoint-service
docker compose restart traefik
curl -s http://localhost:18080/api/v1/import-parsers -H "Authorization: Bearer $TOKEN" | jq '.[].name'
```

Expected: "Nmap XML", "Nessus XML", "Masscan JSON", "Zeek conn.log"

```bash
git add services/endpoint/main.go infra/traefik/dynamic.yml
git commit -m "feat: import parser CRUD API with test endpoint and Traefik routing"
```

---

### Task 15: Generic Parser Engine (Backend)

**Files:**
- Modify: `services/endpoint/main.go`

**Context:** Replace the hardcoded `importNmapXML` with a generic parser engine that interprets parser definitions from the database. The engine handles XML, JSON, and CSV/TSV formats.

**Step 1: Create parser engine types and entry point**

```go
type ParserDefinition struct {
    Version       int                    `json:"version"`
    RootElement   string                 `json:"root_element,omitempty"`   // XML
    HostElement   string                 `json:"host_element,omitempty"`   // XML
    RootPath      string                 `json:"root_path,omitempty"`      // JSON
    CommentPrefix string                 `json:"comment_prefix,omitempty"` // CSV/TSV
    Separator     string                 `json:"separator,omitempty"`      // CSV/TSV
    HeaderLine    string                 `json:"header_line,omitempty"`    // CSV/TSV
    SkipWhen      []SkipCondition        `json:"skip_when,omitempty"`
    FieldMappings []FieldMapping         `json:"field_mappings"`
    EdgeMappings  []EdgeMapping          `json:"edge_mappings,omitempty"`
    NodeTypeRules []NodeTypeRule         `json:"node_type_rules"`
    CreatesEdges  bool                   `json:"creates_edges,omitempty"`
    EdgeGeneration *EdgeGenerationConfig `json:"edge_generation,omitempty"`
}

func (s *Server) executeParser(ctx context.Context, networkID string, data []byte, format string, def ParserDefinition) (ImportResult, error) {
    switch format {
    case "xml":
        return s.executeXMLParser(ctx, networkID, data, def)
    case "json":
        return s.executeJSONParser(ctx, networkID, data, def)
    case "csv", "tsv":
        return s.executeCSVParser(ctx, networkID, data, def)
    default:
        return ImportResult{}, fmt.Errorf("unsupported format: %s", format)
    }
}
```

**Step 2: Implement XML parser engine**

The XML engine:
1. Parses the XML document.
2. Finds all elements matching `host_element` path.
3. For each host element, evaluates `skip_when` conditions.
4. Applies `field_mappings` to extract target fields.
5. Applies `node_type_rules` to classify.
6. Upserts node.
7. Processes `edge_mappings` for traceroute data.
8. Runs `generateSubnetEdges` afterward.

This is the most complex piece. The field mapping logic needs to:
- Navigate nested XML paths (e.g., `"hostnames.hostname"`)
- Apply filters (e.g., `addrtype == 'ipv4'`)
- Extract attributes or text content
- Handle arrays with `sub_mappings`
- Apply transforms (`to_integer`, `to_float`, `to_lowercase`)

Keep the existing `importNmapXML` as a fallback. The generic engine is used when a parser_id is specified or when the import endpoint auto-selects a parser. For backward compatibility, if no parser is found, fall back to the hardcoded logic.

**Step 3: Implement JSON parser engine**

Simpler: parse JSON, navigate to root_path, iterate items, apply field mappings using JSON path navigation.

**Step 4: Implement CSV/TSV parser engine**

Parse headers from header_line, split rows by separator, map columns to fields, handle edge generation for connection logs (Zeek).

**Step 5: Update handleImportFile**

```go
func (s *Server) handleImportFile(w http.ResponseWriter, r *http.Request) {
    networkID := r.PathValue("id")
    parserID := r.URL.Query().Get("parser_id")

    // Read uploaded file (existing code)
    ...

    if parserID != "" {
        // Load parser from DB
        var parser ImportParser
        err := s.db.QueryRow(ctx, "SELECT format, definition FROM import_parsers WHERE id=$1", parserID).Scan(&parser.Format, &parser.Definition)
        ...
        result, err := s.executeParser(ctx, networkID, data, parser.Format, parser.Definition)
        ...
    } else {
        // Auto-detect and use default parser or fall back to hardcoded
        format := detectFormat(data)
        // Try to find default parser for this format
        var def ParserDefinition
        err := s.db.QueryRow(ctx, "SELECT definition FROM import_parsers WHERE format=$1 AND is_default=true LIMIT 1", format).Scan(&def)
        if err == nil {
            result, err := s.executeParser(ctx, networkID, data, format, def)
            ...
        } else {
            // Fallback to hardcoded Nmap parser
            if format == "xml" && isNmapXML(data) {
                result, err := s.importNmapXML(ctx, networkID, data)
                ...
            }
        }
    }
}
```

**Step 6: Rebuild, test with existing Nmap import, verify it still works**

```bash
docker compose up -d --build endpoint-service
# Re-import should still work
curl -X POST "http://localhost:18080/api/v1/networks/$NETWORK_ID/import" -H "Authorization: Bearer $TOKEN" -F "file=@test-data/nmap-scan.xml"
```

**Step 7: Commit**

```bash
git add services/endpoint/main.go
git commit -m "feat: generic parser engine for XML, JSON, and CSV/TSV import formats"
```

---

### Task 16: Parser Workbench — Source Inspector (Left Panel)

**Files:**
- Create: `frontend/src/pages/admin/ParserWorkbench.tsx`
- Create: `frontend/src/pages/admin/ParserWorkbench/SourceInspector.tsx`
- Modify: `frontend/src/App.tsx`

**Context:** The left panel of the three-panel workbench. Uploads a sample file, parses it, and displays as an expandable tree. Each leaf node is draggable.

**Step 1: Create SourceInspector.tsx**

- Props: `{ onFieldDragStart: (path: string, sampleValue: any) => void }`
- File upload zone at top (drag/drop or click to browse)
- Accepts .xml, .json, .csv, .tsv
- Auto-detect format and parse:
  - XML: use DOMParser, build tree from DOM
  - JSON: JSON.parse, recurse object keys
  - CSV/TSV: split headers, show as columns
- Render as expandable tree (indented, with +/- toggles):
  - Object keys show as folder icons
  - Array elements show `[N items]` with first item expandable
  - Leaf values show truncated value in gray
  - Each leaf has a drag handle (≡ icon)
- Fields already mapped show green dot + target name
- Search/filter input at top

**Step 2: Create ParserWorkbench.tsx**

- Route: `/admin/import-parsers`
- Three-panel layout: `display: flex` with left (30%), center (15%), right (55%)
- Top bar: parser selector dropdown (from API), "New Parser" button, "Save" button, "Clone" button
- State: `{ parserId, definition, sampleFile, mappings[] }`
- For now, just render SourceInspector in left panel, placeholder in center and right

**Step 3: Add route in App.tsx**

```tsx
import ParserWorkbench from './pages/admin/ParserWorkbench'
<Route path="/admin/import-parsers" element={<ParserWorkbench />} />
```

**Step 4: Rebuild, verify tree renders, commit**

```bash
docker compose up -d --build frontend
```

Navigate to `/admin/import-parsers`, upload `test-data/nmap-scan.xml`. Verify tree shows XML structure.

```bash
git add frontend/src/pages/admin/ParserWorkbench.tsx frontend/src/pages/admin/ParserWorkbench/ frontend/src/App.tsx
git commit -m "feat: parser workbench with source inspector tree panel"
```

---

### Task 17: Parser Workbench — Target Schema + Mapping Canvas

**Files:**
- Create: `frontend/src/pages/admin/ParserWorkbench/TargetSchema.tsx`
- Create: `frontend/src/pages/admin/ParserWorkbench/MappingCanvas.tsx`
- Modify: `frontend/src/pages/admin/ParserWorkbench.tsx`

**Context:** Right panel shows target node fields as drop targets. Center panel draws SVG lines between mapped source and target fields. Drag from source → drop on target creates a mapping.

**Step 1: Create TargetSchema.tsx**

- Shows all node fields as a list:
  - `ip_address` (required, red asterisk)
  - `hostname`
  - `mac_address`
  - `os` / `os_version`
  - `status`
  - `node_type`
  - `services` (array — expandable to show sub-fields: port, protocol, service, product, version)
  - `metadata.vulnerabilities` (array)
  - `metadata.interfaces` (array)
  - `metadata.notes`
- Each field is a **drop target**: accepts dragged source fields
- When a field has a mapping, shows the source path in blue below it
- "Remove mapping" (X) button per mapped field
- Live preview at bottom: renders a mock node card using current mappings applied to sample data

**Step 2: Create MappingCanvas.tsx**

- Absolute-positioned SVG overlay between left and right panels
- Draws Bezier curves from source field positions to target field positions
- Line colors: green=direct mapping, blue=with filter, orange=with transform
- Click a line → popover:
  - Transform dropdown: as_is, to_integer, to_float, to_lowercase, regex_extract
  - Filter: field + operator + value
  - Live preview of transform output
- Delete button per line

**Step 3: Wire into ParserWorkbench.tsx**

- Connect drag events from SourceInspector → drop events on TargetSchema
- On drop: create mapping entry `{ source: 'path.to.field', target: 'hostname', transform: 'as_is' }`
- MappingCanvas reads mapping array + DOM positions to draw lines
- "Save" serializes mappings into the parser definition JSON format and PATCHes the API

**Step 4: Add node type rules editor**

Below the mapping canvas, add a "Node Type Rules" section:
- List of rules: condition type + parameters + resulting type
- Add/edit/delete/reorder (drag handle)
- Condition types: `ports_include_any`, `vendor_match`, `os_match`, `default`

**Step 5: Add "Test Import" button**

- Calls `POST /api/v1/import-parsers/{id}/test` with the sample file
- Shows results: N nodes would be created, any errors, field coverage stats
- Display parsed nodes in a table below the preview

**Step 6: Rebuild, verify full workbench, commit**

```bash
docker compose up -d --build frontend
```

Full test:
1. Navigate to `/admin/import-parsers`
2. Select "Nmap XML" parser
3. Upload `test-data/nmap-scan.xml`
4. Left panel shows XML tree
5. Right panel shows target fields with existing mappings from the definition
6. Center shows mapping lines
7. Click a line → see transform options
8. Drag a new source field to a target → new mapping created
9. "Test Import" → shows 3 nodes would be created
10. "Save" → parser definition updated

```bash
git add frontend/src/pages/admin/ParserWorkbench/
git commit -m "feat: parser workbench target schema panel, mapping canvas, and test import"
```

---

### Task 18: Final Polish + CLAUDE.md Update

**Files:**
- Modify: `CLAUDE.md`
- Modify: `frontend/src/version.ts`

**Step 1: Update CLAUDE.md**

- Update milestone progress section
- Add new file references (DeviceIcons, OsLogos, NodeDetailPanel, VulnDrillDown, DisplaySchemaEditor, ParserWorkbench)
- Add new API endpoints to conventions
- Note parser workbench admin features

**Step 2: Bump version**

Update `frontend/src/version.ts` to `v0.6.0`.

**Step 3: Rebuild, verify everything works end-to-end**

```bash
docker compose up -d --build frontend endpoint-service
```

Full verification checklist:
- [ ] Map shows SVG device icons (not shapes)
- [ ] OS logos appear as badges on nodes
- [ ] Click node → tabbed detail panel (Overview, Services, Vulns, Interfaces, Notes)
- [ ] Inline editing works (change hostname, change status to compromised → red border)
- [ ] Add vulnerability → appears in Vulns tab
- [ ] Click CVE → drill-down with exploit mapping
- [ ] Add notes → saves and renders markdown preview
- [ ] Import creates auto-edges between subnet nodes
- [ ] Admin → Display Schemas editor loads with JSON editor + preview
- [ ] Admin → Import Parsers workbench loads with three panels
- [ ] Upload sample file → tree renders in left panel
- [ ] Mapping lines visible in center
- [ ] Test Import shows preview results

**Step 4: Commit and push**

```bash
git add CLAUDE.md frontend/src/version.ts
git commit -m "chore: bump version to v0.6.0, update CLAUDE.md for M4b+ enhancements"
git push
```

Create tar:
```bash
cd .. && tar czf ems-cop-v0.6.0.tar.gz --exclude='.git' --exclude='node_modules' --exclude='.playwright-mcp' ems-cop/
```
