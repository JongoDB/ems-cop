# EMS-COP NiFi — CTI Data Flow Orchestration Hub
# Runs in the cti-net zone, handles cross-enclave data flow between
# low-side (tactical) and high-side (strategic) enclaves.
#
# NiFi 2.x with NATS CLI for interacting with NATS JetStream via
# ExecuteProcess processors. Custom NATS NARs can be added later.

FROM apache/nifi:2.0.0

USER root

# Install NATS CLI for ExecuteProcess-based NATS interaction
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip && \
    curl -L https://github.com/nats-io/natscli/releases/download/v0.1.5/nats-0.1.5-linux-amd64.zip -o /tmp/nats.zip && \
    cd /tmp && unzip nats.zip && mv nats-0.1.5-linux-amd64/nats /usr/local/bin/nats && \
    chmod +x /usr/local/bin/nats && \
    rm -rf /tmp/nats* && \
    apt-get purge -y unzip && \
    apt-get autoremove -y && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create directories for content and provenance repos
RUN mkdir -p /opt/nifi/content /opt/nifi/provenance && \
    chown -R nifi:nifi /opt/nifi/content /opt/nifi/provenance

USER nifi

# NiFi configuration overrides
ENV NIFI_WEB_HTTP_PORT=8443
# Set via docker-compose environment
# ENV NIFI_SENSITIVE_PROPS_KEY=
ENV NIFI_FLOW_CONFIGURATION_FILE=/opt/nifi/nifi-current/conf/flow.json
ENV NIFI_CONTENT_REPOSITORY_DIRECTORY_DEFAULT=/opt/nifi/content
ENV NIFI_PROVENANCE_REPOSITORY_DIRECTORY_DEFAULT=/opt/nifi/provenance
# Set via docker-compose environment
# ENV SINGLE_USER_CREDENTIALS_USERNAME=
# ENV SINGLE_USER_CREDENTIALS_PASSWORD=

EXPOSE 8443

# Health check against NiFi REST API
HEALTHCHECK --interval=15s --timeout=5s --retries=10 \
  CMD curl -sf http://localhost:8443/nifi-api/system-diagnostics || exit 1
