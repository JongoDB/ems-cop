# EMS-COP Key Files Reference

> Quick lookup for important files. Agents can also `glob` or `grep` to find files on demand.

## Core Services

| Service | Entry Point | Scope |
|---------|-------------|-------|
| auth | `services/auth/main.go` | JWT, RBAC, sessions |
| workflow-engine | `services/workflow-engine/main.go` | DAG execution, approval gates |
| ticket | `services/ticket/src/index.js` | Ticket CRUD, state machine |
| dashboard | `services/dashboard/src/index.js` | Layout CRUD, templates |
| c2-gateway | `services/c2-gateway/main.go` | C2Provider interface |
| audit | `services/audit/main.go` | NATS → ClickHouse |
| notification | `services/notification/src/index.js` | Multi-channel dispatch |
| endpoint | `services/endpoint/main.go` | Registry, health, topology |
| ws-relay | `services/ws-relay/src/index.js` | NATS → WebSocket |
| cti-relay | `services/cti-relay/main.go` | Cross-domain bridge |

## C2 Gateway

- **Provider interface**: `services/c2-gateway/main.go`
- **Provider registry**: `services/c2-gateway/provider_registry.go`
- **Mythic provider**: `services/c2-gateway/mythic_provider.go`
- **Havoc provider**: `services/c2-gateway/havoc_provider.go`

## CTI / NiFi

- **NiFi client**: `services/cti-relay/nifi_client.go`
- **NiFi Dockerfile**: `nifi/Dockerfile`
- **NiFi flow template**: `nifi/flow-templates/ems-cti-flow.json`
- **MiNiFi configs**: `nifi/minifi-low.yml`, `nifi/minifi-high.yml`

## Frontend

- **Widget catalog**: `frontend/src/components/widgets/WidgetRegistry.ts`
- **Network map**: `frontend/src/components/network-map/`
- **Dashboard layout**: `frontend/src/components/dashboard/`
- **Workflow components**: `frontend/src/components/workflow/`
- **Classification**: `frontend/src/components/ClassificationBadge.tsx`, `ClassificationSelect.tsx`, `ClassificationFilter.tsx`
- **Enclave**: `frontend/src/components/EnclaveBanner.tsx`, `frontend/src/components/DegradedModeOverlay.tsx`
- **Pages**: `frontend/src/pages/` (Login, Home, Tickets, C2, Operations, Dashboards, admin/)
- **Stores**: `frontend/src/stores/` (auth, dashboard, socket, workflow, notification, enclave, cti)
- **Hooks**: `frontend/src/hooks/` (useAuth, useSocket)

## Infrastructure

- **Docker Compose**: `docker-compose.yml` (dev), `docker-compose.low.yml`, `docker-compose.high.yml`, `docker-compose.cti.yml`
- **Traefik routing**: `infra/traefik/dynamic.yml`, `dynamic-low.yml`, `dynamic-high.yml`
- **Traefik static**: `infra/traefik/traefik.yml`
- **Helm chart**: `charts/ems-cop/Chart.yaml`, `values.yaml`, `values-low.yaml`, `values-high.yaml`
- **Ingress**: `charts/ems-cop/templates/ingress.yaml`

## Database

- **PG migrations**: `infra/db/postgres/migrations/` (001 through 010)
  - 001: Core schema
  - 008: Data classification
  - 009: CTI transfers
  - 010: CTI NiFi (approvals, flow configs, audit log)
- **ClickHouse**: `infra/db/clickhouse/init.sql`, `002_classification.sql`, `003_cti_provenance.sql`

## Documentation

- **System design**: `docs/SYSTEM_DESIGN.md`
- **Architecture**: `docs/ARCHITECTURE.md`
- **Milestones**: `docs/MILESTONES.md`
- **Design docs**: `docs/plans/`
