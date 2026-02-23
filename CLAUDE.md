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

## Current State

**What exists and is production-quality:**
- Complete PostgreSQL schema with all tables, indexes, constraints, triggers, seed data (users, roles, workflows, endpoints, endpoint groups)
- Complete ClickHouse schema with audit events (hash-chained), C2 telemetry, endpoint health, materialized views
- Docker Compose with all 20+ services, health checks, network topology, volume mounts, Traefik labels
- C2 Gateway with full `C2Provider` interface, `SliverProvider` stub, risk classification system, REST API handlers
- Frontend widget registry with 12 widget definitions, echelon-default dashboard templates, plugin registration hook
- Sliver Dockerfile and entrypoint (daemon mode, auto-generates operator config)
- Endpoint Dockerfiles (Ubuntu + Alpine with SSH, web services, simulated users)
- Seed data: 7 users (admin, planner1, mc1, sup1, lead1, op1, op2), 6 roles, default workflow (6 stages), 4 endpoints, 2 groups

**What exists as scaffold (health endpoint only, needs implementation):**
- auth-service, workflow-engine, audit-service, endpoint-service (Go stubs)
- ticket-service, dashboard-service, notification-service, ws-relay (Node stubs)
- Frontend app shell (package.json, Dockerfile — no React app yet)

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
- `operation.*` — created, status_changed, phase_changed
- `c2.*` — command_executed, session_opened, session_closed, implant_checkin
- `endpoint.*` — registered, status_changed, health_updated
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

**M1 — Skeleton (Current target):** All containers start, health checks pass, Traefik routes, frontend loads login page, DB schemas applied, seed data loaded.

**M2 — Auth + Tickets:** Users can register/login (JWT), RBAC enforced at gateway, ticket CRUD, audit events flowing to ClickHouse.

**M3 — Sliver Connected:** C2 Gateway connects to Sliver gRPC. List implants, open shell via xterm.js widget. Commands logged.

**M4 — Dashboards:** Drag/drop dashboard with tabs, core widgets (terminal, topology, tickets, audit log, endpoints, notes), echelon templates.

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
