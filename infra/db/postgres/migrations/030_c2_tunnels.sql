-- 030_c2_tunnels.sql — Tunnel registry for c2-gateway
-- Tracks port-forwards, SOCKS proxies, and pivot relays across providers.
CREATE TABLE IF NOT EXISTS c2_tunnels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID,
  provider TEXT NOT NULL,
  tunnel_type TEXT NOT NULL CHECK (tunnel_type IN ('portfwd_local','portfwd_remote','socks5','pivot_relay')),
  src_session_id TEXT NOT NULL,
  src_implant_name TEXT,
  dst_host TEXT,
  dst_port INTEGER,
  listen_host TEXT,
  listen_port INTEGER,
  parent_tunnel_id UUID REFERENCES c2_tunnels(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','closing','closed','error')),
  classification TEXT NOT NULL DEFAULT 'UNCLASSIFIED',
  error_message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_c2_tunnels_operation ON c2_tunnels(operation_id);
CREATE INDEX IF NOT EXISTS idx_c2_tunnels_session ON c2_tunnels(src_session_id);
CREATE INDEX IF NOT EXISTS idx_c2_tunnels_status ON c2_tunnels(status);
CREATE INDEX IF NOT EXISTS idx_c2_tunnels_parent ON c2_tunnels(parent_tunnel_id);
