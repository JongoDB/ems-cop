import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { useEnclaveStore } from '../stores/enclaveStore'
import {
  GitBranch, RefreshCw, ChevronLeft, ChevronRight,
  Search, ArrowRight, FileSearch, Plus, Eye,
} from 'lucide-react'
import ClassificationBadge from '../components/ClassificationBadge'

// ════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════

interface Finding {
  id: string
  title: string
  classification: string
  source_enclave: 'low' | 'high'
  origin_finding_id?: string
  operation_id?: string
  severity?: string
  status?: string
  mitre_tactics?: string[]
  enriched_fields?: string[]
  redacted_summary?: string
  created_at: string
  updated_at: string
}

interface LineageNode {
  finding: Finding
  children: LineageNode[]
  link_type?: string // 'enrichment' | 'duplicate' | 'related'
}

interface LineageResponse {
  root: LineageNode
}

interface FindingListResponse {
  data: Finding[]
  pagination: { page: number; limit: number; total: number }
}

// ════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#f59e0b',
  low: '#3b82f6',
  informational: '#6b7280',
}

const LINK_TYPE_LABELS: Record<string, string> = {
  enrichment: 'Enrichment',
  duplicate: 'Duplicate',
  related: 'Related',
}

// ════════════════════════════════════════════
//  COMPONENT
// ════════════════════════════════════════════

export default function FindingLineagePage() {
  const { id } = useParams<{ id: string }>()

  if (id) {
    return <FindingLineageDetail findingId={id} />
  }

  return <FindingLineageList />
}

// ════════════════════════════════════════════
//  FINDING LIST VIEW
// ════════════════════════════════════════════

function FindingLineageList() {
  const navigate = useNavigate()
  const { isHighSide } = useEnclaveStore()
  const [findings, setFindings] = useState<Finding[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [enclaveFilter, setEnclaveFilter] = useState<string>('')
  const [classFilter, setClassFilter] = useState<string>('')

  const limit = 20

  const fetchFindings = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(limit))
      if (searchQuery) params.set('search', searchQuery)
      if (enclaveFilter) params.set('source_enclave', enclaveFilter)
      if (classFilter) params.set('classification', classFilter)
      params.set('has_lineage', 'true')

      const data = await apiFetch<FindingListResponse>(
        `/findings?${params.toString()}`
      )
      setFindings(data.data || [])
      setTotal(data.pagination?.total ?? 0)
    } catch {
      setFindings([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, searchQuery, enclaveFilter, classFilter])

  useEffect(() => {
    fetchFindings()
  }, [fetchFindings])

  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="tickets-layout">
      {/* Toolbar */}
      <div className="tickets-toolbar">
        <div className="toolbar-left">
          <GitBranch size={18} style={{ color: 'var(--color-accent)' }} />
          <h1 className="page-title">FINDING LINEAGE</h1>
          <span className="ticket-count">{total} findings</span>
        </div>
        <div className="toolbar-right">
          <div className="filter-group">
            <select
              value={enclaveFilter}
              onChange={(e) => { setEnclaveFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Enclaves</option>
              <option value="low">Low Side</option>
              <option value="high">High Side</option>
            </select>
            <select
              value={classFilter}
              onChange={(e) => { setClassFilter(e.target.value); setPage(1) }}
              className="filter-select"
            >
              <option value="">All Classifications</option>
              <option value="UNCLASS">UNCLASS</option>
              <option value="CUI">CUI</option>
              {isHighSide && <option value="SECRET">SECRET</option>}
            </select>
            <div className="search-box">
              <Search size={14} />
              <input
                type="text"
                placeholder="Search findings..."
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setPage(1) }}
                className="search-input"
              />
            </div>
          </div>
          <button
            onClick={fetchFindings}
            className="page-btn"
            title="Refresh"
            style={{ width: 32, height: 32 }}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="tickets-table-wrap">
        <table className="tickets-table">
          <thead>
            <tr>
              <th>TITLE</th>
              <th>CLASS</th>
              <th>ENCLAVE</th>
              <th>SEVERITY</th>
              <th>ORIGIN</th>
              <th>CREATED</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="table-empty">Loading...</td></tr>
            ) : findings.length === 0 ? (
              <tr><td colSpan={7} className="table-empty">No findings with lineage found</td></tr>
            ) : (
              findings.map((f) => (
                <tr key={f.id} className="ticket-row" onClick={() => navigate(`/findings/${f.id}/lineage`)}>
                  <td className="title-cell">{f.title}</td>
                  <td>
                    <ClassificationBadge classification={f.classification} size="sm" />
                  </td>
                  <td>
                    <EnclaveBadge enclave={f.source_enclave} />
                  </td>
                  <td>
                    {f.severity && (
                      <span
                        className="status-badge"
                        style={{
                          borderColor: SEVERITY_COLORS[f.severity] || '#6b7280',
                          color: SEVERITY_COLORS[f.severity] || '#6b7280',
                        }}
                      >
                        {f.severity.toUpperCase()}
                      </span>
                    )}
                  </td>
                  <td className="mono-cell">
                    {f.origin_finding_id ? truncateId(f.origin_finding_id) : '--'}
                  </td>
                  <td className="mono-cell">{new Date(f.created_at).toLocaleDateString()}</td>
                  <td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate(`/findings/${f.id}/lineage`)
                      }}
                      style={{
                        background: 'none',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius)',
                        padding: '4px 8px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 9,
                        letterSpacing: 0.5,
                        color: 'var(--color-accent)',
                      }}
                    >
                      <Eye size={10} />
                      LINEAGE
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
    </div>
  )
}

// ════════════════════════════════════════════
//  FINDING LINEAGE DETAIL VIEW
// ════════════════════════════════════════════

function FindingLineageDetail({ findingId }: { findingId: string }) {
  const navigate = useNavigate()
  const { enclave, isHighSide } = useEnclaveStore()
  const [lineage, setLineage] = useState<LineageNode | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  const fetchLineage = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<LineageResponse>(`/findings/${findingId}/lineage`)
      setLineage(data.root)
      // Auto-select root
      if (data.root?.finding) {
        setSelectedFinding(data.root.finding)
      }
    } catch {
      setLineage(null)
    } finally {
      setLoading(false)
    }
  }, [findingId])

  useEffect(() => {
    fetchLineage()
  }, [fetchLineage])

  const handleEnrich = async () => {
    if (!selectedFinding) return
    setActionLoading(true)
    try {
      await apiFetch(`/findings/${selectedFinding.id}/enrich`, { method: 'POST' })
      fetchLineage()
    } catch {
      // error handled
    } finally {
      setActionLoading(false)
    }
  }

  const handleRedact = async () => {
    if (!selectedFinding) return
    setActionLoading(true)
    try {
      await apiFetch(`/findings/${selectedFinding.id}/redact`, { method: 'POST' })
      fetchLineage()
    } catch {
      // error handled
    } finally {
      setActionLoading(false)
    }
  }

  const handleSyncToHigh = async () => {
    if (!selectedFinding) return
    setActionLoading(true)
    try {
      await apiFetch(`/findings/${selectedFinding.id}/sync-high`, { method: 'POST' })
      fetchLineage()
    } catch {
      // error handled
    } finally {
      setActionLoading(false)
    }
  }

  // Flatten lineage tree for rendering
  const nodes = lineage ? flattenLineage(lineage) : []

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0, overflow: 'hidden', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
        <button
          onClick={() => navigate('/findings/lineage')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: 1,
            color: 'var(--color-text-muted)',
            textDecoration: 'none',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <ChevronLeft size={14} />
          FINDING LINEAGE
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <GitBranch size={18} style={{ color: 'var(--color-accent)' }} />
          <h1 style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: 2,
            color: 'var(--color-text-bright)',
            margin: 0,
          }}>
            LINEAGE: {truncateId(findingId)}
          </h1>
          <button
            onClick={fetchLineage}
            className="page-btn"
            title="Refresh"
            style={{ width: 28, height: 28 }}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)', letterSpacing: 1 }}>
            LOADING LINEAGE...
          </span>
        </div>
      ) : !lineage ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <FileSearch size={32} style={{ color: 'var(--color-border-strong)' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)', letterSpacing: 1 }}>
            NO LINEAGE DATA FOUND
          </span>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', gap: 16, minHeight: 0 }}>
          {/* Lineage Graph */}
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            overflow: 'auto',
          }}>
            {/* Graph Panel */}
            <div style={{
              padding: 24,
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              minHeight: 200,
            }}>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: 1,
                color: 'var(--color-text-muted)',
                marginBottom: 20,
              }}>
                LINEAGE GRAPH
              </div>
              <LineageGraph
                nodes={nodes}
                selectedId={selectedFinding?.id || null}
                onSelect={(f) => setSelectedFinding(f)}
              />
            </div>

            {/* Selected Finding Detail */}
            {selectedFinding && (
              <div style={{
                padding: 20,
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
                  FINDING DETAIL
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                  <h3 style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--color-text-bright)',
                    margin: 0,
                  }}>
                    {selectedFinding.title}
                  </h3>
                  <ClassificationBadge classification={selectedFinding.classification} size="md" />
                  <EnclaveBadge enclave={selectedFinding.source_enclave} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
                  <DetailRow label="FINDING ID" value={selectedFinding.id} mono />
                  <DetailRow label="STATUS" value={selectedFinding.status || '--'} />
                  <DetailRow label="SEVERITY" value={selectedFinding.severity || '--'} />
                  <DetailRow label="OPERATION" value={selectedFinding.operation_id ? truncateId(selectedFinding.operation_id) : '--'} mono />
                  {selectedFinding.origin_finding_id && (
                    <DetailRow label="ORIGIN FINDING" value={selectedFinding.origin_finding_id} mono />
                  )}
                  <DetailRow label="CREATED" value={new Date(selectedFinding.created_at).toLocaleString()} mono />
                </div>

                {/* Enriched fields */}
                {selectedFinding.enriched_fields && selectedFinding.enriched_fields.length > 0 && (
                  <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                    <div style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: 1,
                      color: 'var(--color-text-muted)',
                      marginBottom: 8,
                    }}>
                      ENRICHED FIELDS
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {selectedFinding.enriched_fields.map((field) => (
                        <span key={field} style={{
                          padding: '2px 8px',
                          background: 'rgba(59,130,246,0.1)',
                          border: '1px solid rgba(59,130,246,0.3)',
                          borderRadius: 'var(--radius)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          color: '#3b82f6',
                        }}>
                          {field}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* MITRE Tactics */}
                {selectedFinding.mitre_tactics && selectedFinding.mitre_tactics.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                    <div style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: 1,
                      color: 'var(--color-text-muted)',
                      marginBottom: 8,
                    }}>
                      MITRE ATT&CK TACTICS
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {selectedFinding.mitre_tactics.map((tactic) => (
                        <span key={tactic} style={{
                          padding: '2px 8px',
                          background: 'rgba(245,158,11,0.1)',
                          border: '1px solid rgba(245,158,11,0.3)',
                          borderRadius: 'var(--radius)',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          color: '#f59e0b',
                        }}>
                          {tactic}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Redacted summary */}
                {selectedFinding.redacted_summary && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
                    <div style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      letterSpacing: 1,
                      color: 'var(--color-text-muted)',
                      marginBottom: 8,
                    }}>
                      REDACTED SUMMARY (LOW SIDE)
                    </div>
                    <div style={{
                      padding: '10px 12px',
                      background: 'rgba(250,176,5,0.05)',
                      border: '1px solid rgba(250,176,5,0.2)',
                      borderRadius: 'var(--radius)',
                      fontSize: 12,
                      color: 'var(--color-warning)',
                      lineHeight: 1.6,
                    }}>
                      {selectedFinding.redacted_summary}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--color-border)', display: 'flex', gap: 8 }}>
                  {/* High side: Enrich and Redact buttons */}
                  {isHighSide && (
                    <>
                      <button
                        onClick={handleEnrich}
                        disabled={actionLoading}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '8px 16px',
                          background: 'rgba(59,130,246,0.1)',
                          border: '1px solid rgba(59,130,246,0.4)',
                          borderRadius: 'var(--radius)',
                          color: '#3b82f6',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: 0.5,
                          cursor: actionLoading ? 'wait' : 'pointer',
                          opacity: actionLoading ? 0.6 : 1,
                        }}
                      >
                        <Plus size={12} />
                        ENRICH
                      </button>
                      <button
                        onClick={handleRedact}
                        disabled={actionLoading || selectedFinding.classification === 'UNCLASS'}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '8px 16px',
                          background: 'rgba(245,158,11,0.1)',
                          border: '1px solid rgba(245,158,11,0.4)',
                          borderRadius: 'var(--radius)',
                          color: '#f59e0b',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: 0.5,
                          cursor: (actionLoading || selectedFinding.classification === 'UNCLASS') ? 'not-allowed' : 'pointer',
                          opacity: (actionLoading || selectedFinding.classification === 'UNCLASS') ? 0.6 : 1,
                        }}
                      >
                        <FileSearch size={12} />
                        REDACT
                      </button>
                    </>
                  )}
                  {/* Low side: Sync to High button */}
                  {(enclave === 'low') && selectedFinding.source_enclave === 'low' && (
                    <button
                      onClick={handleSyncToHigh}
                      disabled={actionLoading}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '8px 16px',
                        background: 'rgba(64,192,87,0.1)',
                        border: '1px solid rgba(64,192,87,0.4)',
                        borderRadius: 'var(--radius)',
                        color: '#40c057',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: 0.5,
                        cursor: actionLoading ? 'wait' : 'pointer',
                        opacity: actionLoading ? 0.6 : 1,
                      }}
                    >
                      <ArrowRight size={12} />
                      SYNC TO HIGH
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════
//  LINEAGE GRAPH (CSS/SVG)
// ════════════════════════════════════════════

interface FlatNode {
  finding: Finding
  depth: number
  link_type?: string
  parentId?: string
}

function flattenLineage(node: LineageNode, depth = 0, parentId?: string): FlatNode[] {
  const result: FlatNode[] = [{ finding: node.finding, depth, link_type: node.link_type, parentId }]
  for (const child of node.children || []) {
    result.push(...flattenLineage(child, depth + 1, node.finding.id))
  }
  return result
}

function LineageGraph({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: FlatNode[]
  selectedId: string | null
  onSelect: (f: Finding) => void
}) {
  if (nodes.length === 0) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        color: 'var(--color-text-muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
      }}>
        No lineage data available
      </div>
    )
  }

  // Group by depth for row-based layout
  const maxDepth = Math.max(...nodes.map((n) => n.depth))
  const rows: FlatNode[][] = []
  for (let d = 0; d <= maxDepth; d++) {
    rows.push(nodes.filter((n) => n.depth === d))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'center' }}>
      {rows.map((row, rowIdx) => (
        <div key={rowIdx} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          {/* Connector arrows from previous row */}
          {rowIdx > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
              {row.map((node) => (
                <div key={`arrow-${node.finding.id}`} style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 2,
                }}>
                  <div style={{
                    width: 1,
                    height: 12,
                    background: 'var(--color-border-strong)',
                  }} />
                  {node.link_type && (
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 8,
                      letterSpacing: 0.5,
                      color: 'var(--color-text-muted)',
                      padding: '1px 6px',
                      background: 'var(--color-bg-primary)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 8,
                    }}>
                      {LINK_TYPE_LABELS[node.link_type] || node.link_type}
                    </span>
                  )}
                  <ArrowRight size={10} style={{ color: 'var(--color-border-strong)', transform: 'rotate(90deg)' }} />
                </div>
              ))}
            </div>
          )}
          {/* Node cards */}
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
            {row.map((node) => (
              <LineageNodeCard
                key={node.finding.id}
                finding={node.finding}
                isSelected={selectedId === node.finding.id}
                onClick={() => onSelect(node.finding)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function LineageNodeCard({
  finding,
  isSelected,
  onClick,
}: {
  finding: Finding
  isSelected: boolean
  onClick: () => void
}) {
  const enclaveColor = finding.source_enclave === 'low' ? '#3b82f6' : '#40c057'

  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '12px 16px',
        minWidth: 200,
        background: isSelected ? 'var(--color-bg-hover)' : 'var(--color-bg-primary)',
        border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius)',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 150ms',
        boxShadow: isSelected ? '0 0 0 1px var(--color-accent)' : 'none',
      }}
    >
      {/* Enclave + Classification */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <EnclaveBadge enclave={finding.source_enclave} />
        <ClassificationBadge classification={finding.classification} size="sm" />
      </div>
      {/* Title */}
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--color-text-bright)',
        lineHeight: 1.3,
      }}>
        {finding.title || truncateId(finding.id)}
      </div>
      {/* ID */}
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: 'var(--color-text-muted)',
        letterSpacing: 0.5,
      }}>
        {truncateId(finding.id)}
      </div>
      {/* Accent bar */}
      <div style={{
        height: 2,
        borderRadius: 1,
        background: enclaveColor,
        opacity: 0.4,
      }} />
    </button>
  )
}

// ════════════════════════════════════════════
//  SHARED COMPONENTS
// ════════════════════════════════════════════

function EnclaveBadge({ enclave }: { enclave: string }) {
  const isLow = enclave === 'low'
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono font-semibold tracking-wider border rounded"
      style={{
        borderColor: isLow ? '#3b82f6' : '#40c057',
        color: isLow ? '#3b82f6' : '#40c057',
      }}
    >
      <span style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: isLow ? '#3b82f6' : '#40c057',
        display: 'inline-block',
        flexShrink: 0,
      }} />
      {enclave.toUpperCase()}
    </span>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
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

function truncateId(id: string): string {
  if (!id) return '--'
  return id.length > 12 ? id.slice(0, 12) + '...' : id
}
