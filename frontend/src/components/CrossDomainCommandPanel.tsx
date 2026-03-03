import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { useEnclaveStore } from '../stores/enclaveStore'
import {
  ArrowRightLeft, RefreshCw, Check, X,
  ChevronDown, ChevronUp,
  ChevronLeft, ChevronRight,
} from 'lucide-react'

// ════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════

interface CrossDomainCommand {
  id: string
  command: string
  session_id: string
  session_hostname?: string
  risk_level: number
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed'
  submitted_by: string
  submitted_at: string
  approved_by?: string
  approved_at?: string
  result?: string
  error?: string
}

interface CrossDomainCommandsResponse {
  data: CrossDomainCommand[]
  pagination: { page: number; limit: number; total: number }
}

// ════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════

const RISK_COLORS: Record<number, string> = {
  1: '#40c057',
  2: '#3b82f6',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
}

const STATUS_COLORS: Record<string, { border: string; color: string }> = {
  pending: { border: '#f59e0b', color: '#f59e0b' },
  approved: { border: '#3b82f6', color: '#3b82f6' },
  rejected: { border: '#ef4444', color: '#ef4444' },
  executing: { border: '#8b5cf6', color: '#8b5cf6' },
  completed: { border: '#40c057', color: '#40c057' },
  failed: { border: '#ef4444', color: '#ef4444' },
}

const STATUS_FILTER_OPTIONS = [
  { key: '', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'executing', label: 'Executing' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
] as const

// ════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════

function formatRelativeTime(iso: string): string {
  try {
    const date = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffSec = Math.floor(diffMs / 1000)
    if (diffSec < 60) return `${diffSec}s ago`
    const diffMin = Math.floor(diffSec / 60)
    if (diffMin < 60) return `${diffMin}m ago`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h ago`
    const diffDay = Math.floor(diffHr / 24)
    return `${diffDay}d ago`
  } catch {
    return 'Unknown'
  }
}

// ════════════════════════════════════════════
//  COMPONENT
// ════════════════════════════════════════════

export default function CrossDomainCommandPanel() {
  const { roles } = useAuth()
  const { enclave } = useEnclaveStore()
  const [commands, setCommands] = useState<CrossDomainCommand[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const isSupervisor = roles.includes('admin') || roles.includes('supervisor') || roles.includes('e2') || roles.includes('e1')
  const limit = 20

  const fetchCommands = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      if (statusFilter) params.set('status', statusFilter)

      const data = await apiFetch<CrossDomainCommandsResponse>(
        `/c2/cross-domain/commands?${params.toString()}`
      )
      setCommands(data.data || [])
      setTotal(data.pagination?.total ?? 0)
    } catch {
      setCommands([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter])

  useEffect(() => {
    fetchCommands()
  }, [fetchCommands])

  // Auto-refresh for pending commands
  useEffect(() => {
    if (statusFilter === 'pending' || statusFilter === '' || statusFilter === 'executing') {
      const interval = setInterval(fetchCommands, 15000)
      return () => clearInterval(interval)
    }
  }, [statusFilter, fetchCommands])

  const handleApprove = async (id: string) => {
    setActionLoading(id)
    try {
      await apiFetch(`/c2/cross-domain/commands/${id}/approve`, { method: 'POST' })
      fetchCommands()
    } catch {
      // error handled
    } finally {
      setActionLoading(null)
    }
  }

  const handleReject = async (id: string) => {
    setActionLoading(id)
    try {
      await apiFetch(`/c2/cross-domain/commands/${id}/reject`, { method: 'POST' })
      fetchCommands()
    } catch {
      // error handled
    } finally {
      setActionLoading(null)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit))

  // Not in dual-enclave or low side? Show placeholder
  if (enclave === 'low') {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 60,
        gap: 12,
      }}>
        <ArrowRightLeft size={32} style={{ color: 'var(--color-border-strong)' }} />
        <p style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--color-text-muted)',
          letterSpacing: 1,
          margin: 0,
        }}>
          Cross-domain commands are managed from the high side.
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <ArrowRightLeft size={14} style={{ color: 'var(--color-accent)' }} />
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: 1,
            color: 'var(--color-text-bright)',
          }}>
            CROSS-DOMAIN COMMANDS
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--color-text-muted)',
          }}>
            ({total})
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
            className="filter-select"
            style={{ fontSize: 10, padding: '4px 8px' }}
          >
            {STATUS_FILTER_OPTIONS.map(({ key, label }) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <button
            onClick={fetchCommands}
            style={{
              background: 'none',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              padding: '4px 6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>
      </div>

      {/* Commands List */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--color-text-muted)',
            letterSpacing: 1,
          }}>
            LOADING...
          </div>
        ) : commands.length === 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--color-text-muted)',
            letterSpacing: 1,
          }}>
            NO CROSS-DOMAIN COMMANDS
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {commands.map((cmd) => {
              const isExpanded = expandedId === cmd.id
              const statusStyle = STATUS_COLORS[cmd.status] || { border: '#6b7280', color: '#6b7280' }
              const riskColor = RISK_COLORS[cmd.risk_level] || '#6b7280'

              return (
                <div
                  key={cmd.id}
                  style={{
                    background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius)',
                    overflow: 'hidden',
                  }}
                >
                  {/* Row */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 12px',
                      cursor: 'pointer',
                    }}
                    onClick={() => setExpandedId(isExpanded ? null : cmd.id)}
                  >
                    {/* Command */}
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--color-text-bright)',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      $ {cmd.command}
                    </span>

                    {/* Session */}
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--color-text-muted)',
                      flexShrink: 0,
                    }}>
                      {cmd.session_hostname || cmd.session_id.slice(0, 8)}
                    </span>

                    {/* Risk Level */}
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '2px 6px',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9,
                        fontWeight: 600,
                        letterSpacing: 0.5,
                        border: `1px solid ${riskColor}`,
                        borderRadius: 'var(--radius)',
                        color: riskColor,
                        flexShrink: 0,
                      }}
                    >
                      RISK {cmd.risk_level}
                    </span>

                    {/* Status */}
                    <span
                      className="status-badge"
                      style={{
                        borderColor: statusStyle.border,
                        color: statusStyle.color,
                        flexShrink: 0,
                      }}
                    >
                      {cmd.status.toUpperCase()}
                    </span>

                    {/* Time */}
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      color: 'var(--color-text-muted)',
                      flexShrink: 0,
                    }}>
                      {formatRelativeTime(cmd.submitted_at)}
                    </span>

                    {/* Expand icon */}
                    {isExpanded ? (
                      <ChevronUp size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                    ) : (
                      <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                    )}
                  </div>

                  {/* Expanded Detail */}
                  {isExpanded && (
                    <div style={{
                      padding: '12px 12px 16px',
                      borderTop: '1px solid var(--color-border)',
                      background: 'var(--color-bg-primary)',
                    }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px 16px', marginBottom: 12 }}>
                        <DetailItem label="COMMAND" value={cmd.command} mono />
                        <DetailItem label="SESSION" value={cmd.session_hostname || cmd.session_id} mono />
                        <DetailItem label="SUBMITTED BY" value={cmd.submitted_by} />
                        <DetailItem label="SUBMITTED AT" value={new Date(cmd.submitted_at).toLocaleString()} mono />
                        {cmd.approved_by && (
                          <DetailItem label="APPROVED BY" value={cmd.approved_by} />
                        )}
                        {cmd.approved_at && (
                          <DetailItem label="APPROVED AT" value={new Date(cmd.approved_at).toLocaleString()} mono />
                        )}
                      </div>

                      {/* Result */}
                      {(cmd.result || cmd.error) && (
                        <div style={{ marginTop: 8 }}>
                          <div style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 9,
                            letterSpacing: 1,
                            color: cmd.error ? 'var(--color-danger)' : 'var(--color-text-muted)',
                            marginBottom: 4,
                          }}>
                            {cmd.error ? 'ERROR' : 'RESULT'}
                          </div>
                          <pre style={{
                            padding: '10px 12px',
                            background: cmd.error
                              ? 'rgba(255,107,107,0.05)'
                              : 'var(--color-bg-surface)',
                            border: `1px solid ${cmd.error
                              ? 'rgba(255,107,107,0.2)'
                              : 'var(--color-border)'}`,
                            borderRadius: 'var(--radius)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            color: cmd.error ? 'var(--color-danger)' : 'var(--color-text)',
                            overflow: 'auto',
                            maxHeight: 200,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            margin: 0,
                          }}>
                            {cmd.error || cmd.result}
                          </pre>
                        </div>
                      )}

                      {/* Approve/Reject buttons for pending, risk 3+ */}
                      {cmd.status === 'pending' && cmd.risk_level >= 3 && isSupervisor && (
                        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => handleApprove(cmd.id)}
                            disabled={actionLoading === cmd.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '8px 16px',
                              background: 'rgba(64,192,87,0.15)',
                              border: '1px solid var(--color-success)',
                              borderRadius: 'var(--radius)',
                              color: 'var(--color-success)',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              fontWeight: 600,
                              letterSpacing: 0.5,
                              cursor: actionLoading === cmd.id ? 'wait' : 'pointer',
                              opacity: actionLoading === cmd.id ? 0.6 : 1,
                            }}
                          >
                            <Check size={12} />
                            APPROVE
                          </button>
                          <button
                            onClick={() => handleReject(cmd.id)}
                            disabled={actionLoading === cmd.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '8px 16px',
                              background: 'rgba(255,107,107,0.1)',
                              border: '1px solid var(--color-danger)',
                              borderRadius: 'var(--radius)',
                              color: 'var(--color-danger)',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              fontWeight: 600,
                              letterSpacing: 0.5,
                              cursor: actionLoading === cmd.id ? 'wait' : 'pointer',
                              opacity: actionLoading === cmd.id ? 0.6 : 1,
                            }}
                          >
                            <X size={12} />
                            REJECT
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="pagination" style={{ padding: '8px 0' }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="page-btn">
            <ChevronLeft size={14} />
          </button>
          <span className="page-info">PAGE {page} OF {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="page-btn">
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

function DetailItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: 1,
        color: 'var(--color-text-muted)',
      }}>
        {label}
      </span>
      <span style={{
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
        fontSize: mono ? 10 : 12,
        color: 'var(--color-text-bright)',
        wordBreak: 'break-all',
      }}>
        {value}
      </span>
    </div>
  )
}
