# EMS-COP: Endpoint Management System — Common Operating Picture

An enterprise-grade platform providing a unified operational workspace for planning, approving, executing, and supervising endpoint management operations. Built for red teaming with extensibility toward full endpoint lifecycle management.

## Quick Start

```bash
cp env.template .env        # Configure your environment
docker compose up -d --build # Start all services
```

Access the EMS dashboard at `http://localhost` (or the configured port).

## Architecture

See [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) for the full system design document including requirements, user stories, architecture decisions, data schema, and product roadmap.

### Services

| Service | Language | Port | Purpose |
|---------|----------|------|---------|
| Auth | Go | 3001 | Identity, RBAC, sessions |
| Workflow Engine | Go | 3002 | Approval chains, DAG execution |
| Ticket Service | Node/TS | 3003 | Unified ticketing CRUD |
| Dashboard Service | Node/TS | 3004 | Layout configs, widget data |
| C2 Gateway | Go | 3005 | Sliver (and future C2) integration |
| Audit Service | Go | 3006 | Append-only event logging |
| Notification Service | Node/TS | 3007 | Multi-channel notifications |
| Endpoint Service | Go | 3008 | Endpoint registry, health |
| WebSocket Relay | Node/TS | 3009 | Real-time push to frontend |
| Frontend | React/TS | 80 | COP Dashboard SPA |

### Infrastructure

| Component | Purpose |
|-----------|---------|
| PostgreSQL 16 | Primary relational data store |
| ClickHouse | Audit logs & telemetry (append-only, columnar) |
| Redis 7 | Cache, sessions, pub/sub |
| NATS JetStream | Durable async messaging |
| MinIO | S3-compatible object storage |
| Traefik v3 | API gateway, reverse proxy, service discovery |

### C2 Backend

| Component | Purpose |
|-----------|---------|
| Sliver Server | C2 framework (based on [JongoDB/sliver-weather](https://github.com/JongoDB/sliver-weather)) |
| POC Endpoints | Ubuntu & Alpine containers as managed targets |

## Project Structure

```
ems-cop/
├── docker-compose.yml          # Full POC orchestration
├── env.template                # Environment variable template
├── docs/
│   └── SYSTEM_DESIGN.md        # Architecture, requirements, roadmap
├── services/
│   ├── auth/                   # Auth service (Go)
│   ├── workflow-engine/        # Workflow engine (Go)
│   ├── ticket/                 # Ticket service (Node/TS)
│   ├── dashboard/              # Dashboard service (Node/TS)
│   ├── c2-gateway/             # C2 gateway with provider interface (Go)
│   ├── audit/                  # Audit service (Go)
│   ├── notification/           # Notification service (Node/TS)
│   ├── endpoint/               # Endpoint service (Go)
│   └── ws-relay/               # WebSocket relay (Node/TS)
├── frontend/                   # React SPA
│   └── src/components/widgets/ # Dashboard widget catalog
├── infra/
│   └── db/
│       ├── postgres/migrations/  # PostgreSQL schema
│       └── clickhouse/           # ClickHouse audit tables
├── sliver/                     # Sliver C2 server container
├── endpoints/                  # POC managed endpoint containers
└── scripts/                    # Utility scripts
```

## Default Users (POC)

| Username | Role | Echelon |
|----------|------|---------|
| `admin` | System Admin | — |
| `planner1` | Planner | — |
| `mc1` | Mission Commander | E3 |
| `sup1` | Supervisor | E2 |
| `lead1` | Senior Leadership | E1 |
| `op1`, `op2` | Operator | — |

Default password for all: `changeme`

## License

Proprietary — internal use only.
