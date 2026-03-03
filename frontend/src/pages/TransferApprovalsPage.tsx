import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import {
  ShieldCheck, Check, X, RefreshCw, ArrowRightLeft,
  Clock, ChevronLeft, ChevronRight, AlertTriangle,
} from 'lucide-react'
import { useEnclaveStore } from '../stores/enclaveStore'
import { useCTIStore, type TransferApproval } from '../stores/ctiStore'
import ClassificationBadge from '../components/ClassificationBadge'

const STATUS_TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: '', label: 'All' },
] as const

const STATUS_COLORS: Record<string, { border: string; color: string }> = {
  pending: { border: 'var(--color-warning)', color: 'var(--color-warning)' },
  approved: { border: 'var(--color-success)', color: 'var(--color-success)' },
  rejected: { border: 'var(--color-danger)', color: 'var(--color-danger)' },
}

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

function truncateId(id: string): string {
  if (!id) return '--'
  return id.length > 8 ? id.slice(0, 8) + '...' : id
}

function DirectionBadge({ direction }: { direction: string }) {
  const isUpward = direction.includes('low') && direction.includes('high')
    ? direction.indexOf('low') < direction.indexOf('high')
    : direction.startsWith('low')

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold tracking-wider border rounded"
      style={{
        borderColor: isUpward ? 'var(--color-info)' : 'var(--color-warning)',
        color: isUpward ? 'var(--color-info)' : 'var(--color-warning)',
      }}
    >
      <ArrowRightLeft size={10} />
      {direction.toUpperCase().replace('->', ' -> ').replace('_', ' ')}
    </span>
  )
}

export default function TransferApprovalsPage() {
  const { enclave, isHighSide } = useEnclaveStore()
  const {
    approvals,
    approvalsLoading,
    fetchApprovals,
    approveTransfer,
    rejectTransfer,
  } = useCTIStore()

  const [activeTab, setActiveTab] = useState<string>('pending')
  const [selectedApproval, setSelectedApproval] = useState<TransferApproval | null>(null)
  const [showRejectForm, setShowRejectForm] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [page, setPage] = useState(1)
  const limit = 20

  // Redirect non-high-side users (single-enclave mode allows access)
  if (enclave === 'low') {
    return <Navigate to="/operations" replace />
  }

  const loadApprovals = useCallback(() => {
    fetchApprovals(activeTab || undefined)
  }, [fetchApprovals, activeTab])

  // Fetch approvals on mount and tab change
  useEffect(() => {
    loadApprovals()
  }, [loadApprovals])

  // Auto-refresh for pending tab
  useEffect(() => {
    if (activeTab !== 'pending') return
    const interval = setInterval(loadApprovals, 15000)
    return () => clearInterval(interval)
  }, [activeTab, loadApprovals])

  const handleApprove = async () => {
    if (!selectedApproval) return
    setActionLoading(true)
    try {
      await approveTransfer(selectedApproval.id)
      setSelectedApproval(null)
      setConfirmApprove(false)
    } catch {
      // error handled by store
    } finally {
      setActionLoading(false)
    }
  }

  const handleReject = async () => {
    if (!selectedApproval || !rejectReason.trim()) return
    setActionLoading(true)
    try {
      await rejectTransfer(selectedApproval.id, rejectReason.trim())
      setSelectedApproval(null)
      setShowRejectForm(false)
      setRejectReason('')
    } catch {
      // error handled by store
    } finally {
      setActionLoading(false)
    }
  }

  const selectApproval = (a: TransferApproval) => {
    setSelectedApproval(a)
    setShowRejectForm(false)
    setConfirmApprove(false)
    setRejectReason('')
  }

  const pendingCount = approvals.filter((a) => a.status === 'pending').length
  const paginatedApprovals = approvals.slice((page - 1) * limit, page * limit)
  const totalPages = Math.max(1, Math.ceil(approvals.length / limit))

  return (
    <>
      <div className="tickets-layout">
        {/* Toolbar */}
        <div className="tickets-toolbar">
          <div className="toolbar-left">
            <h1 className="page-title">TRANSFER APPROVALS</h1>
            {enclave && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-mono font-semibold tracking-wider border rounded"
                style={{
                  borderColor: isHighSide ? 'var(--color-danger)' : 'var(--color-success)',
                  color: isHighSide ? 'var(--color-danger)' : 'var(--color-success)',
                }}
              >
                {enclave.toUpperCase()} SIDE
              </span>
            )}
          </div>
          <div className="toolbar-right">
            <button onClick={loadApprovals} className="page-btn" title="Refresh" style={{ width: 32, height: 32 }}>
              <RefreshCw size={14} className={approvalsLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-bg-primary)',
        }}>
          {STATUS_TABS.map(({ key, label }) => {
            const active = activeTab === key
            const count = key === 'pending' ? pendingCount : key ? approvals.filter((a) => a.status === key).length : approvals.length
            return (
              <button
                key={key}
                onClick={() => { setActiveTab(key); setPage(1); setSelectedApproval(null); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 16px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: 0.5,
                  color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  textDecoration: 'none',
                  borderBottom: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
                  cursor: 'pointer',
                  background: 'none',
                  border: 'none',
                  borderBottomWidth: 2,
                  borderBottomStyle: 'solid',
                  borderBottomColor: active ? 'var(--color-accent)' : 'transparent',
                }}
              >
                {label}
                {key === 'pending' && pendingCount > 0 && (
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 18,
                    height: 18,
                    padding: '0 5px',
                    borderRadius: 9,
                    background: 'var(--color-warning)',
                    color: '#0a0e14',
                    fontSize: 10,
                    fontWeight: 700,
                  }}>
                    {pendingCount}
                  </span>
                )}
                {key !== 'pending' && (
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>({count})</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Table */}
        <div className="tickets-table-wrap">
          <table className="tickets-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>ENTITY TYPE</th>
                <th>CLASSIFICATION</th>
                <th>DIRECTION</th>
                <th>REQUESTED BY</th>
                <th>REQUESTED AT</th>
                <th>STATUS</th>
              </tr>
            </thead>
            <tbody>
              {approvalsLoading ? (
                <tr><td colSpan={7} className="table-empty">Loading...</td></tr>
              ) : paginatedApprovals.length === 0 ? (
                <tr><td colSpan={7} className="table-empty">No transfer requests found</td></tr>
              ) : (
                paginatedApprovals.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => selectApproval(a)}
                    className="ticket-row"
                    style={selectedApproval?.id === a.id ? { background: 'var(--color-bg-hover)' } : undefined}
                  >
                    <td className="mono-cell" title={a.id}>{truncateId(a.id)}</td>
                    <td>
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        letterSpacing: 0.5,
                        color: 'var(--color-text-bright)',
                      }}>
                        {a.entity_type.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <ClassificationBadge classification={a.classification} size="sm" />
                    </td>
                    <td>
                      <DirectionBadge direction={a.direction} />
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{a.requested_by}</td>
                    <td className="mono-cell">
                      <span title={new Date(a.requested_at).toLocaleString()}>
                        {formatRelativeTime(a.requested_at)}
                      </span>
                    </td>
                    <td>
                      <span
                        className="status-badge"
                        style={{
                          borderColor: STATUS_COLORS[a.status]?.border || 'var(--color-muted)',
                          color: STATUS_COLORS[a.status]?.color || 'var(--color-text-muted)',
                        }}
                      >
                        {a.status.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="pagination">
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

      {/* Detail Panel */}
      {selectedApproval && (
        <div className="side-panel">
          <button
            className="panel-close"
            onClick={() => { setSelectedApproval(null); setShowRejectForm(false); setConfirmApprove(false); }}
          >
            <X size={16} />
          </button>

          <div className="panel-content">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <ShieldCheck size={16} style={{ color: 'var(--color-accent)' }} />
              <span className="mono-cell" style={{ fontSize: 11 }}>TRANSFER REQUEST</span>
            </div>

            <h2 className="panel-title" style={{ fontSize: 14 }}>
              {truncateId(selectedApproval.id)}
            </h2>

            <div className="detail-meta">
              <div className="meta-row">
                <span className="meta-label">TRANSFER ID</span>
                <span className="mono-cell" style={{ fontSize: 10, wordBreak: 'break-all' }}>{selectedApproval.id}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">ENTITY TYPE</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-bright)' }}>
                  {selectedApproval.entity_type.toUpperCase()}
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-label">CLASSIFICATION</span>
                <ClassificationBadge classification={selectedApproval.classification} size="md" />
              </div>
              <div className="meta-row">
                <span className="meta-label">DIRECTION</span>
                <DirectionBadge direction={selectedApproval.direction} />
              </div>
              <div className="meta-row">
                <span className="meta-label">STATUS</span>
                <span
                  className="status-badge"
                  style={{
                    borderColor: STATUS_COLORS[selectedApproval.status]?.border || 'var(--color-muted)',
                    color: STATUS_COLORS[selectedApproval.status]?.color || 'var(--color-text-muted)',
                  }}
                >
                  {selectedApproval.status.toUpperCase()}
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-label">REQUESTED BY</span>
                <span>{selectedApproval.requested_by}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">REQUESTED AT</span>
                <span className="mono-cell">{new Date(selectedApproval.requested_at).toLocaleString()}</span>
              </div>
              {selectedApproval.reviewed_by && (
                <>
                  <div className="meta-row">
                    <span className="meta-label">REVIEWED BY</span>
                    <span>{selectedApproval.reviewed_by}</span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">REVIEWED AT</span>
                    <span className="mono-cell">
                      {selectedApproval.reviewed_at ? new Date(selectedApproval.reviewed_at).toLocaleString() : '--'}
                    </span>
                  </div>
                </>
              )}
            </div>

            {/* Entity IDs */}
            {selectedApproval.entity_ids && selectedApproval.entity_ids.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
                <h3 className="detail-section-title">ENTITY IDS ({selectedApproval.entity_ids.length})</h3>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  maxHeight: 120,
                  overflowY: 'auto',
                  padding: '8px 10px',
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                }}>
                  {selectedApproval.entity_ids.map((eid, i) => (
                    <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>
                      {eid}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Policy */}
            {selectedApproval.policy && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
                <h3 className="detail-section-title">TRANSFER POLICY</h3>
                <div style={{
                  padding: '10px 12px',
                  background: 'rgba(250, 176, 5, 0.05)',
                  border: '1px solid rgba(250, 176, 5, 0.2)',
                  borderRadius: 'var(--radius)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-warning)',
                  lineHeight: 1.6,
                }}>
                  <AlertTriangle size={12} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 6 }} />
                  {selectedApproval.policy}
                </div>
              </div>
            )}

            {/* Rejection reason (if rejected) */}
            {selectedApproval.status === 'rejected' && selectedApproval.rejection_reason && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
                <h3 className="detail-section-title">REJECTION REASON</h3>
                <div style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 107, 107, 0.05)',
                  border: '1px solid rgba(255, 107, 107, 0.2)',
                  borderRadius: 'var(--radius)',
                  fontSize: 12,
                  color: 'var(--color-danger)',
                  lineHeight: 1.6,
                }}>
                  {selectedApproval.rejection_reason}
                </div>
              </div>
            )}

            {/* Action buttons (only for pending) */}
            {selectedApproval.status === 'pending' && (
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
                {!confirmApprove && !showRejectForm && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => setConfirmApprove(true)}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        padding: '10px 16px',
                        background: 'rgba(64, 192, 87, 0.15)',
                        border: '1px solid var(--color-success)',
                        borderRadius: 'var(--radius)',
                        color: 'var(--color-success)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: 1,
                        cursor: 'pointer',
                      }}
                    >
                      <Check size={14} />
                      APPROVE
                    </button>
                    <button
                      onClick={() => setShowRejectForm(true)}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        padding: '10px 16px',
                        background: 'rgba(255, 107, 107, 0.1)',
                        border: '1px solid var(--color-danger)',
                        borderRadius: 'var(--radius)',
                        color: 'var(--color-danger)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: 1,
                        cursor: 'pointer',
                      }}
                    >
                      <X size={14} />
                      REJECT
                    </button>
                  </div>
                )}

                {/* Confirm approve */}
                {confirmApprove && (
                  <div style={{
                    padding: 12,
                    background: 'rgba(64, 192, 87, 0.05)',
                    border: '1px solid rgba(64, 192, 87, 0.3)',
                    borderRadius: 'var(--radius)',
                  }}>
                    <p style={{ fontSize: 12, marginBottom: 12, color: 'var(--color-text)' }}>
                      Are you sure you want to approve this transfer?
                    </p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={handleApprove}
                        disabled={actionLoading}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          background: 'var(--color-success)',
                          border: 'none',
                          borderRadius: 'var(--radius)',
                          color: '#0a0e14',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: actionLoading ? 'wait' : 'pointer',
                          opacity: actionLoading ? 0.6 : 1,
                        }}
                      >
                        {actionLoading ? 'APPROVING...' : 'CONFIRM APPROVE'}
                      </button>
                      <button
                        onClick={() => setConfirmApprove(false)}
                        style={{
                          padding: '8px 12px',
                          background: 'var(--color-bg-surface)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius)',
                          color: 'var(--color-text-muted)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        CANCEL
                      </button>
                    </div>
                  </div>
                )}

                {/* Reject form */}
                {showRejectForm && (
                  <div style={{
                    padding: 12,
                    background: 'rgba(255, 107, 107, 0.05)',
                    border: '1px solid rgba(255, 107, 107, 0.3)',
                    borderRadius: 'var(--radius)',
                  }}>
                    <label style={{
                      display: 'block',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      letterSpacing: 1,
                      color: 'var(--color-text-muted)',
                      marginBottom: 6,
                    }}>
                      REJECTION REASON
                    </label>
                    <textarea
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      className="form-input form-textarea"
                      placeholder="Provide a reason for rejection..."
                      rows={3}
                      style={{ marginBottom: 8 }}
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={handleReject}
                        disabled={actionLoading || !rejectReason.trim()}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          background: 'var(--color-danger)',
                          border: 'none',
                          borderRadius: 'var(--radius)',
                          color: '#fff',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: (actionLoading || !rejectReason.trim()) ? 'not-allowed' : 'pointer',
                          opacity: (actionLoading || !rejectReason.trim()) ? 0.6 : 1,
                        }}
                      >
                        {actionLoading ? 'REJECTING...' : 'CONFIRM REJECT'}
                      </button>
                      <button
                        onClick={() => { setShowRejectForm(false); setRejectReason(''); }}
                        style={{
                          padding: '8px 12px',
                          background: 'var(--color-bg-surface)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius)',
                          color: 'var(--color-text-muted)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        CANCEL
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Timestamps footer */}
            <div style={{
              marginTop: 16,
              paddingTop: 12,
              borderTop: '1px solid var(--color-border)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
            }}>
              <Clock size={10} />
              Requested {formatRelativeTime(selectedApproval.requested_at)}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
