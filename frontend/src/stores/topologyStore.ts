// Realtime store for C2 implant + tunnel topology.
//
// Subscribes to the `c2.tunnels` and `c2.sessions` socket topics, applies
// create/update/delete events to local state, and maintains a transient
// throughput ring buffer (per-tunnel) for live sparklines.

import { create } from 'zustand'
import { useEffect } from 'react'
import { useSocketStore } from './socketStore'
import type { ImplantSession, Tunnel } from '../lib/c2Topology'

const THROUGHPUT_BUFFER_SIZE = 60 // ~last 60 samples (≈60s at 1Hz)

export interface ThroughputSample {
  t: number // unix ms
  bytes_in: number
  bytes_out: number
}

interface TunnelEvent {
  type: 'created' | 'updated' | 'deleted' | 'throughput'
  tunnel?: Tunnel
  tunnel_id?: string
  throughput?: { bytes_in: number; bytes_out: number }
}

interface SessionEvent {
  type: 'created' | 'updated' | 'deleted'
  session?: ImplantSession
  session_id?: string
}

interface TopologyState {
  sessions: ImplantSession[]
  tunnels: Tunnel[]
  throughput: Record<string, ThroughputSample[]>
  lastEventAt: number | null

  // Bulk hydration from the /api/v1/c2/topology snapshot
  hydrate: (data: { sessions: ImplantSession[]; tunnels: Tunnel[] }) => void
  reset: () => void

  // Event handlers (called by the socket subscription hook)
  applyTunnelEvent: (evt: TunnelEvent) => void
  applySessionEvent: (evt: SessionEvent) => void

  // Selectors
  getThroughput: (tunnelId: string) => ThroughputSample[]
}

export const useTopologyStore = create<TopologyState>((set, get) => ({
  sessions: [],
  tunnels: [],
  throughput: {},
  lastEventAt: null,

  hydrate: ({ sessions, tunnels }) => {
    set({ sessions, tunnels })
  },

  reset: () => {
    set({ sessions: [], tunnels: [], throughput: {}, lastEventAt: null })
  },

  applyTunnelEvent: (evt) => {
    const now = Date.now()
    if (evt.type === 'throughput') {
      const id = evt.tunnel?.id ?? evt.tunnel_id
      if (!id || !evt.throughput) return
      const buf = get().throughput[id] ?? []
      const next = [
        ...buf,
        { t: now, bytes_in: evt.throughput.bytes_in, bytes_out: evt.throughput.bytes_out },
      ]
      while (next.length > THROUGHPUT_BUFFER_SIZE) next.shift()
      set({ throughput: { ...get().throughput, [id]: next }, lastEventAt: now })
      return
    }

    if (evt.type === 'deleted') {
      const id = evt.tunnel?.id ?? evt.tunnel_id
      if (!id) return
      set({
        tunnels: get().tunnels.filter((t) => t.id !== id),
        lastEventAt: now,
      })
      return
    }

    if (!evt.tunnel) return
    const incoming = evt.tunnel
    const tunnels = get().tunnels
    const idx = tunnels.findIndex((t) => t.id === incoming.id)
    if (idx === -1) {
      set({ tunnels: [...tunnels, incoming], lastEventAt: now })
    } else {
      const next = tunnels.slice()
      next[idx] = { ...next[idx], ...incoming }
      set({ tunnels: next, lastEventAt: now })
    }
  },

  applySessionEvent: (evt) => {
    const now = Date.now()
    if (evt.type === 'deleted') {
      const id = evt.session?.id ?? evt.session_id
      if (!id) return
      set({
        sessions: get().sessions.filter((s) => s.id !== id),
        lastEventAt: now,
      })
      return
    }
    if (!evt.session) return
    const incoming = evt.session
    const sessions = get().sessions
    const idx = sessions.findIndex((s) => s.id === incoming.id)
    if (idx === -1) {
      set({ sessions: [...sessions, incoming], lastEventAt: now })
    } else {
      const next = sessions.slice()
      next[idx] = { ...next[idx], ...incoming }
      set({ sessions: next, lastEventAt: now })
    }
  },

  getThroughput: (tunnelId: string) => {
    return get().throughput[tunnelId] ?? []
  },
}))

// ─────────────────────────────────────────────
//  Hook: subscribe to topology socket topics
// ─────────────────────────────────────────────

/**
 * Subscribes to `c2.tunnels` and `c2.sessions` topics for the lifetime of
 * the calling component, draining buffered events into the topology store.
 * Safe to mount in multiple places — subscriptions are reference-counted
 * by the underlying socket store.
 */
export function useTopologyRealtime(enabled: boolean = true) {
  const subscribe = useSocketStore((s) => s.subscribe)
  const unsubscribe = useSocketStore((s) => s.unsubscribe)
  const tunnelEvents = useSocketStore((s) => s.eventBuffers.get('c2.tunnels'))
  const sessionEvents = useSocketStore((s) => s.eventBuffers.get('c2.sessions'))
  const applyTunnelEvent = useTopologyStore((s) => s.applyTunnelEvent)
  const applySessionEvent = useTopologyStore((s) => s.applySessionEvent)

  useEffect(() => {
    if (!enabled) return
    subscribe('c2.tunnels')
    subscribe('c2.sessions')
    return () => {
      unsubscribe('c2.tunnels')
      unsubscribe('c2.sessions')
    }
  }, [enabled, subscribe, unsubscribe])

  // Drain new events into the store. We track a ref-equivalent via length
  // because each socket event mutates the buffer with a new Map identity.
  useEffect(() => {
    if (!enabled) return
    if (!tunnelEvents || tunnelEvents.length === 0) return
    const last = tunnelEvents[tunnelEvents.length - 1]
    if (last && last.data) {
      applyTunnelEvent(last.data as TunnelEvent)
    }
  }, [enabled, tunnelEvents, applyTunnelEvent])

  useEffect(() => {
    if (!enabled) return
    if (!sessionEvents || sessionEvents.length === 0) return
    const last = sessionEvents[sessionEvents.length - 1]
    if (last && last.data) {
      applySessionEvent(last.data as SessionEvent)
    }
  }, [enabled, sessionEvents, applySessionEvent])
}
