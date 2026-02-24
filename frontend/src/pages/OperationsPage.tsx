import { useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { Plus, Search, ChevronLeft, ChevronRight, X } from 'lucide-react'

interface OperationRecord {
  id: string
  name: string
  status: string
  risk_level: number
  objective: string
  network_count: number
  finding_count: number
  created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  pending_approval: '#f59e0b',
  approved: '#3b82f6',
  in_progress: '#40c057',
  paused: '#f97316',
  completed: '#8b5cf6',
  aborted: '#ef4444',
}

const RISK_COLORS: Record<number, string> = {
  1: '#40c057',
  2: '#3b82f6',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
}

export default function OperationsPage() {
  const navigate = useNavigate()

  const [operations, setOperations] = useState<OperationRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)

  // Create modal
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createObjective, setCreateObjective] = useState('')
  const [createRisk, setCreateRisk] = useState(3)
  const [createLoading, setCreateLoading] = useState(false)

  const limit = 20

  const fetchOperations = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      if (statusFilter) params.set('status', statusFilter)
      if (searchQuery) params.set('search', searchQuery)

      const data = await apiFetch<{ data: OperationRecord[]; pagination: { total: number } }>(
        `/operations?${params.toString()}`
      )
      setOperations(data.data || [])
      setTotal(data.pagination.total)
    } catch {
      setOperations([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, statusFilter, searchQuery])

  useEffect(() => {
    fetchOperations()
  }, [fetchOperations])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createName.trim() || !createObjective.trim()) return
    setCreateLoading(true)
    try {
      await apiFetch('/operations', {
        method: 'POST',
        body: JSON.stringify({
          name: createName,
          objective: createObjective,
          risk_level: createRisk,
        }),
      })
      setCreateName('')
      setCreateObjective('')
      setCreateRisk(3)
      setShowCreate(false)
      fetchOperations()
    } finally {
      setCreateLoading(false)
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="tickets-layout">
      {/* Toolbar */}
      <div className="tickets-toolbar">
        <div className="toolbar-left">
          <h1 className="page-title">OPERATIONS</h1>
          <span className="ticket-count">{total} total</span>
        </div>
        <div className="toolbar-right">
          <div className="filter-group">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Status</option>
              {Object.keys(STATUS_COLORS).map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ').toUpperCase()}</option>
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
          <button onClick={() => setShowCreate(true)} className="create-btn">
            <Plus size={14} />
            NEW OPERATION
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="tickets-table-wrap">
        <table className="tickets-table">
          <thead>
            <tr>
              <th>NAME</th>
              <th>STATUS</th>
              <th>RISK</th>
              <th>NETWORKS</th>
              <th>FINDINGS</th>
              <th>CREATED</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="table-empty">Loading...</td></tr>
            ) : operations.length === 0 ? (
              <tr><td colSpan={6} className="table-empty">No operations found</td></tr>
            ) : (
              operations.map((op) => (
                <tr
                  key={op.id}
                  onClick={() => navigate(`/operations/${op.id}`)}
                  className="ticket-row"
                >
                  <td className="title-cell">{op.name}</td>
                  <td>
                    <span
                      className="status-badge"
                      style={{
                        borderColor: STATUS_COLORS[op.status] || '#6b7280',
                        color: STATUS_COLORS[op.status] || '#6b7280',
                      }}
                    >
                      {op.status.replace(/_/g, ' ').toUpperCase()}
                    </span>
                  </td>
                  <td>
                    <span
                      className="status-badge"
                      style={{
                        borderColor: RISK_COLORS[op.risk_level] || '#6b7280',
                        color: RISK_COLORS[op.risk_level] || '#6b7280',
                      }}
                    >
                      LEVEL {op.risk_level}
                    </span>
                  </td>
                  <td className="mono-cell">{op.network_count ?? 0}</td>
                  <td className="mono-cell">{op.finding_count ?? 0}</td>
                  <td className="mono-cell">{new Date(op.created_at).toLocaleDateString()}</td>
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

      {/* Create Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">NEW OPERATION</span>
              <button className="modal-close" onClick={() => setShowCreate(false)}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">NAME</label>
                  <input
                    type="text"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    className="form-input"
                    placeholder="Operation name"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">OBJECTIVE</label>
                  <textarea
                    value={createObjective}
                    onChange={(e) => setCreateObjective(e.target.value)}
                    className="form-input form-textarea"
                    placeholder="Describe the operation objective..."
                    rows={4}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">RISK LEVEL</label>
                  <select
                    value={createRisk}
                    onChange={(e) => setCreateRisk(Number(e.target.value))}
                    className="form-input"
                  >
                    <option value={1}>1 - MINIMAL</option>
                    <option value={2}>2 - LOW</option>
                    <option value={3}>3 - MODERATE</option>
                    <option value={4}>4 - HIGH</option>
                    <option value={5}>5 - CRITICAL</option>
                  </select>
                </div>
              </div>
              <div className="modal-footer">
                <button type="submit" className="submit-btn" disabled={createLoading}>
                  {createLoading ? 'CREATING...' : 'CREATE OPERATION'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
