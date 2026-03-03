import { useEffect } from 'react'
import { Activity, ArrowUpRight, ArrowDownLeft, AlertCircle, Clock, Workflow, ShieldCheck } from 'lucide-react'
import { useCTIStore } from '../../stores/ctiStore'
import { useEnclaveStore } from '../../stores/enclaveStore'
import type { WidgetProps } from './WidgetRegistry'

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never'
  try {
    const date = new Date(iso)
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return 'Unknown'
  }
}

export default function CTIHealthWidget(_props: WidgetProps) {
  const {
    connected,
    degraded,
    lastCheck,
    pendingTransfers,
    authSyncStatus,
    transferStats,
    startPolling,
    nifiStatus,
    nifiFlows,
    fetchNiFiStatus,
  } = useCTIStore()
  const { enclave } = useEnclaveStore()

  useEffect(() => {
    if (!enclave) return
    const stopPolling = startPolling()
    return stopPolling
  }, [enclave, startPolling])

  // Also poll NiFi status
  useEffect(() => {
    if (!enclave) return
    fetchNiFiStatus()
    const interval = setInterval(fetchNiFiStatus, 30000)
    return () => clearInterval(interval)
  }, [enclave, fetchNiFiStatus])

  if (!enclave) {
    return (
      <div className="cti-health-widget">
        <div className="cti-health-placeholder">
          <Activity size={24} className="cti-health-placeholder-icon" />
          <p>CTI monitoring is only available in dual-enclave mode.</p>
          <p className="cti-health-hint">Set VITE_ENCLAVE=low or VITE_ENCLAVE=high to enable.</p>
        </div>
      </div>
    )
  }

  const statusColor = connected ? 'var(--color-success)' : 'var(--color-danger)'
  const statusLabel = connected ? 'CONNECTED' : 'DISCONNECTED'
  const statusBg = connected
    ? 'rgba(64, 192, 87, 0.1)'
    : 'rgba(255, 107, 107, 0.1)'

  const nifiColor = nifiStatus === 'online'
    ? 'var(--color-success)'
    : nifiStatus === 'offline'
      ? 'var(--color-danger)'
      : 'var(--color-text-muted)'

  const activeFlows = nifiFlows.filter((f) => f.status === 'running').length
  const recentTransferCount = transferStats.sent24h + transferStats.received24h

  return (
    <div className="cti-health-widget">
      {/* Primary status indicator */}
      <div className="cti-health-status" style={{ background: statusBg, borderColor: statusColor }}>
        <div
          className={`cti-health-dot ${connected ? '' : 'cti-health-dot-pulse'}`}
          style={{ background: statusColor }}
        />
        <span className="cti-health-status-label" style={{ color: statusColor }}>
          {statusLabel}
        </span>
        {degraded && (
          <span className="cti-health-degraded-tag">DEGRADED</span>
        )}
      </div>

      {/* Stats grid */}
      <div className="cti-health-grid">
        <div className="cti-health-stat">
          <Clock size={12} className="cti-health-stat-icon" />
          <span className="cti-health-stat-label">Last Check</span>
          <span className="cti-health-stat-value">{formatTimestamp(lastCheck)}</span>
        </div>

        <div className="cti-health-stat">
          <AlertCircle size={12} className="cti-health-stat-icon" />
          <span className="cti-health-stat-label">Pending</span>
          <span className="cti-health-stat-value">{pendingTransfers}</span>
        </div>

        <div className="cti-health-stat">
          <ArrowUpRight size={12} className="cti-health-stat-icon" />
          <span className="cti-health-stat-label">Sent (24h)</span>
          <span className="cti-health-stat-value">{transferStats.sent24h}</span>
        </div>

        <div className="cti-health-stat">
          <ArrowDownLeft size={12} className="cti-health-stat-icon" />
          <span className="cti-health-stat-label">Recv (24h)</span>
          <span className="cti-health-stat-value">{transferStats.received24h}</span>
        </div>
      </div>

      {/* NiFi status section */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: 0.5,
          color: 'var(--color-text-muted)',
        }}>
          <Workflow size={10} />
          NIFI STATUS
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: nifiColor,
              flexShrink: 0,
            }} />
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 600,
              color: nifiColor,
              letterSpacing: 1,
            }}>
              {nifiStatus === 'online' ? 'ONLINE' : nifiStatus === 'offline' ? 'OFFLINE' : 'UNKNOWN'}
            </span>
          </div>
          <span style={{ width: 1, height: 14, background: 'var(--color-border)' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            <Activity size={10} style={{ color: 'var(--color-text-muted)' }} />
            <span style={{ color: 'var(--color-text-muted)' }}>Flows:</span>
            <span style={{ color: 'var(--color-text-bright)', fontWeight: 600 }}>{activeFlows}</span>
            <span style={{ color: 'var(--color-text-muted)' }}>/ {nifiFlows.length}</span>
          </div>
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ShieldCheck size={10} style={{ color: 'var(--color-text-muted)' }} />
            <span style={{ color: 'var(--color-text-muted)' }}>Approvals:</span>
            <span style={{
              color: pendingTransfers > 0 ? 'var(--color-warning)' : 'var(--color-text-bright)',
              fontWeight: 600,
            }}>
              {pendingTransfers}
            </span>
          </div>
          <span style={{ width: 1, height: 14, background: 'var(--color-border)' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <ArrowUpRight size={10} style={{ color: 'var(--color-text-muted)' }} />
            <span style={{ color: 'var(--color-text-muted)' }}>Transfers (24h):</span>
            <span style={{ color: 'var(--color-text-bright)', fontWeight: 600 }}>{recentTransferCount}</span>
          </div>
        </div>
      </div>

      {/* Auth sync status */}
      <div className="cti-health-footer">
        <span className="cti-health-footer-label">Auth Sync:</span>
        <span className={`cti-health-footer-value ${authSyncStatus === 'synced' ? 'cti-health-synced' : ''}`}>
          {authSyncStatus.toUpperCase()}
        </span>
        {transferStats.failed24h > 0 && (
          <>
            <span className="cti-health-footer-sep">|</span>
            <span className="cti-health-footer-label">Failed (24h):</span>
            <span className="cti-health-footer-value cti-health-failed">{transferStats.failed24h}</span>
          </>
        )}
      </div>
    </div>
  )
}
