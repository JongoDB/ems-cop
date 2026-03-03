import { useState, useCallback, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import SeverityBadge from '../components/SeverityBadge'
import MitreBadge from '../components/MitreBadge'
import AlertFeed from '../components/AlertFeed'
import {
  Search, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, CheckSquare, AlertTriangle,
} from 'lucide-react'

interface AlertRecord {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  source_system: string
  status: string
  mitre_techniques?: string[]
  raw_payload?: Record<string, unknown>
  created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  new: '#3b82f6',
  acknowledged: '#f59e0b',
  investigating: '#8b5cf6',
  escalated: '#ef4444',
  resolved: '#22c55e',
  closed: '#6b7280',
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Filters
  const [severityFilter, setSeverityFilter] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // UI state
  const [showFeed, setShowFeed] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const limit = 25

  const fetchAlerts = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('page_size', String(limit))
      params.set('sort', 'created_at')
      params.set('order', 'desc')
      if (severityFilter) params.set('severity', severityFilter)
      if (sourceFilter) params.set('source_system', sourceFilter)
      if (statusFilter) params.set('status', statusFilter)
      if (searchQuery) params.set('search', searchQuery)

      const data = await apiFetch<{ data: AlertRecord[]; pagination: { total: number } }>(
        `/endpoints/alerts?${params.toString()}`
      )
      setAlerts(data.data || [])
      setTotal(data.pagination?.total || 0)
      setError(null)
    } catch (err) {
      setAlerts([])
      setTotal(0)
      setError(err instanceof Error ? err.message : 'Failed to fetch alerts')
    } finally {
      setLoading(false)
    }
  }, [page, severityFilter, sourceFilter, statusFilter, searchQuery])

  useEffect(() => {
    fetchAlerts()
  }, [fetchAlerts])

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(fetchAlerts, 30000)
    return () => clearInterval(interval)
  }, [fetchAlerts])

  const handleBulkAcknowledge = async () => {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    try {
      for (const id of ids) {
        await apiFetch(`/endpoints/alerts/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'acknowledged' }),
        })
      }
      setSelected(new Set())
      fetchAlerts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acknowledge alerts')
    }
  }

  const handleEscalateToIncident = async () => {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    try {
      for (const id of ids) {
        const alert = alerts.find((a) => a.id === id)
        await apiFetch(`/endpoints/alerts/${id}/escalate`, {
          method: 'POST',
          body: JSON.stringify({
            title: alert?.title || 'Escalated Alert',
            severity: alert?.severity || 'medium',
            assigned_to: '',
          }),
        })
      }
      setSelected(new Set())
      fetchAlerts()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to escalate alerts')
    }
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === alerts.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(alerts.map((a) => a.id)))
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="tickets-layout">
      {/* Live Feed (collapsible) */}
      <div style={{ marginBottom: 12 }}>
        <button
          onClick={() => setShowFeed(!showFeed)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'none',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            padding: '4px 10px',
            color: 'var(--color-text-muted)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: 0.5,
          }}
        >
          {showFeed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          LIVE FEED
        </button>
        {showFeed && (
          <div style={{
            marginTop: 4,
            maxHeight: 200,
            overflow: 'auto',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            background: 'var(--color-bg-elevated)',
          }}>
            <AlertFeed limit={10} />
          </div>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded" style={{ marginBottom: 12, fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* Toolbar */}
      <div className="tickets-toolbar">
        <div className="toolbar-left">
          <h1 className="page-title">ALERTS</h1>
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
              value={sourceFilter}
              onChange={(e) => { setSourceFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Sources</option>
              <option value="splunk">Splunk</option>
              <option value="elastic">Elastic/ELK</option>
              <option value="crowdstrike">CrowdStrike</option>
              <option value="generic">Generic</option>
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
        </div>
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
          marginBottom: 8,
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
        }}>
          <span>{selected.size} selected</span>
          <button onClick={handleBulkAcknowledge} className="transition-btn" style={{ fontSize: 10, padding: '2px 8px' }}>
            <CheckSquare size={10} />
            ACKNOWLEDGE
          </button>
          <button onClick={handleEscalateToIncident} className="transition-btn" style={{ fontSize: 10, padding: '2px 8px' }}>
            <AlertTriangle size={10} />
            ESCALATE TO INCIDENT
          </button>
        </div>
      )}

      {/* Table */}
      <div className="tickets-table-wrap">
        <table className="tickets-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={alerts.length > 0 && selected.size === alerts.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th>SEVERITY</th>
              <th>TITLE</th>
              <th>SOURCE</th>
              <th>STATUS</th>
              <th>MITRE</th>
              <th>CREATED</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="table-empty">Loading...</td></tr>
            ) : alerts.length === 0 ? (
              <tr><td colSpan={7} className="table-empty">No alerts found</td></tr>
            ) : (
              alerts.map((alert) => (
                <tr key={alert.id} className="ticket-row">
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(alert.id)}
                      onChange={() => toggleSelect(alert.id)}
                    />
                  </td>
                  <td>
                    <SeverityBadge severity={alert.severity} />
                  </td>
                  <td className="title-cell">{alert.title}</td>
                  <td>
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--color-text-muted)',
                    }}>
                      {alert.source_system}
                    </span>
                  </td>
                  <td>
                    <span
                      className="status-badge"
                      style={{
                        borderColor: STATUS_COLORS[alert.status] || '#6b7280',
                        color: STATUS_COLORS[alert.status] || '#6b7280',
                      }}
                    >
                      {alert.status.toUpperCase()}
                    </span>
                  </td>
                  <td>
                    {alert.mitre_techniques && alert.mitre_techniques.length > 0 && (
                      <MitreBadge techniques={alert.mitre_techniques} />
                    )}
                  </td>
                  <td className="mono-cell">
                    {new Date(alert.created_at).toLocaleDateString()}
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
  )
}
