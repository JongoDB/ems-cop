# CLAUDE.md — EMS-COP Project Context

## What This Project Is

EMS-COP (Endpoint Management System — Common Operating Picture) is an enterprise platform that provides a unified operational workspace for planning, approving, executing, and supervising red team / endpoint management operations. Think: Kibana + Splunk dashboards meets military-style C2 (command and control) meets ticketing system — built for offensive security teams with proper approval chains, audit trails, and echelon-appropriate visibility.

The initial POC focuses on **red teaming operations** with Sliver C2 as the backend. All services run in Docker.

## Architecture Overview

Microservices communicating over REST (sync) and NATS JetStream (async). Traefik as API gateway. Two Docker networks: `ems-net` (services) and `endpoint-net` (managed targets). The C2 Gateway bridges both.

### Services

| Service | Lang | Port | Route Prefix | Purpose |
|---------|------|------|-------------|---------|
| auth-service | Go | 3001 | `/api/v1/auth` | JWT auth, RBAC (Casbin/OPA), sessions |
| workflow-engine | Go | 3002 | `/api/v1/workflows` | DAG-based workflow execution, approval gates |
| ticket-service | Node/TS | 3003 | `/api/v1/tickets` | Unified ticketing CRUD, state machine, search |
| dashboard-service | Node/TS | 3004 | `/api/v1/dashboards` | Layout configs, widget registry, templates |
| c2-gateway | Go | 3005 | `/api/v1/c2` | Bridges EMS ↔ Sliver via C2Provider interface |
| audit-service | Go | 3006 | `/api/v1/audit` | Ingests events from NATS → ClickHouse, hash chains |
| notification-service | Node/TS | 3007 | `/api/v1/notifications` | In-app (WebSocket), email, webhooks, Jira |
| endpoint-service | Go | 3008 | `/api/v1/endpoints` | Endpoint registry, health, telemetry ingest |
| ws-relay | Node/TS | 3009 | `/ws` | WebSocket fan-out to frontend clients |
| frontend | React/TS | 80 | `/` (catch-all) | COP Dashboard SPA |

### Data Stores

| Store | Tech | Purpose |
|-------|------|---------|
| Primary DB | PostgreSQL 16 | All relational data (schema in `infra/db/postgres/migrations/`) |
| Audit/Telemetry | ClickHouse | Append-only event store (schema in `infra/db/clickhouse/`) |
| Cache | Redis 7 | Sessions, rate limiting, ephemeral pub/sub |
| Message Bus | NATS JetStream | Durable async events between services |
| Object Storage | MinIO | Artifacts, loot, attachments (S3-compatible) |

### C2 Backend

- **Sliver server** in Docker (based on github.com/JongoDB/sliver-weather Dockerfile pattern)
- EMS connects to Sliver via **gRPC** using operator credentials
- The `C2Provider` interface in `services/c2-gateway/main.go` is the key abstraction — Sliver is the first implementation, but Mythic/Havoc/etc. can be added by implementing the same interface
- All C2 commands flow through a **risk classification** system (levels 1-5) that determines approval requirements

### Managed Endpoints (POC)

- Ubuntu 22.04 containers (workstations) on `172.31.1.x`
- Alpine 3.19 containers (DMZ servers) on `172.31.2.x`
- Sliver implants will be deployed to these for testing

## Project Structure

```
ems-cop/
├── docker-compose.yml              # Full orchestration (20+ services)
├── env.template                    # → copy to .env
├── .gitignore
├── README.md
├── CLAUDE.md                       # This file
├── docs/
│   └── SYSTEM_DESIGN.md            # Full requirements, user stories, architecture, roadmap
├── services/
│   ├── auth/                       # Go — JWT, RBAC, user CRUD
│   ├── workflow-engine/            # Go — DAG execution, approval gates, kickbacks
│   ├── ticket/                     # Node/TS — ticket CRUD, state machine, threading
│   ├── dashboard/                  # Node/TS — layout CRUD, widget configs, templates
│   ├── c2-gateway/                 # Go — C2Provider interface + Sliver adapter
│   ├── audit/                      # Go — NATS consumer → ClickHouse writer, hash chain
│   ├── notification/               # Node/TS — multi-channel notification dispatch
│   ├── endpoint/                   # Go — endpoint registry, health checks, telemetry
│   └── ws-relay/                   # Node/TS — NATS → WebSocket fan-out
├── frontend/
│   ├── src/
│   │   └── components/widgets/     # Dashboard widget catalog
│   ├── package.json                # React 18, react-grid-layout, xterm.js, cytoscape, tiptap, recharts
│   ├── Dockerfile                  # Multi-stage: Vite build → Nginx
│   └── nginx.conf                  # SPA routing
├── infra/
│   └── db/
│       ├── postgres/migrations/    # 001_core_schema.sql — COMPLETE relational schema + seed data
│       └── clickhouse/             # init.sql — audit events, C2 telemetry, health telemetry
├── sliver/
│   ├── Dockerfile                  # Sliver server install + daemon mode
│   └── docker-entrypoint.sh        # Auto-starts daemon, generates operator config
├── endpoints/
│   ├── Dockerfile.ubuntu           # Corp workstation target
│   └── Dockerfile.alpine           # DMZ server target
└── scripts/                        # Utility scripts
```

## Current State (M2 Complete — 2026-02-23)

**Fully implemented:**
- Complete PostgreSQL schema with all tables, indexes, constraints, triggers, seed data (users, roles, workflows, endpoints, endpoint groups)
- Complete ClickHouse schema with audit events (hash-chained), C2 telemetry, endpoint health, materialized views
- Docker Compose with all 20+ services, health checks, network topology, volume mounts, Traefik labels
- C2 Gateway with full `C2Provider` interface, `SliverProvider` stub, risk classification system, REST API handlers
- Frontend widget registry with 12 widget definitions, echelon-default dashboard templates, plugin registration hook
- Sliver Dockerfile and entrypoint (daemon mode, auto-generates operator config)
- Endpoint Dockerfiles (Ubuntu + Alpine with SSH, web services, simulated users)
- Seed data: 7 users (admin, planner1, mc1, sup1, lead1, op1, op2), 6 roles, default workflow (6 stages), 4 endpoints, 2 groups
- auth-service (Go) — JWT login/refresh/logout, ForwardAuth verify endpoint, Redis sessions, NATS event publishing
- ticket-service (Node) — full CRUD, 10-state machine transitions, comments, pagination, filtering, search (pg_trgm)
- audit-service (Go) — NATS consumer subscribing to auth/ticket/workflow/operation/c2/endpoint events, batch insert to ClickHouse, SHA-256 hash chain, query API with filters
- Frontend SPA — LoginPage, HomePage (ticket queue summary), TicketsPage (table + detail panel + create form), auth flows (Zustand store, token refresh, ProtectedRoute guard), tactical dark theme
- Traefik ForwardAuth wiring — public routes (login/refresh) at priority 100, protected API routes with auth-verify middleware at priority 50, CORS middleware

**What exists as scaffold (health endpoint only, needs implementation):**
- workflow-engine (Go) — DAG engine, approval gates, kickbacks not implemented
- dashboard-service (Node) — layout/config CRUD not implemented
- notification-service (Node) — multi-channel dispatch not implemented
- endpoint-service (Go) — endpoint registry, health/telemetry not implemented
- ws-relay (Node) — WebSocket fan-out not implemented

## Design Principles

1. **User-sovereign customization** — Roles, workflows, approval chains, dashboards, and visibility are ALL user-configurable at runtime. Ship defaults, never lock in.
2. **Linear-first, branch-capable workflows** — Default approval chain: Planner → E3 → E2 → E1 → Operator. Any stage can have kickback rules, conditional branches, parallel gates, inserted stages.
3. **Expandable, not disposable** — Every POC decision should be something we build on, not throw away. No temporary workarounds taped together.
4. **Audit everything** — Every user/system action → NATS event → ClickHouse. Append-only, hash-chained.
5. **Echelon-appropriate granularity** — Same data, different views. Visibility controlled by RBAC, not separate data models.
6. **C2-agnostic** — Sliver is the first backend, but the `C2Provider` interface must support Mythic, Havoc, Cobalt Strike, or custom C2 without core changes.

## Coding Conventions

### Go Services (auth, workflow-engine, c2-gateway, audit, endpoint)
- Go 1.22+, use standard library `net/http` with `mux.HandleFunc("METHOD /path", handler)` pattern (Go 1.22+ routing)
- Structured logging with `log/slog`
- Errors: wrap with `fmt.Errorf("context: %w", err)`, return errors up, handle at handler level
- NATS client: `github.com/nats-io/nats.go` with JetStream
- PostgreSQL: `github.com/jackc/pgx/v5` (not `database/sql`)
- ClickHouse: `github.com/ClickHouse/clickhouse-go/v2`
- gRPC (for Sliver): `google.golang.org/grpc`
- Config from environment variables, no config files

### Node/TS Services (ticket, dashboard, notification, ws-relay)
- Node 20 LTS, TypeScript
- Express.js for HTTP
- `pg` for PostgreSQL
- `nats` for NATS JetStream
- `ioredis` for Redis
- `socket.io` for WebSocket (ws-relay)
- Config from environment variables

### Frontend (React/TS)
- React 18 with TypeScript
- Vite for build tooling
- Zustand for state management
- TanStack Query for server state
- TanStack Table for data tables
- Tailwind CSS for styling
- react-grid-layout for dashboard drag/drop
- Cytoscape.js for network topology
- xterm.js for terminal widget
- TipTap for rich text editor
- Recharts for charts
- Socket.IO client for real-time updates
- Lucide React for icons
- Components in `src/components/`, pages in `src/pages/`, hooks in `src/hooks/`

### API Conventions
- All REST endpoints under `/api/v1/{service}/`
- JSON request/response bodies
- Standard error format: `{ "error": { "code": "NOT_FOUND", "message": "..." } }`
- Pagination: `?page=1&limit=20` → response includes `{ data: [...], pagination: { page, limit, total } }`
- Filtering: query params `?status=active&risk_level=3`
- Sorting: `?sort=created_at&order=desc`
- All timestamps in ISO 8601 UTC

### Event Bus (NATS) Topics
- `auth.*` — login, logout, role changes
- `ticket.*` — created, updated, status_changed, commented
- `workflow.*` — stage_entered, approved, rejected, kickback, escalated
- `operation.*` — created, updated, status_changed, member_added, member_removed
- `c2.*` — command_executed, session_opened, session_closed, implant_checkin
- `endpoint.*` — registered, status_changed, health_updated
- `command_preset.*` — created, updated, deleted
- `network.*` — created, imported, deleted, node_added, node_updated, edge_added
- `finding.*` — created, updated
- `audit.*` — catch-all for audit service consumption

### Database Conventions
- UUIDs for all primary keys (`gen_random_uuid()`)
- `created_at` / `updated_at` timestamps on all tables (auto-updated via trigger)
- JSONB for semi-structured data (permissions, configs, metadata)
- `TEXT[]` arrays for tags
- Indexes on all foreign keys and common query patterns
- Audit log in ClickHouse (NOT PostgreSQL) — events published via NATS, consumed by audit-service

## Environment Variables

All services receive common env vars via `x-common-env` in docker-compose.yml:
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `REDIS_URL`
- `NATS_URL`
- `CLICKHOUSE_HOST`, `CLICKHOUSE_PORT`, `CLICKHOUSE_DB`
- `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`
- `JWT_SECRET`
- `SERVICE_NAME`, `SERVICE_PORT`

## Milestone Roadmap

**M1 — Skeleton (Complete):** All containers start, health checks pass, Traefik routes, frontend loads login page, DB schemas applied, seed data loaded.

**M2 — Auth + Tickets (Complete):** Users can login (JWT), RBAC enforced at gateway via ForwardAuth, ticket CRUD with 10-state machine, audit events flowing to ClickHouse.

**M3 — Sliver Connected (Complete):** C2 Gateway connects to Sliver gRPC. List sessions, execute commands via C2 page. Configurable command presets. Commands logged to audit.

**M4 — Operations & Network Maps (In Progress):** Operations-centric navigation, network topology maps (Cytoscape.js), Nmap/Nessus import, findings management, auto-enrichment from C2 activity, dashboards with echelon templates.

**M5 — Workflows:** Linear workflow engine. Task → approval → execute flow. Kickback + conditional branch support. Visual editor.

**M6 — Integrations:** Notifications (in-app, email, webhooks), Sliver C2 panel widget, noVNC, Jira sync.

**M7 — Hardening:** Security audit, perf testing, docs, Helm chart scaffolding.

## Key Files to Reference

- **Full requirements & architecture:** `docs/SYSTEM_DESIGN.md`
- **Database schema:** `infra/db/postgres/migrations/001_core_schema.sql`
- **Audit schema:** `infra/db/clickhouse/init.sql`
- **C2 Provider interface:** `services/c2-gateway/main.go`
- **Widget catalog:** `frontend/src/components/widgets/WidgetRegistry.ts`
- **Docker topology:** `docker-compose.yml`
- **Traefik routing:** `infra/traefik/dynamic.yml` (file-based provider)
- **Traefik static config:** `infra/traefik/traefik.yml`
- **Command presets migration:** `infra/db/postgres/migrations/003_command_presets.sql`
- **Auth service:** `services/auth/main.go`
- **Ticket + commands API:** `services/ticket/src/index.js`
- **Audit service:** `services/audit/main.go`
- **Workflow engine (operations CRUD):** `services/workflow-engine/main.go`
- **Networks migration:** `infra/db/postgres/migrations/004_networks_and_findings.sql`
- **M4 design doc:** `docs/plans/2026-02-23-m4-operations-networks-design.md`

## Testing

- Go: standard `go test` with table-driven tests
- Node: Jest
- Frontend: Vitest + React Testing Library
- Integration: Docker Compose test profile with health check assertions
- E2E: Playwright (future)

## Important Notes

- The Sliver image builds from source on first run — this takes a few minutes. Be patient.
- All seed user passwords are bcrypt hashes of `changeme` — NEVER use in production.
- The `endpoint-net` network is isolated from `ems-net` — only the C2 gateway and Sliver server bridge both. This simulates real network segmentation.
- ClickHouse audit tables use `MergeTree` engine which is append-only by design. This is intentional for audit integrity. Do NOT use `ReplacingMergeTree` or any engine that allows mutations.
- The `C2Provider` interface in `c2-gateway/main.go` is the contract. Do not add Sliver-specific types to shared code — keep Sliver details inside `SliverProvider`.
- Traefik uses a **file-based provider** (not Docker provider) because Docker Desktop for Mac's proxy socket doesn't support the full Docker API. Routes are defined in `infra/traefik/dynamic.yml`.
- Network subnets: `ems-net` = `10.100.0.0/16`, `endpoint-net` = `10.101.0.0/16`. Endpoints at `10.101.1.x` (ubuntu) and `10.101.2.x` (alpine).
- All host ports are parameterized via `.env` to avoid conflicts with other Docker projects. Default dev ports: HTTP=18080, PG=15432, CH=18123, Redis=16379, NATS=14222, MinIO API=19090.
- ClickHouse TTL expressions must use `toDateTime(timestamp)` — raw `DateTime64` is not supported in TTL.

## Current Progress (M4a Complete — 2026-02-24)

M1 milestone fully validated (2026-02-22):
- All 21 containers start and stay healthy
- PostgreSQL: 25 tables, 7 users, 6 roles, 4 endpoints seeded
- ClickHouse: 3 tables + 2 materialized views
- Traefik: file-based routing to all 10 service paths
- Sliver: daemon running, gRPC :31337, operator config generated

M2 milestone fully validated (2026-02-23):
- Auth service: JWT login/refresh/logout, ForwardAuth verify, Redis sessions
- Ticket service: CRUD, 10-state machine, comments, pagination, search
- Audit pipeline: NATS events → audit-service → ClickHouse with hash chain
- Frontend: LoginPage, HomePage, TicketsPage with full auth flows
- Traefik ForwardAuth: unauthenticated API calls return 401, public routes stay open

M3 milestone fully validated (2026-02-23):
- C2 Gateway: Sliver gRPC connected, SliverProvider implements full C2Provider interface
- Sessions: list sessions, session details, OS/arch/transport metadata
- Commands: execute via Sliver RPC (ls, cat, ps, whoami, pwd, ifconfig, netstat, upload, download, shell)
- Command string parsing: compound commands like `cat /etc/hostname` auto-split into command + args
- Generic shell fallback: unknown commands execute via `/bin/sh -c` on implant
- Command timeout: 120s (for HTTP transport polling latency)
- Configurable command presets: PostgreSQL-backed, OS-aware (36 seed commands across linux/windows/macos)
- Two-tier presets: admin global presets + user personal presets with CRUD API
- Frontend C2 page: session list, command output, dynamic preset grid, add/edit/delete presets
- Audit: all C2 commands and command_preset changes flow to ClickHouse via NATS
- HTTP implant auto-deployed to ubuntu-workstation-1, verified end-to-end

**Known M3 limitations:**
- HTTP/HTTPS transport does not support persistent interactive shell (WebSocket terminal). Requires MTLS/WireGuard implant.
- Implant check-in interval means command responses have polling latency (~5-10s)

M4a milestone (Operations + Navigation) validated (2026-02-24):
- Migration 004: networks, network_nodes, network_edges, operation_members tables + findings enhancements
- Workflow engine: full operations CRUD API (create, list, get, update, transition, members) with pgx + NATS
- Traefik: routes for /api/v1/operations, /api/v1/networks, /api/v1/nodes, /api/v1/edges, /api/v1/findings
- Frontend: operations-centric nav (OPERATIONS, TICKETS, DASHBOARDS), OperationsPage, OperationDetailPage with 5 tab sub-routes
- Seed data: "Training Exercise" operation with Corp LAN (2 nodes) and DMZ (2 nodes) networks
- Version bumped to v0.4.0

**Next: M4b — Network Map Core** (Cytoscape.js topology, Nmap XML import, endpoint-service CRUD)
