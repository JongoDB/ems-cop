import { describe, it, expect } from 'vitest'
import { DEMO_TOPOLOGY, DEMO_THROUGHPUT_GENERATOR } from '../demoTopology'
import type {
  C2Provider,
  TunnelStatus,
  TunnelType,
} from '../c2Topology'

describe('DEMO_TOPOLOGY', () => {
  it('has exactly 6 implant sessions', () => {
    expect(DEMO_TOPOLOGY.sessions).toHaveLength(6)
  })

  it('has exactly 8 tunnels', () => {
    expect(DEMO_TOPOLOGY.tunnels).toHaveLength(8)
  })

  it('exposes all 4 providers and they are all marked connected', () => {
    expect(DEMO_TOPOLOGY.providers).toHaveLength(4)
    const types = DEMO_TOPOLOGY.providers.map((p) => p.type).sort()
    expect(types).toEqual<C2Provider[]>(['havoc', 'merlin', 'mythic', 'sliver'])
    for (const p of DEMO_TOPOLOGY.providers) {
      expect(p.connected).toBe(true)
      expect(p.enabled).toBe(true)
    }
  })

  it('covers every tunnel_type at least once', () => {
    const types = new Set(DEMO_TOPOLOGY.tunnels.map((t) => t.tunnel_type))
    const expected: TunnelType[] = ['portfwd_local', 'portfwd_remote', 'socks5', 'pivot_relay']
    for (const t of expected) {
      expect(types.has(t)).toBe(true)
    }
  })

  it('covers every status at least once (active, pending, error, closed)', () => {
    const statuses = new Set(DEMO_TOPOLOGY.tunnels.map((t) => t.status))
    const required: TunnelStatus[] = ['active', 'pending', 'error', 'closed']
    for (const s of required) {
      expect(statuses.has(s)).toBe(true)
    }
  })

  it('has exactly one tunnel with a non-null parent_tunnel_id and the parent exists', () => {
    const chained = DEMO_TOPOLOGY.tunnels.filter((t) => t.parent_tunnel_id !== null)
    expect(chained).toHaveLength(1)
    const child = chained[0]
    const parent = DEMO_TOPOLOGY.tunnels.find((t) => t.id === child.parent_tunnel_id)
    expect(parent).toBeDefined()
    // Parent must itself be a pivot relay (the chain head).
    expect(parent?.tunnel_type).toBe('pivot_relay')
  })

  it('classifications include UNCLASSIFIED, CUI, and SECRET across nodes/edges', () => {
    const all = new Set<string>()
    for (const s of DEMO_TOPOLOGY.sessions) all.add(s.classification.toUpperCase())
    for (const t of DEMO_TOPOLOGY.tunnels) all.add(t.classification.toUpperCase())
    expect(all.has('UNCLASSIFIED')).toBe(true)
    expect(all.has('CUI')).toBe(true)
    expect(all.has('SECRET')).toBe(true)
  })

  it('every tunnel src_session_id resolves to a known session', () => {
    const ids = new Set(DEMO_TOPOLOGY.sessions.map((s) => s.id))
    for (const t of DEMO_TOPOLOGY.tunnels) {
      expect(ids.has(t.src_session_id)).toBe(true)
    }
  })

  it('has at least one offline implant for offline-styling demo', () => {
    expect(DEMO_TOPOLOGY.sessions.some((s) => !s.is_alive)).toBe(true)
  })

  it('has at least one fresh check-in (< 60s ago) for the pulse demo', () => {
    const now = Date.now()
    const fresh = DEMO_TOPOLOGY.sessions.some(
      (s) => s.is_alive && now - Date.parse(s.last_checkin) < 60_000
    )
    expect(fresh).toBe(true)
  })
})

describe('DEMO_THROUGHPUT_GENERATOR', () => {
  it('returns non-negative bytes_in/bytes_out', () => {
    const sample = DEMO_THROUGHPUT_GENERATOR('demo-tun-01')
    expect(sample.bytes_in).toBeGreaterThanOrEqual(0)
    expect(sample.bytes_out).toBeGreaterThanOrEqual(0)
  })

  it('returns numbers (no NaN)', () => {
    const sample = DEMO_THROUGHPUT_GENERATOR('demo-tun-04')
    expect(Number.isFinite(sample.bytes_in)).toBe(true)
    expect(Number.isFinite(sample.bytes_out)).toBe(true)
  })

  it('different tunnel ids get distinct waveforms over many samples', () => {
    const a: number[] = []
    const b: number[] = []
    for (let i = 0; i < 8; i++) {
      a.push(DEMO_THROUGHPUT_GENERATOR('demo-tun-01').bytes_in)
      b.push(DEMO_THROUGHPUT_GENERATOR('demo-tun-04').bytes_in)
    }
    // Their averages should not be exactly equal — phase + jitter.
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    expect(avg(a)).not.toBe(avg(b))
  })
})
