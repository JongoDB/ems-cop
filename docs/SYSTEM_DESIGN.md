# EMS-COP System Design Document v0.2.0

## Revision Notes (v0.2.0)
- Workflow engine: linear-first with user-extensible branching and kickback gates
- Backend: polyglot microservices in containers — Go for C2/perf-critical, Node/TS for API/dashboard, Python optional for scripting
- Audit storage: ClickHouse — columnar, append-only, future-proof for analytical queries at scale
- Sliver image: based on [JongoDB/sliver-weather](https://github.com/JongoDB/sliver-weather) Dockerfile pattern
- Design principle: **solid foundations over temporary workarounds** — every POC decision should be expandable, not disposable

---

## 1. Design Principles

1. **User-sovereign customization**: Roles, workflows, approval chains, dashboard layouts, and visibility scopes are all user-configurable at runtime. The system ships with sensible defaults but never locks users into them.

2. **Linear-first, branch-capable workflows**: The default approval chain is a simple linear pipeline (Planner → E3 → E2 → E1 → Operator). Any role in the chain can define:
   - **Kickback rules**: send a ticket back to a prior stage with comments
   - **Conditional branches**: if [condition], route to [alternate stage] (e.g., risk_level > 3 → add E1 approval)
   - **Additional stages**: insert new approval or action steps anywhere in the chain
   - **Parallel gates**: require sign-off from multiple roles at the same stage

3. **Expandable architecture**: Every service interface, data schema, and integration point is designed for extension. No hardcoded assumptions about the number of echelons, command types, or C2 backends.

4. **Audit everything**: If a human or system did it, there's a record. Append-only, hash-chained, queryable, exportable.

5. **Echelon-appropriate granularity**: The same underlying data is presented at different levels of detail depending on who's looking. This is a UI/RBAC concern, not a data modeling concern — all data exists; visibility is controlled by role.

---

## 2. Architecture Decisions

### 2.1 Service Language Choices

| Service | Language | Rationale |
|---------|----------|-----------|
| C2 Gateway | Go | Native gRPC, same ecosystem as Sliver, high-perf streaming |
| Auth Service | Go | Policy evaluation needs to be fast; Casbin/OPA are Go-native |
| Workflow Engine | Go | State machine with high-throughput event processing |
| Audit Service | Go | High-write-volume event ingestion into ClickHouse |
| Endpoint Service | Go | Telemetry ingestion, health monitoring |
| Ticket Service | Node/TS | CRUD-heavy with complex querying; Prisma/TypeORM ecosystem |
| Dashboard Service | Node/TS | Serves the SPA, manages layout configs, close to frontend |
| Notification Service | Node/TS | I/O-bound integrations (SMTP, REST APIs, webhooks) |
| WebSocket Relay | Node/TS | Socket.IO / ws library ecosystem |
| Frontend | React/TS | Component model fits widget architecture; rich ecosystem |

### 2.2 Data Storage

| Store | Technology | Purpose | Why Future-Proof |
|-------|-----------|---------|------------------|
| Primary DB | PostgreSQL 16 | Relational data (users, roles, tickets, workflows, endpoints, dashboards) | Industry standard, JSON support, excellent extension ecosystem, scales vertically well and horizontally with Citus if needed |
| Audit/Telemetry | ClickHouse | Append-only event store, time-series telemetry, analytical queries | Columnar compression (10-50x), handles billions of rows, SQL-compatible, real-time inserts, no updates/deletes by design (perfect for audit), scales to petabytes |
| Cache/Sessions | Redis 7 (w/ persistence) | Session tokens, rate limiting, ephemeral pub/sub, WebSocket state | Cluster mode for HA, streams for message queuing fallback |
| Message Bus | NATS JetStream | Durable async messaging between services | Lightweight, K8s-native, JetStream gives exactly-once delivery, horizontally scalable, simpler ops than Kafka for this scale |
| Object Storage | MinIO | Artifacts, loot, attachments, exports, implant binaries | S3-compatible API (drop-in for AWS S3 in prod), erasure coding, versioning |

### 2.3 Why ClickHouse for Audit

ClickHouse is purpose-built for the audit log workload:
- **Append-only by design**: `MergeTree` engine doesn't support in-place updates — records are immutable once written
- **Columnar compression**: Audit events are highly repetitive (same action types, same users) → 10-50x compression ratio
- **Fast analytical queries**: "Show me all commands run by operator X in operation Y between dates A and B" is a native strength
- **Real-time inserts**: Handles 100k+ inserts/second on modest hardware
- **SQL interface**: No new query language to learn; ClickHouse speaks SQL
- **Materialized views**: Pre-aggregate common queries (e.g., daily command counts per user) without impacting write performance
- **TTL policies**: Built-in data lifecycle management for retention policies
- **Scales independently**: Can grow to petabytes without affecting PostgreSQL performance

For the POC, ClickHouse runs as a single container. In production, it clusters natively.

---

## 3. Workflow Engine Design

### 3.1 Core Model

A Workflow is an ordered list of Stages. The default execution is **linear** (stage 1 → stage 2 → ... → stage N). Each stage can optionally define **transition rules** that override the default linear flow.

```
Workflow
├── Stage 1: "Planner Drafts" (type: action)
├── Stage 2: "E3 Review" (type: approval, gate: mission_commander role)
│   ├── on_approve → Stage 3 (default: next)
│   ├── on_reject → Stage 1 (kickback to planner)
│   └── on_condition: if risk_level > 3 → Stage 2b
├── Stage 2b: "E1 Additional Review" (type: approval, gate: senior_leadership role)
│   ├── on_approve → Stage 3
│   └── on_reject → Stage 1
├── Stage 3: "E2 Approval" (type: approval, gate: supervisor role)
│   ├── on_approve → Stage 4
│   └── on_reject → Stage 2 (kickback to E3 with comments)
├── Stage 4: "Execute" (type: action, actor: operator role)
└── Stage 5: "Complete" (type: terminal)
```

### 3.2 Stage Types

| Type | Behavior |
|------|----------|
| `action` | A user with the specified role performs work (drafting, executing). Auto-advances when marked complete. |
| `approval` | Requires explicit approve/reject from user(s) with the gate role. Configurable: single approver, quorum (M of N), or all. |
| `notification` | Fires a notification and auto-advances. Used for informing stakeholders without blocking. |
| `condition` | Evaluates an expression against ticket/operation metadata and routes to the matching next stage. |
| `timer` | Waits for a duration, then advances or escalates. Used for SLA enforcement. |
| `terminal` | End state. No transitions out. |

### 3.3 User Customization

Users with the `workflow.manage` permission can:
- Create new workflows from scratch or by cloning/forking an existing one
- Add/remove/reorder stages
- Configure gate conditions (which roles, how many approvers, auto-approve rules)
- Define kickback targets (which prior stage to return to on rejection)
- Add conditional branches (if [expression] then route to [stage])
- Set escalation timers on approval stages
- Save workflows as templates for reuse
- Assign workflows to operations or set as the default for new operations

The UI for this is a visual DAG editor (react-flow or similar) with a linear view as the default, and branch/merge nodes available via drag-and-drop.

---

## 4. Sliver Integration Architecture

### 4.1 Container Setup

Based on the [JongoDB/sliver-weather](https://github.com/JongoDB/sliver-weather) Dockerfile pattern:

```
sliver/
├── Dockerfile           # Based on sliver-weather pattern
├── docker-entrypoint.sh # Starts sliver-server daemon, configures operator creds
└── config/              # Mounted volume for persistent Sliver state
```

The EMS C2 Gateway connects to Sliver's gRPC API using operator credentials. The Sliver server runs in daemon mode, and the C2 Gateway is the sole client — all operator interaction goes through EMS, not direct Sliver CLI access.

### 4.2 gRPC Integration Flow

```
Operator (browser) → EMS Frontend → EMS API Gateway → C2 Gateway → Sliver gRPC
                                                            ↓
                                                    Audit Service (logs command)
                                                    Workflow Engine (checks approval)
                                                    Endpoint Service (updates telemetry)
```

### 4.3 Command Risk Classification

| Risk Level | Examples | Approval Required |
|-----------|----------|-------------------|
| 1 (Recon) | ls, ps, netstat, ifconfig, whoami | Auto-approve (logged) |
| 2 (Low) | upload, download, screenshot | Auto-approve (logged, notified) |
| 3 (Medium) | execute, shell, sideload | E3 approval |
| 4 (High) | pivot, portfwd, execute-assembly | E3 + E2 approval |
| 5 (Critical) | Credential dumping, lateral movement, persistence | Full chain (E3 → E2 → E1) |

Risk classifications are **user-configurable** — the defaults above are templates. Operations can override per-engagement based on ROE.

---

## 5. Docker Compose Architecture (POC)

See `docker-compose.yml` for the full definition. Key design:

- All services on a shared Docker network (`ems-net`)
- Traefik as the API gateway with automatic service discovery via Docker labels
- PostgreSQL with initialization scripts for schema creation
- ClickHouse with table creation on startup
- NATS with JetStream enabled for durable messaging
- Sliver server based on JongoDB/sliver-weather image pattern
- POC endpoint containers (Ubuntu, Alpine) on a separate network segment (`endpoint-net`) bridged to `ems-net` via the C2 gateway
- Volume mounts for all persistent state (DB data, Sliver config, MinIO storage, builds)

---

## 6. Roadmap Refinement

### POC Milestones (Definition of Done)

**M1 — Skeleton (Week 1-2)**: All containers start, health checks pass, Traefik routes, frontend loads login page, PostgreSQL schema applied, ClickHouse tables created.

**M2 — Auth + Tickets (Week 3-4)**: Users can register/login, create roles, create tickets, view ticket queue. Audit events written to ClickHouse for all actions.

**M3 — Sliver Connected (Week 5-7)**: C2 Gateway talks to Sliver gRPC. Operators can list implants, open shell sessions via xterm.js widget. Commands logged to audit.

**M4 — Dashboards (Week 8-11)**: Drag-and-drop dashboard with tabs. Core widgets: terminal, network topology, ticket queue, audit log, endpoint table, notes. Dashboard templates per echelon.

**M5 — Workflows (Week 12-15)**: Linear workflow engine operational. Task → approval → execute flow working end-to-end. Kickback and conditional branch support. Visual workflow editor.

**M6 — Integrations + Polish (Week 16-19)**: Notification channels (in-app, email, webhooks). Sliver C2 panel widget. noVNC widget. Dashboard sharing. Operation lifecycle complete.

**M7 — Hardening (Week 20-22)**: Security audit, performance testing, documentation, Helm chart scaffolding for K8s migration path.
