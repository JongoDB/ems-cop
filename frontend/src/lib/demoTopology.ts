// Demo topology fixture — a hand-curated example of the C2 implant graph.
//
// This is loaded in place of the live API response when "Demo Mode" is
// enabled (see useDemoModeStore). It exercises every node-status case and
// every edge style so a user can preview the visualization without real
// implants present.

import type {
  ImplantSession,
  ProviderInfo,
  TopologyResponse,
  Tunnel,
} from './c2Topology'

const NOW = Date.now()
const ISO = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

// Stable-ish providers — all four supported, all "connected" so the
// Generate Implant modal lights them up.
const PROVIDERS: ProviderInfo[] = [
  { name: 'sliver', type: 'sliver', enabled: true, connected: true },
  { name: 'mythic', type: 'mythic', enabled: true, connected: true },
  { name: 'havoc', type: 'havoc', enabled: true, connected: true },
  { name: 'merlin', type: 'merlin', enabled: true, connected: true },
]

// Six implants — mix of providers, OSes, classifications, alive states.
// Hostnames double-up where useful so we can exercise hostname → ghost
// matching in the graph (e.g. relay child targets a hostname).
const SESSIONS: ImplantSession[] = [
  {
    id: 'demo-impl-01',
    provider: 'sliver',
    implant_name: 'BLUE_MARTEN',
    hostname: 'corp-ws-001',
    os: 'windows-amd64',
    remote_addr: '198.51.100.42:51244',
    username: 'CORP\\jdoe',
    pid: 4812,
    transport: 'mtls',
    is_alive: true,
    // ~15s ago — triggers the "fresh check-in pulse" (border-width 4).
    last_checkin: ISO(-15_000),
    classification: 'UNCLASSIFIED',
  },
  {
    id: 'demo-impl-02',
    provider: 'sliver',
    implant_name: 'GREEN_OTTER',
    hostname: 'dmz-web-001',
    os: 'linux-amd64',
    remote_addr: '203.0.113.18:443',
    username: 'www-data',
    pid: 1042,
    transport: 'https',
    is_alive: true,
    last_checkin: ISO(-90_000),
    classification: 'UNCLASSIFIED',
  },
  {
    id: 'demo-impl-03',
    provider: 'mythic',
    implant_name: 'CRIMSON_FOX',
    hostname: 'devops-laptop-9',
    os: 'darwin-arm64',
    remote_addr: '192.0.2.77:51200',
    username: 'sgranger',
    pid: 23104,
    transport: 'https',
    is_alive: true,
    last_checkin: ISO(-45_000),
    classification: 'UNCLASSIFIED',
  },
  {
    id: 'demo-impl-04',
    provider: 'havoc',
    implant_name: 'AMBER_RAVEN',
    hostname: 'fin-jumphost',
    os: 'windows-amd64',
    remote_addr: '198.51.100.91:8443',
    username: 'CORP\\svc_backup',
    pid: 6128,
    transport: 'https',
    is_alive: true,
    last_checkin: ISO(-120_000),
    classification: 'CUI',
  },
  {
    id: 'demo-impl-05',
    provider: 'merlin',
    implant_name: 'IRON_WOLF',
    hostname: 'attacker-jumpbox',
    os: 'linux-amd64',
    remote_addr: '10.13.37.7:51820',
    username: 'root',
    pid: 982,
    transport: 'wireguard',
    is_alive: true,
    last_checkin: ISO(-25_000),
    classification: 'SECRET',
  },
  {
    id: 'demo-impl-06',
    provider: 'sliver',
    implant_name: 'GHOST_RABBIT',
    hostname: 'lab-vm-04',
    os: 'linux-amd64',
    remote_addr: '203.0.113.244:53',
    username: 'analyst',
    pid: 3344,
    transport: 'dns',
    // Offline — last check-in 5 min ago.
    is_alive: false,
    last_checkin: ISO(-5 * 60_000),
    classification: 'UNCLASSIFIED',
  },
]

// Eight tunnels covering every (tunnel_type x status) corner-case the graph
// renders specially.
const TUNNELS: Tunnel[] = [
  // 1. Active local port-forward — RDP into an internal Windows host.
  {
    id: 'demo-tun-01',
    operation_id: null,
    provider: 'sliver',
    tunnel_type: 'portfwd_local',
    src_session_id: 'demo-impl-01',
    src_implant_name: 'BLUE_MARTEN',
    dst_host: '192.168.50.10',
    dst_port: 3389,
    listen_host: '127.0.0.1',
    listen_port: 13389,
    parent_tunnel_id: null,
    status: 'active',
    classification: 'UNCLASSIFIED',
    created_by: 'demo',
    created_at: ISO(-50 * 60_000),
  },
  // 2. Active remote port-forward — Kerberos KDC relay (CUI).
  {
    id: 'demo-tun-02',
    operation_id: null,
    provider: 'havoc',
    tunnel_type: 'portfwd_remote',
    src_session_id: 'demo-impl-04',
    src_implant_name: 'AMBER_RAVEN',
    dst_host: 'kdc.fin.corp.local',
    dst_port: 88,
    parent_tunnel_id: null,
    status: 'active',
    classification: 'CUI',
    created_by: 'demo',
    created_at: ISO(-42 * 60_000),
  },
  // 3. Active SOCKS5 — Mythic browser pivot.
  {
    id: 'demo-tun-03',
    operation_id: null,
    provider: 'mythic',
    tunnel_type: 'socks5',
    src_session_id: 'demo-impl-03',
    src_implant_name: 'CRIMSON_FOX',
    listen_host: '127.0.0.1',
    listen_port: 1080,
    parent_tunnel_id: null,
    status: 'active',
    classification: 'UNCLASSIFIED',
    created_by: 'demo',
    created_at: ISO(-30 * 60_000),
  },
  // 4. SECRET pivot relay — Merlin acts as the relay (the chain head).
  {
    id: 'demo-tun-04',
    operation_id: null,
    provider: 'merlin',
    tunnel_type: 'pivot_relay',
    src_session_id: 'demo-impl-05',
    src_implant_name: 'IRON_WOLF',
    listen_host: '0.0.0.0',
    listen_port: 4444,
    parent_tunnel_id: null,
    status: 'active',
    classification: 'SECRET',
    created_by: 'demo',
    created_at: ISO(-20 * 60_000),
  },
  // 5. Active local port-forward chained THROUGH the Merlin relay.
  // parent_tunnel_id points at demo-tun-04 — this is the headline visual.
  // dst_host matches an existing implant hostname so the edge routes
  // through the relay implant in the graph.
  {
    id: 'demo-tun-05',
    operation_id: null,
    provider: 'merlin',
    tunnel_type: 'portfwd_local',
    src_session_id: 'demo-impl-05',
    src_implant_name: 'IRON_WOLF',
    dst_host: 'fin-jumphost',
    dst_port: 445,
    listen_host: '127.0.0.1',
    listen_port: 14445,
    parent_tunnel_id: 'demo-tun-04',
    status: 'active',
    classification: 'SECRET',
    created_by: 'demo',
    created_at: ISO(-18 * 60_000),
  },
  // 6. Pending tunnel — dashed grey edge demo.
  {
    id: 'demo-tun-06',
    operation_id: null,
    provider: 'sliver',
    tunnel_type: 'portfwd_local',
    src_session_id: 'demo-impl-02',
    src_implant_name: 'GREEN_OTTER',
    dst_host: '10.0.5.32',
    dst_port: 22,
    listen_host: '127.0.0.1',
    listen_port: 12222,
    parent_tunnel_id: null,
    status: 'pending',
    classification: 'UNCLASSIFIED',
    created_by: 'demo',
    created_at: ISO(-3 * 60_000),
  },
  // 7. Errored SOCKS5 — believable failure message.
  {
    id: 'demo-tun-07',
    operation_id: null,
    provider: 'sliver',
    tunnel_type: 'socks5',
    src_session_id: 'demo-impl-02',
    src_implant_name: 'GREEN_OTTER',
    listen_host: '127.0.0.1',
    listen_port: 1081,
    parent_tunnel_id: null,
    status: 'error',
    classification: 'UNCLASSIFIED',
    error_message: 'listener bind: address in use',
    created_by: 'demo',
    created_at: ISO(-12 * 60_000),
  },
  // 8. Closed local port-forward — faded edge demo.
  {
    id: 'demo-tun-08',
    operation_id: null,
    provider: 'sliver',
    tunnel_type: 'portfwd_local',
    src_session_id: 'demo-impl-01',
    src_implant_name: 'BLUE_MARTEN',
    dst_host: '192.168.50.20',
    dst_port: 5985,
    listen_host: '127.0.0.1',
    listen_port: 15985,
    parent_tunnel_id: null,
    status: 'closed',
    classification: 'UNCLASSIFIED',
    created_by: 'demo',
    created_at: ISO(-55 * 60_000),
  },
]

export const DEMO_TOPOLOGY: TopologyResponse = {
  sessions: SESSIONS,
  tunnels: TUNNELS,
  providers: PROVIDERS,
}

// ─────────────────────────────────────────────
//  Synthetic throughput
// ─────────────────────────────────────────────
//
// Hash a tunnel id into a stable phase so each tunnel has its own waveform.
function hashId(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

/**
 * Returns synthetic byte-rate samples for a tunnel. Numbers are derived
 * from a sin-wave (so the sparkline animates smoothly) plus a small
 * per-call jitter (so live polling looks alive).
 */
export function DEMO_THROUGHPUT_GENERATOR(
  tunnelId: string
): { bytes_in: number; bytes_out: number } {
  const phase = hashId(tunnelId) % 1000
  const t = (Date.now() / 1000 + phase) / 6 // ~6s period
  const baseIn = 48_000 + 28_000 * Math.sin(t)
  const baseOut = 22_000 + 16_000 * Math.sin(t + 1.7)
  const jitter = () => (Math.random() - 0.5) * 4_000
  return {
    bytes_in: Math.max(0, Math.round(baseIn + jitter())),
    bytes_out: Math.max(0, Math.round(baseOut + jitter())),
  }
}
