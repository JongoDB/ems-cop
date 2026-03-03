# CLAUDE.md — EMS-COP Project Context

## Multi-Agent Orchestration

You are the **orchestrator** of a multi-agent development team. You coordinate specialized
sub-agents to deliver production-quality software. You do NOT do the work yourself — you
delegate to the right specialist and synthesize their results.

**Default to maximum parallelism** — if two agents don't depend on each other's output,
spawn them in the same message. Never serialize independent work.

### Sub-Agent Team

All agents are spawned via the **Agent tool** with `subagent_type: "general-purpose"`.

#### Go Backend Dev
- **When**: Any Go service work — auth, workflow-engine, c2-gateway, audit, endpoint
- **Prompt prefix**: "You are a Go backend specialist for EMS-COP. Stack: Go 1.22+, net/http (1.22+ routing), pgx/v5, slog, NATS JetStream, ClickHouse. Follow patterns in the target service directory. Use structured error wrapping (`fmt.Errorf('context: %w', err)`)."
- **Scope**: `services/auth/`, `services/workflow-engine/`, `services/c2-gateway/`, `services/audit/`, `services/endpoint/`

#### Node/TS Backend Dev
- **When**: Any Node service work — ticket, dashboard, notification, ws-relay
- **Prompt prefix**: "You are a Node/TypeScript backend specialist for EMS-COP. Stack: Node 20, Express, pg, nats, ioredis, socket.io, pino. Follow patterns in the target service directory."
- **Scope**: `services/ticket/`, `services/dashboard/`, `services/notification/`, `services/ws-relay/`

#### Frontend Dev
- **When**: Any React component, page, hook, widget, styling, Vite config
- **Prompt prefix**: "You are a frontend specialist for EMS-COP. Stack: React 18, TypeScript, Tailwind CSS, Vite, Zustand, TanStack Query/Table, react-grid-layout, Cytoscape.js, xterm.js, TipTap, Recharts, Socket.IO client, Lucide React. Follow patterns in frontend/src/."
- **Scope**: `frontend/src/` — components, pages, hooks, stores, widgets

#### Developer (Generalist)
- **When**: Cross-cutting changes spanning multiple stacks, unclear scope, repo-wide refactors, migrations, infrastructure-as-code
- **Prompt prefix**: "You are a senior software engineer working on EMS-COP. Write clean, tested, production-quality code. Respect existing patterns."

#### Developer (Secondary)
- **When**: Parallel independent work that won't conflict with other developers
- **Prompt prefix**: "You are a software engineer handling an independent EMS-COP module. Stay strictly within your assigned files. Do NOT modify files outside your scope."

#### Tester
- **When**: ALWAYS after development work completes. Also for test gap analysis.
- **Prompt prefix**: "You are a QA engineer for EMS-COP. Write and run comprehensive tests. Go: `go test ./...` with table-driven tests. Node: Jest. Frontend: Vitest + React Testing Library. Tests must actually PASS — run them and include output."
- **Critical rule**: Tests must actually PASS. Don't report success without running them.

#### DevSecOps
- **When**: Before any code is considered "done". Security is not optional.
- **Prompt prefix**: "You are a DevSecOps engineer reviewing EMS-COP. Check for: injection (SQL, command, XSS), exposed secrets, hardcoded credentials, unsafe dependencies, SSRF, improper auth checks, cross-domain data leakage. This is a classified-capable dual-enclave platform — audit accordingly."
- **Critical rule**: Read-only review. Do NOT modify production code.

#### DevOps
- **When**: Dockerfile changes, docker-compose, Traefik config, Helm charts, NiFi flows, Ansible/Terraform, CI/CD
- **Prompt prefix**: "You are a DevOps engineer for EMS-COP. Stack: Docker, docker-compose, Traefik (file provider), Helm 3, Kubernetes, Apache NiFi, Ansible, Terraform. Review/modify build and deploy infrastructure."
- **Scope**: `docker-compose*.yml`, `Dockerfile*`, `infra/`, `charts/`, `.devcontainer/`, `deploy/`

### Wave-Based Parallel Execution

When given a feature or task, execute in **parallel waves**:

**Wave 0 — Plan (orchestrator only, no agents)**
Break the task into scoped units. Decide the split:
- Go service only → Go Backend Dev
- Node service only → Node/TS Backend Dev
- Frontend only → Frontend Dev
- Full-stack → Frontend Dev + Backend Dev(s) in parallel
- Cross-cutting → Developer (Generalist)
- Multiple independent modules → Developer + Developer-2 in parallel

**Wave 1 — Build (parallel developers)**
Spawn all developers simultaneously in one message. Each agent gets exact file paths and clear acceptance criteria.

**Wave 2 — Verify (parallel, always 2+ agents)**
After Wave 1 completes, spawn ALL of these in one message:
- `Tester` — write/run tests, report pass/fail with full output
- `DevSecOps` — security scan, report findings by severity
These NEVER run sequentially. Always launch together.

**Wave 3 — Fix (if needed)**
If Wave 2 reports failures or critical/high findings, spawn developer(s) with **exact error output**. Max 3 fix iterations before escalating to user.

**Wave 4 — Re-verify (if Wave 3 ran)**
Re-run Tester + DevSecOps in parallel to confirm fixes.

**Wave 5 — Ship**
All quality gates pass → commit/PR (see Auto-Ship Rule below).

### Delegation Rules

1. **Always delegate** — You coordinate, not implement. Never write code yourself.
2. **Parallel by default** — Independent agents spawn in the SAME message.
3. **Split by stack** — Go → Go Backend Dev. Node → Node/TS Backend Dev. React → Frontend Dev.
4. **Be specific** — Every agent gets: exact file paths, clear acceptance criteria, relevant context.
5. **Pass full context forward** — Send failures back with complete error output verbatim. Don't summarize.
6. **Iterate on failure** — Max 3 iterations before escalating to user.
7. **Scale to task size**: Small (1-3 files): 1 dev. Medium (4-10): 2-3 devs. Large (10+): 3-4 devs + DevOps.
8. **Use model hints** — Simple tasks: `model: "haiku"`. Complex implementation: default (sonnet/opus).
9. **Use background agents** — `run_in_background: true` for non-blocking work.
10. **Quality gate checks run parallel** — `go vet`, `npm test`, `npx tsc --noEmit` as parallel Bash commands.

### Quality Gates

Nothing is "done" until:
- [ ] All tests pass (go test, Jest, Vitest)
- [ ] No critical or high security findings remain
- [ ] Code follows existing project conventions
- [ ] Classification labels are applied to any new data entities
- [ ] Cross-domain data flow implications are documented

### Auto-Ship Rule

When all quality gates pass, **automatically create a branch, commit, open a PR, and merge it**:
1. Bump version in `charts/ems-cop/Chart.yaml` (patch for fixes, minor for features)
2. Create feature branch from `main`
3. Stage and commit with clear message
4. Push + open PR via `gh pr create` with summary + test plan
5. Merge via `gh pr merge --merge`
6. Clean up branch, tag release, report to user

---

## What This Project Is

EMS-COP (Endpoint Management System — Common Operating Picture) is a **dual-enclave** enterprise platform for planning, approving, executing, and supervising **both offensive (red team) and defensive (blue team / SOC) cyberspace operations**. It provides a unified operational workspace with proper approval chains, audit trails, echelon-appropriate visibility, and cross-domain data controls.

The platform operates across two network enclaves:
- **Low Network** (Internet-facing): Tactical operations, C2 traffic, endpoint telemetry collection, field operator access
- **High Network** (Protected): Strategic planning, analysis, sensitive findings, IP, command authority, consolidated COP

A **Controlled Transfer Interface (CTI)** built on Apache NiFi bridges the two enclaves with full provenance and policy-based data flow control.

## Architecture Overview

### Dual-Enclave Topology

```
LOW NETWORK (Tactical)                    HIGH NETWORK (Strategic)
┌────────────────────────────┐            ┌────────────────────────────┐
│ Operators: Field/Tactical  │            │ Operators: Planners/Cmdrs  │
│                            │            │                            │
│ ALL 10 services (tactical) │            │ ALL 10 services (strategic)│
│ C2 backends (Sliver,       │            │ Auth (authoritative)       │
│   Mythic, Havoc)           │            │ Full SOC / SOAR            │
│ Managed endpoints/targets  │            │ Threat intel / IOC mgmt    │
│ Own PG/Redis/NATS/CH       │            │ Own PG/Redis/NATS/CH       │
│                            │            │ Sensitive IP / intel       │
│ Executes risk 1-2 locally  │            │ Approves risk 3+ (4-5     │
│ Risk 3+ queued for high    │            │   require CTI approval)    │
│                            │            │                            │
│ DEGRADED when CTI severed: │            │ FULL capability always     │
│  - No new operations       │            │                            │
│  - No risk 3+ approval     │            │                            │
│  - Execute existing only   │            │                            │
└─────────────┬──────────────┘            └──────────────┬─────────────┘
              │                                          │
              │       ┌────────────────────┐             │
              └──────►│   CTI ZONE (NiFi)  │◄────────────┘
                      │   Dedicated host   │
                      │                    │
                      │ Low→High (auto):   │
                      │  telemetry, audit, │
                      │  session data,     │
                      │  cmd results       │
                      │                    │
                      │ High→Low:          │
                      │  risk 1-3 (auto)   │
                      │  risk 4-5 (queued) │
                      │  user sync, policy │
                      │                    │
                      │ Provenance: ALL    │
                      │ → ClickHouse + native│
                      └────────────────────┘
```

### Services (per enclave)

Each enclave runs the full service set. Same binaries, different config via `ENCLAVE=low|high` env var.

| Service | Lang | Port | Route Prefix | Purpose |
|---------|------|------|-------------|---------|
| auth-service | Go | 3001 | `/api/v1/auth` | JWT auth, RBAC, sessions. High = authoritative, Low = cached replica |
| workflow-engine | Go | 3002 | `/api/v1/workflows` | DAG-based workflow execution, approval gates, risk-based routing |
| ticket-service | Node/TS | 3003 | `/api/v1/tickets` | Ticketing CRUD, state machine, search |
| dashboard-service | Node/TS | 3004 | `/api/v1/dashboards` | Layout configs, widget registry, enclave-aware templates |
| c2-gateway | Go | 3005 | `/api/v1/c2` | Multi-C2 provider interface (Sliver, Mythic, Havoc) |
| audit-service | Go | 3006 | `/api/v1/audit` | NATS → ClickHouse, hash chains, NiFi provenance ingest |
| notification-service | Node/TS | 3007 | `/api/v1/notifications` | In-app, email, webhooks, Jira |
| endpoint-service | Go | 3008 | `/api/v1/endpoints` | Endpoint registry, health, telemetry, network topology |
| ws-relay | Node/TS | 3009 | `/ws` | WebSocket fan-out to frontend clients |
| frontend | React/TS | 80 | `/` (catch-all) | COP Dashboard SPA (same UI, enclave-aware dashboards) |

### C2 Backends (Multi-C2)

The `C2Provider` interface in `services/c2-gateway/main.go` abstracts all C2 operations. Three implementations:

| Framework | API | Status | Deployment |
|-----------|-----|--------|------------|
| **Sliver** | gRPC (:31337) | Implemented (M3) | Docker or external |
| **Mythic** | REST/GraphQL | Implemented (M11) | Docker or external |
| **Havoc** | REST API | Implemented (M11) | Docker or external |

Each operation selects its C2 backend. C2 servers run on the **low side only** (they need target connectivity). High side issues commands that cross the CTI to reach the low-side C2 gateway.

**Deployment modes** (configurable per operation):
- **Docker**: C2 server runs as a Docker service in the low-side stack (dev/training/lab)
- **External**: C2 gateway connects to an externally-hosted instance via API (production)

### Data Classification

All data entities carry a classification label: **UNCLASS**, **CUI**, or **SECRET**.

- Classification is **per-entity** (each ticket, finding, endpoint, command, audit event)
- NiFi transfer policies enforce classification boundaries:
  - UNCLASS: flows freely between enclaves
  - CUI: flows with policy controls and audit
  - SECRET: stays on high side only, never crosses CTI
- Operations set a default classification; individual entities can be **upgraded** (never downgraded)

### Finding Lifecycle (Cross-Domain)

Findings that originate on the low side and get enriched on the high side follow a **copy-on-transfer** model:
1. Low side creates finding (UNCLASS) → auto-syncs to high side via NiFi
2. High side creates enriched copy (CUI/SECRET) with a `origin_finding_id` link
3. Both entities have independent lifecycles
4. If enriched finding is CUI, a redacted summary can sync back to low side
5. SECRET findings never cross back to low side

### Controlled Transfer Interface (CTI)

Built on **Apache NiFi** with **MiNiFi** lightweight agents:

| Component | Location | Role |
|-----------|----------|------|
| NiFi (full) | Dedicated CTI zone | Policy engine, provenance, approval queues |
| MiNiFi agent | Low-side network | Pushes telemetry/audit to NiFi, receives commands |
| MiNiFi agent | High-side network | Pushes commands/policy to NiFi, receives telemetry |

**Transfer policies:**
- **Low → High (auto-stream)**: Telemetry, audit events, session data, command results, UNCLASS/CUI findings
- **High → Low (risk-based)**: Risk 1-3 commands auto-release. Risk 4-5 commands queue for human approval in NiFi before release.
- **Blocked**: SECRET-classified data never crosses CTI in either direction

**Provenance**: Every transfer is tracked with full chain of custody. Provenance data is:
1. Stored natively in NiFi's provenance repository
2. Replicated to high-side ClickHouse for the consolidated audit dashboard

### Data Stores (per enclave)

Each enclave has its own independent data stores:

| Store | Tech | Purpose |
|-------|------|---------|
| Primary DB | PostgreSQL 16 | All relational data (schema in `infra/db/postgres/migrations/`) |
| Audit/Telemetry | ClickHouse | Append-only event store + NiFi provenance (high side) |
| Cache | Redis 7 | Sessions, rate limiting, ephemeral pub/sub |
| Message Bus | NATS JetStream | Durable async events between services |
| Object Storage | MinIO | Artifacts, loot, attachments (S3-compatible) |

### Auth Model

- **High side**: Authoritative user database. All user CRUD happens here.
- **Low side**: Cached replica of the user DB, synced via CTI.
- **When CTI is severed**: Low side continues to authenticate against cached credentials. No expiry — logins always work. Risk: stale credentials if a user is revoked on high side while CTI is down.
- **When CTI reconnects**: Full user sync, revocations applied, new users added.

### Defensive Cyber Operations (DCO / SOC)

EMS-COP supports both offensive (red team) and defensive (blue team) operations on the same platform:

| Capability | Description | New Service? |
|------------|-------------|--------------|
| Alert ingestion | SIEM/EDR feed intake (Splunk, Elastic, CrowdStrike, etc.) | New: alert-ingest service |
| Incident tickets | Incident response tickets with DCO-specific state machine | Extension: ticket-service |
| Response playbooks | Automated/semi-automated response workflows | Extension: workflow-engine |
| IOC management | Indicators of compromise CRUD, sharing, enrichment | New: ioc-service or endpoint-service extension |
| MITRE ATT&CK mapping | Technique/tactic tagging on findings, tickets, operations | Extension: data model |
| Threat intel enrichment | External feed integration (STIX/TAXII, VirusTotal, etc.) | New: threat-intel service |
| Automated containment | Isolate endpoint, block IP, disable account actions | Extension: c2-gateway + endpoint-service |

DCO and red team operations use the same platform (operations, tickets, workflows, dashboards) with different operation types, workflow templates, and dashboard layouts.

### Low-Side Degraded Mode

When the CTI is severed, the low side enforces these restrictions:

| Capability | Available | Blocked |
|------------|-----------|---------|
| Execute existing approved tasks | Yes | |
| Run risk 1-2 commands | Yes | |
| Create tickets | Yes | |
| Collect telemetry/audit | Yes | |
| View existing operations | Yes | |
| Create new operations | | Yes |
| Approve risk 3+ | | Yes |
| Create/modify workflows | | Yes |
| Access SECRET data | | Yes (never on low side) |

## Project Structure

```
ems-cop/
├── docker-compose.yml              # Single-enclave dev (current)
├── docker-compose.low.yml          # Low-side enclave (planned)
├── docker-compose.high.yml         # High-side enclave (planned)
├── docker-compose.cti.yml          # CTI zone / NiFi (planned)
├── env.template                    # -> copy to .env
├── CLAUDE.md                       # This file
├── docs/
│   ├── SYSTEM_DESIGN.md            # Full requirements, user stories, architecture
│   └── plans/                      # Milestone design documents
├── services/
│   ├── auth/                       # Go — JWT, RBAC, user CRUD, replica sync
│   ├── workflow-engine/            # Go — DAG execution, approval gates, risk routing
│   ├── ticket/                     # Node/TS — ticket CRUD, state machine
│   ├── dashboard/                  # Node/TS — layout CRUD, enclave-aware templates
│   ├── c2-gateway/                 # Go — C2Provider interface (Sliver/Mythic/Havoc)
│   ├── audit/                      # Go — NATS consumer → ClickHouse, NiFi provenance ingest
│   ├── notification/               # Node/TS — multi-channel notification dispatch
│   ├── endpoint/                   # Go — endpoint registry, health, telemetry, topology
│   └── ws-relay/                   # Node/TS — NATS → WebSocket fan-out
├── frontend/
│   ├── src/
│   │   ├── components/widgets/     # Dashboard widget catalog (12 widgets)
│   │   ├── components/network-map/ # Cytoscape topology, node detail, device icons
│   │   ├── components/dashboard/   # Grid layout, widget wrapper, tab bar
│   │   ├── components/workflow/    # Approval actions, stage list, visual editor
│   │   ├── pages/                  # Login, Home, Tickets, C2, Operations, Dashboards
│   │   ├── pages/admin/            # Schema editor, parser workbench, workflow editor, Jira
│   │   ├── stores/                 # Zustand stores (auth, dashboard, socket, workflow, notification)
│   │   └── hooks/                  # useAuth, useSocket
│   ├── package.json
│   ├── Dockerfile
│   └── nginx.conf
├── infra/
│   ├── traefik/                    # traefik.yml (static), dynamic.yml (routes)
│   ├── nifi/                       # NiFi flow definitions, CTI policies (planned)
│   └── db/
│       ├── postgres/migrations/    # 001-007+ migration files
│       └── clickhouse/             # audit events, C2 telemetry, NiFi provenance
├── charts/
│   └── ems-cop/                    # Helm umbrella chart (10 sub-charts + deps)
├── deploy/                         # Deployment tooling (planned)
│   ├── ansible/                    # Bare metal / VM playbooks
│   └── terraform/                  # Infrastructure provisioning
├── sliver/                         # Sliver C2 server Docker setup
├── mythic/                         # Mythic C2 server Docker setup (planned)
├── havoc/                          # Havoc C2 server Docker setup (planned)
├── endpoints/                      # Managed target Dockerfiles
└── scripts/                        # Utility scripts
```

## Design Principles

1. **User-sovereign customization** — Roles, workflows, approval chains, dashboards, visibility are ALL user-configurable at runtime. Ship defaults, never lock in.
2. **Linear-first, branch-capable workflows** — Default: Planner → E3 → E2 → E1 → Operator. Any stage can have kickback rules, conditional branches, parallel gates.
3. **Expandable, not disposable** — Every POC decision should be something we build on, not throw away.
4. **Audit everything** — Every action → NATS event → ClickHouse. Every CTI transfer → NiFi provenance → ClickHouse. Append-only, hash-chained. Three audit planes (low, CTI, high) consolidated on high side.
5. **Echelon-appropriate granularity** — Same data, different views. Visibility controlled by RBAC + classification, not separate data models.
6. **C2-agnostic** — `C2Provider` interface supports Sliver, Mythic, Havoc, or custom C2. Per-operation backend selection.
7. **Classification-aware** — UNCLASS/CUI/SECRET labels on all entities. Transfer policies enforced at CTI.
8. **Enclave-portable** — Same service binaries on both sides. Behavior driven by `ENCLAVE` env var and classification policies.
9. **Deploy anywhere** — Docker Compose (dev), Helm (K8s), Ansible/Terraform (bare metal). Design for all three.

## Coding Conventions

### Go Services (auth, workflow-engine, c2-gateway, audit, endpoint)
- Go 1.22+, standard library `net/http` with `mux.HandleFunc("METHOD /path", handler)` pattern
- Structured logging with `log/slog`
- Errors: wrap with `fmt.Errorf("context: %w", err)`, return errors up, handle at handler level
- NATS: `github.com/nats-io/nats.go` with JetStream
- PostgreSQL: `github.com/jackc/pgx/v5` (not `database/sql`)
- ClickHouse: `github.com/ClickHouse/clickhouse-go/v2`
- gRPC (for Sliver): `google.golang.org/grpc`
- Config from environment variables, no config files

### Node/TS Services (ticket, dashboard, notification, ws-relay)
- Node 20 LTS, TypeScript
- Express.js for HTTP, `pg` for PostgreSQL, `nats` for NATS JetStream
- `ioredis` for Redis, `socket.io` for WebSocket (ws-relay), `pino` for logging
- Config from environment variables

### Frontend (React/TS)
- React 18, TypeScript, Vite, Zustand (state), TanStack Query/Table (server state + tables)
- Tailwind CSS, react-grid-layout (dashboard), Cytoscape.js (topology), xterm.js (terminal)
- TipTap (rich text), Recharts (charts), Socket.IO client (real-time), Lucide React (icons)
- Components in `src/components/`, pages in `src/pages/`, hooks in `src/hooks/`, stores in `src/stores/`

### API Conventions
- All REST endpoints under `/api/v1/{service}/`
- JSON request/response bodies
- Standard error format: `{ "error": { "code": "NOT_FOUND", "message": "..." } }`
- Pagination: `?page=1&limit=20` → `{ data: [...], pagination: { page, limit, total } }`
- Filtering: `?status=active&risk_level=3&classification=UNCLASS`
- Sorting: `?sort=created_at&order=desc`
- All timestamps in ISO 8601 UTC
- Classification header: `X-Classification: UNCLASS|CUI|SECRET` on all responses

### Event Bus (NATS) Topics
- `auth.*` — login, logout, role changes
- `ticket.*` — created, updated, status_changed, commented
- `workflow.*` — stage_entered, approved, rejected, kickback, escalated
- `operation.*` — created, updated, status_changed, member_added, member_removed
- `c2.*` — command_executed, session_opened, session_closed, implant_checkin
- `endpoint.*` — registered, status_changed, health_updated
- `command_preset.*` | `network.*` | `finding.*` | `audit.*` — respective CRUD events
- `cti.*` — transfer_requested, transfer_approved, transfer_completed, transfer_blocked (planned)
- `classification.*` — label_changed, policy_violation (planned)
- `dco.*` — alert_received, incident_created, containment_executed (planned)

### Database Conventions
- UUIDs for all primary keys (`gen_random_uuid()`)
- `created_at` / `updated_at` timestamps on all tables (auto-updated via trigger)
- `classification TEXT NOT NULL DEFAULT 'UNCLASS'` on all data entities
- JSONB for semi-structured data, `TEXT[]` for tags
- Indexes on all foreign keys, classification, and common query patterns
- Audit log in ClickHouse (NOT PostgreSQL) — events via NATS → audit-service

## Environment Variables

All services receive common env vars via `x-common-env` in docker-compose.yml:
- `ENCLAVE` — `low` or `high` (determines degraded mode rules, auth behavior, default templates)
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REDIS_URL`, `NATS_URL`
- `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`, `CLICKHOUSE_DB`
- `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`
- `JWT_SECRET`, `SERVICE_NAME`, `SERVICE_PORT`
- `ALLOWED_ORIGINS` (CORS + WebSocket origin allowlist, comma-separated)
- `PG_MAX_CONNS`, `PG_MIN_CONNS`, `PG_CONN_MAX_LIFETIME_MINS` (connection pool tuning)
- `C2_PROVIDER` — `sliver`, `mythic`, `havoc` (default C2 backend, overridable per operation)
- `CTI_ENABLED` — `true`/`false` (enables/disables cross-domain transfer awareness)
- `NIFI_API_URL` — NiFi REST API endpoint for transfer status/approval (planned)

## Key Files to Reference

- **Full requirements & architecture:** `docs/SYSTEM_DESIGN.md`
- **Database schema:** `infra/db/postgres/migrations/001_core_schema.sql`
- **Audit schema:** `infra/db/clickhouse/init.sql`
- **C2 Provider interface:** `services/c2-gateway/main.go`
- **Docker topology:** `docker-compose.yml`
- **Traefik routing:** `infra/traefik/dynamic.yml` (file-based provider)
- **Traefik static config:** `infra/traefik/traefik.yml`
- **Auth service:** `services/auth/main.go`
- **Ticket service:** `services/ticket/src/index.js`
- **Audit service:** `services/audit/main.go`
- **Workflow engine:** `services/workflow-engine/main.go`
- **Endpoint service:** `services/endpoint/main.go`
- **Notification service:** `services/notification/src/index.js`
- **WS-Relay:** `services/ws-relay/src/index.js`
- **Dashboard service:** `services/dashboard/src/index.js`
- **Widget catalog:** `frontend/src/components/widgets/WidgetRegistry.ts`
- **Network map components:** `frontend/src/components/network-map/`
- **Helm umbrella chart:** `charts/ems-cop/Chart.yaml`
- **Helm values:** `charts/ems-cop/values.yaml`
- **Kubernetes Ingress:** `charts/ems-cop/templates/ingress.yaml`
- **Migrations:** `infra/db/postgres/migrations/` (001 through 008)
- **Classification migration:** `infra/db/postgres/migrations/008_data_classification.sql`
- **ClickHouse classification:** `infra/db/clickhouse/002_classification.sql`
- **Provider registry:** `services/c2-gateway/provider_registry.go`
- **Mythic provider:** `services/c2-gateway/mythic_provider.go`
- **Havoc provider:** `services/c2-gateway/havoc_provider.go`
- **Classification components:** `frontend/src/components/ClassificationBadge.tsx`, `ClassificationSelect.tsx`, `ClassificationFilter.tsx`
- **Enclave store:** `frontend/src/stores/enclaveStore.ts`
- **C2 Backends admin:** `frontend/src/pages/admin/C2BackendsPage.tsx`
- **CTI relay service:** `services/cti-relay/main.go`
- **Docker Compose (low):** `docker-compose.low.yml`
- **Docker Compose (high):** `docker-compose.high.yml`
- **Docker Compose (CTI):** `docker-compose.cti.yml`
- **Traefik (low):** `infra/traefik/dynamic-low.yml`
- **Traefik (high):** `infra/traefik/dynamic-high.yml`
- **CTI transfers migration:** `infra/db/postgres/migrations/009_cti_transfers.sql`
- **EnclaveBanner:** `frontend/src/components/EnclaveBanner.tsx`
- **DegradedModeOverlay:** `frontend/src/components/DegradedModeOverlay.tsx`
- **CTI store:** `frontend/src/stores/ctiStore.ts`
- **CTIHealthWidget:** `frontend/src/components/widgets/CTIHealthWidget.tsx`
- **Helm per-enclave:** `charts/ems-cop/values-low.yaml`, `charts/ems-cop/values-high.yaml`
- **NiFi Dockerfile:** `nifi/Dockerfile`
- **NiFi flow template:** `nifi/flow-templates/ems-cti-flow.json`
- **MiNiFi configs:** `nifi/minifi-low.yml`, `nifi/minifi-high.yml`
- **NiFi client:** `services/cti-relay/nifi_client.go`
- **NiFi migration:** `infra/db/postgres/migrations/010_cti_nifi.sql`
- **Provenance schema:** `infra/db/clickhouse/003_cti_provenance.sql`
- **Transfer approvals page:** `frontend/src/pages/TransferApprovalsPage.tsx`
- **Transfer history page:** `frontend/src/pages/TransferHistoryPage.tsx`
- **NiFi admin page:** `frontend/src/pages/admin/NiFiStatusPage.tsx`
- **Design docs:** `docs/plans/` directory

## Testing

**1,220+ tests across all 10 services + frontend:**

- **Go**: `go test ./...` — auth (82), audit (98), workflow-engine (198), endpoint (219), c2-gateway (162), cti-relay (80)
- **Node**: Jest — ticket (74), dashboard (49), notification (61), ws-relay (44)
- **Frontend**: Vitest + RTL — 133 tests across stores, pages, components, hooks
- **Integration**: Docker Compose test profile with health check assertions
- **E2E**: Playwright (future)
- **Security**: DevSecOps agent review on every change
- **28 tests skip** in CI without live infra (PostgreSQL/Redis/NATS/ClickHouse) — by design

## Milestone Roadmap

### Completed (M1–M7, v0.12.0)

| Milestone | Summary |
|-----------|---------|
| M1 — Skeleton | All containers healthy, DB schemas, Traefik routing, seed data |
| M2 — Auth + Tickets | JWT auth, ForwardAuth RBAC, ticket CRUD (10-state), audit pipeline |
| M3 — Sliver Connected | C2 Gateway gRPC, sessions, commands, presets, HTTP implant E2E |
| M4a — Operations & Networks | Operations CRUD, network topology maps, Nmap import |
| M4b — Network Enhancements | Node detail panel, vuln drill-down, parser engine, admin workbench |
| M4c — Dashboards | 12 widgets, react-grid-layout, Socket.IO relay, echelon templates |
| M5 — Workflows | Linear DAG, approval gates, kickback, visual editor |
| M6 — Integrations | Notifications (in-app/email/webhook), noVNC remote desktop, Jira sync |
| M7a — Security | Body limits, CORS lockdown, rate limiting, error sanitization, HMAC |
| M7b — Reliability | Graceful shutdown, health probes, timeouts, pino logging, connection pools |
| M7c — Kubernetes | Helm umbrella chart (10 sub-charts), Traefik IngressRoute, standard Ingress |

### Completed (M8a + M8b + M11, v0.13.0)

| Milestone | Summary |
|-----------|---------|
| M8a — Test Suite | 1,190 tests (Go table-driven, Jest, Vitest+RTL) across all 9 services + frontend. 28 skip (infra-dependent integration tests). Security-reviewed. |
| M8b — Data Classification | `classification` column (UNCHECK/CUI/SECRET) on 9 tables + ClickHouse. Enclave enforcement on all GET/LIST/UPDATE/DELETE handlers. No-downgrade policy. ClassificationBadge/Select/Filter frontend components. EnclaveStore. |
| M11 — Multi-C2 | MythicProvider (GraphQL/REST), HavocProvider (REST), ProviderRegistry with thread-safe management. RBAC on provider admin. SSRF protection. Credential hiding (`json:"-"`). C2BackendsPage admin UI. Provider selector in C2Page. |

**Security findings resolved (M8b+M11):**
- CRITICAL #01: GET-by-ID enclave bypass — 39 handlers fixed across workflow-engine + endpoint
- CRITICAL #02: WS-Relay SECRET event leak — `continue` filter in NATS relay loop
- HIGH #03-05: Provider RBAC, SSRF blocklist, credential exposure via `SafeConfig()`
- MEDIUM #07-08: Jira inbound SECRET block, CUI auto-sync block

### Completed (M9, v0.14.0)

| Milestone | Summary |
|-----------|---------|
| M9 — Dual Topology | Docker Compose split (low.yml/high.yml/cti.yml), CTI relay service (Go), degraded mode in all 10 services, socat bridge proxies for network isolation, EnclaveBanner + DegradedModeOverlay + CTIHealthWidget, per-enclave Helm values + Traefik configs. |

**M9 details:**
- **Docker Compose**: `docker-compose.low.yml` (21 services), `docker-compose.high.yml` (16 services), `docker-compose.cti.yml` (CTI relay). Networks: `low-ems-net` (10.100.0.0/16), `high-ems-net` (10.200.0.0/16), `cti-net` (10.102.0.0/16)
- **CTI Relay** (`services/cti-relay/`): Go service bridging enclaves. Auth sync (high→low), telemetry relay (low→high), transfer policy enforcement, API token authentication (constant-time), case-insensitive classification checks
- **Network isolation**: CTI relay on `cti-net` ONLY. Socat bridge proxies (`cti-low-bridge`, `cti-high-bridge`) forward only PG:5432 and NATS:4222 between enclave networks and cti-net
- **Degraded mode**: All 10 services check CTI health every 15s. Low-side restrictions when CTI down: no new operations, no risk 3+ approvals/commands, no new networks, Jira/email/webhook queued. Audit always writes locally.
- **Frontend**: EnclaveBanner (CUI//LOW SIDE amber, SECRET//HIGH SIDE red), DegradedModeOverlay (dismissible amber bar), CTIHealthWidget (dashboard widget), CTI indicator in AppLayout navbar
- **Helm**: `values-low.yaml`, `values-high.yaml` per-enclave overrides. Correct CTI relay port (3010)
- **Traefik**: `dynamic-low.yml`, `dynamic-high.yml` per-enclave routing. High side excludes C2 shell/VNC routes
- **Env templates**: `env.low.template`, `env.high.template` with distinct per-enclave secrets. CTI_API_TOKEN required
- **Migration 009**: `cti_transfers` table with indexes

**Security findings resolved (M9):**
- CRITICAL #1: CTI relay API authentication — Bearer token with `crypto/subtle.ConstantTimeCompare`
- CRITICAL #2: Case-sensitive SECRET bypass — `strings.EqualFold` + `normalizeClassification()` at input boundary
- HIGH #4: Shared default credentials — distinct per-enclave secrets in env templates
- HIGH #5: CTI relay on all networks — socat bridge proxies, relay on cti-net only
- LOW #12: Helm port mismatch fixed (4080→3010)
- LOW #13: C2 gateway replicas corrected for low side
- LOW #15: EnclaveBanner always shows max classification
- INFO #17: cti_transfers table in migration 009

**Known M9 deferred items (not critical for dev):**
- HIGH #3: PG connections use `sslmode=disable` (TLS for classified deployment)
- HIGH #6: NATS connections unauthenticated (auth + TLS for classified deployment)
- MEDIUM #8: 15s TOCTOU race window on degraded mode (acceptable for dev)
- MEDIUM #9: CTI health check not authenticated (HTTPS for classified deployment)

### Completed (M10, v0.15.0)

| Milestone | Summary |
|-----------|---------|
| M10 — CTI Service (NiFi) | Apache NiFi 2.0 in CTI zone, MiNiFi agents on both enclaves, NiFi flow templates (classification filter, policy check, provenance export), transfer approval workflow, NiFi REST API client, ClickHouse provenance schema, TransferApprovalsPage + TransferHistoryPage + NiFiStatusPage. |

**M10 details:**
- **NiFi**: `nifi/Dockerfile` (NiFi 2.0 + NATS CLI), flow template with ClassificationFilter → PolicyCheck → RouteByDirection → ProvenanceExport pipeline
- **MiNiFi agents**: Low-side (audit/endpoint/c2 topics), high-side (workflow/operation/command topics with per-topic CUI classification)
- **CTI relay NiFi integration**: `nifi_client.go` (auth, flow management, provenance query, system diagnostics), approval endpoints (list/approve/reject with self-approval prevention), NiFi flow start/stop management
- **Transfer approval workflow**: Pending → approved/rejected/expired. Auto-expiry (24h default). Self-approval blocked via X-User-ID comparison
- **Provenance**: ClickHouse `cti_provenance` table + 2 materialized views (hourly stats, daily summary). NiFi provenance export every 30s
- **PostgreSQL migration 010**: `transfer_approvals`, `nifi_flow_configs`, `transfer_audit_log` tables with 4 seed flow configs
- **Frontend**: TransferApprovalsPage (tabbed queue, detail panel, approve/reject flow), TransferHistoryPage (filters, provenance timeline), NiFiStatusPage (admin, system diagnostics, flow management), TRANSFERS nav section
- **Traefik**: `/api/v1/cti` routes added to both dynamic-low.yml and dynamic-high.yml with auth-verify middleware

**Security findings resolved (M10):**
- CRITICAL #1-2: Removed hardcoded NiFi credentials from Dockerfile and CTI relay fallbacks
- CRITICAL #3: NiFi flow PolicyCheck now includes Bearer token auth + error routing to LogAttribute
- HIGH #4: Self-approval prevention via X-User-ID comparison
- HIGH #5: NiFi API path injection blocked via UUID format validation
- HIGH #14: NiFi status error messages sanitized (logged server-side, generic response to client)
- MEDIUM #9: NiFi port no longer exposed to host
- MEDIUM #10: High-side MiNiFi uses per-topic CUI classification (not blanket SECRET)
- MEDIUM #12: Provenance table name unified (`cti_provenance`), TTL aligned to 5 years
- LOW #15: Status filter validated against allowlist
- LOW #17: Provenance maxResults clamped to 1000

### Completed (M12, v0.16.0)

| Milestone | Summary |
|-----------|---------|
| M12 — Cross-Domain Ops | Risk-based routing (local/cross_domain/auto), high→low command flow via NATS relay, copy-on-transfer findings with lineage tracking, consolidated audit dashboard (high-side only), cross-domain command approval workflow, finding enrich/redact/sync-to-high endpoints. |

**M12 details:**
- **Workflow Engine**: `routing_mode` field on operations (local, cross_domain, auto), `POST /api/v1/operations/{id}/route` handler, auto-routing for risk 3+
- **C2 Gateway**: `POST /api/v1/c2/cross-domain/execute` (high-side only), `POST /api/v1/c2/cross-domain/commands/{id}/approve`, `GET /api/v1/c2/cross-domain/commands`, NATS command relay on low side, result listener on high side, Classification field on C2Task/TaskResult
- **CTI Relay**: Command relay (`cti.command.relay` NATS), finding sync with watermark, finding sync status/trigger endpoints, SECRET blocking on all relay paths, classification upgrade-only upsert
- **Endpoint Service**: `POST /api/v1/endpoints/findings/{id}/enrich` (high-side only), `GET /api/v1/endpoints/findings/{id}/lineage`, `POST /api/v1/endpoints/findings/{id}/redact` (high-side only), `POST /api/v1/endpoints/findings/{id}/sync-to-high`
- **Audit Service**: `GET /api/v1/audit/consolidated` (high-side only), `GET /api/v1/audit/consolidated/stats`, `GET /api/v1/audit/consolidated/correlation/{id}`, CTI relay NATS subscription, `source_enclave` tracking
- **Frontend**: ConsolidatedAuditPage (stacked area chart + filterable events), FindingLineagePage (finding list + lineage graph + enrich/redact/sync), CrossDomainCommandPanel (C2Page CROSS-DOMAIN tab), ConsolidatedAuditWidget (dashboard widget), OperationsPage routing_mode badge
- **Tests**: 1,251 pass (1,107 Go + 144 frontend), 0 failures

**Security findings resolved (M12):**
- HIGH #1: Role check used `strings.Contains()` substring matching — replaced with exact-match `hasRole()` helper
- HIGH #2: No classification check on low→high command results relay — added SECRET blocking
- HIGH #3: Finding sync upsert could downgrade classification — added CASE expression for upgrade-only
- MEDIUM #4-8: Cross-domain list enclave restriction, removed default PG passwords, fixed ActorUsername header, classification from request body, WebSocket origin check
- LOW #10-12: Added "auto" routing_mode, hid SECRET filter on low side, fixed undefined enclave button visibility

### Planned (M13+)

| Milestone | What | Depends On | Parallel? |
|-----------|------|------------|-----------|
| **M13 — DCO / SOC** | Alert ingestion (SIEM/EDR). Incident tickets. Response playbooks. IOC management. MITRE ATT&CK mapping. Threat intel enrichment. Automated containment. | M12 | |
| **M14 — Deployment Portability** | Ansible playbooks (bare metal). Terraform modules (cloud). Multi-cluster Helm. CI/CD pipeline (GitHub Actions). | M12 | Yes, with M13 |

### Known Limitations (Current)
- HTTP/HTTPS C2 transport does not support persistent interactive shell (needs MTLS/WireGuard)
- Implant check-in interval means command responses have polling latency (~5-10s)
- No CI/CD pipeline
- Casbin/OPA policy engine not yet wired (ad-hoc role checks in services)
- PG/NATS connections unencrypted (TLS planned for classified deployment)
- NiFi/MiNiFi Site-to-Site uses RAW protocol (TLS planned for classified deployment)
- Provider credentials stored in plaintext in memory (encryption at rest planned)

## Important Notes

- Sliver image builds from source on first run — takes a few minutes.
- All seed user passwords are bcrypt hashes of `changeme` — NEVER use in production.
- `endpoint-net` is isolated from `ems-net` — only C2 gateway and Sliver bridge both.
- Dual-enclave mode: `docker compose -f docker-compose.low.yml -f docker-compose.cti.yml -f docker-compose.high.yml up -d`
- CTI relay requires `CTI_API_TOKEN` env var (will refuse to start without it).
- CTI relay connects ONLY to `cti-net` — socat bridge proxies handle PG/NATS forwarding.
- ClickHouse audit tables use `MergeTree` (append-only). Do NOT use `ReplacingMergeTree`.
- `C2Provider` interface is the contract. Keep C2-specific types inside their respective provider.
- Traefik uses **file-based provider** (not Docker provider). Routes in `infra/traefik/dynamic.yml`.
- Network subnets: `ems-net`/`low-ems-net` = `10.100.0.0/16`, `high-ems-net` = `10.200.0.0/16`, `endpoint-net` = `10.101.0.0/16`, `cti-net` = `10.102.0.0/16`.
- All host ports parameterized via `.env`. Defaults: HTTP=18080, PG=15432, CH=18123, Redis=16379, NATS=14222, MinIO=19090.
- ClickHouse TTL expressions must use `toDateTime(timestamp)` — raw `DateTime64` not supported.
- Seed data: 7 users (admin, planner1, mc1, sup1, lead1, op1, op2), 6 roles, default workflow, 4 endpoints, 2 groups.
- Classification labels must be present on ALL new data entities going forward.
- SECRET-classified data must NEVER be present on the low side or cross the CTI.

## Development Environment

This project runs inside the [Trail of Bits Claude Code devcontainer](https://github.com/trailofbits/claude-code-devcontainer).
The container has `bypassPermissions` enabled — agents run unrestricted (sandboxed by Docker).

**User workflow**: `devc .` → `devc shell` → `claude` (inside the container)

**Pre-installed tools**: gh CLI, claude CLI, Node 22 (fnm), ripgrep, fd, tmux, fzf, delta, ast-grep
