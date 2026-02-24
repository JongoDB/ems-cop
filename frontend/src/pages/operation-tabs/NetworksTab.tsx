import { useState, useCallback, useEffect, useRef } from 'react'
import { useOutletContext } from 'react-router-dom'
import { apiFetch, getAccessToken } from '../../lib/api'
import { Network, Plus, Upload, Server, Shield, X } from 'lucide-react'

interface NetworkRecord {
  id: string
  operation_id: string
  name: string
  description: string
  cidr_ranges: string[] | null
  import_source: string | null
  metadata: unknown
  created_by: string
  created_at: string
  updated_at: string
  node_count: number
  compromised_count: number
}

interface ImportResult {
  format: string
  nodes_created: number
  nodes_updated: number
  total_hosts: number
  hosts_skipped: number
}

export default function NetworksTab() {
  const { operation, refresh } = useOutletContext<{
    operation: { id: string; name: string; status: string }
    refresh: () => void
  }>()

  const [networks, setNetworks] = useState<NetworkRecord[]>([])
  const [loading, setLoading] = useState(true)

  // Create modal
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createCidrs, setCreateCidrs] = useState('')
  const [createLoading, setCreateLoading] = useState(false)

  // Import state
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [showImportResult, setShowImportResult] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchNetworks = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<{ data: NetworkRecord[]; pagination: { total: number } }>(
        `/networks?operation_id=${operation.id}`
      )
      setNetworks(data.data || [])
    } catch {
      setNetworks([])
    } finally {
      setLoading(false)
    }
  }, [operation.id])

  useEffect(() => {
    fetchNetworks()
  }, [fetchNetworks])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createName.trim()) return
    setCreateLoading(true)
    try {
      const cidr_ranges = createCidrs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      await apiFetch('/networks', {
        method: 'POST',
        body: JSON.stringify({
          operation_id: operation.id,
          name: createName,
          description: createDescription,
          cidr_ranges: cidr_ranges.length > 0 ? cidr_ranges : [],
        }),
      })
      setCreateName('')
      setCreateDescription('')
      setCreateCidrs('')
      setShowCreate(false)
      fetchNetworks()
      refresh()
    } finally {
      setCreateLoading(false)
    }
  }

  const handleImportClick = (networkId: string) => {
    setImportingId(networkId)
    fileInputRef.current?.click()
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !importingId) return

    const formData = new FormData()
    formData.append('file', file)

    try {
      const token = getAccessToken()
      const res = await fetch(`/api/v1/networks/${importingId}/import`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error?.message || `Import failed: ${res.status}`)
      }

      const result: ImportResult = await res.json()
      setImportResult(result)
      setShowImportResult(true)
      fetchNetworks()
      refresh()
    } catch (err) {
      console.error('Import failed:', err)
    } finally {
      setImportingId(null)
      // Reset file input so same file can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleCardClick = (networkId: string) => {
    console.log('Navigate to network map:', networkId)
  }

  // Loading state
  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 60,
        color: 'var(--color-text-muted)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        letterSpacing: 1,
      }}>
        LOADING NETWORKS...
      </div>
    )
  }

  // Empty state
  if (networks.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 80,
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        animation: 'fadeIn 0.3s ease',
      }}>
        <Network size={40} style={{ color: 'var(--color-border-strong)', marginBottom: 16 }} />
        <p style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          letterSpacing: 1,
          color: 'var(--color-text-muted)',
          margin: '0 0 20px 0',
        }}>
          NO NETWORKS DEFINED
        </p>
        <button
          onClick={() => setShowCreate(true)}
          className="create-btn"
        >
          <Plus size={14} />
          CREATE FIRST NETWORK
        </button>

        {/* Create modal rendered here too */}
        {renderCreateModal()}
      </div>
    )
  }

  function renderCreateModal() {
    if (!showCreate) return null
    return (
      <div className="modal-overlay" onClick={() => setShowCreate(false)}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">NEW NETWORK</span>
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
                  placeholder="e.g. Corp LAN"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">DESCRIPTION</label>
                <textarea
                  value={createDescription}
                  onChange={(e) => setCreateDescription(e.target.value)}
                  className="form-input form-textarea"
                  placeholder="Describe the network scope..."
                  rows={3}
                />
              </div>
              <div className="form-group">
                <label className="form-label">CIDR RANGES</label>
                <input
                  type="text"
                  value={createCidrs}
                  onChange={(e) => setCreateCidrs(e.target.value)}
                  className="form-input"
                  placeholder="10.0.0.0/24, 192.168.1.0/24"
                />
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text-muted)',
                  marginTop: 4,
                  display: 'block',
                }}>
                  Comma-separated CIDR notation
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button type="submit" className="submit-btn" disabled={createLoading}>
                {createLoading ? 'CREATING...' : 'CREATE NETWORK'}
              </button>
            </div>
          </form>
        </div>
      </div>
    )
  }

  function renderImportResultModal() {
    if (!showImportResult || !importResult) return null
    return (
      <div className="modal-overlay" onClick={() => setShowImportResult(false)}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
          <div className="modal-header">
            <span className="modal-title">IMPORT COMPLETE</span>
            <button className="modal-close" onClick={() => setShowImportResult(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
            }}>
              <div style={statBoxStyle}>
                <span style={statLabelStyle}>FORMAT</span>
                <span style={statValueStyle}>{importResult.format.toUpperCase()}</span>
              </div>
              <div style={statBoxStyle}>
                <span style={statLabelStyle}>TOTAL HOSTS</span>
                <span style={statValueStyle}>{importResult.total_hosts}</span>
              </div>
              <div style={statBoxStyle}>
                <span style={statLabelStyle}>CREATED</span>
                <span style={{ ...statValueStyle, color: 'var(--color-success)' }}>{importResult.nodes_created}</span>
              </div>
              <div style={statBoxStyle}>
                <span style={statLabelStyle}>UPDATED</span>
                <span style={{ ...statValueStyle, color: 'var(--color-accent)' }}>{importResult.nodes_updated}</span>
              </div>
              {importResult.hosts_skipped > 0 && (
                <div style={{ ...statBoxStyle, gridColumn: 'span 2' }}>
                  <span style={statLabelStyle}>SKIPPED</span>
                  <span style={{ ...statValueStyle, color: 'var(--color-warning)' }}>{importResult.hosts_skipped}</span>
                </div>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button
              className="submit-btn"
              onClick={() => setShowImportResult(false)}
            >
              DONE
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      {/* Hidden file input for imports */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xml,.nmap,.json"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: 1,
            color: 'var(--color-text-muted)',
          }}>
            {networks.length} NETWORK{networks.length !== 1 ? 'S' : ''}
          </span>
        </div>
        <button onClick={() => setShowCreate(true)} className="create-btn">
          <Plus size={14} />
          NEW NETWORK
        </button>
      </div>

      {/* Card Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
        gap: 14,
      }}>
        {networks.map((net) => (
          <div
            key={net.id}
            onClick={() => handleCardClick(net.id)}
            style={{
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              padding: 18,
              cursor: 'pointer',
              transition: 'border-color 0.15s ease, background 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border-strong)'
              e.currentTarget.style.background = 'var(--color-bg-hover)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border)'
              e.currentTarget.style.background = 'var(--color-bg-elevated)'
            }}
          >
            {/* Card header */}
            <div style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              marginBottom: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Network size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--color-text-bright)',
                  letterSpacing: 0.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {net.name}
                </span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleImportClick(net.id)
                }}
                title="Import Nmap scan"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                  padding: '4px 8px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  letterSpacing: 0.5,
                  color: 'var(--color-text-muted)',
                  transition: 'border-color 0.15s ease, color 0.15s ease',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-accent)'
                  e.currentTarget.style.color = 'var(--color-accent)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)'
                  e.currentTarget.style.color = 'var(--color-text-muted)'
                }}
              >
                <Upload size={12} />
                IMPORT
              </button>
            </div>

            {/* Description */}
            {net.description && (
              <p style={{
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                color: 'var(--color-text-muted)',
                margin: '0 0 12px 0',
                lineHeight: 1.5,
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}>
                {net.description}
              </p>
            )}

            {/* CIDR badges */}
            {net.cidr_ranges && net.cidr_ranges.length > 0 && (
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                marginBottom: 12,
              }}>
                {net.cidr_ranges.map((cidr) => (
                  <span
                    key={cidr}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--color-accent)',
                      background: 'rgba(77, 171, 247, 0.08)',
                      border: '1px solid rgba(77, 171, 247, 0.2)',
                      borderRadius: 'var(--radius)',
                      padding: '2px 8px',
                      letterSpacing: 0.5,
                    }}
                  >
                    {cidr}
                  </span>
                ))}
              </div>
            )}

            {/* Stats row */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              paddingTop: 10,
              borderTop: '1px solid var(--color-border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Server size={12} style={{ color: 'var(--color-text-muted)' }} />
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-text)',
                }}>
                  {net.node_count}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text-muted)',
                  letterSpacing: 0.5,
                }}>
                  NODES
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Shield size={12} style={{
                  color: net.compromised_count > 0 ? 'var(--color-danger)' : 'var(--color-text-muted)',
                }} />
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: net.compromised_count > 0 ? 'var(--color-danger)' : 'var(--color-text)',
                }}>
                  {net.compromised_count}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text-muted)',
                  letterSpacing: 0.5,
                }}>
                  COMPROMISED
                </span>
              </div>
            </div>

            {/* Footer: import source + date */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 10,
            }}>
              {net.import_source ? (
                <span
                  className="status-badge"
                  style={{
                    borderColor: 'var(--color-warning)',
                    color: 'var(--color-warning)',
                    fontSize: 9,
                  }}
                >
                  {net.import_source.toUpperCase()}
                </span>
              ) : (
                <span />
              )}
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--color-text-muted)',
              }}>
                {new Date(net.created_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Modals */}
      {renderCreateModal()}
      {renderImportResultModal()}
    </div>
  )
}

// Style constants for import result modal
const statBoxStyle: React.CSSProperties = {
  background: 'var(--color-bg-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const statLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: 1,
  color: 'var(--color-text-muted)',
}

const statValueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--color-text-bright)',
}
