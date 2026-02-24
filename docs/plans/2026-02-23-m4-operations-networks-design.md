# M4 Design — Operations, Network Maps, & Enhanced C2

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform EMS-COP from a flat C2 tool into a top-down operational platform where operations contain networks, networks contain endpoints, and all C2 activity, findings, and audit data scope to an operation.

**Architecture:** Operations-centric navigation with drill-down tabs. New `networks`, `network_nodes`, and `network_edges` tables model target environments as graphs. Cytoscape.js renders interactive topology maps. Nmap/Nessus/Metasploit XML imports pre-populate networks; C2 activity auto-enriches them in real time.

**Tech Stack:** React 18 + Cytoscape.js (frontend), Go endpoint-service (networks/import), Go workflow-engine (operations CRUD), existing ticket-service (findings), PostgreSQL (new tables), NATS (events), ClickHouse (audit).

---

## 1. Navigation & URL Structure

### Top-Level Nav

```
[EMS-COP v0.4.0]  OPERATIONS  TICKETS  DASHBOARDS  [user v]
```

- **OPERATIONS** — central hub. All operational work flows from here.
- **TICKETS** — global approval pipeline across all operations.
- **DASHBOARDS** — dual-scoped: per-operation (auto-generated) + global (user-created).

### URL Scheme

```
/operations                         Operations list
/operations/:id                     Operation detail (tabbed)
/operations/:id/networks            Network list for this operation
/operations/:id/networks/:nid       Single network topology map
/operations/:id/c2                  C2 sessions scoped to this operation
/operations/:id/findings            Findings scoped to this operation
/operations/:id/audit               Audit log scoped to this operation
/tickets                            Global ticket list (unchanged)
/dashboards                         Dashboard list (global + per-operation)
/login                              Login page (unchanged)
```

The current `/c2` route redirects to the most recently active operation's C2 tab. All C2 work happens in operation context.

---

## 2. Data Model — New Tables

### Migration: `004_networks_and_findings.sql`

#### `networks`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| operation_id | UUID FK → operations | Parent operation |
| name | VARCHAR(255) | e.g., "Corp LAN", "DMZ" |
| description | TEXT | |
| cidr_ranges | TEXT[] | Subnet ranges (e.g., `{"10.101.1.0/24"}`) |
| import_source | VARCHAR(32) | nmap, nessus, metasploit, manual, null |
| metadata | JSONB | Flexible extension |
| created_by | UUID FK → users | |
| created_at / updated_at | TIMESTAMPTZ | Auto-managed |

#### `network_nodes`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| network_id | UUID FK → networks | Parent network |
| endpoint_id | UUID FK → endpoints (nullable) | Link to managed endpoint if applicable |
| ip_address | VARCHAR(45) | IPv4 or IPv6 |
| hostname | VARCHAR(255) | |
| mac_address | VARCHAR(17) | |
| os | VARCHAR(128) | |
| os_version | VARCHAR(128) | |
| status | VARCHAR(32) | discovered, alive, compromised, offline |
| node_type | VARCHAR(32) | host, router, firewall, server, workstation, unknown |
| position_x | FLOAT | Persisted layout position |
| position_y | FLOAT | Persisted layout position |
| services | JSONB | Array of `{port, protocol, state, service, version, banner}` |
| metadata | JSONB | |
| created_at / updated_at | TIMESTAMPTZ | |

Unique constraint on `(network_id, ip_address)` for deduplication during import.

#### `network_edges`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | |
| network_id | UUID FK → networks | |
| source_node_id | UUID FK → network_nodes | |
| target_node_id | UUID FK → network_nodes | |
| edge_type | VARCHAR(32) | network_adjacency, c2_callback, c2_pivot, lateral_movement, tunnel, port_forward |
| label | VARCHAR(255) | Display label |
| confidence | FLOAT | 0.0–1.0 (discovered vs inferred) |
| discovered_by | VARCHAR(32) | import, scan, c2_activity, manual |
| metadata | JSONB | Protocol, ports, latency, etc. |
| created_at / updated_at | TIMESTAMPTZ | |

#### Findings table alterations

```sql
ALTER TABLE findings ADD COLUMN cve_id VARCHAR(32);
ALTER TABLE findings ADD COLUMN cvss_score FLOAT;
ALTER TABLE findings ADD COLUMN network_node_id UUID REFERENCES network_nodes(id);
CREATE INDEX idx_findings_cve ON findings(cve_id) WHERE cve_id IS NOT NULL;
CREATE INDEX idx_findings_node ON findings(network_node_id) WHERE network_node_id IS NOT NULL;
```

---

## 3. Network Map — Import Pipeline

### Supported Formats (by priority)

| Priority | Format | Extension | Provides |
|----------|--------|-----------|----------|
| P0 | Nmap XML | `.xml` | Hosts, ports, services, OS |
| P1 | Nessus XML | `.nessus` | Hosts, ports, services, OS, vulnerabilities (CVE, CVSS) |
| P1 | Metasploit XML | `.xml` | Hosts, ports, services, OS, vulns, credentials |
| P2 | BloodHound JSON | `.json`/`.zip` | AD computers, OS, attack relationships |
| P2 | masscan JSON/XML | `.json`/`.xml` | Hosts, ports (no services/OS) |

### Import Flow

1. User uploads file via `POST /api/v1/networks/:id/import`
2. Endpoint-service detects format from file content (XML root element or JSON structure)
3. Parser extracts hosts → creates/merges `network_nodes` by IP+hostname dedup
4. Parser extracts ports/services → populates node `services` JSONB
5. For Nessus/Metasploit: vulnerabilities → create `findings` rows linked to `network_node_id`
6. Publish `network.imported` NATS event for audit
7. Return import summary: `{nodes_created, nodes_updated, findings_created}`

### Nmap XML Parser (P0 — Go)

Use `github.com/lair-framework/go-nmap` or manual `encoding/xml` with structs matching the Nmap DTD. Extract:
- `host/address[@addrtype='ipv4']` → `ip_address`
- `host/hostnames/hostname` → `hostname`
- `host/address[@addrtype='mac']` → `mac_address`
- `host/os/osmatch` → `os` (highest accuracy match)
- `host/ports/port` → `services` JSONB array

### Auto-Enrichment from C2

When `c2.session_opened` fires on NATS:
1. Endpoint-service subscribes, extracts `remote_addr` from event
2. Matches against `network_nodes.ip_address` across all networks in the session's operation
3. Updates matching node `status` to `compromised`
4. Publishes `network.node_updated` for frontend real-time update

---

## 4. Network Map — Visualization

### Technology

Cytoscape.js (already in `package.json` at v3.30) with extensions:
- `cytoscape-fcose` — compound force-directed layout (default)
- `cytoscape-dagre` — hierarchical DAG layout (C2 chain view)
- `cytoscape-context-menus` — right-click menus on nodes
- `cytoscape-popper` — hover tooltips

### Layouts

| Layout | Use Case | Trigger |
|--------|----------|---------|
| fcose (compound) | Default network view. Nodes grouped by subnet. | Default |
| dagre (hierarchical) | C2 communication chains. Sliver server at root. | Toggle button |

### Node Visual Encoding

| Attribute | Encoding |
|-----------|----------|
| `node_type` | Shape: server=rectangle, workstation=rounded-rect, router=diamond, firewall=hexagon, unknown=ellipse |
| `status` | Border color: gray=discovered, blue=alive, green=compromised+active, red=compromised+dead, dashed=offline |
| OS | Small badge overlay (Linux/Windows/Mac icon) |
| Privilege level | Crown decoration for root/SYSTEM sessions |
| Active check-in | Subtle pulse animation |

### Interaction

- **Click node** → right detail panel: hostname, IP, OS, services, sessions, findings, notes
- **Right-click node** → context menu: Open Terminal, View Findings, Add Note, Mark as Target
- **Click edge** → detail: type, confidence, discovery method
- **Drag node** → persists `position_x`/`position_y` via `PATCH /api/v1/nodes/:id`
- **Toolbar** → layout toggle, filter dropdowns (status, OS, subnet), search, Add Node, Import
- **Legend bar** → collapsible, shows shape/color meanings

### Filtering

Default: show all nodes in the selected network. Filter options: status (compromised only), OS, subnet, "has active session", "has critical findings". Prevents hairball problem on large networks.

### Real-Time Updates

Frontend subscribes via ws-relay to `network.*` events. New nodes slide in with animation; status changes update border color. No full re-layout — incremental only.

---

## 5. Page Layouts

### Operations List (`/operations`)

```
┌─────────────────────────────────────────────────────────┐
│ OPERATIONS                             [+ New Operation] │
│ [Status v] [Risk v] [Search...                ]         │
├─────────────────────────────────────────────────────────┤
│ * Op Thundercat    ACTIVE   Risk:3  | 2 nets | 4 sess  │
│ * Op Silent Rain   PLANNING Risk:2  | 1 net  | 0 sess  │
│ * Op Red Sunrise   COMPLETED Risk:4 | 3 nets | 0 sess  │
│                                                         │
│ [< 1 2 3 >]                                            │
└─────────────────────────────────────────────────────────┘
```

### Operation Overview (`/operations/:id`)

```
┌─────────────────────────────────────────────────────────┐
│ <- Operations  OP THUNDERCAT          Status: * ACTIVE  │
│ [Overview] [Networks] [C2] [Findings] [Audit]           │
├──────────────────────────┬──────────────────────────────┤
│ STATUS         TEAM      │  RECENT ACTIVITY             │
│ ┌────┐ ┌────┐ ┌────┐    │  10:31 - op1 ran `ls` on     │
│ │ 4  │ │ 12 │ │ 3  │    │         corp-ws-001           │
│ │sess│ │find│ │tix │    │  10:28 - admin imported       │
│ └────┘ └────┘ └────┘    │         nmap scan (24 hosts)  │
│                          │  10:15 - op2 opened session   │
│ RISK: ###.. (3/5)        │         on dmz-web-001        │
│ LEAD: operator1          │  10:02 - ticket #47 approved  │
│ CREATED: 2026-02-23      │                               │
│                          │  FINDINGS BY SEVERITY         │
│ NETWORKS                 │  ██████ Critical: 2          │
│ Corp LAN (18 nodes, 3*)  │  ████████████ High: 5        │
│ DMZ (6 nodes, 1*)        │  ████████ Medium: 3           │
│                          │  ████ Low: 2                  │
└──────────────────────────┴──────────────────────────────┘
```

Left column: stats cards, metadata, network summary. Right column: activity feed, findings chart.

### Networks Tab (`/operations/:id/networks`)

```
┌─────────────────────────────────────────────────────────┐
│ [Overview] [Networks] [C2] [Findings] [Audit]           │
│                                        [+ Add Network]  │
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────┐ ┌─────────────────────┐        │
│ │ CORP LAN            │ │ DMZ                 │        │
│ │ 10.101.1.0/24       │ │ 10.101.2.0/24       │        │
│ │ 18 nodes | 3 compro │ │ 6 nodes | 1 compro  │        │
│ │ 5 crit findings     │ │ 2 crit findings     │        │
│ │ Imported: nmap      │ │ Imported: manual     │        │
│ │ [View Map] [Import] │ │ [View Map] [Import]  │        │
│ └─────────────────────┘ └─────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### Network Map (`/operations/:id/networks/:nid`)

```
┌─────────────────────────────────────────────────────────┐
│ <- Networks  CORP LAN                                   │
│ [Force v] [Filter: Status v] [OS v] [Search...] [R]    │
├───────────────────────────────────────┬─────────────────┤
│                                       │ NODE DETAIL     │
│        [Cytoscape.js Canvas]          │                 │
│                                       │ corp-ws-001     │
│   Nodes grouped by subnet in          │ 10.101.1.10     │
│   compound containers.                │ Ubuntu 22.04    │
│   Compromised nodes highlighted.      │ * Session active│
│   Edges show connectivity.            │                 │
│                                       │ SERVICES (4)    │
│                                       │ 22/tcp ssh      │
│                                       │ 80/tcp nginx    │
│                                       │ 443/tcp https   │
│                                       │ 3306/tcp mysql  │
│                                       │                 │
│                                       │ FINDINGS (3)    │
│                                       │ * CVE-2024-...  │
│  [+Node] [Import] [Layout] [Legend]   │ * CVE-2023-...  │
│                                       │                 │
│                                       │ [Terminal] [...] │
└───────────────────────────────────────┴─────────────────┘
```

~75% canvas, ~25% detail panel. Toolbar at top, legend at bottom.

### C2 Sessions (`/operations/:id/c2`)

```
┌─────────────────────────────────────────────────────────┐
│ [Overview] [Networks] [C2] [Findings] [Audit]           │
│ [Sessions] [Listeners] [Implants] [Presets]             │
├──────────────┬──────────────────────────────────────────┤
│ SESSIONS     │ SESSION: corp-ws-001                     │
│ [Alive v] [R]│ Ubuntu 22.04 | MTLS | 10.101.1.10       │
│              │                                          │
│ * corp-ws-001│ ┌──────────────────────────────────────┐ │
│   ubuntu mtls│ │ $ whoami                              │ │
│   10s ago    │ │ root                                  │ │
│              │ │ $ ls /etc                             │ │
│ * dmz-web-01 │ │ hostname  hosts  passwd  shadow  ...  │ │
│   alpine http│ │ $                                     │ │
│   45s ago    │ └──────────────────────────────────────┘ │
│              │                                          │
│ o corp-ws-002│ QUICK COMMANDS                           │
│   (dead)     │ [ls] [ps] [whoami] [netstat] [ifconfig]  │
│              │                                          │
│ [Map]        │                                          │
└──────────────┴──────────────────────────────────────────┘
```

### C2 Listeners (`/operations/:id/c2` → Listeners sub-tab)

```
┌─────────────────────────────────────────────────────────┐
│ [Sessions] [Listeners] [Implants] [Presets]             │
│                                     [+ New Listener]    │
├─────────────────────────────────────────────────────────┤
│ PROTOCOL | HOST      | PORT | STATUS    | ACTIONS       │
│ MTLS     | 0.0.0.0   | 8888 | * Running | [Stop] [Del] │
│ HTTP     | 0.0.0.0   | 80   | * Running | [Stop] [Del] │
│ HTTPS    | 0.0.0.0   | 443  | o Stopped | [Start][Del] │
└─────────────────────────────────────────────────────────┘
```

### C2 Implants (`/operations/:id/c2` → Implants sub-tab)

```
┌─────────────────────────────────────────────────────────┐
│ [Sessions] [Listeners] [Implants] [Presets]             │
│                                        [+ Generate]     │
├─────────────────────────────────────────────────────────┤
│ NAME           | OS    | ARCH  | TRANSPORT | DEPLOYED TO│
│ implant_abc123 | linux | amd64 | mtls      | corp-ws-001│
│ implant_def456 | linux | amd64 | http      | dmz-web-001│
│ implant_ghi789 | win   | amd64 | https     | (pending)  │
└─────────────────────────────────────────────────────────┘
```

### Findings (`/operations/:id/findings`)

```
┌─────────────────────────────────────────────────────────┐
│ [Overview] [Networks] [C2] [Findings] [Audit]           │
│ [All] [Vulnerabilities] [Credentials] [Loot] [Notes]   │
│ [Severity v] [Host v] [Search...          ] [+ Add]    │
├─────────────────────────────────────────────────────────┤
│ SEV  | TITLE                | HOST        | CVE         │
│ *CRI | PrintNightmare RCE   | corp-ws-001 | CVE-2021-.. │
│ *HI  | SMB Signing Disabled | corp-ws-002 | CVE-2017-.. │
│ *MED | Weak SSH Config      | dmz-web-001 | -           │
│ *LOW | Info Disclosure      | dmz-db-001  | -           │
│                                                         │
│ [< 1 2 3 >]                                            │
└─────────────────────────────────────────────────────────┘
```

Click row → right panel with full detail, evidence, remediation, "Locate on Map" button.

### Audit (`/operations/:id/audit`)

```
┌─────────────────────────────────────────────────────────┐
│ [Overview] [Networks] [C2] [Findings] [Audit]           │
│ [Event Type v] [Actor v] [From: ___] [To: ___] [R]     │
├─────────────────────────────────────────────────────────┤
│ TIME     | ACTOR  | EVENT               | DETAIL        │
│ 10:31:02 | op1    | c2.command_executed  | ls on ws-001  │
│ 10:28:15 | admin  | network.imported     | nmap 24 hosts │
│ 10:15:44 | op2    | c2.session_opened    | dmz-web-001   │
│ 10:02:01 | sup1   | ticket.approved      | ticket #47    │
│                                                         │
│ [< 1 2 3 >]                                            │
└─────────────────────────────────────────────────────────┘
```

---

## 6. Backend API Endpoints

### Endpoint Service (networks, nodes, edges, import)

```
POST   /api/v1/operations/:opId/networks           Create network
GET    /api/v1/operations/:opId/networks           List networks for operation
GET    /api/v1/networks/:id                        Get network with counts
PATCH  /api/v1/networks/:id                        Update network
DELETE /api/v1/networks/:id                        Delete network (cascades)

GET    /api/v1/networks/:id/nodes                  List nodes
POST   /api/v1/networks/:id/nodes                  Create node
PATCH  /api/v1/nodes/:id                           Update node (position, status)
DELETE /api/v1/nodes/:id                           Delete node

GET    /api/v1/networks/:id/edges                  List edges
POST   /api/v1/networks/:id/edges                  Create edge
DELETE /api/v1/edges/:id                           Delete edge

POST   /api/v1/networks/:id/import                 Upload file (nmap/nessus/msf)
GET    /api/v1/networks/:id/topology               Full nodes+edges for Cytoscape
```

### Workflow Engine (operations CRUD)

```
POST   /api/v1/operations                          Create operation
GET    /api/v1/operations                          List with summary counts
GET    /api/v1/operations/:id                      Detail with stats
PATCH  /api/v1/operations/:id                      Update
POST   /api/v1/operations/:id/transition           Status change

GET    /api/v1/operations/:id/members              List members
POST   /api/v1/operations/:id/members              Add member
DELETE /api/v1/operations/:id/members/:userId       Remove member
```

### Ticket Service (findings additions)

```
GET    /api/v1/operations/:opId/findings           List findings for operation
POST   /api/v1/operations/:opId/findings           Create finding
GET    /api/v1/findings/:id                        Get finding detail
PATCH  /api/v1/findings/:id                        Update finding
```

### C2 Gateway (scoping additions)

Existing endpoints gain optional `?operation_id=` query parameter to filter sessions/implants by operation.

### Traefik Route Additions

```yaml
operations:
  rule: "PathPrefix(`/api/v1/operations`)"
  service: workflow
  middlewares: [auth-verify, cors-headers]

networks:
  rule: "PathPrefix(`/api/v1/networks`)"
  service: endpoint
  middlewares: [auth-verify, cors-headers]

nodes:
  rule: "PathPrefix(`/api/v1/nodes`)"
  service: endpoint
  middlewares: [auth-verify, cors-headers]

edges:
  rule: "PathPrefix(`/api/v1/edges`)"
  service: endpoint
  middlewares: [auth-verify, cors-headers]
```

### NATS Events Added

- `network.created`, `network.imported`, `network.deleted`
- `network.node_added`, `network.node_updated`, `network.node_removed`
- `network.edge_added`, `network.edge_removed`
- `finding.created`, `finding.updated`
- `operation.created`, `operation.status_changed`, `operation.member_added`

---

## 7. Dashboards — Dual Scope

### Per-Operation Dashboards

Each operation auto-generates a dashboard from the user's echelon template:
- **Strategic (E1):** KPI charts, critical findings count, operation timeline
- **Operational (E2):** Network maps, ticket queue, session count, audit log
- **Tactical (E3):** Network topology, C2 sessions, findings, audit
- **Operator:** Terminal, topology, command presets, endpoints
- **Planner:** Network topology, ticket queue, notes, endpoints

Auto-generated dashboards use the existing widget registry. The `operationId` prop scopes each widget's data.

### Global Dashboards

Users create custom dashboards via drag-and-drop (react-grid-layout). Widgets without `operationId` pull cross-operation data. Examples: "All Active Sessions", "SOC Overview", "Approval Pipeline".

### Dashboard List Page (`/dashboards`)

Shows two sections: "My Operation Dashboards" (grouped by operation) and "Global Dashboards" (user-created). Create button opens dashboard builder.

---

## 8. Implementation Phases

### Phase 1 — Operations + Navigation (M4a)

- Migration `004_networks_and_findings.sql`
- Operations CRUD on workflow-engine
- Frontend: new nav, operations list, operation detail with tab skeleton
- Move C2 page into operation context
- Traefik routes

### Phase 2 — Network Map Core (M4b)

- Endpoint-service: networks/nodes/edges CRUD, topology endpoint
- Nmap XML import parser
- Frontend: Networks tab, network map with Cytoscape.js (fcose layout)
- Node click → detail panel, drag-to-persist positions
- Manual node/edge creation

### Phase 3 — C2 Integration & Auto-Enrichment (M4c)

- Scope C2 sessions to operations
- NATS listener: `c2.session_opened` → update network node status
- Frontend: C2 sub-tabs (Sessions, Listeners, Implants, Presets)
- "Locate on Map" cross-linking
- Real-time map updates via ws-relay

### Phase 4 — Findings & Additional Imports (M4d)

- Findings CRUD scoped to operations
- Nessus XML import (auto-creates vulnerability findings)
- Frontend: Findings tab with sub-tabs, severity filtering
- Bidirectional map-findings highlighting
- Operation audit tab

### Phase 5 — Polish & Dashboards (M4e)

- Metasploit XML, BloodHound JSON importers
- Operation overview tab (stats, activity feed)
- Dashboard system: per-operation + global
- Layout toggle (force-directed / hierarchical)
- Right-click context menus on map nodes

Each phase ships independently. Phase 2 delivers the core network map; subsequent phases add depth.
