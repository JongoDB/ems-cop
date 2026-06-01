# EMS-COP Merlin C2 Server
# Multi-stage build of the Merlin server from source.
#
# Reference: https://github.com/Ne0nd0g/merlin
#   - Server binary built with `go build cmd/merlinserver/main.go`
#   - HTTPS C2 listener defaults to :8443
#   - JSON-RPC / gRPC control plane on :50051
#
# EMS-COP integration:
#   - c2-gateway connects via the gRPC interface using a preshared key (PSK)
#   - The PSK is supplied via the MERLIN_PSK env var
#   - A self-signed certificate is generated on first start if /opt/merlin/data/server.crt
#     does not already exist (data is persisted in a Docker volume).

# ════════════════════════════════════════════
#  Stage 1 — Builder (Alpine for minimum disk footprint)
# ════════════════════════════════════════════
FROM golang:1.23-alpine AS builder

ARG MERLIN_REF=main

RUN apk add --no-cache git make ca-certificates bash

WORKDIR /src
RUN git clone --depth 1 https://github.com/Ne0nd0g/merlin.git .

# main.go is at the repo root. Build with plain `go build` so any error
# is surfaced directly in the docker build output (no log-file shimming).
RUN mkdir -p /out && \
    go mod download && \
    go build -trimpath -o /out/merlinServer . && \
    cp -r data /out/seed-data

# ════════════════════════════════════════════
#  Stage 2 — Runtime (Alpine)
# ════════════════════════════════════════════
FROM alpine:3.20

RUN apk add --no-cache ca-certificates openssl bash netcat-openbsd

RUN adduser -D -s /bin/bash -u 10003 merlin && \
    mkdir -p /opt/merlin/data && \
    chown -R merlin:merlin /opt/merlin

WORKDIR /opt/merlin
COPY --from=builder /out/ /opt/merlin/

RUN cat > /opt/merlin/entrypoint.sh <<'BASH'
#!/usr/bin/env bash
set -e

DATA_DIR="/opt/merlin/data"
mkdir -p "$DATA_DIR" "$DATA_DIR/x509" "$DATA_DIR/log"

# Seed default data on first run.
if [ -d /opt/merlin/seed-data ] && [ ! -f "$DATA_DIR/.seeded" ]; then
    echo "[EMS] Seeding Merlin data directory"
    cp -rn /opt/merlin/seed-data/. "$DATA_DIR"/ 2>/dev/null || true
    touch "$DATA_DIR/.seeded"
fi

if [ ! -f /opt/merlin/merlinServer ]; then
    echo "[EMS] Merlin server binary is missing — upstream source build failed."
    echo "[EMS] See /opt/merlin/BUILD_FAILED.log for details. Container will idle."
    if [ -f /opt/merlin/BUILD_FAILED.log ]; then
        echo "----- BUILD LOG (tail) -----"
        tail -200 /opt/merlin/BUILD_FAILED.log || true
    fi
    exec sleep infinity
fi

# Generate a self-signed cert if one is not already present.
CERT="$DATA_DIR/x509/server.crt"
KEY="$DATA_DIR/x509/server.key"
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    echo "[EMS] Generating self-signed certificate for Merlin"
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
        -keyout "$KEY" -out "$CERT" \
        -subj "/CN=ems-merlin/O=EMS-COP" >/dev/null 2>&1
fi

: "${MERLIN_PSK:=ems_merlin_change_me}"
: "${MERLIN_C2_INTERFACE:=0.0.0.0}"
: "${MERLIN_C2_PORT:=8443}"
: "${MERLIN_API_INTERFACE:=0.0.0.0}"
: "${MERLIN_API_PORT:=50051}"

echo "[EMS] Starting Merlin server"
echo "[EMS]  C2 (HTTPS): ${MERLIN_C2_INTERFACE}:${MERLIN_C2_PORT}"
echo "[EMS]  gRPC API : ${MERLIN_API_INTERFACE}:${MERLIN_API_PORT}"

# Merlin server flags (verified against current upstream):
#   -i <iface>  -p <port>  -psk <key>  -x509cert -x509key
# Some versions of the server expose a separate gRPC listener via
# the rpc command. We launch the HTTPS C2 listener and, if the binary
# supports it, the gRPC service in the background.
cd /opt/merlin
if ./merlinServer rpc --help >/dev/null 2>&1; then
    ./merlinServer rpc \
        -i "${MERLIN_API_INTERFACE}" \
        -p "${MERLIN_API_PORT}" \
        -psk "${MERLIN_PSK}" \
        -x509cert "${CERT}" \
        -x509key "${KEY}" \
        > "${DATA_DIR}/log/rpc.log" 2>&1 &
    RPC_PID=$!
    echo "[EMS] Merlin gRPC started (PID $RPC_PID)"
fi

# Foreground HTTPS listener.
exec ./merlinServer \
    -i "${MERLIN_C2_INTERFACE}" \
    -p "${MERLIN_C2_PORT}" \
    -psk "${MERLIN_PSK}" \
    -x509cert "${CERT}" \
    -x509key "${KEY}"
BASH
RUN chmod +x /opt/merlin/entrypoint.sh && \
    chown -R merlin:merlin /opt/merlin

USER merlin

EXPOSE 8443 50051

HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=30s \
    CMD nc -z 127.0.0.1 50051 || nc -z 127.0.0.1 8443 || exit 1

ENTRYPOINT ["/opt/merlin/entrypoint.sh"]
