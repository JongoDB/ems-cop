# EMS-COP Architecture Reference

> Detailed architecture documentation. For quick reference, see CLAUDE.md.
> For full requirements and user stories, see docs/SYSTEM_DESIGN.md.

## Dual-Enclave Topology

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

## C2 Backends (Multi-C2)

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

## Data Classification

All data entities carry a classification label: **UNCLASS**, **CUI**, or **SECRET**.

- Classification is **per-entity** (each ticket, finding, endpoint, command, audit event)
- NiFi transfer policies enforce classification boundaries:
  - UNCLASS: flows freely between enclaves
  - CUI: flows with policy controls and audit
  - SECRET: stays on high side only, never crosses CTI
- Operations set a default classification; individual entities can be **upgraded** (never downgraded)

## Finding Lifecycle (Cross-Domain)

Findings follow a **copy-on-transfer** model:
1. Low side creates finding (UNCLASS) → auto-syncs to high side via NiFi
2. High side creates enriched copy (CUI/SECRET) with `origin_finding_id` link
3. Both entities have independent lifecycles
4. If enriched finding is CUI, a redacted summary can sync back to low side
5. SECRET findings never cross back to low side

## Controlled Transfer Interface (CTI)

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

**Provenance**: Every transfer is tracked with full chain of custody:
1. Stored natively in NiFi's provenance repository
2. Replicated to high-side ClickHouse for the consolidated audit dashboard

## Auth Model

- **High side**: Authoritative user database. All user CRUD happens here.
- **Low side**: Cached replica of the user DB, synced via CTI.
- **When CTI is severed**: Low side continues to authenticate against cached credentials. No expiry — logins always work. Risk: stale credentials if a user is revoked on high side while CTI is down.
- **When CTI reconnects**: Full user sync, revocations applied, new users added.

## Defensive Cyber Operations (DCO / SOC)

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

DCO and red team operations use the same platform with different operation types, workflow templates, and dashboard layouts.

## Low-Side Degraded Mode

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

## Data Stores (per enclave)

Each enclave has its own independent data stores:

| Store | Tech | Purpose |
|-------|------|---------|
| Primary DB | PostgreSQL 16 | All relational data (`infra/db/postgres/migrations/`) |
| Audit/Telemetry | ClickHouse | Append-only event store + NiFi provenance (high side) |
| Cache | Redis 7 | Sessions, rate limiting, ephemeral pub/sub |
| Message Bus | NATS JetStream | Durable async events between services |
| Object Storage | MinIO | Artifacts, loot, attachments (S3-compatible) |

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
- `NIFI_API_URL` — NiFi REST API endpoint for transfer status/approval

## NATS Topics

- `auth.*` — login, logout, role changes
- `ticket.*` — created, updated, status_changed, commented
- `workflow.*` — stage_entered, approved, rejected, kickback, escalated
- `operation.*` — created, updated, status_changed, member_added, member_removed
- `c2.*` — command_executed, session_opened, session_closed, implant_checkin
- `endpoint.*` — registered, status_changed, health_updated
- `command_preset.*` | `network.*` | `finding.*` | `audit.*` — respective CRUD events
- `cti.*` — transfer_requested, transfer_approved, transfer_completed, transfer_blocked
- `classification.*` — label_changed, policy_violation
- `dco.*` — alert_received, incident_created, containment_executed

## Database Conventions

- UUIDs for all primary keys (`gen_random_uuid()`)
- `created_at` / `updated_at` timestamps on all tables (auto-updated via trigger)
- `classification TEXT NOT NULL DEFAULT 'UNCLASS'` on all data entities
- JSONB for semi-structured data, `TEXT[]` for tags
- Indexes on all foreign keys, classification, and common query patterns
- Audit log in ClickHouse (NOT PostgreSQL) — events via NATS → audit-service

## Network Subnets

- `ems-net` / `low-ems-net`: `10.100.0.0/16`
- `high-ems-net`: `10.200.0.0/16`
- `endpoint-net`: `10.101.0.0/16`
- `cti-net`: `10.102.0.0/16`

## Host Port Defaults

All parameterized via `.env`: HTTP=18080, PG=15432, CH=18123, Redis=16379, NATS=14222, MinIO=19090

## Coding Conventions

### Go Services (auth, workflow-engine, c2-gateway, audit, endpoint, cti-relay)
- Go 1.22+, standard library `net/http` with `mux.HandleFunc("METHOD /path", handler)` routing
- Structured logging with `log/slog`
- Errors: wrap with `fmt.Errorf("context: %w", err)`, return errors up, handle at handler level
- `pgx/v5` (not `database/sql`), `nats.go` with JetStream, `clickhouse-go/v2`
- gRPC for Sliver: `google.golang.org/grpc`
- Config from environment variables, no config files

### Node/TS Services (ticket, dashboard, notification, ws-relay)
- Node 20, TypeScript, Express, `pg`, `nats`, `ioredis`, `socket.io`, `pino`
- Config from environment variables

### Frontend (React/TS)
- React 18, TypeScript, Vite, Zustand (state), TanStack Query/Table (server state + tables)
- Tailwind CSS, react-grid-layout, Cytoscape.js, xterm.js, TipTap, Recharts, Socket.IO client, Lucide React
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
