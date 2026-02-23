# Claude Code — EMS-COP Starter Prompt

Use this as your initial prompt when starting a Claude Code session in the `ems-cop/` project directory.

---

## Prompt

```
Read CLAUDE.md and docs/SYSTEM_DESIGN.md for full project context.

We're building EMS-COP — an Endpoint Management System with a Common Operating Picture for red team operations. The project scaffold is in place with Docker Compose (20+ services), complete PostgreSQL and ClickHouse schemas with seed data, a C2 Gateway with Sliver provider interface, frontend widget registry, and container configs for Sliver C2 and managed endpoints.

Current target: Milestone 1 — get the skeleton running end-to-end.

Implement the auth-service (Go) with these requirements:
1. POST /api/v1/auth/login — accepts { username, password }, validates against bcrypt hash in PostgreSQL users table, returns JWT (HS256, signed with JWT_SECRET env var, includes user_id, username, roles[] in claims, 24h expiry)
2. POST /api/v1/auth/register — creates new user (hash password with bcrypt, insert into users table)
3. GET /api/v1/auth/me — requires valid JWT in Authorization: Bearer header, returns user profile with roles
4. GET /api/v1/auth/users — list all users (admin only)
5. Middleware: JWT validation function that extracts claims and can be used by other services via shared JWT secret
6. On startup: connect to PostgreSQL (pgx), verify connection, log ready state
7. Publish auth events to NATS (auth.login, auth.register) for audit service consumption

Use pgx/v5 for PostgreSQL, golang-jwt/jwt/v5 for JWT, nats.go for NATS, golang.org/x/crypto/bcrypt for password hashing. Standard library net/http with Go 1.22 routing patterns. Structured logging with log/slog.

After auth-service is working, implement the ticket-service (Node/TS) with:
1. Full CRUD for tickets (POST, GET, GET/:id, PATCH/:id, DELETE/:id)
2. Ticket state machine (draft → submitted → in_review → approved/rejected → in_progress → completed/cancelled)
3. POST /api/v1/tickets/:id/comments — add threaded comments
4. GET /api/v1/tickets?status=X&priority=Y&assigned_to=Z — filtering + pagination
5. Publish ticket events to NATS (ticket.created, ticket.updated, ticket.status_changed)
6. JWT auth middleware that validates the same tokens issued by auth-service

Then wire up the ws-relay to subscribe to NATS events and push them to connected frontend clients via Socket.IO, and implement the audit-service to consume all NATS events and write them to ClickHouse with hash chaining.

Build incrementally — get each service compiling and handling basic requests before moving to the next. Run docker compose up for infrastructure, then test each service individually.
```

---

## Tips for Working with Claude Code on This Project

### Session Management
- Start sessions from the `ems-cop/` root directory so CLAUDE.md is auto-loaded
- Claude Code will read CLAUDE.md automatically for project context

### Infrastructure
- Run `chmod +x scripts/bootstrap.sh && ./scripts/bootstrap.sh` first to get infrastructure containers running
- Or manually: `cp env.template .env && docker compose up -d postgres redis nats minio clickhouse traefik`
- Verify: `docker compose ps` — all infra should show "healthy"

### Development Workflow
- Develop services locally (outside Docker) during iteration for faster feedback loops
- Each Go service: `cd services/auth && go mod tidy && go run .`
- Each Node service: `cd services/ticket && npm install && npm run dev`
- Frontend: `cd frontend && npm install && npm run dev`
- Test against containerized infrastructure (Postgres, Redis, NATS, etc.)
- Once a service works locally, build its Docker image: `docker compose build auth-service`

### Useful Commands
```bash
# Check what's running
docker compose ps

# View logs for a specific service
docker compose logs -f auth-service

# Connect to PostgreSQL directly
docker exec -it ems-postgres psql -U ems_admin -d ems

# Connect to ClickHouse
docker exec -it ems-clickhouse clickhouse-client --database ems_audit

# Check NATS health
curl http://localhost:8222/healthz

# Inspect Traefik routing
curl http://localhost:8080/api/http/routers | jq .

# Enter Sliver container
docker exec -it ems-sliver /bin/bash

# View an endpoint container
docker exec -it ems-endpoint-ubuntu-1 /bin/bash
```

### Follow-Up Prompts

After M1, here are good follow-up prompts:

**M2 — Build the frontend shell:**
```
Implement the frontend React app with: login page, authenticated layout with sidebar navigation, and a basic dashboard page that uses react-grid-layout with a placeholder widget. Use Zustand for auth state, TanStack Query for API calls, Tailwind CSS for styling. Wire up the auth flow to the auth-service JWT endpoints.
```

**M3 — Sliver integration:**
```
Implement the actual Sliver gRPC connection in the C2 Gateway. The Sliver server generates an operator config file at /home/sliver/configs/ems-operator.cfg — use this to establish a mTLS gRPC connection. Implement ListSessions, ListImplants, and ExecuteTask (for basic commands like ls, ps, whoami) on the SliverProvider. Then build the terminal widget (xterm.js) that connects to the ws-relay for interactive shell sessions proxied through the C2 Gateway.
```

**M4 — Dashboard engine:**
```
Build the full dashboard engine: react-grid-layout with drag/drop widget placement, tabbed views, save/load dashboard configurations via the dashboard-service API. Implement the core widgets: TerminalWidget (xterm.js connected to ws-relay), NetworkTopologyWidget (Cytoscape.js showing endpoints and implants from the endpoint-service API), TicketQueueWidget (filterable ticket list from ticket-service), AuditLogWidget (real-time log stream from ws-relay), EndpointTableWidget (TanStack Table from endpoint-service), and InlineNotesWidget (TipTap editor). Load the echelon-default templates from WidgetRegistry.ts.
```

**M5 — Workflow engine:**
```
Implement the workflow-engine service. It should: manage workflow CRUD (create/read/update/delete workflow definitions with stages and transitions), instantiate workflow runs when tickets are submitted, evaluate approval gates (check if the approving user has the required role), handle kickbacks (route ticket back to prior stage with comments), evaluate condition stages (parse simple expressions against ticket/operation metadata), and publish workflow events to NATS. Then build the approval UI in the frontend — inline approve/reject buttons on tickets with comment fields.
```
