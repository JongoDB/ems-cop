# M4a — Operations + Navigation Skeleton Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add operations CRUD, network/findings tables, and restructure frontend navigation so all operational work flows from an operation context.

**Architecture:** Workflow-engine gains operations CRUD endpoints with PostgreSQL via pgx. Endpoint-service gains networks/nodes/edges CRUD. Frontend gets new nav (Operations, Tickets, Dashboards), operation detail page with tabbed layout, and the existing C2 page moves into operation context.

**Tech Stack:** Go 1.22 + pgx/v5 + NATS (backend), React 18 + React Router 6 (frontend), PostgreSQL 16 (new migration 004).

**Design doc:** `docs/plans/2026-02-23-m4-operations-networks-design.md`

---

## Task 1: Database Migration — Networks, Nodes, Edges, Findings Columns

**Files:**
- Create: `infra/db/postgres/migrations/004_networks_and_findings.sql`

**Step 1: Write the migration**

```sql
-- EMS-COP Migration 004: Networks, Nodes, Edges + Findings enhancements
-- Supports M4 Operations & Network Maps feature

-- ════════════════════════════════════════════
--  NETWORKS
-- ════════════════════════════════════════════

CREATE TABLE networks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id    UUID         NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT         NOT NULL DEFAULT '',
    cidr_ranges     TEXT[]       NOT NULL DEFAULT '{}',
    import_source   VARCHAR(32),  -- nmap, nessus, metasploit, manual, null
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
    -- [{ "port": 22, "protocol": "tcp", "state": "open", "service": "ssh", "version": "OpenSSH 8.9", "banner": "" }]
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

ALTER TABLE findings ADD COLUMN cve_id VARCHAR(32);
ALTER TABLE findings ADD COLUMN cvss_score DOUBLE PRECISION;
ALTER TABLE findings ADD COLUMN network_node_id UUID REFERENCES network_nodes(id) ON DELETE SET NULL;

CREATE INDEX idx_findings_cve ON findings(cve_id) WHERE cve_id IS NOT NULL;
CREATE INDEX idx_findings_node ON findings(network_node_id) WHERE network_node_id IS NOT NULL;

-- ════════════════════════════════════════════
--  SEED: Default Training Operation
-- ════════════════════════════════════════════

INSERT INTO operations (name, objective, risk_level, status, created_by)
SELECT 'Training Exercise', 'Default training operation for POC testing', 2, 'in_progress',
       (SELECT id FROM users WHERE username = 'admin');

-- Link existing endpoint groups to the training operation
INSERT INTO operation_endpoint_groups (operation_id, group_id)
SELECT o.id, eg.id FROM operations o, endpoint_groups eg
WHERE o.name = 'Training Exercise';

-- Create two networks for the training operation
INSERT INTO networks (operation_id, name, description, cidr_ranges, import_source, created_by)
SELECT o.id, 'Corp LAN', 'Corporate workstation segment', ARRAY['10.101.1.0/24'], 'manual',
       (SELECT id FROM users WHERE username = 'admin')
FROM operations o WHERE o.name = 'Training Exercise';

INSERT INTO networks (operation_id, name, description, cidr_ranges, import_source, created_by)
SELECT o.id, 'DMZ', 'DMZ server segment', ARRAY['10.101.2.0/24'], 'manual',
       (SELECT id FROM users WHERE username = 'admin')
FROM operations o WHERE o.name = 'Training Exercise';

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
    OR (n.name = 'DMZ' AND eg.name = 'DMZ - Segment B'));
```

**Step 2: Apply the migration**

```bash
docker exec -i ems-postgres psql -U ems_user -d ems_cop < infra/db/postgres/migrations/004_networks_and_findings.sql
```

Expected: no errors, tables created, seed data inserted.

**Step 3: Verify**

```bash
docker exec ems-postgres psql -U ems_user -d ems_cop -c "\dt networks; \dt network_nodes; \dt network_edges;"
docker exec ems-postgres psql -U ems_user -d ems_cop -c "SELECT name, (SELECT count(*) FROM network_nodes nn WHERE nn.network_id = n.id) as node_count FROM networks n;"
```

Expected: 3 tables exist, Corp LAN has 2 nodes, DMZ has 2 nodes.

**Step 4: Commit**

```bash
git add infra/db/postgres/migrations/004_networks_and_findings.sql
git commit -m "feat: add networks, nodes, edges tables and findings enhancements (004)"
```

---

## Task 2: Workflow Engine — Operations CRUD API

**Files:**
- Modify: `services/workflow-engine/go.mod`
- Modify: `services/workflow-engine/main.go`

**Context:** The workflow-engine is currently a health-check stub. It needs pgx for PostgreSQL, NATS for events, and slog for logging. Follow the same patterns used in `services/auth/main.go` and `services/c2-gateway/main.go`.

**Step 1: Add dependencies**

Add to `services/workflow-engine/go.mod`:
```
require (
    github.com/jackc/pgx/v5 v5.7.2
    github.com/nats-io/nats.go v1.37.0
)
```

Then run:
```bash
cd services/workflow-engine && go mod tidy
```

**Step 2: Implement the service**

Rewrite `services/workflow-engine/main.go` with:

**Server struct:**
```go
type Server struct {
    db     *pgxpool.Pool
    nc     *nats.Conn
    port   string
    logger *slog.Logger
}
```

**Data types:**
```go
type Operation struct {
    ID          string   `json:"id"`
    Name        string   `json:"name"`
    Objective   string   `json:"objective"`
    RiskLevel   int      `json:"risk_level"`
    Status      string   `json:"status"`
    WorkflowID  *string  `json:"workflow_id"`
    Tags        []string `json:"tags"`
    Metadata    any      `json:"metadata"`
    CreatedBy   string   `json:"created_by"`
    CreatedAt   string   `json:"created_at"`
    UpdatedAt   string   `json:"updated_at"`
    // Summary counts (populated on list/get)
    NetworkCount  int `json:"network_count"`
    SessionCount  int `json:"session_count"`
    FindingCount  int `json:"finding_count"`
}

type OperationMember struct {
    UserID      string `json:"user_id"`
    Username    string `json:"username"`
    DisplayName string `json:"display_name"`
    Role        string `json:"role_in_operation"`
}

type CreateOperationReq struct {
    Name        string   `json:"name"`
    Objective   string   `json:"objective"`
    RiskLevel   int      `json:"risk_level"`
    Tags        []string `json:"tags"`
}

type TransitionReq struct {
    Status string `json:"status"`
}
```

**Routes (using Go 1.22 pattern matching):**
```go
mux.HandleFunc("GET /health", s.handleHealth)

// Operations CRUD
mux.HandleFunc("POST /api/v1/operations", s.handleCreateOperation)
mux.HandleFunc("GET /api/v1/operations", s.handleListOperations)
mux.HandleFunc("GET /api/v1/operations/{id}", s.handleGetOperation)
mux.HandleFunc("PATCH /api/v1/operations/{id}", s.handleUpdateOperation)
mux.HandleFunc("POST /api/v1/operations/{id}/transition", s.handleTransitionOperation)

// Operation members
mux.HandleFunc("GET /api/v1/operations/{id}/members", s.handleListMembers)
mux.HandleFunc("POST /api/v1/operations/{id}/members", s.handleAddMember)
mux.HandleFunc("DELETE /api/v1/operations/{id}/members/{userId}", s.handleRemoveMember)
```

**Handler details:**

`POST /api/v1/operations` — Insert into `operations` table. Extract `X-User-ID` header (set by ForwardAuth) for `created_by`. Default status: `draft`. Publish `operation.created` to NATS. Return the created operation.

`GET /api/v1/operations` — Query with pagination (`?page=1&limit=20`), optional filters (`?status=active&risk_level=3`), search (`?search=keyword`). Join to get summary counts:
```sql
SELECT o.*,
  (SELECT count(*) FROM networks WHERE operation_id = o.id) as network_count,
  (SELECT count(*) FROM findings WHERE operation_id = o.id) as finding_count
FROM operations o
WHERE ($1 = '' OR o.status = $1)
  AND ($2 = 0 OR o.risk_level = $2)
  AND ($3 = '' OR o.name ILIKE '%' || $3 || '%')
ORDER BY o.created_at DESC
LIMIT $4 OFFSET $5
```

`GET /api/v1/operations/{id}` — Single operation with counts. Same subquery pattern.

`PATCH /api/v1/operations/{id}` — Update name, objective, risk_level, tags, metadata. Publish `operation.updated` to NATS.

`POST /api/v1/operations/{id}/transition` — Validate status transition:
```
draft → pending_approval → approved → in_progress → paused → in_progress → completed → aborted
```
Also allow: `in_progress → aborted`, `paused → aborted`, `draft → in_progress` (skip approval if no workflow). Publish `operation.status_changed` to NATS.

`GET /api/v1/operations/{id}/members` — Join `operation_members` (note: table doesn't exist yet in schema, use `operation_endpoint_groups` pattern — actually, check: the design says `operation_members` exists, but the schema has no such table). **Create a simple junction approach:** Since this table doesn't exist in the schema, add it to migration 004:
```sql
CREATE TABLE operation_members (
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_in_operation VARCHAR(32) NOT NULL DEFAULT 'member',
    added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (operation_id, user_id)
);
```

`POST /api/v1/operations/{id}/members` — Insert into `operation_members`. Body: `{"user_id": "...", "role": "operator"}`.

`DELETE /api/v1/operations/{id}/members/{userId}` — Delete from junction table.

**NATS publishing pattern** (same as auth-service and c2-gateway):
```go
func (s *Server) publishEvent(eventType string, data any) {
    if s.nc == nil { return }
    payload, _ := json.Marshal(map[string]any{
        "event_type": eventType,
        "data":       data,
        "timestamp":  time.Now().UTC().Format(time.RFC3339),
    })
    s.nc.Publish(eventType, payload)
}
```

**Main function pattern** (connect to PG + NATS, same env vars as other services):
```go
func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

    pgURL := fmt.Sprintf("postgres://%s:%s@%s:%s/%s",
        getEnv("POSTGRES_USER", "ems_user"),
        getEnv("POSTGRES_PASSWORD", "ems_password"),
        getEnv("POSTGRES_HOST", "localhost"),
        getEnv("POSTGRES_PORT", "5432"),
        getEnv("POSTGRES_DB", "ems_cop"))

    pool, err := pgxpool.New(context.Background(), pgURL)
    // ... error handling ...

    nc, err := nats.Connect(getEnv("NATS_URL", "nats://localhost:4222"))
    // ... error handling (non-fatal, log warning) ...

    port := getEnv("SERVICE_PORT", "3002")
    server := &Server{db: pool, nc: nc, port: port, logger: logger}
    server.Start()
}
```

**Response format** (matching existing API conventions):
```go
type PaginatedResponse struct {
    Data       any `json:"data"`
    Pagination struct {
        Page  int `json:"page"`
        Limit int `json:"limit"`
        Total int `json:"total"`
    } `json:"pagination"`
}

type ErrorResponse struct {
    Error struct {
        Code    string `json:"code"`
        Message string `json:"message"`
    } `json:"error"`
}
```

**Step 3: Build and verify**

```bash
docker compose up -d --build workflow-engine
curl -s http://localhost:18080/api/v1/operations | jq .
```

Login first to get a token, then:
```bash
TOKEN=$(curl -s http://localhost:18080/api/v1/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"changeme"}' | jq -r .access_token)

# Create operation
curl -s http://localhost:18080/api/v1/operations -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"Test Op","objective":"Testing","risk_level":3}' | jq .

# List operations (should see Training Exercise + Test Op)
curl -s http://localhost:18080/api/v1/operations -H "Authorization: Bearer $TOKEN" | jq .

# Get single operation
curl -s http://localhost:18080/api/v1/operations/{id} -H "Authorization: Bearer $TOKEN" | jq .

# Transition
curl -s -X POST http://localhost:18080/api/v1/operations/{id}/transition -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"status":"in_progress"}' | jq .
```

**Step 4: Commit**

```bash
git add services/workflow-engine/
git commit -m "feat: operations CRUD API on workflow-engine with pgx + NATS"
```

---

## Task 3: Traefik Route Updates

**Files:**
- Modify: `infra/traefik/dynamic.yml`

**Step 1: Add new routes**

Add these routers under the protected section (priority 50, auth-verify middleware):

```yaml
    operations:
      rule: "PathPrefix(`/api/v1/operations`)"
      entryPoints: [web]
      service: workflow
      middlewares: [auth-verify, cors-headers]
      priority: 50

    networks:
      rule: "PathPrefix(`/api/v1/networks`)"
      entryPoints: [web]
      service: endpoint
      middlewares: [auth-verify, cors-headers]
      priority: 50

    nodes:
      rule: "PathPrefix(`/api/v1/nodes`)"
      entryPoints: [web]
      service: endpoint
      middlewares: [auth-verify, cors-headers]
      priority: 50

    edges:
      rule: "PathPrefix(`/api/v1/edges`)"
      entryPoints: [web]
      service: endpoint
      middlewares: [auth-verify, cors-headers]
      priority: 50

    findings:
      rule: "PathPrefix(`/api/v1/findings`)"
      entryPoints: [web]
      service: ticket
      middlewares: [auth-verify, cors-headers]
      priority: 50
```

Note: `operations` routes go to `workflow` service (workflow-engine:3002). `networks`/`nodes`/`edges` go to `endpoint` service (endpoint-service:3008). `findings` go to `ticket` service (ticket-service:3003).

**Step 2: Verify**

```bash
docker compose restart traefik
curl -s http://localhost:18080/api/v1/operations -H "Authorization: Bearer $TOKEN" | jq .
```

Should reach workflow-engine, not 404.

**Step 3: Commit**

```bash
git add infra/traefik/dynamic.yml
git commit -m "feat: add Traefik routes for operations, networks, nodes, edges, findings"
```

---

## Task 4: Frontend — New Navigation Structure

**Files:**
- Modify: `frontend/src/App.tsx`
- Create: `frontend/src/pages/OperationsPage.tsx`
- Create: `frontend/src/pages/OperationDetailPage.tsx`
- Modify: All existing pages that render the navbar (LoginPage excluded)

**Context:** The current navbar is inline in each page (HomePage, TicketsPage, C2Page). The nav has: EMS-COP brand, TICKETS link, C2 link, user badge, logout button. We need to:
1. Extract navbar into a shared layout component
2. Change nav links to: OPERATIONS, TICKETS, DASHBOARDS
3. Add new routes for `/operations` and `/operations/:id/*`
4. The `/c2` route now redirects to operations (C2 lives under operation context)
5. The `/` home route redirects to `/operations`

**Step 1: Create shared AppLayout component**

Create `frontend/src/components/AppLayout.tsx`:

```tsx
import { Link, useLocation, Outlet } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useAuth } from '../hooks/useAuth'
import { APP_VERSION } from '../version'

export default function AppLayout() {
  const location = useLocation()
  const { user } = useAuthStore()
  const { logout } = useAuth()

  const navLinks = [
    { to: '/operations', label: 'OPERATIONS' },
    { to: '/tickets', label: 'TICKETS' },
    { to: '/dashboards', label: 'DASHBOARDS' },
  ]

  return (
    <div className="app-shell">
      <nav className="navbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <Link to="/operations" className="navbar-brand">
            <span style={{ marginRight: '0.5rem' }}>🛡</span>
            EMS-COP
          </Link>
          <span className="version-badge">{APP_VERSION}</span>
          {navLinks.map(link => (
            <Link
              key={link.to}
              to={link.to}
              className={`nav-link ${location.pathname.startsWith(link.to) ? 'active' : ''}`}
            >
              {link.label}
            </Link>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {user && (
            <>
              <span className="user-badge">{user.display_name}</span>
              {user.roles?.map((r: string) => (
                <span key={r} className="role-pill">{r.toUpperCase()}</span>
              ))}
            </>
          )}
          <button onClick={logout} className="logout-btn">LOGOUT</button>
        </div>
      </nav>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
```

**Step 2: Create OperationsPage**

Create `frontend/src/pages/OperationsPage.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'

interface Operation {
  id: string
  name: string
  objective: string
  risk_level: number
  status: string
  tags: string[]
  created_at: string
  network_count: number
  session_count: number
  finding_count: number
}

export default function OperationsPage() {
  const navigate = useNavigate()
  const [operations, setOperations] = useState<Operation[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const limit = 20

  const fetchOperations = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      if (statusFilter) params.set('status', statusFilter)
      if (search) params.set('search', search)
      const res = await apiFetch<{ data: Operation[]; pagination: { total: number } }>(
        `/operations?${params}`
      )
      setOperations(res.data || [])
      setTotal(res.pagination?.total || 0)
    } catch (e) {
      console.error('Failed to fetch operations', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchOperations() }, [page, statusFilter, search])

  const [showCreate, setShowCreate] = useState(false)
  const [newOp, setNewOp] = useState({ name: '', objective: '', risk_level: 3 })

  const handleCreate = async () => {
    try {
      const created = await apiFetch<Operation>('/operations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newOp),
      })
      setShowCreate(false)
      setNewOp({ name: '', objective: '', risk_level: 3 })
      navigate(`/operations/${created.id}`)
    } catch (e) {
      console.error('Failed to create operation', e)
    }
  }

  const statusColors: Record<string, string> = {
    draft: '#6b7280', pending_approval: '#f59e0b', approved: '#3b82f6',
    in_progress: '#10b981', paused: '#f97316', completed: '#6366f1', aborted: '#ef4444',
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="operations-page">
      <div className="page-header">
        <h1>OPERATIONS</h1>
        <button className="submit-btn" onClick={() => setShowCreate(true)}>+ NEW OPERATION</button>
      </div>

      <div className="toolbar" style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
        <select className="form-input" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}
          style={{ width: '160px' }}>
          <option value="">All Statuses</option>
          {['draft','pending_approval','approved','in_progress','paused','completed','aborted'].map(s =>
            <option key={s} value={s}>{s.replace(/_/g, ' ').toUpperCase()}</option>
          )}
        </select>
        <input className="form-input" placeholder="Search operations..." value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }} style={{ flex: 1 }} />
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-muted)' }}>Loading...</div>
      ) : operations.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-muted)' }}>No operations found</div>
      ) : (
        <table className="tickets-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>NAME</th>
              <th>STATUS</th>
              <th>RISK</th>
              <th>NETWORKS</th>
              <th>FINDINGS</th>
              <th>CREATED</th>
            </tr>
          </thead>
          <tbody>
            {operations.map(op => (
              <tr key={op.id} className="ticket-row" onClick={() => navigate(`/operations/${op.id}`)}
                style={{ cursor: 'pointer' }}>
                <td style={{ fontWeight: 600 }}>{op.name}</td>
                <td>
                  <span className="status-badge" style={{
                    backgroundColor: statusColors[op.status] || '#6b7280',
                    color: '#fff', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem'
                  }}>
                    {op.status.replace(/_/g, ' ').toUpperCase()}
                  </span>
                </td>
                <td>{'█'.repeat(op.risk_level)}{'░'.repeat(5 - op.risk_level)} ({op.risk_level}/5)</td>
                <td>{op.network_count}</td>
                <td>{op.finding_count}</td>
                <td>{new Date(op.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>&lt;</button>
          <span>{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>&gt;</button>
        </div>
      )}

      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
            <h2>NEW OPERATION</h2>
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" value={newOp.name}
                onChange={e => setNewOp({ ...newOp, name: e.target.value })} placeholder="Operation name" />
            </div>
            <div className="form-group">
              <label className="form-label">Objective</label>
              <textarea className="form-textarea" value={newOp.objective}
                onChange={e => setNewOp({ ...newOp, objective: e.target.value })} placeholder="Mission objective" rows={3} />
            </div>
            <div className="form-group">
              <label className="form-label">Risk Level (1-5)</label>
              <select className="form-input" value={newOp.risk_level}
                onChange={e => setNewOp({ ...newOp, risk_level: parseInt(e.target.value) })}>
                {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} - {['Minimal','Low','Medium','High','Critical'][n-1]}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button className="cancel-btn" onClick={() => setShowCreate(false)}>CANCEL</button>
              <button className="submit-btn" disabled={!newOp.name || !newOp.objective} onClick={handleCreate}>CREATE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

**Step 3: Create OperationDetailPage with tab skeleton**

Create `frontend/src/pages/OperationDetailPage.tsx`:

This page renders the operation header + tab bar. Each tab is a sub-route rendered via `<Outlet />`. For Phase 1, only the Overview tab has content; other tabs show placeholder text.

```tsx
import { useState, useEffect } from 'react'
import { Link, useParams, useNavigate, Outlet, useLocation } from 'react-router-dom'
import { apiFetch } from '../lib/api'

interface Operation {
  id: string
  name: string
  objective: string
  risk_level: number
  status: string
  tags: string[]
  metadata: any
  created_by: string
  created_at: string
  updated_at: string
  network_count: number
  session_count: number
  finding_count: number
}

const statusColors: Record<string, string> = {
  draft: '#6b7280', pending_approval: '#f59e0b', approved: '#3b82f6',
  in_progress: '#10b981', paused: '#f97316', completed: '#6366f1', aborted: '#ef4444',
}

export default function OperationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [operation, setOperation] = useState<Operation | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch<Operation>(`/operations/${id}`)
      .then(setOperation)
      .catch(() => navigate('/operations'))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) return <div style={{ padding: '2rem', color: 'var(--color-muted)' }}>Loading...</div>
  if (!operation) return null

  const tabs = [
    { path: '', label: 'Overview' },
    { path: 'networks', label: 'Networks' },
    { path: 'c2', label: 'C2' },
    { path: 'findings', label: 'Findings' },
    { path: 'audit', label: 'Audit' },
  ]

  // Determine active tab from URL
  const pathAfterOp = location.pathname.replace(`/operations/${id}`, '').replace(/^\//, '')
  const activeTab = tabs.find(t => t.path && pathAfterOp.startsWith(t.path))?.path
    ?? (pathAfterOp === '' ? '' : '')

  return (
    <div className="operation-detail">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <Link to="/operations" style={{ color: 'var(--color-muted)', textDecoration: 'none' }}>← Operations</Link>
        <h1 style={{ margin: 0, flex: 1 }}>{operation.name.toUpperCase()}</h1>
        <span className="status-badge" style={{
          backgroundColor: statusColors[operation.status] || '#6b7280',
          color: '#fff', padding: '4px 12px', borderRadius: '4px', fontSize: '0.85rem',
        }}>
          {operation.status.replace(/_/g, ' ').toUpperCase()}
        </span>
      </div>

      <div className="c2-tabs" style={{ marginBottom: '1rem' }}>
        {tabs.map(tab => (
          <button
            key={tab.path}
            className={`c2-tab ${activeTab === tab.path ? 'active' : ''}`}
            onClick={() => navigate(tab.path ? `/operations/${id}/${tab.path}` : `/operations/${id}`)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <Outlet context={{ operation, refresh: () => {
        apiFetch<Operation>(`/operations/${id}`).then(setOperation)
      }}} />
    </div>
  )
}
```

**Step 4: Create tab placeholder components**

Create `frontend/src/pages/operation-tabs/OverviewTab.tsx`:
```tsx
import { useOutletContext } from 'react-router-dom'

export default function OverviewTab() {
  const { operation } = useOutletContext<{ operation: any }>()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
      <div>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem' }}>
          {[
            { label: 'Networks', value: operation.network_count },
            { label: 'Findings', value: operation.finding_count },
          ].map(stat => (
            <div key={stat.label} className="stat-card" style={{
              background: 'var(--color-surface, #1a1a2e)', padding: '1rem 1.5rem',
              borderRadius: '8px', textAlign: 'center', flex: 1,
            }}>
              <div style={{ fontSize: '2rem', fontWeight: 700 }}>{stat.value}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-muted)', textTransform: 'uppercase' }}>{stat.label}</div>
            </div>
          ))}
        </div>
        <div style={{ background: 'var(--color-surface, #1a1a2e)', padding: '1rem', borderRadius: '8px' }}>
          <h3 style={{ margin: '0 0 0.5rem' }}>Details</h3>
          <p style={{ margin: '0.25rem 0', color: 'var(--color-muted)' }}><strong>Objective:</strong> {operation.objective}</p>
          <p style={{ margin: '0.25rem 0', color: 'var(--color-muted)' }}><strong>Risk Level:</strong> {'█'.repeat(operation.risk_level)}{'░'.repeat(5 - operation.risk_level)} ({operation.risk_level}/5)</p>
          <p style={{ margin: '0.25rem 0', color: 'var(--color-muted)' }}><strong>Created:</strong> {new Date(operation.created_at).toLocaleString()}</p>
        </div>
      </div>
      <div style={{ background: 'var(--color-surface, #1a1a2e)', padding: '1rem', borderRadius: '8px' }}>
        <h3 style={{ margin: '0 0 0.5rem' }}>Recent Activity</h3>
        <p style={{ color: 'var(--color-muted)', fontStyle: 'italic' }}>Activity feed will be populated in Phase 5.</p>
      </div>
    </div>
  )
}
```

Create `frontend/src/pages/operation-tabs/NetworksTab.tsx`:
```tsx
export default function NetworksTab() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
      <h2>Networks</h2>
      <p>Network map functionality coming in Phase 2 (M4b).</p>
    </div>
  )
}
```

Create `frontend/src/pages/operation-tabs/C2Tab.tsx`:
```tsx
export default function C2Tab() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
      <h2>C2</h2>
      <p>C2 integration coming in Phase 3 (M4c). For now, use the legacy /c2 page.</p>
    </div>
  )
}
```

Create `frontend/src/pages/operation-tabs/FindingsTab.tsx`:
```tsx
export default function FindingsTab() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
      <h2>Findings</h2>
      <p>Findings management coming in Phase 4 (M4d).</p>
    </div>
  )
}
```

Create `frontend/src/pages/operation-tabs/AuditTab.tsx`:
```tsx
export default function AuditTab() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
      <h2>Audit Log</h2>
      <p>Operation-scoped audit log coming in Phase 4 (M4d).</p>
    </div>
  )
}
```

**Step 5: Update App.tsx routing**

Replace `frontend/src/App.tsx` with:

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LoginPage from './pages/LoginPage'
import ProtectedRoute from './components/ProtectedRoute'
import AppLayout from './components/AppLayout'
import OperationsPage from './pages/OperationsPage'
import OperationDetailPage from './pages/OperationDetailPage'
import OverviewTab from './pages/operation-tabs/OverviewTab'
import NetworksTab from './pages/operation-tabs/NetworksTab'
import C2Tab from './pages/operation-tabs/C2Tab'
import FindingsTab from './pages/operation-tabs/FindingsTab'
import AuditTab from './pages/operation-tabs/AuditTab'
import TicketsPage from './pages/TicketsPage'
import C2Page from './pages/C2Page'

const queryClient = new QueryClient()

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
            <Route path="/operations" element={<OperationsPage />} />
            <Route path="/operations/:id" element={<OperationDetailPage />}>
              <Route index element={<OverviewTab />} />
              <Route path="networks" element={<NetworksTab />} />
              <Route path="c2" element={<C2Tab />} />
              <Route path="findings" element={<FindingsTab />} />
              <Route path="audit" element={<AuditTab />} />
            </Route>
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/c2" element={<C2Page />} />
            <Route path="/dashboards" element={
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--color-muted)' }}>
                <h2>Dashboards</h2>
                <p>Dashboard system coming in Phase 5 (M4e).</p>
              </div>
            } />
            <Route path="/" element={<Navigate to="/operations" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/operations" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
```

**Step 6: Update existing pages to remove inline navbars**

The existing `HomePage.tsx`, `TicketsPage.tsx`, and `C2Page.tsx` each render their own navbar inline. Since the navbar now lives in `AppLayout`, remove the navbar JSX from each page. Keep the page content.

For `TicketsPage.tsx` and `C2Page.tsx`: remove the `<nav className="navbar">...</nav>` block and the wrapping `<div className="app-shell">` — the page content should start directly with the page-specific markup.

`HomePage.tsx` can be deleted or kept as a redirect — it's replaced by `OperationsPage` as the landing page. The `/` route now redirects to `/operations`.

**Step 7: Update ProtectedRoute to support Outlet**

The current `ProtectedRoute` wraps children. It needs to also work as a layout route (rendering `<Outlet />`). Modify to accept children OR render children directly:

```tsx
import { Navigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}
```

This should already work since `<ProtectedRoute><AppLayout /></ProtectedRoute>` passes AppLayout as children, and AppLayout renders `<Outlet />` for nested routes.

**Step 8: Update version**

In `frontend/src/version.ts`, bump to `v0.4.0`.

**Step 9: Build and verify**

```bash
docker compose up -d --build frontend
```

Then in browser:
- Navigate to app → should land on `/operations`
- Should see "Training Exercise" in the operations list
- Click it → operation detail page with tabs
- Tab navigation works (Overview, Networks, C2, Findings, Audit)
- TICKETS nav link still works
- DASHBOARDS shows placeholder
- Legacy `/c2` route still works (existing C2 page preserved)

**Step 10: Commit**

```bash
git add frontend/
git commit -m "feat: operations-centric navigation with AppLayout, OperationsPage, OperationDetailPage"
```

---

## Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update progress section**

- Update milestone roadmap: M4 description to match new design
- Add M4a progress section documenting what was built
- Add new NATS topics: `network.*`, `operation.*`, `finding.*`
- Add key files: migration 004, workflow-engine (operations CRUD), endpoint-service path
- Bump "Current Progress" header to M4a

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for M4a progress"
```

---

## Summary

| Task | What | Service | Files |
|------|------|---------|-------|
| 1 | Database migration (networks, nodes, edges, findings, operation_members, seed data) | PostgreSQL | `infra/db/postgres/migrations/004_networks_and_findings.sql` |
| 2 | Operations CRUD API (create, list, get, update, transition, members) | workflow-engine | `services/workflow-engine/main.go`, `go.mod` |
| 3 | Traefik routes for new endpoints | Traefik | `infra/traefik/dynamic.yml` |
| 4 | Frontend nav restructure + Operations pages + tab skeleton | Frontend | `App.tsx`, `AppLayout.tsx`, `OperationsPage.tsx`, `OperationDetailPage.tsx`, 5 tab components |
| 5 | Update CLAUDE.md | Docs | `CLAUDE.md` |

Build order: 1 → 2 → 3 → 4 → 5 (each depends on the previous).
