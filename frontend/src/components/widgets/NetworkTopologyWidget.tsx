import { useState, useEffect, useRef, useCallback } from 'react'
// @ts-expect-error no type declarations for react-cytoscapejs
import CytoscapeComponent from 'react-cytoscapejs'
import type { Core, StylesheetStyle } from 'cytoscape'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'
import { useSocket } from '../../hooks/useSocket'

interface Operation {
  id: string
  name: string
}

interface TopoNode {
  id: string
  label?: string
  name?: string
  node_type?: string
  x?: number
  y?: number
  [key: string]: unknown
}

interface TopoEdge {
  id?: string
  source: string
  target: string
  label?: string
  [key: string]: unknown
}

interface TopologyData {
  nodes: TopoNode[]
  edges: TopoEdge[]
}

const NODE_COLORS: Record<string, string> = {
  server: '#60a5fa',
  workstation: '#4ade80',
  router: '#facc15',
  firewall: '#ef4444',
}

const DEFAULT_NODE_COLOR = '#94a3b8'

function unwrap<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  if (res && typeof res === 'object' && 'data' in res && Array.isArray((res as { data: unknown }).data))
    return (res as { data: T[] }).data
  return []
}

export default function NetworkTopologyWidget({ id, config, onConfigChange }: WidgetProps) {
  const [operations, setOperations] = useState<Operation[]>([])
  const [topology, setTopology] = useState<TopologyData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cyRef = useRef<Core | null>(null)

  const operationId = (config.operation_id as string) || ''

  const { events: endpointEvents } = useSocket('endpoint.*')

  // Fetch operations list
  useEffect(() => {
    apiFetch<unknown>('/operations')
      .then(res => setOperations(unwrap<Operation>(res)))
      .catch(() => setOperations([]))
  }, [])

  // Fetch topology when operation selected
  const fetchTopology = useCallback(async () => {
    if (!operationId) {
      setTopology(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const networks = unwrap<{ id: string }>(
        await apiFetch<unknown>(`/networks?operation_id=${operationId}`)
      )
      if (networks.length === 0) {
        setTopology({ nodes: [], edges: [] })
        setLoading(false)
        return
      }
      const topo = await apiFetch<TopologyData>(`/networks/${networks[0].id}/topology`)
      setTopology(topo)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load topology')
    } finally {
      setLoading(false)
    }
  }, [operationId])

  useEffect(() => {
    fetchTopology()
  }, [fetchTopology])

  // Refetch on endpoint events
  useEffect(() => {
    if (endpointEvents.length > 0 && operationId) {
      fetchTopology()
    }
    // Only trigger on new events
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointEvents.length])

  const handleOperationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newId = e.target.value
    onConfigChange?.({ ...config, operation_id: newId })
  }

  const elements = topology
    ? [
        ...topology.nodes.map((n, i) => ({
          data: {
            id: n.id,
            label: n.label || n.name || n.id,
            node_type: n.node_type || 'default',
          },
          position: {
            x: n.x ?? (i % 5) * 120 + 60,
            y: n.y ?? Math.floor(i / 5) * 120 + 60,
          },
        })),
        ...topology.edges.map((e, i) => ({
          data: {
            id: e.id || `edge-${i}`,
            source: e.source,
            target: e.target,
            label: e.label || '',
          },
        })),
      ]
    : []

  const stylesheet: StylesheetStyle[] = [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-size': '10px',
        color: '#e2e8f0',
        'text-outline-color': '#1e293b',
        'text-outline-width': 1,
        shape: 'round-rectangle',
        width: 80,
        height: 36,
        'background-color': DEFAULT_NODE_COLOR,
      },
    },
    ...Object.entries(NODE_COLORS).map(([type, color]) => ({
      selector: `node[node_type="${type}"]`,
      style: { 'background-color': color },
    })),
    {
      selector: 'edge',
      style: {
        width: 2,
        'line-color': '#475569',
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'target-arrow-color': '#475569',
        'arrow-scale': 0.8,
      },
    },
  ]

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    color: 'var(--color-text-primary)',
    background: 'var(--color-bg-primary)',
  }

  const toolbarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  }

  const selectStyle: React.CSSProperties = {
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '3px 6px',
    fontSize: '11px',
    flex: 1,
    maxWidth: '240px',
  }

  const btnStyle: React.CSSProperties = {
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '3px 8px',
    fontSize: '11px',
    cursor: 'pointer',
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={toolbarStyle}>
        <select value={operationId} onChange={handleOperationChange} style={selectStyle}>
          <option value="">-- Select Operation --</option>
          {operations.map(op => (
            <option key={op.id} value={op.id}>
              {op.name}
            </option>
          ))}
        </select>
        <button style={btnStyle} onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.2)}>
          +
        </button>
        <button style={btnStyle} onClick={() => cyRef.current?.zoom(cyRef.current.zoom() / 1.2)}>
          -
        </button>
        <button style={btnStyle} onClick={() => cyRef.current?.fit(undefined, 30)}>
          Fit
        </button>
      </div>

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {!operationId && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
            }}
          >
            Select an operation
          </div>
        )}

        {operationId && loading && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
            }}
          >
            Loading topology...
          </div>
        )}

        {operationId && error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#ef4444',
            }}
          >
            {error}
          </div>
        )}

        {operationId && !loading && !error && topology && elements.length === 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
            }}
          >
            No topology data
          </div>
        )}

        {operationId && !loading && !error && topology && elements.length > 0 && (
          <CytoscapeComponent
            elements={elements}
            stylesheet={stylesheet}
            layout={{ name: 'preset' }}
            style={{ width: '100%', height: '100%' }}
            cy={(cy: Core) => {
              cyRef.current = cy
            }}
          />
        )}
      </div>
    </div>
  )
}
