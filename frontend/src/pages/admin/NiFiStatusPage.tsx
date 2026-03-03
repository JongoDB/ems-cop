import { useState, useEffect, useCallback } from 'react'
import {
  Activity, Play, Square, RefreshCw, AlertCircle,
  Cpu, HardDrive, Layers, Zap, Clock,
} from 'lucide-react'
import { useCTIStore, type NiFiFlow } from '../../stores/ctiStore'
import { useEnclaveStore } from '../../stores/enclaveStore'

function formatBytes(bytes?: number): string {
  if (!bytes && bytes !== 0) return '--'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

const FLOW_STATUS_CONFIG: Record<string, {
  color: string
  bg: string
  label: string
}> = {
  running: { color: 'var(--color-success)', bg: 'rgba(64, 192, 87, 0.1)', label: 'RUNNING' },
  stopped: { color: 'var(--color-text-muted)', bg: 'rgba(108, 117, 125, 0.1)', label: 'STOPPED' },
  error: { color: 'var(--color-danger)', bg: 'rgba(255, 107, 107, 0.1)', label: 'ERROR' },
  disabled: { color: 'var(--color-warning)', bg: 'rgba(250, 176, 5, 0.1)', label: 'DISABLED' },
}

function FlowStatusIndicator({ status }: { status: string }) {
  const config = FLOW_STATUS_CONFIG[status] || FLOW_STATUS_CONFIG.stopped
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 8px',
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      letterSpacing: 1,
      border: '1px solid',
      borderColor: config.color,
      color: config.color,
      borderRadius: 2,
      background: config.bg,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: config.color,
        flexShrink: 0,
      }} />
      {config.label}
    </span>
  )
}

export default function NiFiStatusPage() {
  const { enclave } = useEnclaveStore()
  const {
    nifiStatus,
    nifiFlows,
    nifiSystem,
    fetchNiFiStatus,
    startNiFiFlow,
    stopNiFiFlow,
  } = useCTIStore()

  const [selectedFlow, setSelectedFlow] = useState<NiFiFlow | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const loadStatus = useCallback(() => {
    fetchNiFiStatus()
  }, [fetchNiFiStatus])

  // Initial load
  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  // Auto-refresh every 10s
  useEffect(() => {
    const interval = setInterval(loadStatus, 10000)
    return () => clearInterval(interval)
  }, [loadStatus])

  // Update selected flow when nifiFlows change
  useEffect(() => {
    if (selectedFlow) {
      const updated = nifiFlows.find((f) => f.id === selectedFlow.id)
      if (updated) setSelectedFlow(updated)
    }
  }, [nifiFlows, selectedFlow])

  const handleStartFlow = async (flowId: string) => {
    setActionLoading(flowId)
    try {
      await startNiFiFlow(flowId)
    } catch {
      // handled by store
    } finally {
      setActionLoading(null)
    }
  }

  const handleStopFlow = async (flowId: string) => {
    setActionLoading(flowId)
    try {
      await stopNiFiFlow(flowId)
    } catch {
      // handled by store
    } finally {
      setActionLoading(null)
    }
  }

  const systemOnline = nifiStatus === 'online'
  const systemColor = systemOnline ? 'var(--color-success)' : nifiStatus === 'offline' ? 'var(--color-danger)' : 'var(--color-text-muted)'
  const systemBg = systemOnline ? 'rgba(64, 192, 87, 0.08)' : nifiStatus === 'offline' ? 'rgba(255, 107, 107, 0.08)' : 'rgba(108, 117, 125, 0.08)'

  const runningFlows = nifiFlows.filter((f) => f.status === 'running').length
  const errorFlows = nifiFlows.filter((f) => f.status === 'error').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 16, padding: '16px 0' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Activity size={18} style={{ color: 'var(--color-accent)' }} />
          <h1 style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: 2,
            color: 'var(--color-text-bright)',
            margin: 0,
          }}>
            NIFI FLOW MANAGEMENT
          </h1>
          {enclave && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono font-semibold tracking-wider border rounded"
              style={{
                borderColor: enclave === 'high' ? 'var(--color-danger)' : 'var(--color-success)',
                color: enclave === 'high' ? 'var(--color-danger)' : 'var(--color-success)',
              }}
            >
              {enclave.toUpperCase()} SIDE
            </span>
          )}
        </div>
        <button onClick={loadStatus} className="page-btn" title="Refresh" style={{ width: 32, height: 32 }}>
          <RefreshCw size={14} />
        </button>
      </div>

      {/* System diagnostics bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '14px 18px',
        background: systemBg,
        border: `1px solid ${systemColor}`,
        borderRadius: 'var(--radius)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: systemColor,
            flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 2,
            color: systemColor,
          }}>
            {nifiStatus === 'online' ? 'ONLINE' : nifiStatus === 'offline' ? 'OFFLINE' : 'UNKNOWN'}
          </span>
        </div>

        <span style={{ width: 1, height: 24, background: 'var(--color-border)' }} />

        {nifiSystem && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Cpu size={12} style={{ color: 'var(--color-text-muted)' }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>Threads:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-bright)' }}>
                {nifiSystem.active_threads ?? '--'}/{nifiSystem.total_threads ?? '--'}
              </span>
            </div>

            <span style={{ width: 1, height: 24, background: 'var(--color-border)' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <HardDrive size={12} style={{ color: 'var(--color-text-muted)' }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>Heap:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-bright)' }}>
                {nifiSystem.heap_used_mb ?? '--'}/{nifiSystem.heap_max_mb ?? '--'}MB
              </span>
            </div>

            <span style={{ width: 1, height: 24, background: 'var(--color-border)' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Layers size={12} style={{ color: 'var(--color-text-muted)' }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>FlowFiles:</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-bright)' }}>
                {nifiSystem.flow_file_count ?? '--'}
              </span>
            </div>

            {nifiSystem.uptime && (
              <>
                <span style={{ width: 1, height: 24, background: 'var(--color-border)' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Clock size={12} style={{ color: 'var(--color-text-muted)' }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>Uptime:</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--color-text-bright)' }}>
                    {nifiSystem.uptime}
                  </span>
                </div>
              </>
            )}
          </>
        )}

        {/* Summary counts */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--color-success)',
          }}>
            {runningFlows} running
          </span>
          {errorFlows > 0 && (
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--color-danger)',
            }}>
              {errorFlows} error
            </span>
          )}
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--color-text-muted)',
          }}>
            {nifiFlows.length} total
          </span>
        </div>
      </div>

      {/* Content: Flows table + selected flow stats */}
      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        {/* Flows table */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="tickets-table-wrap" style={{ flex: 1, overflow: 'auto' }}>
            <table className="tickets-table">
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>TYPE</th>
                  <th>STATUS</th>
                  <th>THREADS</th>
                  <th style={{ textAlign: 'right' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {nifiFlows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="table-empty">
                      {nifiStatus === 'unknown' ? 'Connecting to NiFi...' : 'No flows configured'}
                    </td>
                  </tr>
                ) : (
                  nifiFlows.map((flow) => (
                    <tr
                      key={flow.id}
                      onClick={() => setSelectedFlow(flow)}
                      className="ticket-row"
                      style={selectedFlow?.id === flow.id ? { background: 'var(--color-bg-hover)' } : undefined}
                    >
                      <td>
                        <span style={{ color: 'var(--color-text-bright)', fontWeight: 500 }}>
                          {flow.name}
                        </span>
                      </td>
                      <td>
                        <span style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          letterSpacing: 0.5,
                          color: 'var(--color-text-muted)',
                        }}>
                          {flow.type?.toUpperCase() || '--'}
                        </span>
                      </td>
                      <td>
                        <FlowStatusIndicator status={flow.status} />
                      </td>
                      <td>
                        <span className="mono-cell">{flow.active_threads ?? '--'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {flow.status === 'running' ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleStopFlow(flow.id); }}
                            disabled={actionLoading === flow.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '4px 10px',
                              background: 'rgba(255, 107, 107, 0.1)',
                              border: '1px solid var(--color-danger)',
                              borderRadius: 'var(--radius)',
                              color: 'var(--color-danger)',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              cursor: actionLoading === flow.id ? 'wait' : 'pointer',
                              opacity: actionLoading === flow.id ? 0.5 : 1,
                            }}
                          >
                            <Square size={10} />
                            STOP
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleStartFlow(flow.id); }}
                            disabled={actionLoading === flow.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '4px 10px',
                              background: 'rgba(64, 192, 87, 0.1)',
                              border: '1px solid var(--color-success)',
                              borderRadius: 'var(--radius)',
                              color: 'var(--color-success)',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              cursor: actionLoading === flow.id ? 'wait' : 'pointer',
                              opacity: actionLoading === flow.id ? 0.5 : 1,
                            }}
                          >
                            <Play size={10} />
                            START
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Selected flow statistics */}
        {selectedFlow && (
          <div style={{
            width: 320,
            flexShrink: 0,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderTop: '2px solid var(--color-accent)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            overflow: 'auto',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: 1,
                color: 'var(--color-text-muted)',
              }}>
                FLOW STATISTICS
              </span>
              <FlowStatusIndicator status={selectedFlow.status} />
            </div>

            <h3 style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--color-text-bright)',
              margin: 0,
            }}>
              {selectedFlow.name}
            </h3>

            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
            }}>
              <StatCard
                icon={<Zap size={12} />}
                label="FlowFiles In"
                value={String(selectedFlow.flow_files_in ?? '--')}
              />
              <StatCard
                icon={<Zap size={12} />}
                label="FlowFiles Out"
                value={String(selectedFlow.flow_files_out ?? '--')}
              />
              <StatCard
                icon={<Layers size={12} />}
                label="Queued"
                value={String(selectedFlow.flow_files_queued ?? '--')}
                highlight={selectedFlow.flow_files_queued && selectedFlow.flow_files_queued > 10}
              />
              <StatCard
                icon={<Cpu size={12} />}
                label="Active Threads"
                value={String(selectedFlow.active_threads ?? '--')}
              />
              <StatCard
                icon={<HardDrive size={12} />}
                label="Bytes In"
                value={formatBytes(selectedFlow.bytes_in)}
              />
              <StatCard
                icon={<HardDrive size={12} />}
                label="Bytes Out"
                value={formatBytes(selectedFlow.bytes_out)}
              />
            </div>

            {/* Type info */}
            <div style={{
              padding: '8px 10px',
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
            }}>
              <span style={{ color: 'var(--color-text-muted)' }}>Type:</span>
              <span style={{ color: 'var(--color-text)', fontWeight: 600 }}>
                {selectedFlow.type?.toUpperCase() || '--'}
              </span>
            </div>

            {/* Error indicator */}
            {selectedFlow.status === 'error' && (
              <div style={{
                padding: '10px 12px',
                background: 'rgba(255, 107, 107, 0.05)',
                border: '1px solid rgba(255, 107, 107, 0.3)',
                borderRadius: 'var(--radius)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}>
                <AlertCircle size={14} style={{ color: 'var(--color-danger)', flexShrink: 0 }} />
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-danger)',
                }}>
                  Flow is in error state. Check NiFi UI for details.
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  highlight,
}: {
  icon: React.ReactNode
  label: string
  value: string
  highlight?: boolean | number
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      padding: '8px 10px',
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius)',
    }}>
      <div style={{ color: 'var(--color-text-muted)', marginBottom: 2 }}>{icon}</div>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: 1,
        color: 'var(--color-text-muted)',
        textTransform: 'uppercase',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        fontWeight: 600,
        color: highlight ? 'var(--color-warning)' : 'var(--color-text-bright)',
      }}>
        {value}
      </span>
    </div>
  )
}
