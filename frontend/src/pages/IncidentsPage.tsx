import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import SeverityBadge from '../components/SeverityBadge'
import MitreBadge from '../components/MitreBadge'
import {
  Search, ChevronLeft, ChevronRight, Plus,
  Clock,
} from 'lucide-react'

interface IncidentRecord {
  id: string
  title: string
  incident_severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  status: string
  source: string
  mitre_techniques?: string[]
  containment_status?: string
  assigned_to?: string
  assignee_name?: string
  created_at: string
}

interface IncidentStats {
  total_open: number
  by_severity: Record<string, number>
  mttd_hours?: number
  mttr_hours?: number
}

const STATUS_COLORS: Record<string, string> = {
  new: '#3b82f6',
  investigating: '#f59e0b',
  containing: '#f97316',
  contained: '#8b5cf6',
  remediating: '#a855f7',
  resolved: '#22c55e',
  closed: '#6b7280',
}

const CONTAINMENT_COLORS: Record<string, string> = {
  none: '#6b7280',
  partial: '#f59e0b',
  full: '#22c55e',
  failed: '#ef4444',
}

function formatDuration(hours?: number): string {
  if (hours === undefined || hours === null) return '--'
  if (hours < 1) return `${Math.round(hours * 60)}m`
  return `${hours.toFixed(1)} hrs`
}

export default function IncidentsPage() {
  const navigate = useNavigate()

  const [incidents, setIncidents] = useState<IncidentRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<IncidentStats | null>(null)

  const [error, setError] = useState<string | null>(null)

  // Filters
  const [severityFilter, setSeverityFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [containmentFilter, setContainmentFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  const limit = 20

  const fetchIncidents = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('page_size', String(limit))
      params.set('sort', 'created_at')
      params.set('order', 'desc')
      if (severityFilter) params.set('incident_severity', severityFilter)
      if (statusFilter) params.set('status', statusFilter)
      if (containmentFilter) params.set('containment_status', containmentFilter)
      if (searchQuery) params.set('search', searchQuery)

      const data = await apiFetch<{ data: IncidentRecord[]; pagination: { total: number } }>(
        `/tickets/incidents?${params.toString()}`
      )
      setIncidents(data.data || [])
      setTotal(data.pagination?.total || 0)
      setError(null)
    } catch (err) {
      setIncidents([])
      setTotal(0)
      setError(err instanceof Error ? err.message : 'Failed to fetch incidents')
    } finally {
      setLoading(false)
    }
  }, [page, severityFilter, statusFilter, containmentFilter, searchQuery])

  const fetchStats = useCallback(async () => {
    try {
      const data = await apiFetch<IncidentStats>('/tickets/incidents/stats')
      setStats(data)
    } catch (err) {
      setStats(null)
      setError(err instanceof Error ? err.message : 'Failed to fetch incident stats')
    }
  }, [])

  useEffect(() => {
    fetchIncidents()
  }, [fetchIncidents])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      fetchIncidents()
      fetchStats()
    }, 30000)
    return () => clearInterval(interval)
  }, [fetchIncidents, fetchStats])

  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="tickets-layout">
      {/* Stats Summary */}
      {stats && (
        <div style={{
          display: 'flex',
          gap: 16,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}>
          <div style={{
            padding: '10px 16px',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            flex: '1 1 120px',
          }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-muted)', letterSpacing: 1 }}>
              OPEN INCIDENTS
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color: 'var(--color-text-bright)' }}>
              {stats.total_open}
            </div>
          </div>
          {stats.by_severity && Object.entries(stats.by_severity).map(([sev, count]) => (
            <div key={sev} style={{
              padding: '10px 16px',
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              flex: '0 0 auto',
            }}>
              <div style={{ marginBottom: 4 }}>
                <SeverityBadge severity={sev as 'critical' | 'high' | 'medium' | 'low' | 'info'} />
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-bright)' }}>
                {count}
              </div>
            </div>
          ))}
          <div style={{
            padding: '10px 16px',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            flex: '0 0 auto',
          }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-muted)', letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Clock size={10} /> MTTD
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-bright)' }}>
              {formatDuration(stats.mttd_hours)}
            </div>
          </div>
          <div style={{
            padding: '10px 16px',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            flex: '0 0 auto',
          }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--color-text-muted)', letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Clock size={10} /> MTTR
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--color-text-bright)' }}>
              {formatDuration(stats.mttr_hours)}
            </div>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded" style={{ marginBottom: 12, fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* Toolbar */}
      <div className="tickets-toolbar">
        <div className="toolbar-left">
          <h1 className="page-title">INCIDENTS</h1>
          <span className="ticket-count">{total} total</span>
        </div>
        <div className="toolbar-right">
          <div className="filter-group">
            <select
              value={severityFilter}
              onChange={(e) => { setSeverityFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Severity</option>
              <option value="critical">CRITICAL</option>
              <option value="high">HIGH</option>
              <option value="medium">MEDIUM</option>
              <option value="low">LOW</option>
              <option value="info">INFO</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Status</option>
              {Object.keys(STATUS_COLORS).map((s) => (
                <option key={s} value={s}>{s.toUpperCase()}</option>
              ))}
            </select>
            <select
              value={containmentFilter}
              onChange={(e) => { setContainmentFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Containment</option>
              {Object.keys(CONTAINMENT_COLORS).map((c) => (
                <option key={c} value={c}>{c.toUpperCase()}</option>
              ))}
            </select>
            <div className="search-box">
              <Search size={14} />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1) }}
                className="search-input"
              />
            </div>
          </div>
          <button
            onClick={() => navigate('/tickets?type=incident')}
            className="create-btn"
          >
            <Plus size={14} />
            NEW INCIDENT
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="tickets-table-wrap">
        <table className="tickets-table">
          <thead>
            <tr>
              <th>SEVERITY</th>
              <th>TITLE</th>
              <th>STATUS</th>
              <th>SOURCE</th>
              <th>MITRE</th>
              <th>CONTAINMENT</th>
              <th>ASSIGNED</th>
              <th>CREATED</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="table-empty">Loading...</td></tr>
            ) : incidents.length === 0 ? (
              <tr><td colSpan={8} className="table-empty">No incidents found</td></tr>
            ) : (
              incidents.map((inc) => (
                <tr
                  key={inc.id}
                  className="ticket-row"
                  onClick={() => navigate(`/incidents/${inc.id}`)}
                >
                  <td>
                    <SeverityBadge severity={inc.incident_severity} />
                  </td>
                  <td className="title-cell">{inc.title}</td>
                  <td>
                    <span
                      className="status-badge"
                      style={{
                        borderColor: STATUS_COLORS[inc.status] || '#6b7280',
                        color: STATUS_COLORS[inc.status] || '#6b7280',
                      }}
                    >
                      {inc.status.toUpperCase()}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
                    {inc.source || '--'}
                  </td>
                  <td>
                    {inc.mitre_techniques && inc.mitre_techniques.length > 0 && (
                      <MitreBadge techniques={inc.mitre_techniques} />
                    )}
                  </td>
                  <td>
                    {inc.containment_status && (
                      <span
                        className="status-badge"
                        style={{
                          borderColor: CONTAINMENT_COLORS[inc.containment_status] || '#6b7280',
                          color: CONTAINMENT_COLORS[inc.containment_status] || '#6b7280',
                          fontSize: 9,
                        }}
                      >
                        {inc.containment_status.toUpperCase()}
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 11 }}>{inc.assignee_name || '--'}</td>
                  <td className="mono-cell">{new Date(inc.created_at).toLocaleDateString()}</td>
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
  )
}
