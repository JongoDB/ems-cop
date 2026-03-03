import { useState, useEffect, useCallback, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { useEnclaveStore } from '../stores/enclaveStore'
import {
  ScrollText, RefreshCw, ChevronLeft, ChevronRight,
  X, Clock, Filter,
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts'

// ════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════

interface AuditEvent {
  id: string
  source_enclave: 'low' | 'high'
  event_type: string
  actor: string
  resource_type: string
  resource_id: string
  action: string
  timestamp: string
  details?: Record<string, unknown>
  before_state?: Record<string, unknown>
  after_state?: Record<string, unknown>
}

interface TimelineBucket {
  hour: string
  low: number
  high: number
}

interface ConsolidatedAuditResponse {
  data: AuditEvent[]
  pagination: { page: number; limit: number; total: number }
  timeline?: TimelineBucket[]
}

// ════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════

const ENCLAVE_FILTERS = [
  { key: 'all', label: 'All Enclaves' },
  { key: 'low', label: 'Low Side' },
  { key: 'high', label: 'High Side' },
] as const

const EVENT_TYPE_OPTIONS = [
  '', 'auth', 'ticket', 'workflow', 'operation',
  'c2', 'endpoint', 'audit', 'cti', 'finding',
]

// ════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return '--'
  }
}

function formatHourLabel(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

function truncate(str: string, len: number): string {
  if (!str) return '--'
  return str.length > len ? str.slice(0, len) + '...' : str
}

// ════════════════════════════════════════════
//  COMPONENT
// ════════════════════════════════════════════

export default function ConsolidatedAuditPage() {
  const { enclave } = useEnclaveStore()

  // Redirect low-side users
  if (enclave === 'low') {
    return <Navigate to="/operations" replace />
  }

  return <ConsolidatedAuditContent />
}

function ConsolidatedAuditContent() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [timeline, setTimeline] = useState<TimelineBucket[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Filters
  const [enclaveFilter, setEnclaveFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [actorFilter, setActorFilter] = useState<string>('')

  // Detail panel
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null)

  // Auto-refresh
  const refreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const limit = 20

  const fetchAudit = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      if (enclaveFilter !== 'all') params.set('source_enclave', enclaveFilter)
      if (typeFilter) params.set('event_type', typeFilter)
      if (actorFilter) params.set('actor', actorFilter)
      params.set('include_timeline', 'true')

      const data = await apiFetch<ConsolidatedAuditResponse>(
        `/audit/consolidated?${params.toString()}`
      )
      setEvents(data.data || [])
      setTotal(data.pagination?.total ?? 0)
      if (data.timeline) setTimeline(data.timeline)
    } catch {
      setEvents([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, enclaveFilter, typeFilter, actorFilter])

  useEffect(() => {
    fetchAudit()
  }, [fetchAudit])

  // Auto-refresh every 30s
  useEffect(() => {
    refreshRef.current = setInterval(fetchAudit, 30000)
    return () => {
      if (refreshRef.current) clearInterval(refreshRef.current)
    }
  }, [fetchAudit])

  const totalPages = Math.max(1, Math.ceil(total / limit))

  // Generate placeholder timeline data if none from API
  const chartData = timeline.length > 0
    ? timeline.map((b) => ({
        hour: formatHourLabel(b.hour),
        low: b.low,
        high: b.high,
      }))
    : generatePlaceholderTimeline()

  return (
    <>
      <div className="tickets-layout">
        {/* Toolbar */}
        <div className="tickets-toolbar">
          <div className="toolbar-left">
            <ScrollText size={18} style={{ color: 'var(--color-accent)' }} />
            <h1 className="page-title">CONSOLIDATED AUDIT TRAIL</h1>
            <span className="ticket-count">{total} events</span>
          </div>
          <div className="toolbar-right">
            <div className="filter-group">
              <select
                value={enclaveFilter}
                onChange={(e) => { setEnclaveFilter(e.target.value); setPage(1) }}
                className="filter-select"
              >
                {ENCLAVE_FILTERS.map(({ key, label }) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <select
                value={typeFilter}
                onChange={(e) => { setTypeFilter(e.target.value); setPage(1) }}
                className="filter-select"
              >
                <option value="">All Types</option>
                {EVENT_TYPE_OPTIONS.filter(Boolean).map((t) => (
                  <option key={t} value={t}>{t}.*</option>
                ))}
              </select>
              {actorFilter && (
                <button
                  className="page-btn"
                  onClick={() => { setActorFilter(''); setPage(1) }}
                  title="Clear actor filter"
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}
                >
                  <Filter size={10} />
                  {actorFilter}
                  <X size={10} />
                </button>
              )}
            </div>
            <button
              onClick={fetchAudit}
              className="page-btn"
              title="Refresh"
              style={{ width: 32, height: 32 }}
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* Timeline Chart */}
        <div style={{
          margin: '0 0 16px 0',
          padding: 16,
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
        }}>
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: 1,
            color: 'var(--color-text-muted)',
            marginBottom: 12,
          }}>
            EVENT VOLUME (LAST 24H)
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis
                dataKey="hour"
                tick={{ fill: 'var(--color-text-muted)', fontSize: 9, fontFamily: 'var(--font-mono)' }}
                axisLine={{ stroke: 'var(--color-border)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: 'var(--color-text-muted)', fontSize: 9, fontFamily: 'var(--font-mono)' }}
                axisLine={{ stroke: 'var(--color-border)' }}
                tickLine={false}
                width={36}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                }}
                labelStyle={{ color: 'var(--color-text-muted)', fontSize: 10 }}
              />
              <Legend
                wrapperStyle={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}
              />
              <Area
                type="monotone"
                dataKey="low"
                name="LOW SIDE"
                stackId="1"
                stroke="#3b82f6"
                fill="rgba(59,130,246,0.3)"
                strokeWidth={1.5}
              />
              <Area
                type="monotone"
                dataKey="high"
                name="HIGH SIDE"
                stackId="1"
                stroke="#40c057"
                fill="rgba(64,192,87,0.3)"
                strokeWidth={1.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Events Table */}
        <div className="tickets-table-wrap">
          <table className="tickets-table">
            <thead>
              <tr>
                <th>TIME</th>
                <th>ENCLAVE</th>
                <th>TYPE</th>
                <th>ACTOR</th>
                <th>RESOURCE</th>
                <th>RESOURCE ID</th>
                <th>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="table-empty">Loading...</td></tr>
              ) : events.length === 0 ? (
                <tr><td colSpan={7} className="table-empty">No audit events found</td></tr>
              ) : (
                events.map((evt) => (
                  <tr
                    key={evt.id}
                    onClick={() => setSelectedEvent(evt)}
                    className="ticket-row"
                    style={selectedEvent?.id === evt.id ? { background: 'var(--color-bg-hover)' } : undefined}
                  >
                    <td className="mono-cell">{formatTimestamp(evt.timestamp)}</td>
                    <td>
                      <EnclaveBadge enclave={evt.source_enclave} />
                    </td>
                    <td>
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--color-text-bright)',
                      }}>
                        {evt.event_type}
                      </span>
                    </td>
                    <td>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setActorFilter(evt.actor)
                          setPage(1)
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color: 'var(--color-accent)',
                          cursor: 'pointer',
                          textDecoration: 'none',
                        }}
                        title={`Filter by actor: ${evt.actor}`}
                      >
                        {evt.actor}
                      </button>
                    </td>
                    <td style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--color-text-muted)',
                    }}>
                      {evt.resource_type}
                    </td>
                    <td className="mono-cell" title={evt.resource_id}>
                      {truncate(evt.resource_id, 12)}
                    </td>
                    <td>
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        letterSpacing: 0.5,
                        padding: '2px 6px',
                        borderRadius: 'var(--radius)',
                        background: 'var(--color-bg-surface)',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text)',
                      }}>
                        {evt.action}
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

      {/* Detail Side Panel */}
      {selectedEvent && (
        <div className="side-panel">
          <button
            className="panel-close"
            onClick={() => setSelectedEvent(null)}
          >
            <X size={16} />
          </button>

          <div className="panel-content">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <ScrollText size={16} style={{ color: 'var(--color-accent)' }} />
              <span className="mono-cell" style={{ fontSize: 11 }}>AUDIT EVENT</span>
            </div>

            <h2 className="panel-title" style={{ fontSize: 14 }}>
              {selectedEvent.event_type}
            </h2>

            <div className="detail-meta">
              <div className="meta-row">
                <span className="meta-label">EVENT ID</span>
                <span className="mono-cell" style={{ fontSize: 10, wordBreak: 'break-all' }}>{selectedEvent.id}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">SOURCE ENCLAVE</span>
                <EnclaveBadge enclave={selectedEvent.source_enclave} />
              </div>
              <div className="meta-row">
                <span className="meta-label">TIMESTAMP</span>
                <span className="mono-cell">{new Date(selectedEvent.timestamp).toLocaleString()}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">ACTOR</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{selectedEvent.actor}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">RESOURCE TYPE</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-bright)' }}>
                  {selectedEvent.resource_type}
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-label">RESOURCE ID</span>
                <span className="mono-cell" style={{ fontSize: 10, wordBreak: 'break-all' }}>{selectedEvent.resource_id}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">ACTION</span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 'var(--radius)',
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text-bright)',
                }}>
                  {selectedEvent.action}
                </span>
              </div>
            </div>

            {/* Details JSON */}
            {selectedEvent.details && Object.keys(selectedEvent.details).length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
                <h3 className="detail-section-title">DETAILS</h3>
                <pre style={{
                  padding: '10px 12px',
                  background: 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text)',
                  overflow: 'auto',
                  maxHeight: 200,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
                  {JSON.stringify(selectedEvent.details, null, 2)}
                </pre>
              </div>
            )}

            {/* Before/After State */}
            {(selectedEvent.before_state || selectedEvent.after_state) && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}>
                <h3 className="detail-section-title">STATE CHANGE</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {selectedEvent.before_state && (
                    <div>
                      <div style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9,
                        letterSpacing: 1,
                        color: 'var(--color-danger)',
                        marginBottom: 4,
                      }}>
                        BEFORE
                      </div>
                      <pre style={{
                        padding: '8px 10px',
                        background: 'rgba(255,107,107,0.05)',
                        border: '1px solid rgba(255,107,107,0.15)',
                        borderRadius: 'var(--radius)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--color-text)',
                        overflow: 'auto',
                        maxHeight: 150,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}>
                        {JSON.stringify(selectedEvent.before_state, null, 2)}
                      </pre>
                    </div>
                  )}
                  {selectedEvent.after_state && (
                    <div>
                      <div style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9,
                        letterSpacing: 1,
                        color: 'var(--color-success)',
                        marginBottom: 4,
                      }}>
                        AFTER
                      </div>
                      <pre style={{
                        padding: '8px 10px',
                        background: 'rgba(64,192,87,0.05)',
                        border: '1px solid rgba(64,192,87,0.15)',
                        borderRadius: 'var(--radius)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--color-text)',
                        overflow: 'auto',
                        maxHeight: 150,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}>
                        {JSON.stringify(selectedEvent.after_state, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}

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
              {new Date(selectedEvent.timestamp).toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ════════════════════════════════════════════
//  ENCLAVE BADGE
// ════════════════════════════════════════════

function EnclaveBadge({ enclave }: { enclave: string }) {
  const isLow = enclave === 'low'
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono font-semibold tracking-wider border rounded"
      style={{
        borderColor: isLow ? '#3b82f6' : '#40c057',
        color: isLow ? '#3b82f6' : '#40c057',
      }}
    >
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: isLow ? '#3b82f6' : '#40c057',
        display: 'inline-block',
        flexShrink: 0,
      }} />
      {enclave.toUpperCase()}
    </span>
  )
}

// ════════════════════════════════════════════
//  PLACEHOLDER DATA
// ════════════════════════════════════════════

function generatePlaceholderTimeline(): Array<{ hour: string; low: number; high: number }> {
  const data = []
  const now = new Date()
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000)
    data.push({
      hour: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      low: 0,
      high: 0,
    })
  }
  return data
}
