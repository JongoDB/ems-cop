// Compact dashboard widget for the C2 implant + tunnel topology.

import { useEffect, useMemo, useState } from 'react'
import type { Core } from 'cytoscape'
import { apiFetch } from '../../lib/api'
import type { WidgetProps } from './WidgetRegistry'
import { useTopology } from '../../hooks/useTunnels'
import { useTopologyStore, useTopologyRealtime } from '../../stores/topologyStore'
import { useDemoModeStore } from '../../stores/demoModeStore'
import { DEMO_TOPOLOGY } from '../../lib/demoTopology'
import TunnelGraph, { tunnelGraphFit } from '../c2/TunnelGraph'

interface OperationLite {
  id: string
  name: string
}

function unwrap<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  if (res && typeof res === 'object' && 'data' in res && Array.isArray((res as { data: unknown }).data))
    return (res as { data: T[] }).data
  return []
}

export default function TunnelTopologyWidget({ id, config, onConfigChange }: WidgetProps) {
  const operationId = (config.operation_id as string) || ''
  const [operations, setOperations] = useState<OperationLite[]>([])
  const [cy, setCy] = useState<Core | null>(null)
  const demoMode = useDemoModeStore((s) => s.enabled)

  useEffect(() => {
    if (demoMode) {
      setOperations([])
      return
    }
    apiFetch<unknown>('/operations')
      .then((res) => setOperations(unwrap<OperationLite>(res)))
      .catch(() => setOperations([]))
  }, [demoMode])

  const topologyQuery = useTopology(operationId || undefined)
  const hydrate = useTopologyStore((s) => s.hydrate)
  useEffect(() => {
    if (demoMode) return
    if (topologyQuery.data) {
      hydrate({
        sessions: topologyQuery.data.sessions,
        tunnels: topologyQuery.data.tunnels,
      })
    }
  }, [topologyQuery.data, hydrate, demoMode])
  useTopologyRealtime(!demoMode)

  const liveSessions = useTopologyStore((s) => s.sessions)
  const liveTunnels = useTopologyStore((s) => s.tunnels)

  const sessions = demoMode ? DEMO_TOPOLOGY.sessions : liveSessions
  const tunnels = demoMode ? DEMO_TOPOLOGY.tunnels : liveTunnels

  const isLoading = demoMode ? false : topologyQuery.isLoading
  const isEmpty = !isLoading && sessions.length === 0 && tunnels.length === 0

  const summary = useMemo(() => {
    const alive = sessions.filter((s) => s.is_alive).length
    const active = tunnels.filter((t) => t.status === 'active').length
    return { alive, total: sessions.length, active }
  }, [sessions, tunnels])

  return (
    <div
      data-widget-id={id}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'var(--color-bg-primary, var(--color-bg, #0a0e14))',
        color: 'var(--color-text)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderBottom: '1px solid var(--color-border)',
          flexShrink: 0,
        }}
      >
        <select
          value={operationId}
          onChange={(e) => onConfigChange?.({ ...config, operation_id: e.target.value })}
          style={{
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            padding: '3px 6px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            flex: 1,
            maxWidth: 220,
          }}
        >
          <option value="">All Operations</option>
          {operations.map((op) => (
            <option key={op.id} value={op.id}>
              {op.name}
            </option>
          ))}
        </select>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: 0.5,
            color: 'var(--color-text-muted)',
          }}
        >
          {summary.alive}/{summary.total} alive · {summary.active} tunnels
        </span>
        <button
          onClick={() => tunnelGraphFit(cy)}
          style={{
            background: 'var(--color-bg-elevated)',
            color: 'var(--color-text-muted)',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 10,
            cursor: 'pointer',
          }}
          title="Fit to view"
        >
          Fit
        </button>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {demoMode && (
          <div
            aria-label="Demo Mode"
            title="Showing example data — Demo Mode is on"
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              zIndex: 6,
              padding: '2px 6px',
              borderRadius: 4,
              background: 'rgba(251, 191, 36, 0.18)',
              border: '1px solid rgba(251, 191, 36, 0.55)',
              color: '#fbbf24',
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: 1,
              fontWeight: 600,
              pointerEvents: 'none',
            }}
          >
            DEMO
          </div>
        )}
        {isLoading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: 1,
            }}
          >
            LOADING…
          </div>
        )}
        {isEmpty && !isLoading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 12,
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              textAlign: 'center',
            }}
          >
            <div style={{ marginBottom: 4 }}>NO IMPLANTS OR TUNNELS</div>
            <div style={{ fontSize: 10, opacity: 0.7 }}>
              Generate an implant to populate the topology.
            </div>
          </div>
        )}
        {!isEmpty && !isLoading && (
          <TunnelGraph
            sessions={sessions}
            tunnels={tunnels}
            operationId={operationId || undefined}
            onCytoscapeReady={setCy}
            variant="widget"
          />
        )}
      </div>
    </div>
  )
}
