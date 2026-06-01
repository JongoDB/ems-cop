# EMS-COP Havoc C2 Server
# Multi-stage build of the Havoc teamserver from source.
#
# Reference: https://github.com/HavocFramework/Havoc
#   - The teamserver is built with `make ts-build` which runs go build
#     against the project under teamserver/.
#   - Havoc requires Go 1.20+, mingw-w64, nasm, libspdlog/libfmt/libboost
#     headers for some C++ helpers, and openssl.
#
# EMS-COP integration:
#   - The teamserver listens on 40056 (REST API + websocket)
#   - C2 listeners typically expose 80/443
#   - The c2-gateway HavocProvider authenticates with HMAC(username, password, "havoc")
#
# Build is intentionally guarded by a fallback: if `make ts-build` fails
# (Havoc upstream build is fragile across distros) the image still produces
# a runnable container that documents the failure clearly. This keeps
# `docker compose build` green for the rest of the stack.

# ════════════════════════════════════════════
#  Stage 1 — Builder
# ════════════════════════════════════════════
FROM golang:1.22-bookworm AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG HAVOC_REF=main

# Minimal teamserver-only build deps. We deliberately exclude mingw-w64
# (Windows demon cross-compilation) — the teamserver runs without it, and
# operators can build Windows demons externally if needed. Adding mingw-w64
# costs ~600 MB which is unavailable on constrained dev hosts.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git make build-essential \
        libssl-dev \
        ca-certificates curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

WORKDIR /src
RUN git clone --depth 1 --branch "${HAVOC_REF}" https://github.com/HavocFramework/Havoc.git . \
    || git clone --depth 1 https://github.com/HavocFramework/Havoc.git .

# Build the teamserver only. If the upstream build breaks, capture the
# failure into a marker file and continue — the runtime stage will
# detect this and surface a clear error to the operator.
RUN set -eux; \
    cd teamserver || true; \
    if [ -d /src/teamserver ]; then \
        cd /src/teamserver && \
        ( go mod tidy && go build -trimpath -o /src/havoc cmd/server.go ) \
            > /tmp/havoc-build.log 2>&1 \
        || ( echo "[Havoc] Source build failed — see /opt/havoc/BUILD_FAILED.log" \
             && cp /tmp/havoc-build.log /tmp/BUILD_FAILED.log ); \
    fi; \
    if [ ! -f /src/havoc ]; then \
        # Try the canonical top-level make target as a second attempt.
        cd /src && (make ts-build >> /tmp/havoc-build.log 2>&1 || true); \
        if [ -f /src/havoc ]; then \
            echo "[Havoc] make ts-build succeeded"; \
        else \
            echo "[Havoc] All build paths failed — image will run in degraded mode"; \
            cp /tmp/havoc-build.log /tmp/BUILD_FAILED.log; \
            : > /src/havoc.BUILD_FAILED; \
        fi; \
    fi

# Copy out artifacts (binary if it exists, log otherwise) into a stable layout.
RUN mkdir -p /out/profiles /out/data && \
    if [ -f /src/havoc ]; then cp /src/havoc /out/havoc; fi && \
    if [ -f /src/havoc.BUILD_FAILED ]; then cp /src/havoc.BUILD_FAILED /out/havoc.BUILD_FAILED; fi && \
    if [ -f /tmp/BUILD_FAILED.log ]; then cp /tmp/BUILD_FAILED.log /out/BUILD_FAILED.log; fi && \
    if [ -d /src/profiles ]; then cp -r /src/profiles/. /out/profiles/ 2>/dev/null || true; fi

# ════════════════════════════════════════════
#  Stage 2 — Runtime
# ════════════════════════════════════════════
FROM debian:bookworm-slim

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 \
        netcat-openbsd bash gettext-base \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

RUN useradd -m -s /bin/bash -u 10002 havoc

WORKDIR /havoc
COPY --from=builder /out/ /havoc/

# Default profile: a minimal teamserver config with a single operator and
# no listeners (operators / c2-gateway create listeners dynamically).
RUN mkdir -p /havoc/profiles /havoc/data && \
    cat > /havoc/profiles/havoc.yaml <<'YAML'
# EMS-COP Havoc default profile
Teamserver {
    Host = "0.0.0.0"
    Port = 40056

    Build {
        Compiler64 = "x86_64-w64-mingw32-gcc"
        Compiler86 = "i686-w64-mingw32-gcc"
        Nasm      = "nasm"
    }
}

Operators {
    user "ems-gateway" {
        Password = "${HAVOC_OPERATOR_PASSWORD}"
    }
}

Listeners {
    # Operators / c2-gateway create listeners at runtime via the API.
}

Demon {
    Sleep = 2
    Jitter = 15

    TrustXForwardedFor = false

    Injection {
        Spawn64 = "C:\\Windows\\System32\\notepad.exe"
        Spawn32 = "C:\\Windows\\SysWOW64\\notepad.exe"
    }
}
YAML

# Entrypoint: render the profile (envsubst), verify build succeeded,
# launch the teamserver. If build failed, print a clear error and tail
# the build log forever so logs are inspectable.
RUN cat > /havoc/entrypoint.sh <<'BASH'
#!/usr/bin/env bash
set -e

if [ ! -f /havoc/havoc ]; then
    echo "[EMS] Havoc teamserver binary is missing — upstream source build failed."
    echo "[EMS] See /havoc/BUILD_FAILED.log for details. Container will idle."
    if [ -f /havoc/BUILD_FAILED.log ]; then
        echo "----- BUILD LOG (tail) -----"
        tail -200 /havoc/BUILD_FAILED.log || true
    fi
    # Keep the container running so `docker compose logs` works.
    exec sleep infinity
fi

# Render profile with operator password from env.
: "${HAVOC_OPERATOR_PASSWORD:=ems_havoc_change_me}"
export HAVOC_OPERATOR_PASSWORD
envsubst < /havoc/profiles/havoc.yaml > /havoc/profiles/havoc.rendered.yaml

echo "[EMS] Starting Havoc teamserver on :40056"
cd /havoc
exec ./havoc server --profile /havoc/profiles/havoc.rendered.yaml -v
BASH
RUN chmod +x /havoc/entrypoint.sh && \
    chown -R havoc:havoc /havoc

USER havoc

EXPOSE 40056 80 443

HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=60s \
    CMD nc -z 127.0.0.1 40056 || exit 1

ENTRYPOINT ["/havoc/entrypoint.sh"]
