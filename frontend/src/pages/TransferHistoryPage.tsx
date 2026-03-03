import { useState, useEffect, useCallback } from 'react'
import {
  History, RefreshCw, ChevronLeft, ChevronRight, X,
  ArrowRightLeft, Clock, Workflow, ChevronDown,
} from 'lucide-react'
import { useEnclaveStore } from '../stores/enclaveStore'
import { useCTIStore, type TransferRecord, type ProvenanceEvent } from '../stores/ctiStore'
import ClassificationBadge from '../components/ClassificationBadge'

const STATUS_COLORS: Record<string, { border: string; color: string }> = {
  completed: { border: 'var(--color-success)', color: 'var(--color-success)' },
  failed: { border: 'var(--color-danger)', color: 'var(--color-danger)' },
  pending: { border: 'var(--color-warning)', color: 'var(--color-warning)' },
  in_progress: { border: 'var(--color-info)', color: 'var(--color-info)' },
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return 'Unknown'
  }
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '--'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function formatDuration(ms?: number): string {
  if (!ms) return '--'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
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

const PROVENANCE_EVENT_COLORS: Record<string, string> = {
  RECEIVE: 'var(--color-info)',
  ROUTE: 'var(--color-accent)',
  SEND: 'var(--color-success)',
  TRANSFORM: 'var(--color-warning)',
  FILTER: 'var(--color-muted)',
  DROP: 'var(--color-danger)',
}

function ProvenanceTimeline({ events }: { events: ProvenanceEvent[] }) {
  if (events.length === 0) {
    return (
      <div style={{
        padding: 16,
        textAlign: 'center',
        color: 'var(--color-text-muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
      }}>
        No provenance data available
      </div>
    )
  }

  // Calculate total bytes and duration
  const totalBytes = events.reduce((sum, e) => sum + (e.bytes ?? 0), 0)
  const firstTs = events.length > 0 ? new Date(events[0].timestamp).getTime() : 0
  const lastTs = events.length > 0 ? new Date(events[events.length - 1].timestamp).getTime() : 0
  const totalDuration = lastTs - firstTs

  return (
    <div>
      {/* Summary chain */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '8px 10px',
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        marginBottom: 10,
        flexWrap: 'wrap',
      }}>
        {events.map((e, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              color: PROVENANCE_EVENT_COLORS[e.event_type] || 'var(--color-text-muted)',
            }}>
              {e.event_type}
            </span>
            {i < events.length - 1 && (
              <span style={{ color: 'var(--color-border-strong)', fontSize: 10 }}> &rarr; </span>
            )}
          </span>
        ))}
        <span style={{
          marginLeft: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--color-text-muted)',
        }}>
          ({events.length} steps, {formatBytes(totalBytes)}, {formatDuration(totalDuration)})
        </span>
      </div>

      {/* Detailed timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {events.map((e, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '6px 0',
              borderLeft: `2px solid ${PROVENANCE_EVENT_COLORS[e.event_type] || 'var(--color-border)'}`,
              paddingLeft: 12,
              marginLeft: 6,
            }}
          >
            {/* Dot on the timeline */}
            <div style={{
              position: 'relative',
              left: -19,
              top: 3,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: PROVENANCE_EVENT_COLORS[e.event_type] || 'var(--color-border)',
              flexShrink: 0,
            }} />
            <div style={{ flex: 1, marginLeft: -8 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text-muted)',
                }}>
                  {new Date(e.timestamp).toLocaleTimeString(undefined, {
                    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
                  } as Intl.DateTimeFormatOptions)}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  color: PROVENANCE_EVENT_COLORS[e.event_type] || 'var(--color-text)',
                }}>
                  {e.event_type}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text-bright)',
                }}>
                  {e.component}
                </span>
              </div>
              {e.details && (
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--color-text-muted)',
                  marginTop: 2,
                }}>
                  {e.details}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function TransferHistoryPage() {
  const { enclave } = useEnclaveStore()
  const {
    transfers,
    transfersLoading,
    fetchTransfers,
    fetchProvenance,
  } = useCTIStore()

  const [selectedTransfer, setSelectedTransfer] = useState<TransferRecord | null>(null)
  const [provenance, setProvenance] = useState<ProvenanceEvent[]>([])
  const [provenanceLoading, setProvenanceLoading] = useState(false)
  const [directionFilter, setDirectionFilter] = useState('')
  const [classFilter, setClassFilter] = useState('')
  const [dateRange, setDateRange] = useState<{ from: string; to: string }>({
    from: '',
    to: '',
  })
  const [sortField, setSortField] = useState('executed_at')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const limit = 20

  const loadTransfers = useCallback(() => {
    const params: Record<string, string> = {}
    if (directionFilter) params.direction = directionFilter
    if (classFilter) params.classification = classFilter
    if (dateRange.from) params.from = dateRange.from
    if (dateRange.to) params.to = dateRange.to
    params.sort = sortField
    params.order = sortOrder
    fetchTransfers(params)
  }, [fetchTransfers, directionFilter, classFilter, dateRange, sortField, sortOrder])

  useEffect(() => {
    loadTransfers()
  }, [loadTransfers])

  const handleSelectTransfer = async (t: TransferRecord) => {
    setSelectedTransfer(t)
    setProvenanceLoading(true)
    try {
      const events = await fetchProvenance(t.transfer_id || t.id)
      setProvenance(events)
    } catch {
      setProvenance([])
    } finally {
      setProvenanceLoading(false)
    }
  }

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortOrder('desc')
    }
    setPage(1)
  }

  const paginatedTransfers = transfers.slice((page - 1) * limit, page * limit)
  const totalPages = Math.max(1, Math.ceil(transfers.length / limit))

  const SortIcon = ({ field }: { field: string }) => (
    sortField === field ? (
      <ChevronDown size={10} style={{ transform: sortOrder === 'asc' ? 'rotate(180deg)' : undefined, transition: 'transform 150ms' }} />
    ) : null
  )

  return (
    <>
      <div className="tickets-layout">
        {/* Toolbar */}
        <div className="tickets-toolbar">
          <div className="toolbar-left">
            <h1 className="page-title">TRANSFER HISTORY</h1>
            <span className="ticket-count">{transfers.length} records</span>
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
          <div className="toolbar-right">
            <div className="filter-group">
              <select
                value={directionFilter}
                onChange={(e) => { setDirectionFilter(e.target.value); setPage(1); }}
                className="filter-select"
              >
                <option value="">All Directions</option>
                <option value="low-to-high">Low -&gt; High</option>
                <option value="high-to-low">High -&gt; Low</option>
              </select>
              <select
                value={classFilter}
                onChange={(e) => { setClassFilter(e.target.value); setPage(1); }}
                className="filter-select"
              >
                <option value="">All Classifications</option>
                <option value="UNCLASS">UNCLASS</option>
                <option value="CUI">CUI</option>
                <option value="SECRET">SECRET</option>
              </select>
              <input
                type="date"
                value={dateRange.from}
                onChange={(e) => { setDateRange((d) => ({ ...d, from: e.target.value })); setPage(1); }}
                className="filter-select"
                title="From date"
                style={{ width: 130 }}
              />
              <input
                type="date"
                value={dateRange.to}
                onChange={(e) => { setDateRange((d) => ({ ...d, to: e.target.value })); setPage(1); }}
                className="filter-select"
                title="To date"
                style={{ width: 130 }}
              />
            </div>
            <button onClick={loadTransfers} className="page-btn" title="Refresh" style={{ width: 32, height: 32 }}>
              <RefreshCw size={14} className={transfersLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="tickets-table-wrap">
          <table className="tickets-table">
            <thead>
              <tr>
                <th style={{ cursor: 'pointer' }} onClick={() => handleSort('transfer_id')}>
                  TRANSFER ID <SortIcon field="transfer_id" />
                </th>
                <th style={{ cursor: 'pointer' }} onClick={() => handleSort('direction')}>
                  DIRECTION <SortIcon field="direction" />
                </th>
                <th>CLASSIFICATION</th>
                <th style={{ cursor: 'pointer' }} onClick={() => handleSort('entity_type')}>
                  ENTITY TYPE <SortIcon field="entity_type" />
                </th>
                <th style={{ cursor: 'pointer' }} onClick={() => handleSort('status')}>
                  STATUS <SortIcon field="status" />
                </th>
                <th style={{ cursor: 'pointer' }} onClick={() => handleSort('executed_at')}>
                  EXECUTED AT <SortIcon field="executed_at" />
                </th>
                <th>ACTOR</th>
              </tr>
            </thead>
            <tbody>
              {transfersLoading ? (
                <tr><td colSpan={7} className="table-empty">Loading...</td></tr>
              ) : paginatedTransfers.length === 0 ? (
                <tr><td colSpan={7} className="table-empty">No transfer records found</td></tr>
              ) : (
                paginatedTransfers.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => handleSelectTransfer(t)}
                    className="ticket-row"
                    style={selectedTransfer?.id === t.id ? { background: 'var(--color-bg-hover)' } : undefined}
                  >
                    <td className="mono-cell" title={t.transfer_id || t.id}>
                      {truncateId(t.transfer_id || t.id)}
                    </td>
                    <td>
                      <DirectionBadge direction={t.direction} />
                    </td>
                    <td>
                      <ClassificationBadge classification={t.classification} size="sm" />
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 0.5 }}>
                      {t.entity_type?.toUpperCase() || '--'}
                    </td>
                    <td>
                      <span
                        className="status-badge"
                        style={{
                          borderColor: STATUS_COLORS[t.status]?.border || 'var(--color-muted)',
                          color: STATUS_COLORS[t.status]?.color || 'var(--color-text-muted)',
                        }}
                      >
                        {t.status.toUpperCase()}
                      </span>
                    </td>
                    <td className="mono-cell">{formatTimestamp(t.executed_at)}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{t.actor || '--'}</td>
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

      {/* Provenance Panel */}
      {selectedTransfer && (
        <div className="side-panel">
          <button
            className="panel-close"
            onClick={() => { setSelectedTransfer(null); setProvenance([]); }}
          >
            <X size={16} />
          </button>

          <div className="panel-content">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Workflow size={16} style={{ color: 'var(--color-accent)' }} />
              <span className="mono-cell" style={{ fontSize: 11 }}>PROVENANCE CHAIN</span>
            </div>

            <h2 className="panel-title" style={{ fontSize: 14 }}>
              {truncateId(selectedTransfer.transfer_id || selectedTransfer.id)}
            </h2>

            <div className="detail-meta">
              <div className="meta-row">
                <span className="meta-label">DIRECTION</span>
                <DirectionBadge direction={selectedTransfer.direction} />
              </div>
              <div className="meta-row">
                <span className="meta-label">CLASSIFICATION</span>
                <ClassificationBadge classification={selectedTransfer.classification} size="md" />
              </div>
              <div className="meta-row">
                <span className="meta-label">STATUS</span>
                <span
                  className="status-badge"
                  style={{
                    borderColor: STATUS_COLORS[selectedTransfer.status]?.border || 'var(--color-muted)',
                    color: STATUS_COLORS[selectedTransfer.status]?.color || 'var(--color-text-muted)',
                  }}
                >
                  {selectedTransfer.status.toUpperCase()}
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-label">SIZE</span>
                <span className="mono-cell">{formatBytes(selectedTransfer.bytes_transferred)}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">DURATION</span>
                <span className="mono-cell">{formatDuration(selectedTransfer.duration_ms)}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">ACTOR</span>
                <span>{selectedTransfer.actor || '--'}</span>
              </div>
            </div>

            {/* Provenance timeline */}
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
              <h3 className="detail-section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <History size={14} />
                TIMELINE
              </h3>
              {provenanceLoading ? (
                <div style={{
                  padding: 16,
                  textAlign: 'center',
                  color: 'var(--color-text-muted)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                }}>
                  Loading provenance...
                </div>
              ) : (
                <ProvenanceTimeline events={provenance} />
              )}
            </div>

            {/* Timestamp footer */}
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
              Executed at {formatTimestamp(selectedTransfer.executed_at)}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
