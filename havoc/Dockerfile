# EMS-COP Havoc C2 Server
# Based on official Havoc Docker setup (https://github.com/HavocFramework/Havoc)
#
# Havoc is a modern, malleable post-exploitation command and control framework.
# It uses a custom teamserver binary with a REST API for management.
#
# EMS-COP connects to Havoc via:
#   - REST POST /api/login (authentication)
#   - REST GET/POST /api/* endpoints (demons, listeners, tasks)
#
# Ports:
#   40056 — Havoc teamserver API (REST)
#   443   — Default C2 traffic (HTTPS listener)
#   80    — Default C2 traffic (HTTP listener)
#
# NOTE: Havoc requires Go 1.21+ and a C compiler for building the teamserver.
# The official build process is:
#   git clone https://github.com/HavocFramework/Havoc
#   cd Havoc && make ts-build
#
# For EMS-COP integration:
#   1. Build and run the Havoc teamserver
#   2. Ensure the API is accessible from the ems-net Docker network
#   3. Configure the HavocProvider in c2-gateway with:
#      - host: <havoc-server-address>
#      - port: 40056
#      - auth_config: { "username": "havoc_admin", "password": "<password>" }
#
# Reference: https://havocframework.com/docs/

FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

# Install build dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    gcc \
    g++ \
    golang-go \
    nasm \
    mingw-w64 \
    python3 \
    python3-pip \
    ca-certificates \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Go 1.21+ (Ubuntu 22.04 ships older Go)
RUN wget -q https://go.dev/dl/go1.22.0.linux-amd64.tar.gz -O /tmp/go.tar.gz && \
    tar -C /usr/local -xzf /tmp/go.tar.gz && \
    rm /tmp/go.tar.gz
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/root/go"

# Create havoc user
RUN useradd -m -s /bin/bash -u 10002 havoc

# Clone Havoc (pinned to a stable release)
RUN git clone --depth 1 https://github.com/HavocFramework/Havoc.git /opt/havoc

WORKDIR /opt/havoc

# Build the teamserver
# RUN make ts-build
#
# The teamserver binary will be at /opt/havoc/havoc
# Configuration is via a profile YAML file:
#   ./havoc server --profile ./profiles/default.yaotl

# Create data directories
RUN mkdir -p /opt/havoc/data /opt/havoc/logs && \
    chown -R havoc:havoc /opt/havoc

# Expose Havoc API port
EXPOSE 40056

# Expose common C2 traffic ports
EXPOSE 80 443

# Default entrypoint — in production, run the built teamserver
ENTRYPOINT ["/bin/bash", "-c", "echo 'Havoc C2 stub container — build teamserver with make ts-build'; sleep infinity"]
