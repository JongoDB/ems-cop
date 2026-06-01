// Shared C2 Topology types — mirrors the backend /api/v1/c2 contract.

export type C2Provider = 'sliver' | 'mythic' | 'havoc' | 'merlin'

export type TunnelType =
  | 'portfwd_local'
  | 'portfwd_remote'
  | 'socks5'
  | 'pivot_relay'

export type TunnelStatus =
  | 'pending'
  | 'active'
  | 'closing'
  | 'closed'
  | 'error'

export interface ImplantSession {
  id: string
  provider: C2Provider
  implant_name: string
  hostname: string
  os: string
  remote_addr: string
  username?: string
  pid?: number
  transport: string
  is_alive: boolean
  last_checkin: string
  classification: string
}

export interface Tunnel {
  id: string
  operation_id: string | null
  provider: C2Provider
  tunnel_type: TunnelType
  src_session_id: string
  src_implant_name?: string
  dst_host?: string
  dst_port?: number
  listen_host?: string
  listen_port?: number
  parent_tunnel_id: string | null
  status: TunnelStatus
  classification: string
  error_message?: string
  created_by: string
  created_at: string
}

export interface ProviderInfo {
  name: string
  type: C2Provider
  enabled: boolean
  connected: boolean
}

export interface TopologyResponse {
  sessions: ImplantSession[]
  tunnels: Tunnel[]
  providers: ProviderInfo[]
}

export interface CreateTunnelRequest {
  operation_id?: string | null
  provider: C2Provider
  tunnel_type: TunnelType
  src_session_id: string
  dst_host?: string
  dst_port?: number
  listen_port?: number
  parent_tunnel_id?: string | null
  classification?: string
}

export interface ThroughputPoint {
  timestamp: string
  bytes_in: number
  bytes_out: number
}

export interface TunnelThroughputResponse {
  tunnel_id: string
  points: ThroughputPoint[]
}

export interface TunnelFilter {
  operation_id?: string
  provider?: C2Provider
  tunnel_type?: TunnelType
  status?: TunnelStatus
}

// ──────────────────────────────────────────
//  Visual constants
// ──────────────────────────────────────────

export const PROVIDER_COLORS: Record<C2Provider, string> = {
  sliver: '#06b6d4',
  mythic: '#ec4899',
  havoc: '#ef4444',
  merlin: '#8b5cf6',
}

export const TUNNEL_TYPE_COLORS: Record<TunnelType, string> = {
  portfwd_local: '#4dabf7',
  portfwd_remote: '#fd7e14',
  socks5: '#9775fa',
  pivot_relay: '#22d3ee',
}

export const TUNNEL_TYPE_LABELS: Record<TunnelType, string> = {
  portfwd_local: 'Port Forward (Local)',
  portfwd_remote: 'Port Forward (Remote)',
  socks5: 'SOCKS5 Proxy',
  pivot_relay: 'Pivot Relay',
}

export const CLASSIFICATION_COLORS: Record<string, string> = {
  UNCLASSIFIED: '#5c6b7f',
  UNCLASS: '#5c6b7f',
  CUI: '#fab005',
  SECRET: '#ff6b6b',
}

export function tunnelEdgeLabel(t: Tunnel): string {
  if (t.tunnel_type === 'socks5') {
    return `socks5 :${t.listen_port ?? '?'}`
  }
  if (t.tunnel_type === 'pivot_relay') {
    return `relay :${t.listen_port ?? '?'}`
  }
  const listen = t.listen_port ? `:${t.listen_port}` : ''
  const dst = t.dst_host && t.dst_port ? `${t.dst_host}:${t.dst_port}` : ''
  if (listen && dst) return `${listen} → ${dst}`
  if (dst) return dst
  if (listen) return listen
  return t.tunnel_type
}
