-- 006_c2_tunnel_throughput.sql — Per-tunnel throughput telemetry
-- Bytes-in / bytes-out samples written by c2-gateway tunnel manager.
CREATE TABLE IF NOT EXISTS ems_audit.c2_tunnel_throughput (
  timestamp DateTime64(3) DEFAULT now64(),
  tunnel_id UUID,
  operation_id UUID,
  provider LowCardinality(String),
  tunnel_type LowCardinality(String),
  bytes_in UInt64,
  bytes_out UInt64,
  classification LowCardinality(String) DEFAULT 'UNCLASSIFIED'
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (tunnel_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY;
