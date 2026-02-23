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

# Download and install latest Sliver server (detect architecture)
RUN SLIVER_VERSION=$(curl -s https://api.github.com/repos/BishopFox/sliver/releases/latest | grep '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/') && \
    ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in amd64) SLIVER_ARCH="amd64" ;; arm64|aarch64) SLIVER_ARCH="arm64" ;; *) SLIVER_ARCH="amd64" ;; esac && \
    echo "Installing Sliver v${SLIVER_VERSION} for linux-${SLIVER_ARCH}" && \
    curl -L -f -o /opt/sliver-server "https://github.com/BishopFox/sliver/releases/download/v${SLIVER_VERSION}/sliver-server_linux-${SLIVER_ARCH}" && \
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
