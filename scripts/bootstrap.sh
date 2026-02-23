#!/usr/bin/env bash
# EMS-COP Development Bootstrap
# Run this after cloning to set up your local environment.
set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${CYAN}[EMS]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC}  $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC}  $1"; }

# ─── Prerequisites ──────────────────────────────
log "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || { err "Docker not found. Install: https://docs.docker.com/get-docker/"; exit 1; }
ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

command -v docker compose >/dev/null 2>&1 || docker compose version >/dev/null 2>&1 || { err "Docker Compose not found."; exit 1; }
ok "Docker Compose available"

# Optional: node/go for local dev outside containers
command -v node >/dev/null 2>&1 && ok "Node $(node -v)" || warn "Node not found (optional — only needed for local frontend dev)"
command -v go >/dev/null 2>&1 && ok "Go $(go version | awk '{print $3}')" || warn "Go not found (optional — only needed for local Go service dev)"

# ─── Environment File ───────────────────────────
if [ ! -f .env ]; then
    log "Creating .env from template..."
    cp env.template .env
    # Generate a real JWT secret
    if command -v openssl >/dev/null 2>&1; then
        JWT=$(openssl rand -hex 32)
        sed -i.bak "s/ems_jwt_secret_change_me_in_production/$JWT/" .env && rm -f .env.bak
        ok "Generated JWT secret"
    else
        warn "openssl not found — please manually set JWT_SECRET in .env"
    fi
    ok "Created .env — review and adjust values as needed"
else
    ok ".env already exists"
fi

# ─── Directory Setup ────────────────────────────
log "Ensuring directories exist..."
mkdir -p builds
mkdir -p scripts
ok "Directories ready"

# ─── Docker Build ───────────────────────────────
log "Building Docker images (this may take a few minutes on first run)..."
echo ""

# Build infrastructure first (fast — these are pulls)
log "Pulling infrastructure images..."
docker compose pull postgres redis nats minio clickhouse traefik 2>/dev/null || true
ok "Infrastructure images ready"

# Build application services
log "Building application services..."
docker compose build --parallel 2>&1 | tail -5
ok "All images built"

# ─── Start Infrastructure Only ──────────────────
log "Starting infrastructure services..."
docker compose up -d postgres redis nats minio clickhouse traefik
echo ""

# Wait for health
log "Waiting for infrastructure health checks..."
SERVICES="postgres redis nats clickhouse"
for svc in $SERVICES; do
    RETRIES=30
    while [ $RETRIES -gt 0 ]; do
        STATUS=$(docker inspect --format='{{.State.Health.Status}}' "ems-$svc" 2>/dev/null || echo "missing")
        if [ "$STATUS" = "healthy" ]; then
            ok "$svc is healthy"
            break
        fi
        RETRIES=$((RETRIES - 1))
        sleep 2
    done
    if [ $RETRIES -eq 0 ]; then
        err "$svc failed health check"
        docker compose logs "$svc" --tail 20
    fi
done

# ─── Verify Database Schema ────────────────────
log "Verifying PostgreSQL schema..."
TABLE_COUNT=$(docker exec ems-postgres psql -U ems_admin -d ems -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d ' ')
if [ "$TABLE_COUNT" -gt 10 ] 2>/dev/null; then
    ok "PostgreSQL: $TABLE_COUNT tables created"
else
    warn "PostgreSQL schema may not have applied. Check: docker compose logs postgres"
fi

log "Verifying ClickHouse schema..."
CH_TABLES=$(docker exec ems-clickhouse clickhouse-client --query "SELECT count() FROM system.tables WHERE database='ems_audit'" 2>/dev/null | tr -d ' ')
if [ "$CH_TABLES" -gt 2 ] 2>/dev/null; then
    ok "ClickHouse: $CH_TABLES tables created"
else
    warn "ClickHouse schema may not have applied. Check: docker compose logs clickhouse"
fi

# ─── Verify Seed Data ──────────────────────────
log "Verifying seed data..."
USER_COUNT=$(docker exec ems-postgres psql -U ems_admin -d ems -t -c "SELECT count(*) FROM users;" 2>/dev/null | tr -d ' ')
ok "Seed users: $USER_COUNT"

ROLE_COUNT=$(docker exec ems-postgres psql -U ems_admin -d ems -t -c "SELECT count(*) FROM roles;" 2>/dev/null | tr -d ' ')
ok "Seed roles: $ROLE_COUNT"

# ─── Summary ────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  EMS-COP Development Environment Ready${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
echo "  Infrastructure is running. Next steps:"
echo ""
echo "  1. Start all services:     docker compose up -d"
echo "  2. View logs:              docker compose logs -f"
echo "  3. Traefik dashboard:      http://localhost:8080"
echo "  4. MinIO console:          http://localhost:9001"
echo "  5. Stop everything:        docker compose down"
echo ""
echo "  Seed users (password: changeme):"
echo "    admin, planner1, mc1, sup1, lead1, op1, op2"
echo ""
echo "  To start building a specific service:"
echo "    cd services/auth && go run ."
echo "    cd services/ticket && npm run dev"
echo "    cd frontend && npm run dev"
echo ""
