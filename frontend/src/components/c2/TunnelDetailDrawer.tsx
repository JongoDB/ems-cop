// Right-side detail drawer for the C2 topology page.
// Renders either an implant session detail OR a tunnel detail with sparkline.

import { useMemo } from 'react'
import { LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { X, Trash2, Server, User, Cpu, Activity, ArrowRight, AlertTriangle } from 'lucide-react'
import {
  PROVIDER_COLORS,
  TUNNEL_TYPE_COLORS,
  TUNNEL_TYPE_LABELS,
  CLASSIFICATION_COLORS,
  tunnelEdgeLabel,
} from '../../lib/c2Topology'
import type { ImplantSession, Tunnel } from '../../lib/c2Topology'
import { useTopologyStore } from '../../stores/topologyStore'
import { useTunnelThroughput, useDeleteTunnel } from '../../hooks/useTunnels'

interface DrawerProps {
  session: ImplantSession | null
  tunnel: Tunnel | null
  outgoingTunnels?: Tunnel[]
  onClose: () => void
  onSelectTunnel?: (tunnelId: string) => void
  /**
   * When true, mutating actions (e.g. close tunnel) are disabled and a
   * tooltip/disabled-style indicates demo mode. The component does NOT
   * fire the API call when this flag is set.
   */
  demoMode?: boolean
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso)
  if (!t) return '—'
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: 1,
  color: 'var(--color-text-muted)',
  textTransform: 'uppercase',
}
const valueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--color-text-bright)',
  wordBreak: 'break-all',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 }}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle}>{children}</span>
    </div>
  )
}

function ProviderPill({ provider }: { provider: string }) {
  const color =
    (PROVIDER_COLORS as Record<string, string>)[provider] || 'var(--color-text-muted)'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color,
        border: `1px solid ${color}55`,
        background: `${color}11`,
        borderRadius: 'var(--radius)',
        padding: '2px 6px',
      }}
    >
      <Server size={10} />
      {provider}
    </span>
  )
}

function ClassificationPill({ level }: { level: string }) {
  const c = CLASSIFICATION_COLORS[level?.toUpperCase()] || CLASSIFICATION_COLORS.UNCLASSIFIED
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: 1,
        color: c,
        border: `1px solid ${c}66`,
        background: `${c}11`,
        borderRadius: 'var(--radius)',
        padding: '2px 6px',
      }}
    >
      {level?.toUpperCase() || 'UNCLASSIFIED'}
    </span>
  )
}

function StatusPill({ status }: { status: Tunnel['status'] }) {
  const c =
    status === 'active'
      ? '#40c057'
      : status === 'pending'
      ? '#fab005'
      : status === 'error'
      ? '#ff6b6b'
      : status === 'closing'
      ? '#fd7e14'
      : '#5c6b7f'
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: 0.5,
        color: c,
        border: `1px solid ${c}66`,
        background: `${c}11`,
        borderRadius: 'var(--radius)',
        padding: '2px 6px',
        textTransform: 'uppercase',
      }}
    >
      {status}
    </span>
  )
}

export default function TunnelDetailDrawer({
  session,
  tunnel,
  outgoingTunnels = [],
  onClose,
  onSelectTunnel,
  demoMode = false,
}: DrawerProps) {
  const liveSamples = useTopologyStore((s) => (tunnel ? s.getThroughput(tunnel.id) : []))
  const throughputQuery = useTunnelThroughput(tunnel?.id ?? null)
  const deleteTunnel = useDeleteTunnel()

  const sparkData = useMemo(() => {
    // Prefer live socket samples; fallback to backend telemetry points.
    if (liveSamples && liveSamples.length > 1) {
      return liveSamples.map((p) => ({
        ts: p.t,
        in: p.bytes_in,
        out: p.bytes_out,
      }))
    }
    const pts = throughputQuery.data?.points ?? []
    return pts.map((p) => ({
      ts: Date.parse(p.timestamp) || 0,
      in: p.bytes_in,
      out: p.bytes_out,
    }))
  }, [liveSamples, throughputQuery.data])

  const lastIn = sparkData[sparkData.length - 1]?.in ?? 0
  const lastOut = sparkData[sparkData.length - 1]?.out ?? 0

  if (!session && !tunnel) return null

  return (
    <aside
      style={{
        width: 360,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg-elevated)',
        borderLeft: '1px solid var(--color-border)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderBottom: '1px solid var(--color-border)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: 1,
            color: 'var(--color-text-bright)',
          }}
        >
          {session ? 'IMPLANT DETAIL' : 'TUNNEL DETAIL'}
        </span>
        <button
          className="modal-close"
          onClick={onClose}
          aria-label="Close detail drawer"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)' }}
        >
          <X size={16} />
        </button>
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {session && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 10,
                flexWrap: 'wrap',
              }}
            >
              <ProviderPill provider={session.provider} />
              <ClassificationPill level={session.classification} />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: 0.5,
                  color: session.is_alive ? '#40c057' : '#5c6b7f',
                }}
              >
                <Activity size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                {session.is_alive ? 'ALIVE' : 'OFFLINE'}
              </span>
            </div>

            <Row label="Implant">{session.implant_name}</Row>
            <Row label="Hostname">{session.hostname}</Row>
            <Row label="OS">{session.os}</Row>
            <Row label="Remote Address">{session.remote_addr}</Row>
            {session.username && (
              <Row label="User">
                <User size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                {session.username}
              </Row>
            )}
            {session.pid !== undefined && (
              <Row label="PID">
                <Cpu size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                {session.pid}
              </Row>
            )}
            <Row label="Transport">{session.transport}</Row>
            <Row label="Last Check-in">{timeAgo(session.last_checkin)}</Row>

            <div
              style={{
                marginTop: 12,
                paddingTop: 10,
                borderTop: '1px solid var(--color-border)',
              }}
            >
              <span style={{ ...labelStyle, display: 'block', marginBottom: 6 }}>
                OUTGOING TUNNELS ({outgoingTunnels.length})
              </span>
              {outgoingTunnels.length === 0 ? (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--color-text-muted)',
                  }}
                >
                  None
                </span>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {outgoingTunnels.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => onSelectTunnel?.(t.id)}
                      style={{
                        textAlign: 'left',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        background: 'var(--color-bg-surface)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius)',
                        padding: '6px 10px',
                        cursor: 'pointer',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--color-text)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = TUNNEL_TYPE_COLORS[t.tunnel_type]
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = 'var(--color-border)'
                      }}
                    >
                      <span
                        style={{
                          color: TUNNEL_TYPE_COLORS[t.tunnel_type],
                          fontSize: 9,
                          letterSpacing: 0.5,
                          textTransform: 'uppercase',
                        }}
                      >
                        {t.tunnel_type.replace('_', ' ')}
                      </span>
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {tunnelEdgeLabel(t)}
                      </span>
                      <ArrowRight size={11} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {tunnel && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 10,
                flexWrap: 'wrap',
              }}
            >
              <ProviderPill provider={tunnel.provider} />
              <StatusPill status={tunnel.status} />
              <ClassificationPill level={tunnel.classification} />
            </div>

            <Row label="Type">{TUNNEL_TYPE_LABELS[tunnel.tunnel_type]}</Row>
            {tunnel.src_implant_name && <Row label="Source Implant">{tunnel.src_implant_name}</Row>}
            <Row label="Source Session">{tunnel.src_session_id}</Row>
            {tunnel.listen_host && tunnel.listen_port !== undefined && (
              <Row label="Listen">
                {tunnel.listen_host}:{tunnel.listen_port}
              </Row>
            )}
            {!tunnel.listen_host && tunnel.listen_port !== undefined && (
              <Row label="Listen Port">:{tunnel.listen_port}</Row>
            )}
            {tunnel.dst_host && tunnel.dst_port !== undefined && (
              <Row label="Destination">
                {tunnel.dst_host}:{tunnel.dst_port}
              </Row>
            )}
            {tunnel.parent_tunnel_id && <Row label="Parent Tunnel">{tunnel.parent_tunnel_id}</Row>}
            <Row label="Created By">{tunnel.created_by}</Row>
            <Row label="Created">{timeAgo(tunnel.created_at)}</Row>

            {tunnel.error_message && (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 10px',
                  border: '1px solid #ff6b6b66',
                  background: '#ff6b6b11',
                  borderRadius: 'var(--radius)',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  color: '#ff6b6b',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                }}
              >
                <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} />
                <span>{tunnel.error_message}</span>
              </div>
            )}

            {/* Sparkline */}
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 6,
                }}
              >
                <span style={labelStyle}>THROUGHPUT</span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--color-text-muted)',
                  }}
                >
                  ↓ {formatBytes(lastIn)} · ↑ {formatBytes(lastOut)}
                </span>
              </div>
              <div style={{ width: '100%', height: 80 }}>
                {sparkData.length === 0 ? (
                  <div
                    style={{
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    Awaiting telemetry…
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sparkData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <XAxis dataKey="ts" hide />
                      <YAxis hide />
                      <Tooltip
                        formatter={(v: number) => formatBytes(v)}
                        labelFormatter={(v) => new Date(v as number).toLocaleTimeString()}
                        contentStyle={{
                          background: '#0a0e14',
                          border: '1px solid #1e2a3a',
                          fontSize: 11,
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey="in"
                        stroke="#4dabf7"
                        strokeWidth={1.5}
                        dot={false}
                        isAnimationActive={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="out"
                        stroke="#fd7e14"
                        strokeWidth={1.5}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <button
              onClick={() => {
                if (demoMode) return
                deleteTunnel.mutate(
                  { id: tunnel.id, operationId: tunnel.operation_id ?? undefined },
                  {
                    onSuccess: onClose,
                  }
                )
              }}
              disabled={demoMode || deleteTunnel.isPending || tunnel.status === 'closed'}
              title={demoMode ? 'Disabled in Demo Mode' : undefined}
              style={{
                marginTop: 14,
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '8px 10px',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: 0.5,
                color: '#ff6b6b',
                background: 'transparent',
                border: '1px solid #ff6b6b66',
                borderRadius: 'var(--radius)',
                cursor: demoMode || deleteTunnel.isPending ? 'not-allowed' : 'pointer',
                opacity: demoMode ? 0.5 : 1,
              }}
            >
              <Trash2 size={12} />
              {demoMode ? 'DEMO — DISABLED' : deleteTunnel.isPending ? 'CLOSING…' : 'CLOSE TUNNEL'}
            </button>
          </>
        )}
      </div>
    </aside>
  )
}
