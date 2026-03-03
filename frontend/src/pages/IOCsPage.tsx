import { useState, useCallback, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import IOCSearchBar from '../components/IOCSearchBar'
import type { IOC } from '../components/IOCSearchBar'
import ClassificationSelect from '../components/ClassificationSelect'
import type { Classification } from '../components/ClassificationBadge'
import {
  Search, ChevronLeft, ChevronRight, Plus, X,
  Upload, ToggleLeft, ToggleRight,
} from 'lucide-react'

interface IOCRecord {
  id: string
  ioc_type: string
  value: string
  description?: string
  threat_level: string
  source: string
  tags: string[]
  is_active: boolean
  classification?: string
  first_seen: string
  last_seen: string
  created_at: string
}

const THREAT_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  info: '#6b7280',
}

const IOC_TYPES = ['ip', 'domain', 'hash_md5', 'hash_sha1', 'hash_sha256', 'url', 'email']

export default function IOCsPage() {
  const [iocs, setIOCs] = useState<IOCRecord[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  // Filters
  const [typeFilter, setTypeFilter] = useState('')
  const [threatFilter, setThreatFilter] = useState('')
  const [activeFilter, setActiveFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [createType, setCreateType] = useState('ip')
  const [createValue, setCreateValue] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [createThreat, setCreateThreat] = useState('medium')
  const [createTags, setCreateTags] = useState('')
  const [createClassification, setCreateClassification] = useState<Classification>('UNCLASS')

  const limit = 25

  const fetchIOCs = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      params.set('sort', 'last_seen')
      params.set('order', 'desc')
      if (typeFilter) params.set('ioc_type', typeFilter)
      if (threatFilter) params.set('threat_level', threatFilter)
      if (activeFilter) params.set('is_active', activeFilter)
      if (searchQuery) params.set('search', searchQuery)

      const data = await apiFetch<{ data: IOCRecord[]; pagination: { total: number } }>(
        `/endpoints/iocs?${params.toString()}`
      )
      setIOCs(data.data || [])
      setTotal(data.pagination?.total || 0)
    } catch {
      setIOCs([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, typeFilter, threatFilter, activeFilter, searchQuery])

  useEffect(() => {
    fetchIOCs()
  }, [fetchIOCs])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createValue.trim()) return
    try {
      await apiFetch('/endpoints/iocs', {
        method: 'POST',
        body: JSON.stringify({
          ioc_type: createType,
          value: createValue,
          description: createDesc,
          threat_level: createThreat,
          tags: createTags.split(',').map((t) => t.trim()).filter(Boolean),
          classification: createClassification,
        }),
      })
      setCreateValue('')
      setCreateDesc('')
      setCreateTags('')
      setShowCreate(false)
      fetchIOCs()
    } catch {
      // error handled
    }
  }

  const handleToggleActive = async (ioc: IOCRecord) => {
    try {
      await apiFetch(`/endpoints/iocs/${ioc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !ioc.is_active }),
      })
      fetchIOCs()
    } catch {
      // error handled
    }
  }

  const handleSearchSelect = (_ioc: IOC) => {
    // Navigate or highlight selected IOC in the table
    setSearchQuery(_ioc.value)
    setPage(1)
  }

  const handleBulkImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const lines = text.split('\n').filter((l) => l.trim())
    if (lines.length <= 1) return

    // Parse CSV: type,value,threat_level,tags
    const records = lines.slice(1).map((line) => {
      const parts = line.split(',').map((p) => p.trim())
      return {
        ioc_type: parts[0] || 'ip',
        value: parts[1] || '',
        threat_level: parts[2] || 'medium',
        tags: parts[3] ? parts[3].split(';').map((t) => t.trim()) : [],
      }
    }).filter((r) => r.value)

    try {
      await apiFetch('/endpoints/iocs/bulk', {
        method: 'POST',
        body: JSON.stringify({ iocs: records }),
      })
      fetchIOCs()
    } catch {
      // error handled
    }

    // Reset file input
    e.target.value = ''
  }

  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="tickets-layout">
      {/* Search bar */}
      <div style={{ marginBottom: 12 }}>
        <IOCSearchBar onSelect={handleSearchSelect} />
      </div>

      {/* Toolbar */}
      <div className="tickets-toolbar">
        <div className="toolbar-left">
          <h1 className="page-title">IOCs</h1>
          <span className="ticket-count">{total} total</span>
        </div>
        <div className="toolbar-right">
          <div className="filter-group">
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Types</option>
              {IOC_TYPES.map((t) => (
                <option key={t} value={t}>{t.toUpperCase()}</option>
              ))}
            </select>
            <select
              value={threatFilter}
              onChange={(e) => { setThreatFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Threat Levels</option>
              <option value="critical">CRITICAL</option>
              <option value="high">HIGH</option>
              <option value="medium">MEDIUM</option>
              <option value="low">LOW</option>
              <option value="info">INFO</option>
            </select>
            <select
              value={activeFilter}
              onChange={(e) => { setActiveFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Status</option>
              <option value="true">ACTIVE</option>
              <option value="false">INACTIVE</option>
            </select>
            <div className="search-box">
              <Search size={14} />
              <input
                type="text"
                placeholder="Filter..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1) }}
                className="search-input"
              />
            </div>
          </div>
          <label className="create-btn" style={{ cursor: 'pointer' }}>
            <Upload size={14} />
            IMPORT CSV
            <input
              type="file"
              accept=".csv"
              onChange={handleBulkImport}
              style={{ display: 'none' }}
            />
          </label>
          <button onClick={() => setShowCreate(true)} className="create-btn">
            <Plus size={14} />
            NEW IOC
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="tickets-table-wrap">
        <table className="tickets-table">
          <thead>
            <tr>
              <th>TYPE</th>
              <th>VALUE</th>
              <th>THREAT</th>
              <th>SOURCE</th>
              <th>TAGS</th>
              <th>ACTIVE</th>
              <th>FIRST SEEN</th>
              <th>LAST SEEN</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="table-empty">Loading...</td></tr>
            ) : iocs.length === 0 ? (
              <tr><td colSpan={9} className="table-empty">No IOCs found</td></tr>
            ) : (
              iocs.map((ioc) => (
                <tr key={ioc.id} className="ticket-row">
                  <td>
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      padding: '1px 4px',
                      background: 'var(--color-bg-elevated)',
                      borderRadius: 'var(--radius)',
                      color: 'var(--color-text-muted)',
                    }}>
                      {ioc.ioc_type}
                    </span>
                  </td>
                  <td className="title-cell" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    {ioc.value}
                  </td>
                  <td>
                    <span style={{
                      padding: '1px 6px',
                      borderRadius: '9999px',
                      fontSize: 10,
                      fontWeight: 600,
                      color: '#fff',
                      backgroundColor: THREAT_COLORS[ioc.threat_level] || '#6b7280',
                    }}>
                      {ioc.threat_level}
                    </span>
                  </td>
                  <td style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{ioc.source || '--'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                      {(ioc.tags || []).slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          style={{
                            fontSize: 9,
                            padding: '0 4px',
                            background: 'var(--color-bg-elevated)',
                            borderRadius: 2,
                            color: 'var(--color-text-muted)',
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <span style={{ color: ioc.is_active ? '#22c55e' : '#6b7280', fontWeight: 600, fontSize: 10 }}>
                      {ioc.is_active ? 'YES' : 'NO'}
                    </span>
                  </td>
                  <td className="mono-cell">{new Date(ioc.first_seen).toLocaleDateString()}</td>
                  <td className="mono-cell">{new Date(ioc.last_seen).toLocaleDateString()}</td>
                  <td>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleToggleActive(ioc) }}
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        color: ioc.is_active ? '#22c55e' : '#6b7280',
                        padding: 2,
                      }}
                      title={ioc.is_active ? 'Deactivate' : 'Activate'}
                    >
                      {ioc.is_active ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                    </button>
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

      {/* Create Modal */}
      {showCreate && (
        <div className="modal-overlay" onClick={() => setShowCreate(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">NEW IOC</span>
              <button className="modal-close" onClick={() => setShowCreate(false)}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">TYPE</label>
                  <select value={createType} onChange={(e) => setCreateType(e.target.value)} className="form-input">
                    {IOC_TYPES.map((t) => (
                      <option key={t} value={t}>{t.toUpperCase()}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">VALUE</label>
                  <input
                    type="text"
                    value={createValue}
                    onChange={(e) => setCreateValue(e.target.value)}
                    className="form-input"
                    placeholder="IOC value"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">DESCRIPTION</label>
                  <textarea
                    value={createDesc}
                    onChange={(e) => setCreateDesc(e.target.value)}
                    className="form-input form-textarea"
                    placeholder="Description..."
                    rows={3}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">THREAT LEVEL</label>
                  <select value={createThreat} onChange={(e) => setCreateThreat(e.target.value)} className="form-input">
                    <option value="critical">CRITICAL</option>
                    <option value="high">HIGH</option>
                    <option value="medium">MEDIUM</option>
                    <option value="low">LOW</option>
                    <option value="info">INFO</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">TAGS (comma separated)</label>
                  <input
                    type="text"
                    value={createTags}
                    onChange={(e) => setCreateTags(e.target.value)}
                    className="form-input"
                    placeholder="tag1, tag2, tag3"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">CLASSIFICATION</label>
                  <ClassificationSelect
                    value={createClassification}
                    onChange={setCreateClassification}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="submit" className="submit-btn">CREATE IOC</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
