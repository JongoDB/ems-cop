# M2 Design — Auth + Tickets

**Date:** 2026-02-23
**Milestone:** M2
**Status:** Approved

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| JWT strategy | Hybrid: thin access token (15min) + refresh token in Redis | Fast auth on routine requests, strict verification possible for high-risk ops in M3+ |
| Ticket states | 10 states (full) | Avoids retrofitting when workflow engine lands in M5 |
| Audit event publishing | Direct NATS publish per service | No shared cross-language libraries; JSON convention is enough for now |
| API auth enforcement | Traefik ForwardAuth | Services stay clean — no auth logic, just trust X-User-ID/X-User-Roles headers |

---

## 1. Auth Service (Go)

### Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/v1/auth/login` | Public | Validate credentials, create session, return tokens |
| POST | `/api/v1/auth/refresh` | Public | Validate refresh token, issue new access token |
| POST | `/api/v1/auth/logout` | Protected | Invalidate session in Redis |
| GET | `/api/v1/auth/verify` | Internal | ForwardAuth endpoint — validate JWT + session, return user context headers |
| GET | `/api/v1/auth/me` | Protected | Return current user profile + roles |
| GET | `/health` | Public | Health check |

### Token Structure

**Access token (JWT, 15-minute TTL):**
```json
{
  "sub": "user-uuid",
  "roles": ["admin", "operator"],
  "session_id": "session-uuid",
  "iat": 1708700000,
  "exp": 1708700900
}
```

**Refresh token:** Opaque random string, stored in Redis keyed by session ID. 7-day TTL.

### Session Storage (Redis)

- Key: `session:{session_id}`
- Value: `{user_id, roles, created_at, last_active, ip}`
- TTL: 7 days (matches refresh token)
- Logout deletes the key — ForwardAuth rejects immediately on next request

### Login Flow

1. Client sends `POST /api/v1/auth/login` with `{username, password}`
2. Auth-service queries PostgreSQL for user by username
3. Validates bcrypt hash
4. Creates session in Redis with `session:{uuid}` key
5. Signs access token (JWT) and generates refresh token
6. Returns `{access_token, refresh_token, user: {id, username, display_name, roles}}`

### ForwardAuth Flow

1. Traefik receives request to any protected route
2. Traefik forwards request headers to `http://auth-service:3001/api/v1/auth/verify`
3. Auth-service extracts `Authorization: Bearer <token>` header
4. Decodes and validates JWT (signature, expiry)
5. Checks Redis for active session (`session:{session_id}` key exists)
6. On success: returns 200 with headers:
   - `X-User-ID: <user_id>`
   - `X-User-Roles: admin,operator` (comma-separated)
   - `X-Session-ID: <session_id>`
7. On failure: returns 401
8. Traefik injects response headers into the forwarded request (success) or returns 401 to client (failure)

### Dependencies

- `github.com/jackc/pgx/v5` — PostgreSQL
- `github.com/golang-jwt/jwt/v5` — JWT signing/validation
- `github.com/redis/go-redis/v9` — Redis client
- `github.com/nats-io/nats.go` — NATS JetStream publisher
- `golang.org/x/crypto/bcrypt` — password hashing

---

## 2. Traefik ForwardAuth Configuration

### Middleware Definition (infra/traefik/dynamic.yml)

```yaml
http:
  middlewares:
    auth-verify:
      forwardAuth:
        address: "http://auth-service:3001/api/v1/auth/verify"
        authResponseHeaders:
          - "X-User-ID"
          - "X-User-Roles"
          - "X-Session-ID"
```

### Route Split

**Public (no middleware):**
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `GET /api/v1/*/health` (all health endpoints)
- `GET /` and all static assets (frontend SPA)

**Protected (auth-verify middleware):**
- All other `/api/v1/*` routes

Implementation: two routers per service — one public (higher priority, specific path match) and one protected (lower priority, prefix match with middleware).

---

## 3. Ticket Service (Node/TS)

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/tickets` | Create ticket (status: draft) |
| GET | `/api/v1/tickets` | List with pagination, filtering, sorting |
| GET | `/api/v1/tickets/:id` | Single ticket with comments |
| PATCH | `/api/v1/tickets/:id` | Update fields |
| POST | `/api/v1/tickets/:id/transition` | State machine transition |
| POST | `/api/v1/tickets/:id/comments` | Add comment |
| GET | `/api/v1/tickets/:id/comments` | List comments |
| GET | `/health` | Health check |

### State Machine

```
draft → submitted           (action: submit)
submitted → in_review        (action: review)
submitted → rejected         (action: reject)
in_review → approved         (action: approve)
in_review → rejected         (action: reject)
approved → in_progress       (action: start)
in_progress → paused         (action: pause)
paused → in_progress         (action: resume)
in_progress → completed      (action: complete)
completed → closed           (action: close)
any → cancelled              (action: cancel, except closed/cancelled)
```

Invalid transitions return:
```json
{"error": {"code": "INVALID_TRANSITION", "message": "Cannot transition from 'draft' to 'approved'"}}
```

Every transition publishes a NATS event on `ticket.status_changed`.

### Query Parameters

- Pagination: `?page=1&limit=20`
- Filtering: `?status=draft&priority=high&assignee_id=uuid&search=keyword`
- Sorting: `?sort=created_at&order=desc`
- Search: PostgreSQL `pg_trgm` fuzzy search on title and description

### Response Format

```json
{
  "data": [...],
  "pagination": {"page": 1, "limit": 20, "total": 142}
}
```

### Dependencies

- `pg` — PostgreSQL client
- `nats` — NATS JetStream publisher
- `express` — HTTP framework
- `uuid` — ID generation (or use PostgreSQL gen_random_uuid)

---

## 4. Audit Pipeline

### Event Format

All services publish events as JSON to NATS JetStream:

```json
{
  "event_type": "auth.login",
  "actor_id": "uuid",
  "actor_username": "admin",
  "actor_ip": "10.100.0.1",
  "session_id": "uuid",
  "resource_type": "user",
  "resource_id": "uuid",
  "action": "login",
  "details": "{\"method\": \"local\"}",
  "timestamp": "2026-02-23T19:00:00.000Z"
}
```

### NATS Topics

**Auth service:**
- `auth.login` — successful login
- `auth.logout` — logout
- `auth.login_failed` — failed attempt
- `auth.token_refreshed` — token refresh

**Ticket service:**
- `ticket.created` — new ticket
- `ticket.updated` — field changes (details contains diff)
- `ticket.status_changed` — state transition (details: `{from, to, action}`)
- `ticket.commented` — new comment

### Audit Service (Go)

- Subscribes to `auth.>` and `ticket.>` via JetStream durable consumers
- Batch-inserts into ClickHouse `ems_audit.events` table
  - Batch size: 100 events or 1-second window, whichever comes first
- Computes `hash` and `previous_hash` for hash chain integrity:
  - `hash = SHA-256(previous_hash + JSON-serialized event)`
  - Maintains last hash in memory; recovers from most recent ClickHouse row on startup
- Exposes `GET /api/v1/audit/events` for querying audit log
  - Query params: `?event_type=auth.login&actor_id=uuid&from=2026-02-01&to=2026-02-23&page=1&limit=50`

### Dependencies

- `github.com/nats-io/nats.go` — JetStream consumer
- `github.com/ClickHouse/clickhouse-go/v2` — ClickHouse writer
- `github.com/jackc/pgx/v5` — not needed (audit reads from ClickHouse only)

---

## 5. Frontend Changes

### Auth Flow

- Login page wired to `POST /api/v1/auth/login`
- Access token stored in Zustand store (memory only)
- Refresh token stored in httpOnly cookie (set by auth-service `Set-Cookie` header)
- Axios/fetch interceptor attaches `Authorization: Bearer <token>` to all API requests
- On 401 response: attempt `/api/v1/auth/refresh`, if that fails redirect to `/login`
- `useAuth` hook: `{user, roles, isAuthenticated, login, logout, isLoading}`

### Protected Routing

- All routes except `/login` wrapped in auth guard
- Auth guard checks `isAuthenticated` from Zustand store
- If not authenticated, redirect to `/login`

### Post-Login Landing Page (`/`)

- Welcome message with user display name and role badges
- Ticket queue summary: count of tickets by status
- Navbar: EMS-COP logo, Tickets link, user dropdown (profile, logout)
- This page becomes the dashboard shell in M4

### Tickets Page (`/tickets`)

- Table (TanStack Table): ticket number, title, status badge, priority, assignee, created date
- Filter bar: status dropdown, priority dropdown, search input
- "New Ticket" button → modal/page with form (title, description, priority, tags)
- Click row → ticket detail page:
  - Ticket metadata (status, priority, assignee, dates)
  - Description (read/edit)
  - Transition buttons based on current status + user roles
  - Comments thread with reply capability

---

## 6. Implementation Order

| Phase | What | Depends On | Testable Outcome |
|-------|------|-----------|------------------|
| 1 | Auth service core | Nothing | Login returns JWT, verify validates it |
| 2 | Traefik ForwardAuth wiring | Phase 1 | Unauthenticated requests get 401, login stays open |
| 3 | Ticket service | Phase 2 | CRUD tickets with auth, state transitions work |
| 4 | Audit service | Phase 1, 3 | Login + ticket events appear in ClickHouse |
| 5 | Frontend | Phase 1, 2, 3 | Browser login → landing page → create/view tickets |

Each phase is independently verifiable before moving to the next.
