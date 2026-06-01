// C2 Implant + Tunnel Topology — interactive SPA page.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Core } from 'cytoscape'
import {
  Plus,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Lock,
  Unlock,
  ImageDown,
  Filter,
  Network,
  AlertTriangle,
  Activity,
  Info,
  Cpu,
} from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useTopology } from '../hooks/useTunnels'
import { useTopologyStore, useTopologyRealtime } from '../stores/topologyStore'
import { useDemoModeStore } from '../stores/demoModeStore'
import { DEMO_TOPOLOGY, DEMO_THROUGHPUT_GENERATOR } from '../lib/demoTopology'
import {
  PROVIDER_COLORS,
  TUNNEL_TYPE_COLORS,
} from '../lib/c2Topology'
import type {
  C2Provider,
  TunnelType,
  TunnelStatus,
  ImplantSession,
  Tunnel,
} from '../lib/c2Topology'
import TunnelGraph, {
  tunnelGraphZoom,
  tunnelGraphFit,
  tunnelGraphLock,
  tunnelGraphExportPng,
} from '../components/c2/TunnelGraph'
import TunnelDetailDrawer from '../components/c2/TunnelDetailDrawer'
import CreateTunnelModal from '../components/c2/CreateTunnelModal'
import GenerateImplantModal from '../components/c2/GenerateImplantModal'

interface OperationLite {
  id: string
  name: string
  status: string
}

const PROVIDERS: C2Provider[] = ['sliver', 'mythic', 'havoc', 'merlin']
const TYPES: TunnelType[] = ['portfwd_local', 'portfwd_remote', 'socks5', 'pivot_relay']
const STATUSES: TunnelStatus[] = ['pending', 'active', 'closing', 'closed', 'error']

function unwrap<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[]
  if (res && typeof res === 'object' && 'data' in res && Array.isArray((res as { data: unknown }).data))
    return (res as { data: T[] }).data
  return []
}

function FilterChip({
  label,
  active,
  onClick,
  color,
}: {
  label: string
  active: boolean
  onClick: () => void
  color?: string
}) {
  const c = color ?? 'var(--color-accent)'
  return (
    <button
      onClick={onClick}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: 0.5,
        padding: '3px 8px',
        borderRadius: 'var(--radius)',
        border: '1px solid',
        borderColor: active ? c : 'var(--color-border)',
        background: active ? `${c}1a` : 'var(--color-bg-surface)',
        color: active ? c : 'var(--color-text-muted)',
        cursor: 'pointer',
        textTransform: 'uppercase',
        transition: 'all 0.15s ease',
      }}
    >
      {label}
    </button>
  )
}

function ToolbarButton({
  onClick,
  title,
  children,
  disabled,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 'var(--radius)',
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        color: 'var(--color-text-muted)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.15s ease',
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.borderColor = 'var(--color-accent)'
        e.currentTarget.style.color = 'var(--color-accent)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border)'
        e.currentTarget.style.color = 'var(--color-text-muted)'
      }}
    >
      {children}
    </button>
  )
}

// Tunnel-type swatches drawn for the redesigned topology.
// Edges encode type through both line style/arrow AND a hue accent
// (portfwd_remote = orange + tee, pivot_relay = teal solid thick,
// portfwd_local = neutral solid). socks5 is omitted — it renders as a
// node-side listener badge.
const EDGE_COLORS = {
  portfwd_local: '#9aa9bd',
  portfwd_remote: '#fd7e14',
  pivot_relay: '#14b8a6',
} as const
type DrawnTunnelType = keyof typeof EDGE_COLORS
const DRAWN_TUNNEL_TYPES: DrawnTunnelType[] = [
  'portfwd_local',
  'portfwd_remote',
  'pivot_relay',
]

function TunnelTypeSwatch({ type }: { type: DrawnTunnelType }) {
  // Reproduce the cytoscape encoding: solid neutral for portfwd_local,
  // solid orange + tee for portfwd_remote, thick solid teal for pivot_relay.
  const c = EDGE_COLORS[type]
  const arrow =
    type === 'portfwd_remote' ? (
      // Tee (perpendicular bar) arrow head.
      <span
        style={{
          width: 2,
          height: 10,
          background: c,
          marginLeft: -1,
        }}
      />
    ) : (
      // Triangle arrow head (default).
      <span
        style={{
          width: 0,
          height: 0,
          borderTop: '4px solid transparent',
          borderBottom: '4px solid transparent',
          borderLeft: `6px solid ${c}`,
        }}
      />
    )
  // pivot_relay rides thicker — matches the cytoscape stylesheet width: 4.
  const lineThickness = type === 'pivot_relay' ? 3 : 2
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <span
        style={{
          width: 18,
          height: 0,
          borderTop: `${lineThickness}px solid ${c}`,
        }}
      />
      {arrow}
    </span>
  )
}

function Legend() {
  // Compact legend pinned bottom-left. Single horizontal row of swatches —
  // small, low-contrast, never larger than it needs to be. Detailed
  // explanations live in the (?) help popover; this strip is just a
  // quick visual key the user can refer to without leaving the canvas.
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 10,
        left: 10,
        background: 'rgba(13, 22, 34, 0.85)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        padding: '5px 9px',
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: 0.5,
        color: 'var(--color-text-muted)',
        backdropFilter: 'blur(6px)',
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      {Object.entries(PROVIDER_COLORS).map(([p, c]) => (
        <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              width: 9,
              height: 9,
              border: `2px solid ${c}`,
              borderRadius: 2,
              background: '#0d1117',
            }}
          />
          <span style={{ textTransform: 'uppercase' }}>{p}</span>
        </div>
      ))}
      <span
        style={{
          width: 1,
          height: 12,
          background: 'var(--color-border)',
          margin: '0 2px',
        }}
      />
      {DRAWN_TUNNEL_TYPES.map((t) => (
        <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <TunnelTypeSwatch type={t} />
          <span style={{ textTransform: 'uppercase' }}>
            {t === 'portfwd_local'
              ? 'fwd'
              : t === 'portfwd_remote'
              ? 'reverse'
              : 'pivot'}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function C2TopologyPage() {
  const [operations, setOperations] = useState<OperationLite[]>([])
  const [operationId, setOperationId] = useState<string>('')

  const [providerFilter, setProviderFilter] = useState<C2Provider | null>(null)
  const [typeFilter, setTypeFilter] = useState<TunnelType | null>(null)
  const [statusFilter, setStatusFilter] = useState<TunnelStatus | null>(null)
  // "Show Closed" — when off, closed tunnels are hidden from the canvas.
  // The user explicitly wanted historical context to be opt-in rather than
  // permanently rendered as faint dotted lines (which read as a glitch).
  // Default off — much cleaner first impression.
  const [showClosed, setShowClosed] = useState(false)

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showGenerate, setShowGenerate] = useState(false)
  const [layoutLocked, setLayoutLocked] = useState(false)
  const [cy, setCy] = useState<Core | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const helpBtnRef = useRef<HTMLButtonElement | null>(null)
  const filterBtnRef = useRef<HTMLButtonElement | null>(null)
  const [demoToast, setDemoToast] = useState<string | null>(null)

  // Demo mode — when on, replace live API/socket data with the static
  // example fixture. We still mount the page exactly as before, just
  // shadow the data sources.
  const demoMode = useDemoModeStore((s) => s.enabled)
  const toggleDemo = useDemoModeStore((s) => s.toggle)

  // Fetch operations for the selector
  useEffect(() => {
    if (demoMode) {
      // Skip API hit — keep the selector simple in demo mode.
      setOperations([])
      return
    }
    apiFetch<unknown>('/operations')
      .then((res) => setOperations(unwrap<OperationLite>(res)))
      .catch(() => setOperations([]))
  }, [demoMode])

  // Server snapshot via TanStack Query
  const topologyQuery = useTopology(operationId || undefined)

  // Hydrate the realtime store with server data when it (re)loads.
  const hydrate = useTopologyStore((s) => s.hydrate)
  useEffect(() => {
    if (demoMode) return // Live data is suppressed in demo mode.
    if (topologyQuery.data) {
      hydrate({
        sessions: topologyQuery.data.sessions,
        tunnels: topologyQuery.data.tunnels,
      })
    }
  }, [topologyQuery.data, hydrate, demoMode])

  // Subscribe to live updates — but only in live mode.
  useTopologyRealtime(!demoMode)
  const liveSessions = useTopologyStore((s) => s.sessions)
  const liveTunnels = useTopologyStore((s) => s.tunnels)
  const applyTunnelEvent = useTopologyStore((s) => s.applyTunnelEvent)

  // useEffectiveTopology() — returns the demo fixture when demo mode is on,
  // otherwise the live data from the topology store. Resolved here inline.
  const sessions: ImplantSession[] = demoMode ? DEMO_TOPOLOGY.sessions : liveSessions
  const tunnels: Tunnel[] = demoMode ? DEMO_TOPOLOGY.tunnels : liveTunnels

  // Drive synthetic throughput samples in demo mode so the sparkline in
  // the detail drawer animates when an active tunnel is selected. We push
  // samples into the same throughput ring buffer the drawer reads from.
  useEffect(() => {
    if (!demoMode) return
    const activeIds = DEMO_TOPOLOGY.tunnels
      .filter((t) => t.status === 'active')
      .map((t) => t.id)
    // Pre-seed each active tunnel with a 60-sample backlog so the spark
    // looks alive the moment the user clicks one.
    for (const id of activeIds) {
      for (let i = 0; i < 60; i++) {
        const s = DEMO_THROUGHPUT_GENERATOR(id)
        applyTunnelEvent({ type: 'throughput', tunnel_id: id, throughput: s })
      }
    }
    const handle = window.setInterval(() => {
      for (const id of activeIds) {
        const s = DEMO_THROUGHPUT_GENERATOR(id)
        applyTunnelEvent({ type: 'throughput', tunnel_id: id, throughput: s })
      }
    }, 1000)
    return () => window.clearInterval(handle)
  }, [demoMode, applyTunnelEvent])

  const aliveImplantCount = useMemo(
    () => sessions.filter((s) => s.is_alive).length,
    [sessions]
  )

  // Demo guard — block actions that would hit the API while in demo mode.
  // Returns true if blocked (and shows a toast); false otherwise.
  const blockedByDemo = (label: string): boolean => {
    if (!demoMode) return false
    setDemoToast(`Demo mode — ${label} disabled`)
    window.setTimeout(() => setDemoToast(null), 2400)
    return true
  }

  // Keyboard shortcut: press "n" to open the New Tunnel modal (when this page
  // is in the foreground and the user isn't typing in an input).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return
        }
      }
      if (showCreate) return
      if (aliveImplantCount === 0) return
      if (demoMode) {
        e.preventDefault()
        blockedByDemo('New Tunnel')
        return
      }
      e.preventDefault()
      setShowCreate(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreate, aliveImplantCount, demoMode])

  // Listen for the global command-palette "new tunnel" action.
  useEffect(() => {
    const handler = () => {
      if (demoMode) {
        blockedByDemo('New Tunnel')
        return
      }
      if (sessions.filter((s) => s.is_alive).length > 0) setShowCreate(true)
    }
    window.addEventListener('ems:topology:new-tunnel', handler as EventListener)
    return () => window.removeEventListener('ems:topology:new-tunnel', handler as EventListener)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, demoMode])

  // Listen for the global command-palette "generate implant" action.
  useEffect(() => {
    const handler = () => {
      if (demoMode) {
        blockedByDemo('Generate Implant')
        return
      }
      setShowGenerate(true)
    }
    window.addEventListener('ems:topology:generate-implant', handler as EventListener)
    return () =>
      window.removeEventListener('ems:topology:generate-implant', handler as EventListener)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode])

  // Close help popover on outside click / Escape.
  useEffect(() => {
    if (!showHelp) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (helpBtnRef.current && !helpBtnRef.current.contains(target)) {
        setShowHelp(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowHelp(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [showHelp])

  // Close filters popover on outside click / Escape.
  useEffect(() => {
    if (!showFilters) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      // Don't close if click landed inside the filters popover or button.
      const popover = document.querySelector('[data-topology-filters-popover]')
      if (popover && popover.contains(target)) return
      if (filterBtnRef.current && filterBtnRef.current.contains(target)) return
      setShowFilters(false)
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowFilters(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [showFilters])

  // Apply filters
  const filteredSessions = useMemo(() => {
    if (!providerFilter) return sessions
    return sessions.filter((s) => s.provider === providerFilter)
  }, [sessions, providerFilter])

  const filteredTunnels = useMemo(() => {
    return tunnels.filter((t) => {
      if (providerFilter && t.provider !== providerFilter) return false
      if (typeFilter && t.tunnel_type !== typeFilter) return false
      if (statusFilter && t.status !== statusFilter) return false
      return true
    })
  }, [tunnels, providerFilter, typeFilter, statusFilter])

  // Derived selection objects
  const selectedSession = useMemo(
    () => sessions.find((s) => s.id === selectedNodeId) ?? null,
    [sessions, selectedNodeId]
  )
  const selectedTunnel = useMemo(
    () => tunnels.find((t) => t.id === selectedEdgeId) ?? null,
    [tunnels, selectedEdgeId]
  )
  const outgoingTunnels = useMemo(
    () => (selectedSession ? tunnels.filter((t) => t.src_session_id === selectedSession.id) : []),
    [tunnels, selectedSession]
  )

  const aliveCount = filteredSessions.filter((s) => s.is_alive).length
  const activeTunnels = filteredTunnels.filter((t) => t.status === 'active').length

  // In demo mode the topology query is irrelevant — short-circuit the
  // loading/error/empty derivations so the demo data renders immediately.
  const isLoading = demoMode ? false : topologyQuery.isLoading
  const isEmpty =
    !isLoading && filteredSessions.length === 0 && filteredTunnels.length === 0
  const isError = demoMode ? false : topologyQuery.isError

  return (
    <div
      style={{
        // The page outer is a flex item of <main> (display: flex, row).
        // We rely on align-items: stretch (the flex default) to fill the
        // cross-axis (height) — explicitly setting height: 100% here breaks
        // that resolution in some browsers and collapses the page to its
        // content height (~120px), leaving the cytoscape canvas at h=0.
        // alignSelf: 'stretch' makes the intent explicit.
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        alignSelf: 'stretch',
        minHeight: 0,
        animation: 'fadeIn 0.3s ease',
      }}
    >
      {/* Demo Mode banner */}
      {demoMode && (
        <div
          role="status"
          aria-live="polite"
          style={{
            height: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            background: 'rgba(251, 191, 36, 0.18)',
            borderBottom: '1px solid rgba(251, 191, 36, 0.55)',
            color: '#fbbf24',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: 1.4,
            fontWeight: 600,
            flexShrink: 0,
            position: 'sticky',
            top: 0,
            zIndex: 20,
          }}
        >
          <AlertTriangle size={12} />
          DEMO MODE — EXAMPLE DATA, NOT LIVE
        </div>
      )}

      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 10,
          padding: '10px 14px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-bg-elevated)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Network size={16} style={{ color: 'var(--color-accent)' }} />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: 0.5,
              color: 'var(--color-text-bright)',
            }}
          >
            C2 TOPOLOGY
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingLeft: 8,
            borderLeft: '1px solid var(--color-border)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: 1,
              color: 'var(--color-text-muted)',
            }}
          >
            OP
          </span>
          <select
            value={operationId}
            onChange={(e) => {
              setOperationId(e.target.value)
              setSelectedNodeId(null)
              setSelectedEdgeId(null)
            }}
            disabled={demoMode}
            style={{
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              padding: '4px 8px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              maxWidth: 280,
              opacity: demoMode ? 0.5 : 1,
            }}
          >
            <option value="">All Operations</option>
            {operations.map((op) => (
              <option key={op.id} value={op.id}>
                {op.name}
              </option>
            ))}
          </select>
        </div>

        {/* Demo Mode toggle */}
        <button
          type="button"
          onClick={toggleDemo}
          role="switch"
          aria-checked={demoMode}
          aria-label="Toggle Demo Mode"
          title={demoMode ? 'Demo Mode is ON — showing example data' : 'Toggle Demo Mode (example data)'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 8px 3px 6px',
            borderRadius: 999,
            border: '1px solid',
            borderColor: demoMode ? '#fbbf24' : 'var(--color-border)',
            background: demoMode ? 'rgba(251, 191, 36, 0.14)' : 'var(--color-bg-surface)',
            color: demoMode ? '#fbbf24' : 'var(--color-text-muted)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: 1,
            textTransform: 'uppercase',
            transition: 'all 0.15s ease',
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 22,
              height: 12,
              borderRadius: 999,
              background: demoMode ? '#fbbf24' : 'var(--color-border-strong, #3a4a5c)',
              position: 'relative',
              transition: 'background 0.15s ease',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 1,
                left: demoMode ? 11 : 1,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#0a0e14',
                transition: 'left 0.15s ease',
              }}
            />
          </span>
          Demo
        </button>

        {/* Filters dropdown — collapses provider/type/status chips into one
            button so the header doesn't wrap to 2-3 lines on smaller widths.
            The button shows a count badge when any filter is active. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingLeft: 8,
            borderLeft: '1px solid var(--color-border)',
            position: 'relative',
          }}
        >
          <button
            ref={filterBtnRef}
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            aria-label="Open filters"
            title="Filter implants and tunnels"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 'var(--radius)',
              background: showFilters ? 'var(--color-bg-hover)' : 'var(--color-bg-surface)',
              border: '1px solid',
              borderColor:
                providerFilter || typeFilter || statusFilter
                  ? 'var(--color-accent)'
                  : showFilters
                  ? 'var(--color-accent)'
                  : 'var(--color-border)',
              color:
                providerFilter || typeFilter || statusFilter
                  ? 'var(--color-accent)'
                  : showFilters
                  ? 'var(--color-accent)'
                  : 'var(--color-text-muted)',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: 1,
              textTransform: 'uppercase',
            }}
          >
            <Filter size={12} />
            Filters
            {(providerFilter ? 1 : 0) + (typeFilter ? 1 : 0) + (statusFilter ? 1 : 0) > 0 && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 16,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 8,
                  background: 'var(--color-accent)',
                  color: '#0a0e14',
                  fontSize: 9,
                  fontWeight: 700,
                }}
              >
                {(providerFilter ? 1 : 0) + (typeFilter ? 1 : 0) + (statusFilter ? 1 : 0)}
              </span>
            )}
          </button>

          {/* Show-Closed toggle — small inline switch directly in the header
              so it's always discoverable. Default off; flipping it on brings
              back faint dotted edges for historical context. */}
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            role="switch"
            aria-checked={showClosed}
            aria-label="Toggle show closed tunnels"
            title={showClosed ? 'Hide closed tunnels' : 'Show closed (historical) tunnels'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px 3px 6px',
              borderRadius: 999,
              border: '1px solid',
              borderColor: showClosed ? 'var(--color-accent)' : 'var(--color-border)',
              background: showClosed
                ? 'rgba(77, 171, 247, 0.10)'
                : 'var(--color-bg-surface)',
              color: showClosed ? 'var(--color-accent)' : 'var(--color-text-muted)',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: 1,
              textTransform: 'uppercase',
              transition: 'all 0.15s ease',
            }}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 18,
                height: 10,
                borderRadius: 999,
                background: showClosed ? 'var(--color-accent)' : 'var(--color-border-strong, #3a4a5c)',
                position: 'relative',
                transition: 'background 0.15s ease',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 1,
                  left: showClosed ? 9 : 1,
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: '#0a0e14',
                  transition: 'left 0.15s ease',
                }}
              />
            </span>
            Closed
          </button>

          {showFilters && (
            <div
              data-topology-filters-popover
              role="dialog"
              aria-label="Topology filters"
              style={{
                position: 'absolute',
                top: 'calc(100% + 8px)',
                left: 0,
                width: 320,
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border-strong)',
                borderTop: '2px solid var(--color-accent)',
                borderRadius: 'var(--radius)',
                padding: 12,
                zIndex: 50,
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: 0.6,
                  color: 'var(--color-text-muted)',
                  marginBottom: 6,
                }}
              >
                PROVIDER
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                {PROVIDERS.map((p) => (
                  <FilterChip
                    key={p}
                    label={p}
                    active={providerFilter === p}
                    onClick={() => setProviderFilter(providerFilter === p ? null : p)}
                    color={PROVIDER_COLORS[p]}
                  />
                ))}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: 0.6,
                  color: 'var(--color-text-muted)',
                  marginBottom: 6,
                }}
              >
                TUNNEL TYPE
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                {TYPES.map((t) => (
                  <FilterChip
                    key={t}
                    label={t.replace('_', ' ')}
                    active={typeFilter === t}
                    onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                    color={TUNNEL_TYPE_COLORS[t]}
                  />
                ))}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: 0.6,
                  color: 'var(--color-text-muted)',
                  marginBottom: 6,
                }}
              >
                STATUS
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
                {STATUSES.map((s) => (
                  <FilterChip
                    key={s}
                    label={s}
                    active={statusFilter === s}
                    onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                  />
                ))}
              </div>
              {(providerFilter || typeFilter || statusFilter) && (
                <button
                  type="button"
                  onClick={() => {
                    setProviderFilter(null)
                    setTypeFilter(null)
                    setStatusFilter(null)
                  }}
                  style={{
                    marginTop: 4,
                    padding: '4px 10px',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-bg-surface)',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                  }}
                >
                  Clear all
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ flex: 1 }} />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: 0.5,
            color: 'var(--color-text-muted)',
          }}
        >
          <span>
            <Activity size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3, color: '#40c057' }} />
            {aliveCount}/{filteredSessions.length} alive
          </span>
          <span>· {activeTunnels} active tunnel{activeTunnels === 1 ? '' : 's'}</span>
        </div>

        <div style={{ position: 'relative' }}>
          <button
            ref={helpBtnRef}
            onClick={() => setShowHelp((v) => !v)}
            title="What do the colors mean?"
            aria-label="Topology legend help"
            aria-expanded={showHelp}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 'var(--radius)',
              background: showHelp ? 'var(--color-bg-hover)' : 'var(--color-bg-surface)',
              border: '1px solid',
              borderColor: showHelp ? 'var(--color-accent)' : 'var(--color-border)',
              color: showHelp ? 'var(--color-accent)' : 'var(--color-text-muted)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <Info size={14} />
          </button>
          {showHelp && (
            <div
              role="dialog"
              aria-label="Topology legend"
              style={{
                position: 'absolute',
                top: 'calc(100% + 8px)',
                right: 0,
                width: 320,
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border-strong)',
                borderTop: '2px solid var(--color-accent)',
                borderRadius: 'var(--radius)',
                padding: 14,
                zIndex: 50,
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                color: 'var(--color-text)',
                textTransform: 'none',
                letterSpacing: 0,
                textAlign: 'left',
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: 1,
                  color: 'var(--color-text-bright)',
                  marginBottom: 8,
                }}
              >
                LEGEND
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: 0.6,
                  color: 'var(--color-text-muted)',
                  marginBottom: 4,
                }}
              >
                NODE BORDER — IMPLANT PROVIDER
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 12 }}>
                {Object.entries(PROVIDER_COLORS).map(([p, c]) => (
                  <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                    <span
                      style={{
                        width: 12,
                        height: 12,
                        border: `2px solid ${c}`,
                        borderRadius: 2,
                        background: '#0d1117',
                      }}
                    />
                    {p}
                  </div>
                ))}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: 0.6,
                  color: 'var(--color-text-muted)',
                  marginBottom: 4,
                }}
              >
                EDGE LINE STYLE — TUNNEL TYPE
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 10 }}>
                {DRAWN_TUNNEL_TYPES.map((t) => (
                  <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                    <TunnelTypeSwatch type={t} />
                    {t.replace('_', ' ')}
                  </div>
                ))}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: 0.6,
                  color: 'var(--color-text-muted)',
                  marginBottom: 4,
                }}
              >
                NODE LABEL — LISTENERS
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-muted)',
                  marginBottom: 10,
                  lineHeight: 1.5,
                }}
              >
                Implants with a SOCKS5 or unbound listener show a third label
                line like <span style={{ fontFamily: 'var(--font-mono)' }}>listen :1080</span>.
                A red label means the listener errored.
              </div>
              <div
                style={{
                  paddingTop: 10,
                  borderTop: '1px solid var(--color-border)',
                  fontSize: 11,
                  color: 'var(--color-text-muted)',
                  lineHeight: 1.5,
                }}
              >
                Press <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '1px 5px', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius)', background: 'var(--color-bg-surface)' }}>n</kbd> to start a new tunnel. Click an implant to focus its connections; click empty space to clear.
              </div>
            </div>
          )}
        </div>

        <button
          onClick={() => {
            if (blockedByDemo('Generate Implant')) return
            setShowGenerate(true)
          }}
          className="create-btn topo-btn-collapse"
          title={demoMode ? 'Disabled in Demo Mode' : 'Generate a new implant binary'}
          style={{
            background: 'var(--color-bg-surface)',
            color: 'var(--color-text)',
            borderColor: 'var(--color-border)',
            opacity: demoMode ? 0.55 : 1,
          }}
        >
          <Cpu size={14} />
          <span className="topo-btn-label">GENERATE IMPLANT</span>
        </button>

        <button
          onClick={() => {
            if (blockedByDemo('New Tunnel')) return
            setShowCreate(true)
          }}
          className="create-btn topo-btn-collapse"
          title={demoMode ? 'Disabled in Demo Mode' : 'New tunnel (n)'}
          disabled={filteredSessions.filter((s) => s.is_alive).length === 0}
          style={{
            opacity:
              demoMode || filteredSessions.filter((s) => s.is_alive).length === 0 ? 0.5 : 1,
          }}
        >
          <Plus size={14} />
          <span className="topo-btn-label">NEW TUNNEL</span>
        </button>
      </header>

      {/* Body */}
      <div
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            position: 'relative',
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Skeleton / states */}
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
                fontSize: 12,
                letterSpacing: 1,
              }}
            >
              <div className="loading-shimmer" style={{ padding: 20 }}>
                LOADING TOPOLOGY…
              </div>
            </div>
          )}

          {isError && !isEmpty && (
            <div
              style={{
                position: 'absolute',
                top: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                background: '#ff6b6b11',
                border: '1px solid #ff6b6b66',
                borderRadius: 'var(--radius)',
                padding: '6px 10px',
                color: '#ff6b6b',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                zIndex: 10,
              }}
            >
              <AlertTriangle size={12} />
              Backend unreachable — showing cached state.
            </div>
          )}

          {isEmpty && (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 40,
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius)',
                margin: 14,
              }}
            >
              <Network size={48} strokeWidth={1.25} style={{ color: 'var(--color-border-strong)', marginBottom: 14 }} />
              <p
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 14,
                  letterSpacing: 1,
                  color: 'var(--color-text-bright)',
                  margin: '0 0 8px 0',
                }}
              >
                NO IMPLANTS OR TUNNELS YET
              </p>
              <p
                style={{
                  fontFamily: 'var(--font-body)',
                  fontSize: 13,
                  color: 'var(--color-text-muted)',
                  margin: '0 0 14px 0',
                  textAlign: 'center',
                  maxWidth: 420,
                  lineHeight: 1.6,
                }}
              >
                The topology view shows live implants and the tunnels between them.
                Generate an implant from <strong style={{ color: 'var(--color-accent)' }}>Operations → C2 → Implants</strong>,
                then come back here to start pivoting.
              </p>
              <button
                onClick={() => (window.location.href = '/operations')}
                className="create-btn"
                style={{ marginTop: 4 }}
              >
                <Network size={14} />
                GO TO OPERATIONS
              </button>
            </div>
          )}

          {!isEmpty && !isLoading && (
            <>
              {/* Toolbar overlay */}
              <div
                style={{
                  position: 'absolute',
                  top: 10,
                  left: 10,
                  display: 'flex',
                  gap: 6,
                  zIndex: 5,
                }}
              >
                <ToolbarButton onClick={() => tunnelGraphZoom(cy, 1.2)} title="Zoom in">
                  <ZoomIn size={14} />
                </ToolbarButton>
                <ToolbarButton onClick={() => tunnelGraphZoom(cy, 0.83)} title="Zoom out">
                  <ZoomOut size={14} />
                </ToolbarButton>
                <ToolbarButton onClick={() => tunnelGraphFit(cy)} title="Fit to view">
                  <Maximize2 size={14} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => {
                    const next = !layoutLocked
                    tunnelGraphLock(cy, next)
                    setLayoutLocked(next)
                  }}
                  title={layoutLocked ? 'Unlock layout' : 'Lock layout'}
                >
                  {layoutLocked ? <Lock size={14} /> : <Unlock size={14} />}
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => tunnelGraphExportPng(cy, `c2-topology-${operationId || 'all'}.png`)}
                  title="Export PNG"
                >
                  <ImageDown size={14} />
                </ToolbarButton>
              </div>

              <Legend />

              <TunnelGraph
                sessions={filteredSessions}
                tunnels={filteredTunnels}
                operationId={operationId || undefined}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                onSelectNode={setSelectedNodeId}
                onSelectEdge={setSelectedEdgeId}
                onCytoscapeReady={setCy}
                variant="page"
                showClosed={showClosed}
              />
            </>
          )}
        </div>

        {(selectedSession || selectedTunnel) && (
          <TunnelDetailDrawer
            session={selectedSession}
            tunnel={selectedTunnel}
            outgoingTunnels={outgoingTunnels}
            demoMode={demoMode}
            onClose={() => {
              setSelectedNodeId(null)
              setSelectedEdgeId(null)
            }}
            onSelectTunnel={(tid) => {
              setSelectedNodeId(null)
              setSelectedEdgeId(tid)
            }}
          />
        )}
      </div>

      {/* Demo mode action-blocked toast */}
      {demoToast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(251, 191, 36, 0.16)',
            border: '1px solid rgba(251, 191, 36, 0.55)',
            color: '#fbbf24',
            padding: '8px 14px',
            borderRadius: 'var(--radius)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: 1,
            textTransform: 'uppercase',
            zIndex: 100,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
            backdropFilter: 'blur(6px)',
          }}
        >
          {demoToast}
        </div>
      )}

      <CreateTunnelModal
        open={showCreate && !demoMode}
        operationId={operationId || null}
        sessions={sessions}
        tunnels={tunnels}
        onClose={() => setShowCreate(false)}
      />

      <GenerateImplantModal
        open={showGenerate && !demoMode}
        onClose={() => setShowGenerate(false)}
        defaultProvider={providerFilter ?? undefined}
      />

      <style>{`
        @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes shimmer { 0% { opacity: 0.6 } 50% { opacity: 1 } 100% { opacity: 0.6 } }
        .loading-shimmer { animation: shimmer 1.4s ease-in-out infinite }
        /* Collapse the long button labels on narrow screens so the header
           stays a single row at 1024 wide. The Cpu / Plus icons remain. */
        @media (max-width: 1180px) {
          .topo-btn-collapse .topo-btn-label { display: none }
          .topo-btn-collapse { padding-left: 8px; padding-right: 8px }
        }
      `}</style>
    </div>
  )
}
