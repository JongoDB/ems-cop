# M7 — Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden all EMS-COP services for production readiness — fix security vulnerabilities, add reliability primitives (graceful shutdown, health probes, structured logging), and scaffold Helm charts for Kubernetes migration.

**Architecture:** Three sub-milestones (M7a Security → M7b Reliability → M7c Helm). Each builds on the prior — security fixes first, then reliability primitives that K8s probes depend on, then Helm charts that reference both.

**Tech Stack:** Go 1.22+ (net/http, slog), Node 20 (Express, pino), Redis (rate limiting), Helm 3, Kubernetes manifests

---

## M7a — Security Hardening

### Task 1: Request Body Size Limits (Go Services)

**Files:**
- Modify: `services/auth/main.go` (add middleware before route handlers)
- Modify: `services/workflow-engine/main.go` (same pattern)
- Modify: `services/c2-gateway/main.go` (same pattern)
- Modify: `services/audit/main.go` (same pattern)
- Modify: `services/endpoint/main.go` (same pattern)

**Step 1: Add maxBodyMiddleware to auth service**

In `services/auth/main.go`, add a middleware function and wrap the mux:

```go
func maxBodyMiddleware(maxBytes int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		}
		next.ServeHTTP(w, r)
	})
}
```

Then in `main()`, change:
```go
// Before:
if err := http.ListenAndServe(fmt.Sprintf(":%s", port), mux); err != nil {

// After:
handler := maxBodyMiddleware(1<<20, mux) // 1 MB
if err := http.ListenAndServe(fmt.Sprintf(":%s", port), handler); err != nil {
```

**Step 2: Apply same pattern to workflow-engine, c2-gateway, audit, endpoint**

Copy `maxBodyMiddleware` into each Go service's `main.go` and wrap their mux in `main()`. Use 1 MB limit for all except c2-gateway which should use 10 MB (for implant generation payloads).

**Step 3: Verify**

Run: `docker compose build auth-service workflow-engine c2-gateway audit-service endpoint-service`
Expected: All build successfully

**Step 4: Commit**

```bash
git add services/auth/main.go services/workflow-engine/main.go services/c2-gateway/main.go services/audit/main.go services/endpoint/main.go
git commit -m "security: add request body size limits to all Go services"
```

---

### Task 2: Request Body Size Limits (Node Services)

**Files:**
- Modify: `services/ticket/src/index.js`
- Modify: `services/dashboard/src/index.js`
- Modify: `services/notification/src/index.js`
- Modify: `services/ws-relay/src/index.js`

**Step 1: Add limit to express.json()**

In each Node service, change:
```javascript
// Before:
app.use(express.json());

// After:
app.use(express.json({ limit: '1mb' }));
```

Files and approximate line numbers:
- `services/ticket/src/index.js:6`
- `services/dashboard/src/index.js:6`
- `services/notification/src/index.js:13`
- `services/ws-relay/src/index.js:28`

**Step 2: Verify**

Run: `docker compose build ticket-service dashboard-service notification-service ws-relay`
Expected: All build successfully

**Step 3: Commit**

```bash
git add services/ticket/src/index.js services/dashboard/src/index.js services/notification/src/index.js services/ws-relay/src/index.js
git commit -m "security: add request body size limits to all Node services"
```

---

### Task 3: CORS Lockdown

**Files:**
- Modify: `infra/traefik/dynamic.yml`
- Modify: `services/ws-relay/src/index.js`
- Modify: `docker-compose.yml` (add ALLOWED_ORIGINS env var)

**Step 1: Replace wildcard CORS with env-configurable origin**

In `infra/traefik/dynamic.yml`, change:
```yaml
# Before:
accessControlAllowOriginList:
  - "*"

# After:
accessControlAllowOriginList:
  - "http://localhost:18080"
```

Note: In production, this becomes the actual domain. For dev, `localhost:18080` matches the Traefik entry point.

**Step 2: Fix ws-relay WebSocket CORS**

In `services/ws-relay/src/index.js`, change:
```javascript
// Before:
cors: { origin: '*', methods: ['GET', 'POST'] }

// After:
cors: {
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:18080').split(','),
  methods: ['GET', 'POST']
}
```

**Step 3: Add ALLOWED_ORIGINS to docker-compose x-common-env**

In `docker-compose.yml`, add to the `x-common-env` block:
```yaml
ALLOWED_ORIGINS: ${ALLOWED_ORIGINS:-http://localhost:18080}
```

**Step 4: Verify**

Run: `docker compose up -d traefik ws-relay`
Test: `curl -s -D - -H "Origin: http://evil.com" http://localhost:18080/api/v1/auth/login`
Expected: No `Access-Control-Allow-Origin: http://evil.com` header in response

**Step 5: Commit**

```bash
git add infra/traefik/dynamic.yml services/ws-relay/src/index.js docker-compose.yml
git commit -m "security: restrict CORS to configured origins (no more wildcard)"
```

---

### Task 4: Rate Limiting on Auth Endpoints

**Files:**
- Modify: `services/auth/main.go`

**Step 1: Add Redis-backed rate limiter for login**

Add a `rateLimitMiddleware` that uses Redis sorted sets (same pattern as notification service):

```go
func (s *Server) rateLimitMiddleware(maxRequests int, windowSecs int, keyPrefix string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		key := fmt.Sprintf("ratelimit:%s:%s", keyPrefix, ip)
		ctx := r.Context()
		now := time.Now().UnixMilli()
		windowMs := int64(windowSecs) * 1000

		pipe := s.rdb.Pipeline()
		pipe.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", now-windowMs))
		countCmd := pipe.ZCard(ctx, key)
		pipe.ZAdd(ctx, key, redis.Z{Score: float64(now), Member: fmt.Sprintf("%d", now)})
		pipe.Expire(ctx, key, time.Duration(windowSecs*2)*time.Second)
		pipe.Exec(ctx)

		if countCmd.Val() >= int64(maxRequests) {
			writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "Too many requests, try again later")
			return
		}
		next(w, r)
	}
}
```

**Step 2: Wire rate limiter to login and refresh endpoints**

```go
// Before:
mux.HandleFunc("POST /api/v1/auth/login", srv.handleLogin)
mux.HandleFunc("POST /api/v1/auth/refresh", srv.handleRefresh)

// After:
mux.HandleFunc("POST /api/v1/auth/login", srv.rateLimitMiddleware(10, 60, "login", srv.handleLogin))
mux.HandleFunc("POST /api/v1/auth/refresh", srv.rateLimitMiddleware(20, 60, "refresh", srv.handleRefresh))
```

10 login attempts per minute per IP, 20 refresh attempts per minute per IP.

**Step 3: Verify**

Run: `docker compose build auth-service && docker compose up -d auth-service`
Test: Send 11 login requests in rapid succession — 11th should return 429

**Step 4: Commit**

```bash
git add services/auth/main.go
git commit -m "security: add Redis-backed rate limiting on auth endpoints"
```

---

### Task 5: Error Message Sanitization (C2 Gateway)

**Files:**
- Modify: `services/c2-gateway/main.go`

**Step 1: Replace all `http.Error(w, err.Error(), ...)` with generic messages**

In `services/c2-gateway/main.go`, find every instance of `http.Error(w, err.Error(), ...)` and replace with logged error + generic response:

```go
// Before (repeated ~8 times):
http.Error(w, err.Error(), http.StatusInternalServerError)

// After:
s.logger.Error("handler failed", "handler", "listSessions", "error", err)
http.Error(w, `{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}`, http.StatusInternalServerError)
```

Apply to all handlers: `handleListSessions`, `handleListImplants`, `handleListListeners`, `handleCreateListener`, `handleGenerateImplant`, `handleExecuteTask`.

Also fix VNC proxy error at ~line 635:
```go
// Before:
http.Error(w, "Failed to connect to VNC server: "+err.Error(), ...)

// After:
s.logger.Error("VNC connection failed", "target", target, "error", err)
http.Error(w, `{"error":{"code":"VNC_ERROR","message":"Failed to connect to remote desktop"}}`, http.StatusBadGateway)
```

**Step 2: Add a writeError helper (matching auth service pattern)**

```go
func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
```

Then use `writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "Internal server error")` everywhere.

**Step 3: Verify**

Run: `docker compose build c2-gateway && docker compose up -d c2-gateway`

**Step 4: Commit**

```bash
git add services/c2-gateway/main.go
git commit -m "security: sanitize error messages in C2 gateway (no internal detail leakage)"
```

---

### Task 6: Jira Webhook HMAC Verification

**Files:**
- Modify: `services/notification/src/index.js`

**Step 1: Add HMAC-SHA256 signature validation**

In the Jira webhook handler (around line 531), add verification before processing:

```javascript
// At the top of the POST /jira/webhook handler, after parsing body:
const signature = req.headers['x-hub-signature'] || req.headers['x-atlassian-webhook-signature'];
if (!signature) {
  return res.status(401).json({ error: { code: 'MISSING_SIGNATURE', message: 'Webhook signature required' } });
}

// Fetch webhook secret from DB
const configResult = await pool.query('SELECT webhook_secret FROM jira_configs LIMIT 1');
if (configResult.rows.length === 0 || !configResult.rows[0].webhook_secret) {
  return res.status(500).json({ error: { code: 'NO_CONFIG', message: 'Jira not configured' } });
}

const secret = configResult.rows[0].webhook_secret;
const crypto = require('crypto');
const expectedSig = 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
  return res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } });
}
```

Note: `crypto.timingSafeEqual` prevents timing attacks on signature comparison.

**Step 2: Add crypto require at top of file if not already imported**

**Step 3: Verify**

Run: `docker compose build notification-service && docker compose up -d notification-service`

**Step 4: Commit**

```bash
git add services/notification/src/index.js
git commit -m "security: add HMAC-SHA256 verification for Jira inbound webhooks"
```

---

### Task 7: WebSocket Origin Check

**Files:**
- Modify: `services/c2-gateway/main.go`

**Step 1: Replace permissive CheckOrigin**

```go
// Before:
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// After:
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		allowed := os.Getenv("ALLOWED_ORIGINS")
		if allowed == "" {
			allowed = "http://localhost:18080"
		}
		origin := r.Header.Get("Origin")
		for _, o := range strings.Split(allowed, ",") {
			if strings.TrimSpace(o) == origin {
				return true
			}
		}
		return false
	},
}
```

**Step 2: Verify**

Run: `docker compose build c2-gateway && docker compose up -d c2-gateway`

**Step 3: Commit**

```bash
git add services/c2-gateway/main.go
git commit -m "security: restrict WebSocket origins to ALLOWED_ORIGINS"
```

---

### Task 8: M7a Final — Build, smoke test, tag

**Step 1: Rebuild and restart all services**

```bash
docker compose build && docker compose up -d
```

**Step 2: Smoke test**

- Login: `curl -s -X POST http://localhost:18080/api/v1/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"changeme"}' | jq .access_token`
- Rate limit: Send 11 rapid login requests, verify 429 on 11th
- CORS: `curl -s -D - -H "Origin: http://evil.com" http://localhost:18080/api/v1/auth/login` — verify no CORS header
- Large body: `curl -s -X POST http://localhost:18080/api/v1/auth/login -H "Content-Type: application/json" -d "$(python3 -c 'print("{\"x\":\"" + "A"*2000000 + "\"}")')"` — verify 413 or error

**Step 3: Update CLAUDE.md and version**

Bump version to v0.10.0, update Current Progress section.

**Step 4: Commit and tag**

```bash
git add -A
git commit -m "feat: M7a security hardening — body limits, CORS lockdown, rate limiting, error sanitization"
git tag -a v0.10.0 -m "v0.10.0 — M7a Security Hardening"
```

---

## M7b — Reliability & Observability

### Task 9: Graceful Shutdown (Go Services)

**Files:**
- Modify: `services/auth/main.go`
- Modify: `services/audit/main.go`

**Step 1: Add graceful shutdown to auth service**

Replace the `ListenAndServe` block in `services/auth/main.go`:

```go
// Before:
logger.Info("auth-service starting", "port", port)
if err := http.ListenAndServe(fmt.Sprintf(":%s", port), handler); err != nil {
    logger.Error("server failed", "error", err)
    os.Exit(1)
}

// After:
httpServer := &http.Server{
    Addr:         fmt.Sprintf(":%s", port),
    Handler:      handler,
    ReadTimeout:  15 * time.Second,
    WriteTimeout: 30 * time.Second,
    IdleTimeout:  60 * time.Second,
}

go func() {
    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
    <-sigCh
    logger.Info("shutting down")
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    httpServer.Shutdown(ctx)
    nc.Close()
    rdb.Close()
    db.Close()
}()

logger.Info("auth-service starting", "port", port)
if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
    logger.Error("server failed", "error", err)
    os.Exit(1)
}
```

Add imports: `"os/signal"`, `"syscall"`

**Step 2: Apply same pattern to audit service**

Same approach in `services/audit/main.go` — use `http.Server{}` with timeouts, signal handler, graceful drain of NATS subscriptions and ClickHouse connection.

**Step 3: Add HTTP server timeouts to workflow-engine and endpoint-service**

These already have signal handlers but use plain `ListenAndServe`. Convert them to `http.Server{}` with `ReadTimeout`, `WriteTimeout`, `IdleTimeout`.

**Step 4: Verify**

```bash
docker compose build auth-service audit-service workflow-engine endpoint-service
docker compose up -d
docker stop ems-auth  # Should see "shutting down" in logs, clean exit
docker compose logs auth-service --tail=5
```

**Step 5: Commit**

```bash
git add services/auth/main.go services/audit/main.go services/workflow-engine/main.go services/endpoint/main.go
git commit -m "reliability: graceful shutdown + HTTP timeouts for all Go services"
```

---

### Task 10: Graceful Shutdown (Node Services)

**Files:**
- Modify: `services/ticket/src/index.js`
- Modify: `services/dashboard/src/index.js`
- Modify: `services/notification/src/index.js`

**Step 1: Add shutdown handler to ticket service**

At the bottom of `services/ticket/src/index.js`, add:

```javascript
let server;
async function start() {
  await connectNats();
  server = app.listen(port, () => console.log(`[ticket] listening on :${port}`));
}

async function shutdown(signal) {
  console.log(`[ticket] ${signal} received, shutting down...`);
  if (server) server.close(() => console.log('[ticket] HTTP server closed'));
  if (nc) {
    try { await nc.drain(); console.log('[ticket] NATS drained'); } catch (e) { /* ignore */ }
  }
  await pool.end();
  console.log('[ticket] DB pool closed');
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error('[ticket] startup failed:', err); process.exit(1); });
```

**Step 2: Apply same pattern to dashboard and notification services**

Same shutdown handler pattern — close HTTP server, drain NATS, end PG pool, force timeout.

**Step 3: Verify**

```bash
docker compose build ticket-service dashboard-service notification-service
docker compose up -d
docker stop ems-ticket  # Should see graceful shutdown logs
```

**Step 4: Commit**

```bash
git add services/ticket/src/index.js services/dashboard/src/index.js services/notification/src/index.js
git commit -m "reliability: graceful shutdown for all Node services"
```

---

### Task 11: Health Check Overhaul

**Files:**
- Modify: `services/auth/main.go`
- Modify: `services/audit/main.go`
- Modify: `services/workflow-engine/main.go`
- Modify: `services/c2-gateway/main.go`
- Modify: `services/ticket/src/index.js`
- Modify: `services/dashboard/src/index.js`
- Modify: `services/notification/src/index.js`

**Step 1: Define standard health response format**

All services return:
```json
{
  "status": "ok" | "degraded",
  "service": "service-name",
  "checks": {
    "postgres": "ok" | "error",
    "redis": "ok" | "error",
    "nats": "ok" | "error"
  }
}
```

Liveness: `GET /health/live` — always returns 200 if process is up (no dependency checks)
Readiness: `GET /health/ready` — checks all dependencies, returns 503 if any are down
Legacy: `GET /health` — same as `/health/ready` (backward compat for existing docker-compose healthchecks)

**Step 2: Implement in auth service (Go reference pattern)**

```go
func (s *Server) handleHealthLive(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "auth"})
}

func (s *Server) handleHealthReady(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{}
	status := http.StatusOK
	overall := "ok"

	if err := s.db.Ping(r.Context()); err != nil {
		checks["postgres"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["postgres"] = "ok"
	}

	if err := s.rdb.Ping(r.Context()).Err(); err != nil {
		checks["redis"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["redis"] = "ok"
	}

	if !s.nc.IsConnected() {
		checks["nats"] = "error"
		overall = "degraded"
		status = http.StatusServiceUnavailable
	} else {
		checks["nats"] = "ok"
	}

	writeJSON(w, status, map[string]any{"status": overall, "service": "auth", "checks": checks})
}
```

Register both:
```go
mux.HandleFunc("GET /health/live", srv.handleHealthLive)
mux.HandleFunc("GET /health/ready", srv.handleHealthReady)
mux.HandleFunc("GET /health", srv.handleHealthReady) // backward compat
```

**Step 3: Apply to all other Go services**

Same pattern, adjusted for each service's dependencies:
- `workflow-engine`: postgres, nats
- `c2-gateway`: nats (provider health via a separate check)
- `audit`: clickhouse, nats
- `endpoint`: postgres, nats

**Step 4: Apply to all Node services**

```javascript
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', service: 'ticket' });
});

app.get('/health/ready', async (_req, res) => {
  const checks = {};
  let overall = 'ok';

  try { await pool.query('SELECT 1'); checks.postgres = 'ok'; }
  catch { checks.postgres = 'error'; overall = 'degraded'; }

  checks.nats = nc && !nc.isClosed() ? 'ok' : 'error';
  if (checks.nats === 'error') overall = 'degraded';

  const status = overall === 'ok' ? 200 : 503;
  res.status(status).json({ status: overall, service: 'ticket', checks });
});

app.get('/health', async (req, res) => { /* same as /health/ready */ });
```

**Step 5: Update docker-compose healthchecks to use /health/ready**

All service healthcheck commands stay the same since `GET /health` now maps to ready check.

**Step 6: Verify**

```bash
docker compose build && docker compose up -d
curl http://localhost:18080/api/v1/auth/health/ready  # through Traefik — may need route
# Or test directly:
docker exec ems-auth wget -qO- http://localhost:3001/health/ready
```

**Step 7: Commit**

```bash
git add services/
git commit -m "reliability: health check overhaul — liveness + readiness probes for all services"
```

---

### Task 12: Structured JSON Logging for Node Services

**Files:**
- Modify: `services/ticket/package.json` (add pino)
- Modify: `services/ticket/src/index.js`
- Modify: `services/dashboard/package.json`
- Modify: `services/dashboard/src/index.js`
- Modify: `services/notification/package.json`
- Modify: `services/notification/src/index.js`

**Step 1: Add pino to each Node service**

In each service's `package.json`, add `"pino": "^9.0.0"` to dependencies.

**Step 2: Replace console.log/error with pino logger**

In each service, add at the top:
```javascript
const pino = require('pino');
const logger = pino({ name: 'ticket-service' });
```

Then replace:
```javascript
// Before:
console.log('[ticket] connected to nats');
console.error('[ticket] error:', err.message);

// After:
logger.info('connected to nats');
logger.error({ err }, 'operation failed');
```

Output will be JSON:
```json
{"level":30,"time":1709000000000,"name":"ticket-service","msg":"connected to nats"}
```

**Step 3: Verify**

```bash
docker compose build ticket-service dashboard-service notification-service
docker compose up -d
docker compose logs ticket-service --tail=5  # Should be JSON lines
```

**Step 4: Commit**

```bash
git add services/ticket/ services/dashboard/ services/notification/
git commit -m "reliability: structured JSON logging (pino) for all Node services"
```

---

### Task 13: Connection Pool Configuration

**Files:**
- Modify: `services/auth/main.go`
- Modify: `services/workflow-engine/main.go`
- Modify: `services/endpoint/main.go`
- Modify: `services/audit/main.go`
- Modify: `services/ticket/src/index.js`
- Modify: `services/dashboard/src/index.js`

**Step 1: Add pool config env vars to Go services**

```go
pgConfig, err := pgxpool.ParseConfig(pgURL)
if err != nil {
    logger.Error("failed to parse pg config", "error", err)
    os.Exit(1)
}
pgConfig.MaxConns = int32(envOrInt("PG_MAX_CONNS", 10))
pgConfig.MinConns = int32(envOrInt("PG_MIN_CONNS", 2))
pgConfig.MaxConnLifetime = time.Duration(envOrInt("PG_CONN_MAX_LIFETIME_MINS", 30)) * time.Minute
pgConfig.MaxConnIdleTime = 5 * time.Minute

db, err := pgxpool.NewWithConfig(ctx, pgConfig)
```

Add helper:
```go
func envOrInt(key string, fallback int) int {
    if v := os.Getenv(key); v != "" {
        if n, err := strconv.Atoi(v); err == nil {
            return n
        }
    }
    return fallback
}
```

**Step 2: Add pool config to Node services**

```javascript
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'ems_cop',
  user: process.env.POSTGRES_USER || 'ems',
  password: process.env.POSTGRES_PASSWORD || 'ems_dev_password',
  max: parseInt(process.env.PG_MAX_CONNS || '10'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
```

**Step 3: Verify and commit**

```bash
docker compose build && docker compose up -d
git add services/
git commit -m "reliability: configurable connection pool sizes for all services"
```

---

### Task 14: Retry with Exponential Backoff + Jitter

**Files:**
- Modify: `services/ticket/src/index.js`
- Modify: `services/dashboard/src/index.js`
- Modify: `services/notification/src/index.js`

**Step 1: Replace fixed-delay NATS retry in Node services**

```javascript
let natsRetryCount = 0;

async function connectNats() {
  try {
    nc = await connect({
      servers: process.env.NATS_URL || 'nats://localhost:4222',
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    natsRetryCount = 0;
    logger.info('connected to nats');
  } catch (err) {
    natsRetryCount++;
    const baseDelay = Math.min(1000 * Math.pow(2, natsRetryCount), 30000); // max 30s
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;
    logger.warn({ err: err.message, retryIn: Math.round(delay) }, 'nats connection failed, retrying');
    setTimeout(connectNats, delay);
  }
}
```

Apply to ticket, dashboard, notification services.

**Step 2: Verify and commit**

```bash
docker compose build ticket-service dashboard-service notification-service
git add services/ticket/ services/dashboard/ services/notification/
git commit -m "reliability: exponential backoff with jitter for NATS reconnection"
```

---

### Task 15: M7b Final — Build, smoke test, tag

**Step 1: Rebuild and restart all services**

```bash
docker compose build && docker compose up -d
```

**Step 2: Smoke test**

- Health probes: `docker exec ems-auth wget -qO- http://localhost:3001/health/ready | jq .`
- Graceful shutdown: `docker stop ems-auth && docker compose logs auth-service --tail=5` — expect shutdown messages
- JSON logs: `docker compose logs ticket-service --tail=5` — expect JSON lines

**Step 3: Update CLAUDE.md and version**

Bump version to v0.11.0, update Current Progress section.

**Step 4: Commit and tag**

```bash
git add -A
git commit -m "feat: M7b reliability & observability — graceful shutdown, health probes, JSON logging, connection pools"
git tag -a v0.11.0 -m "v0.11.0 — M7b Reliability & Observability"
```

---

## M7c — Kubernetes Migration Path

### Task 16: Helm Chart Scaffolding

**Files:**
- Create: `charts/ems-cop/Chart.yaml` (umbrella chart)
- Create: `charts/ems-cop/values.yaml`
- Create: `charts/ems-cop/templates/_helpers.tpl`
- Create: `charts/ems-cop/charts/auth/` (sub-chart)
- Create: `charts/ems-cop/charts/workflow-engine/` (sub-chart)
- Create: `charts/ems-cop/charts/ticket/` (sub-chart)
- Create: `charts/ems-cop/charts/dashboard/` (sub-chart)
- Create: `charts/ems-cop/charts/c2-gateway/` (sub-chart)
- Create: `charts/ems-cop/charts/audit/` (sub-chart)
- Create: `charts/ems-cop/charts/notification/` (sub-chart)
- Create: `charts/ems-cop/charts/endpoint/` (sub-chart)
- Create: `charts/ems-cop/charts/ws-relay/` (sub-chart)
- Create: `charts/ems-cop/charts/frontend/` (sub-chart)

**Step 1: Create umbrella chart**

`charts/ems-cop/Chart.yaml`:
```yaml
apiVersion: v2
name: ems-cop
description: EMS-COP — Common Operating Picture
type: application
version: 0.12.0
appVersion: "0.12.0"

dependencies:
  - name: postgresql
    version: "~16.0"
    repository: "oci://registry-1.docker.io/bitnamicharts"
    condition: postgresql.enabled
  - name: redis
    version: "~19.0"
    repository: "oci://registry-1.docker.io/bitnamicharts"
    condition: redis.enabled
  - name: nats
    version: "~1.2"
    repository: "https://nats-io.github.io/k8s/helm/charts/"
    condition: nats.enabled
```

**Step 2: Create sub-chart template (auth as reference)**

Each sub-chart follows the same structure. Create `charts/ems-cop/charts/auth/`:

`Chart.yaml`:
```yaml
apiVersion: v2
name: auth
description: EMS-COP Auth Service
type: application
version: 0.12.0
```

`templates/deployment.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "auth.fullname" . }}
  labels: {{- include "auth.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels: {{- include "auth.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels: {{- include "auth.selectorLabels" . | nindent 8 }}
    spec:
      containers:
        - name: auth
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
            - containerPort: 3001
              protocol: TCP
          envFrom:
            - configMapRef:
                name: {{ include "auth.fullname" . }}-config
            - secretRef:
                name: {{ include "auth.fullname" . }}-secrets
          livenessProbe:
            httpGet:
              path: /health/live
              port: 3001
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 3001
            initialDelaySeconds: 10
            periodSeconds: 5
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
```

`templates/service.yaml`:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "auth.fullname" . }}
spec:
  type: ClusterIP
  ports:
    - port: 3001
      targetPort: 3001
  selector: {{- include "auth.selectorLabels" . | nindent 4 }}
```

`templates/configmap.yaml`:
```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "auth.fullname" . }}-config
data:
  SERVICE_NAME: auth-service
  SERVICE_PORT: "3001"
  POSTGRES_HOST: {{ .Values.global.postgres.host | quote }}
  POSTGRES_PORT: {{ .Values.global.postgres.port | quote }}
  POSTGRES_DB: {{ .Values.global.postgres.database | quote }}
  NATS_URL: {{ .Values.global.nats.url | quote }}
  REDIS_URL: {{ .Values.global.redis.url | quote }}
```

`templates/secret.yaml`:
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "auth.fullname" . }}-secrets
type: Opaque
stringData:
  POSTGRES_USER: {{ .Values.global.postgres.user | quote }}
  POSTGRES_PASSWORD: {{ .Values.global.postgres.password | quote }}
  JWT_SECRET: {{ .Values.global.jwtSecret | quote }}
```

**Step 3: Replicate sub-chart structure for remaining 9 services**

Each service follows the same template pattern with adjusted:
- Port number
- Container name
- Probe paths
- ConfigMap entries (service-specific env vars)
- Resource requests/limits

Port mapping reference:
- auth: 3001
- workflow-engine: 3002
- ticket: 3003
- dashboard: 3004
- c2-gateway: 3005
- audit: 3006 (ClickHouse config instead of Redis)
- notification: 3007 (SMTP config optional)
- endpoint: 3008
- ws-relay: 3009
- frontend: 80

**Step 4: Create umbrella values.yaml**

`charts/ems-cop/values.yaml`:
```yaml
global:
  postgres:
    host: ems-cop-postgresql
    port: "5432"
    database: ems_cop
    user: ems_admin
    password: CHANGE_ME
  redis:
    url: redis://ems-cop-redis-master:6379
  nats:
    url: nats://ems-cop-nats:4222
  clickhouse:
    host: clickhouse
    port: "9000"
  jwtSecret: CHANGE_ME
  allowedOrigins: "https://ems-cop.example.com"

auth:
  replicaCount: 2
  image:
    repository: ems-cop/auth
    tag: latest

# ... repeat for each service
```

**Step 5: Commit**

```bash
git add charts/
git commit -m "feat: Helm chart scaffolding — umbrella chart with 10 service sub-charts"
```

---

### Task 17: Ingress Configuration

**Files:**
- Create: `charts/ems-cop/templates/ingress.yaml`

**Step 1: Create Traefik IngressRoute**

```yaml
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: {{ .Release.Name }}-routes
spec:
  entryPoints:
    - web
  routes:
    # Public routes (no auth middleware)
    - match: PathPrefix(`/api/v1/auth/login`) || PathPrefix(`/api/v1/auth/refresh`)
      kind: Rule
      services:
        - name: {{ .Release.Name }}-auth
          port: 3001
      priority: 100

    # Protected API routes
    - match: PathPrefix(`/api/v1/auth`)
      kind: Rule
      services:
        - name: {{ .Release.Name }}-auth
          port: 3001
      middlewares:
        - name: {{ .Release.Name }}-forward-auth
      priority: 50

    # ... remaining routes mirror dynamic.yml

    # Frontend catch-all
    - match: PathPrefix(`/`)
      kind: Rule
      services:
        - name: {{ .Release.Name }}-frontend
          port: 80
      priority: 1
```

Also create a standard `Ingress` resource alternative for non-Traefik clusters with `values.yaml` toggle.

**Step 2: Commit**

```bash
git add charts/ems-cop/templates/ingress.yaml
git commit -m "feat: Kubernetes Ingress configuration (Traefik IngressRoute + standard Ingress)"
```

---

### Task 18: M7c Final — Validate, tag, release

**Step 1: Validate Helm charts**

```bash
helm lint charts/ems-cop/
helm template ems-cop charts/ems-cop/ --debug > /dev/null
```

**Step 2: Update CLAUDE.md and version**

Bump version to v0.12.0, update Current Progress and roadmap.

**Step 3: Commit and tag**

```bash
git add -A
git commit -m "feat: M7c Kubernetes migration path — Helm charts, Ingress, resource limits"
git tag -a v0.12.0 -m "v0.12.0 — M7c Kubernetes Migration Path"
```

---

## Summary

| Sub-milestone | Tasks | Focus |
|--------------|-------|-------|
| **M7a** (Tasks 1-8) | Security hardening | Body limits, CORS, rate limiting, error sanitization, webhook HMAC, WS origins |
| **M7b** (Tasks 9-15) | Reliability | Graceful shutdown, health probes, JSON logging, pool config, retry backoff |
| **M7c** (Tasks 16-18) | Kubernetes | Helm charts, Ingress, values.yaml, resource requests/limits |
