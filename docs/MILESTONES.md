# EMS-COP Milestone History

> Detailed milestone completion records. Current version: **v0.16.0** (M12).

## Completed (M1–M7, v0.12.0)

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

## Completed (M8a + M8b + M11, v0.13.0)

| Milestone | Summary |
|-----------|---------|
| M8a — Test Suite | 1,190 tests (Go table-driven, Jest, Vitest+RTL) across all 9 services + frontend. 28 skip (infra-dependent integration tests). Security-reviewed. |
| M8b — Data Classification | `classification` column (UNCLASS/CUI/SECRET) on 9 tables + ClickHouse. Enclave enforcement on all GET/LIST/UPDATE/DELETE handlers. No-downgrade policy. ClassificationBadge/Select/Filter frontend components. EnclaveStore. |
| M11 — Multi-C2 | MythicProvider (GraphQL/REST), HavocProvider (REST), ProviderRegistry with thread-safe management. RBAC on provider admin. SSRF protection. Credential hiding (`json:"-"`). C2BackendsPage admin UI. Provider selector in C2Page. |

**Security findings resolved (M8b+M11):**
- CRITICAL #01: GET-by-ID enclave bypass — 39 handlers fixed across workflow-engine + endpoint
- CRITICAL #02: WS-Relay SECRET event leak — `continue` filter in NATS relay loop
- HIGH #03-05: Provider RBAC, SSRF blocklist, credential exposure via `SafeConfig()`
- MEDIUM #07-08: Jira inbound SECRET block, CUI auto-sync block

## Completed (M9, v0.14.0)

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

## Completed (M10, v0.15.0)

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

## Completed (M12, v0.16.0)

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

## Planned (M13+)

| Milestone | What | Depends On | Parallel? |
|-----------|------|------------|-----------|
| **M13 — DCO / SOC** | Alert ingestion (SIEM/EDR). Incident tickets. Response playbooks. IOC management. MITRE ATT&CK mapping. Threat intel enrichment. Automated containment. | M12 | |
| **M14 — Deployment Portability** | Ansible playbooks (bare metal). Terraform modules (cloud). Multi-cluster Helm. CI/CD pipeline (GitHub Actions). | M12 | Yes, with M13 |

## Known Limitations

- HTTP/HTTPS C2 transport does not support persistent interactive shell (needs MTLS/WireGuard)
- Implant check-in interval means command responses have polling latency (~5-10s)
- No CI/CD pipeline
- Casbin/OPA policy engine not yet wired (ad-hoc role checks in services)
- PG/NATS connections unencrypted (TLS planned for classified deployment)
- NiFi/MiNiFi Site-to-Site uses RAW protocol (TLS planned for classified deployment)
- Provider credentials stored in plaintext in memory (encryption at rest planned)
