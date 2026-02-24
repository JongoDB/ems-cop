import { useState, useCallback, useEffect, useRef } from 'react'
import { useOutletContext } from 'react-router-dom'
import cytoscape from 'cytoscape'
import { apiFetch, getAccessToken } from '../../lib/api'
import { Network, Plus, Upload, Server, Shield, X, ChevronLeft, Activity } from 'lucide-react'
import { getDeviceSvgDataUri } from '../../components/network-map/DeviceIcons'
import { getOsLogoDataUri, detectOs } from '../../components/network-map/OsLogos'
import NodeDetailPanel from '../../components/network-map/NodeDetailPanel'
import type { NetworkNodeRecord } from '../../components/network-map/types'

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

interface NetworkEdgeRecord {
  id: string
  network_id: string
  source_node_id: string
  target_node_id: string
  edge_type: string
  label: string | null
  confidence: number
  discovered_by: string
  metadata: unknown
  created_at: string
  updated_at: string
}

interface TopologyResponse {
  network: NetworkRecord
  nodes: NetworkNodeRecord[]
  edges: NetworkEdgeRecord[]
}

// Cytoscape dark theme stylesheet
const cyStyle: cytoscape.StylesheetJsonBlock[] = [
  {
    selector: 'node',
    style: {
      'shape': 'roundrectangle',
      'background-color': '#0d1117',
      'border-width': 2,
      'border-color': '#3a4a5c',
      'label': 'data(label)',
      'font-size': '10px',
      'font-family': 'JetBrains Mono, monospace',
      'color': '#c5cdd8',
      'text-valign': 'bottom',
      'text-margin-y': 6,
      'width': 54,
      'height': 54,
      'text-outline-width': 2,
      'text-outline-color': '#0a0e14',
      'background-fit': 'contain',
      'background-clip': 'none',
    } as any
  },
  { selector: 'node[status="alive"]', style: { 'border-color': '#40c057' } },
  { selector: 'node[status="compromised"]', style: { 'border-color': '#ff6b6b', 'border-width': 3 } },
  { selector: 'node[status="offline"]', style: { 'border-color': '#1e2a3a', opacity: 0.5 } },
  { selector: 'node:selected', style: { 'border-color': '#4dabf7', 'border-width': 3 } },
  {
    selector: 'edge',
    style: {
      'width': 1.5,
      'line-color': '#2a3a4e',
      'target-arrow-color': '#2a3a4e',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'opacity': 0.7,
      'line-style': 'solid',
    }
  },
  { selector: 'edge[edgeType="c2_callback"]', style: { 'line-color': '#ff6b6b', 'target-arrow-color': '#ff6b6b', 'line-style': 'dashed' } },
  { selector: 'edge[edgeType="lateral_movement"]', style: { 'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b' } },
  { selector: 'edge[edgeType="tunnel"]', style: { 'line-color': '#4dabf7', 'target-arrow-color': '#4dabf7', 'line-style': 'dashed' } },
]

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

  // Map view state
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null)
  const [topology, setTopology] = useState<TopologyResponse | null>(null)
  const [topoLoading, setTopoLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<NetworkNodeRecord | null>(null)
  const cyContainerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<cytoscape.Core | null>(null)

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

  // Fetch topology when a network is selected
  useEffect(() => {
    if (!selectedNetworkId) {
      setTopology(null)
      return
    }
    let cancelled = false
    setTopoLoading(true)
    setSelectedNode(null)
    apiFetch<TopologyResponse>(`/networks/${selectedNetworkId}/topology`)
      .then((data) => {
        if (!cancelled) setTopology(data)
      })
      .catch(() => {
        if (!cancelled) setTopology(null)
      })
      .finally(() => {
        if (!cancelled) setTopoLoading(false)
      })
    return () => { cancelled = true }
  }, [selectedNetworkId])

  // Initialize Cytoscape when topology data is ready
  useEffect(() => {
    if (!topology || !cyContainerRef.current) return

    // Destroy previous instance
    if (cyRef.current) {
      cyRef.current.destroy()
      cyRef.current = null
    }

    const nodes = topology.nodes || []
    const edges = topology.edges || []

    if (nodes.length === 0) return

    const elements: cytoscape.ElementDefinition[] = [
      ...nodes.map((n) => {
        const statusColor = n.status === 'compromised' ? '#ff6b6b'
                          : n.status === 'offline' ? '#3a4a5c'
                          : '#40c057'
        const deviceIcon = getDeviceSvgDataUri(n.node_type, statusColor)
        const osLogo = getOsLogoDataUri(detectOs(n.os || '', n.os_version || undefined))

        const bgImages = osLogo ? [deviceIcon, osLogo] : [deviceIcon]
        const bgPositionX = osLogo ? ['50%', '82%'] : ['50%']
        const bgPositionY = osLogo ? ['42%', '82%'] : ['42%']
        const bgWidth = osLogo ? ['55%', '24%'] : ['55%']
        const bgHeight = osLogo ? ['55%', '24%'] : ['55%']

        return {
          data: {
            id: n.id,
            label: n.hostname || n.ip_address,
            nodeType: n.node_type,
            status: n.status,
          },
          style: {
            'background-image': bgImages,
            'background-position-x': bgPositionX,
            'background-position-y': bgPositionY,
            'background-width': bgWidth,
            'background-height': bgHeight,
          } as any,
          position: n.position_x != null && n.position_y != null
            ? { x: n.position_x, y: n.position_y }
            : undefined,
        }
      }),
      ...edges.map((e) => ({
        data: {
          id: e.id,
          source: e.source_node_id,
          target: e.target_node_id,
          edgeType: e.edge_type,
          label: e.label || '',
        },
      })),
    ]

    const hasPositions = nodes.some((n) => n.position_x != null && n.position_y != null)

    const cy = cytoscape({
      container: cyContainerRef.current,
      elements,
      style: cyStyle,
      layout: hasPositions
        ? { name: 'preset' }
        : {
            name: 'cose',
            animate: true,
            animationDuration: 500,
            nodeRepulsion: () => 8000,
            idealEdgeLength: () => 120,
            gravity: 0.3,
          } as cytoscape.LayoutOptions,
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.3,
    })

    // Node click
    cy.on('tap', 'node', (evt) => {
      const nodeId = evt.target.data('id') as string
      const nodeData = (topology.nodes || []).find((n) => n.id === nodeId) || null
      setSelectedNode(nodeData)
    })

    // Background click
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        setSelectedNode(null)
      }
    })

    cyRef.current = cy

    return () => {
      cy.destroy()
      cyRef.current = null
    }
  }, [topology])

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
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleCardClick = (networkId: string) => {
    setSelectedNetworkId(networkId)
  }

  const handleBackToGrid = () => {
    setSelectedNetworkId(null)
    setSelectedNode(null)
    if (cyRef.current) {
      cyRef.current.destroy()
      cyRef.current = null
    }
  }

  const handleNodeUpdate = useCallback((updated: NetworkNodeRecord) => {
    setSelectedNode(updated)
    // Refresh topology to update map visuals
    if (selectedNetworkId) {
      apiFetch<TopologyResponse>(`/networks/${selectedNetworkId}/topology`)
        .then(setTopology)
        .catch(() => {})
    }
  }, [selectedNetworkId])

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

  function renderMapView() {
    const networkName = networks.find((n) => n.id === selectedNetworkId)?.name || 'Network'
    const hasNodes = topology && topology.nodes && topology.nodes.length > 0

    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        animation: 'fadeIn 0.3s ease',
      }}>
        {/* Map toolbar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
          flexShrink: 0,
        }}>
          <button
            onClick={handleBackToGrid}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'transparent',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              padding: '6px 10px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              letterSpacing: 0.5,
              color: 'var(--color-text-muted)',
              transition: 'border-color 0.15s ease, color 0.15s ease',
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
            <ChevronLeft size={14} />
            NETWORKS
          </button>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}>
            <Activity size={14} style={{ color: 'var(--color-accent)' }} />
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-text-bright)',
              letterSpacing: 0.5,
            }}>
              {networkName}
            </span>
            {topology && topology.nodes && (
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--color-text-muted)',
                letterSpacing: 0.5,
              }}>
                {topology.nodes.length} NODE{topology.nodes.length !== 1 ? 'S' : ''}
              </span>
            )}
          </div>
        </div>

        {/* Map content */}
        {topoLoading ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            color: 'var(--color-text-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            letterSpacing: 1,
          }}>
            LOADING TOPOLOGY...
          </div>
        ) : !hasNodes ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
          }}>
            <Network size={36} style={{ color: 'var(--color-border-strong)', marginBottom: 14 }} />
            <p style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              letterSpacing: 1,
              color: 'var(--color-text-muted)',
              margin: '0 0 6px 0',
            }}>
              NO NODES DISCOVERED
            </p>
            <p style={{
              fontFamily: 'var(--font-body, var(--font-mono))',
              fontSize: 12,
              color: 'var(--color-text-muted)',
              margin: 0,
              opacity: 0.7,
            }}>
              Import an Nmap scan to populate the topology.
            </p>
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
          }}>
            {/* Cytoscape canvas */}
            <div
              ref={cyContainerRef}
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
                position: 'relative',
                background: '#0a0e14',
              }}
            />
            {/* Node detail panel */}
            {selectedNode && (
              <NodeDetailPanel
                node={selectedNode}
                onClose={() => setSelectedNode(null)}
                onNodeUpdate={handleNodeUpdate}
              />
            )}
          </div>
        )}
      </div>
    )
  }

  // If a network is selected, show the map view
  if (selectedNetworkId) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}>
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".xml,.nmap,.json"
          style={{ display: 'none' }}
          onChange={handleFileSelected}
        />
        {renderMapView()}
        {renderCreateModal()}
        {renderImportResultModal()}
      </div>
    )
  }

  // Grid view (original)
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

