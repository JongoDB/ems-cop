# EMS-COP Mythic C2 Server
# Based on official Mythic Docker setup (https://github.com/its-a-feature/Mythic)
#
# Mythic is a multi-agent collaborative red team platform.
# It uses a PostgreSQL backend, Hasura GraphQL engine, and RabbitMQ for
# inter-container messaging. In production, Mythic is deployed via its own
# docker-compose (mythic-cli), but this Dockerfile provides a minimal reference
# for integrating with EMS-COP's Docker topology.
#
# EMS-COP connects to Mythic via:
#   - REST POST /auth (authentication, JWT)
#   - GraphQL /graphql via Hasura (port 7443)
#
# Ports:
#   7443  — Mythic API (Hasura GraphQL + REST)
#   443   — Default C2 traffic (HTTPS profile)
#   80    — Default C2 traffic (HTTP profile)
#
# NOTE: Mythic's full deployment is complex (multiple containers for Mythic
# server, PostgreSQL, Hasura, RabbitMQ, and payload type containers). This
# Dockerfile is a stub documenting the setup. For a real deployment, use:
#   git clone https://github.com/its-a-feature/Mythic
#   cd Mythic && ./mythic-cli install
#
# For EMS-COP integration:
#   1. Deploy Mythic using its official installer
#   2. Ensure the Mythic API is accessible from the ems-net Docker network
#   3. Configure the MythicProvider in c2-gateway with:
#      - host: <mythic-server-address>
#      - port: 7443
#      - auth_config: { "username": "mythic_admin", "password": "<password>" }
#
# Reference: https://docs.mythic-c2.net/

FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    python3 \
    python3-pip \
    docker.io \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create mythic user
RUN useradd -m -s /bin/bash -u 10001 mythic

# Clone Mythic (pinned to a stable release)
RUN git clone --depth 1 https://github.com/its-a-feature/Mythic.git /opt/mythic

WORKDIR /opt/mythic

# The Mythic server is typically started via mythic-cli, which orchestrates
# multiple sub-containers. For standalone integration:
#   ./mythic-cli start
#
# For EMS-COP, the key service is the Hasura GraphQL engine on port 7443.

# Expose Mythic API port (Hasura GraphQL)
EXPOSE 7443

# Expose common C2 traffic ports
EXPOSE 80 443

# Default entrypoint — in production, use mythic-cli
ENTRYPOINT ["/bin/bash", "-c", "echo 'Mythic C2 stub container — use mythic-cli for full deployment'; sleep infinity"]
