# EMS-COP Sliver C2 Server
# Based on JongoDB/sliver-weather Dockerfile pattern
# Runs sliver-server in daemon mode with gRPC exposed for EMS C2 Gateway

FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    mingw-w64 \
    net-tools \
    iproute2 \
    zip \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create sliver user
RUN useradd -m -s /bin/bash -u 10000 sliver

# Pin Sliver server to v1.5.42 — matches the protobuf surface vendored by
# services/c2-gateway (go.mod: github.com/bishopfox/sliver v1.5.42).
# v1.7.x reorganized ImplantConfig field numbers incompatibly; client+server
# must agree on the wire format. Bump in lockstep with the c2-gateway dep.
# v1.5.x only shipped a linux amd64 binary; the release URL has no arch suffix.
RUN SLIVER_VERSION=1.5.42 && \
    echo "Installing Sliver v${SLIVER_VERSION} (linux/amd64)" && \
    curl -L -f -o /opt/sliver-server "https://github.com/BishopFox/sliver/releases/download/v${SLIVER_VERSION}/sliver-server_linux" && \
    chmod +x /opt/sliver-server

# Create directories
RUN mkdir -p /home/sliver/.sliver /home/sliver/builds /home/sliver/configs && \
    chown -R sliver:sliver /home/sliver

# Entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER sliver
WORKDIR /home/sliver

# Expose gRPC multiplexer port (operator API)
EXPOSE 31337

# Expose common listener ports
EXPOSE 80 443 8080 53

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
