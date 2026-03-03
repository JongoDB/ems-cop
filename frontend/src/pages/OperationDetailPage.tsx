import { useState, useEffect, useCallback } from 'react'
import { Link, Outlet, useParams, useLocation, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { ChevronLeft, Eye, Network, Terminal, FileSearch, ScrollText, GitBranch, ArrowRightLeft } from 'lucide-react'
import ClassificationBadge from '../components/ClassificationBadge'
import { useEnclaveStore } from '../stores/enclaveStore'

interface Operation {
  id: string
  name: string
  status: string
  risk_level: number
  classification?: string
  routing_mode?: 'local' | 'cross-domain'
  linked_operation_id?: string
  origin_enclave?: 'low' | 'high'
  cross_domain_command_count?: number
  transfer_status?: string
  objective: string
  network_count: number
  finding_count: number
  created_by: string
  created_at: string
  updated_at: string
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

const TABS = [
  { key: '', label: 'OVERVIEW', icon: Eye },
  { key: 'networks', label: 'NETWORKS', icon: Network },
  { key: 'c2', label: 'C2', icon: Terminal },
  { key: 'findings', label: 'FINDINGS', icon: FileSearch },
  { key: 'workflow', label: 'WORKFLOW', icon: GitBranch },
  { key: 'audit', label: 'AUDIT', icon: ScrollText },
]

export default function OperationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { isHighSide } = useEnclaveStore()
  const [operation, setOperation] = useState<Operation | null>(null)
  const [loading, setLoading] = useState(true)
  const [routeLoading, setRouteLoading] = useState(false)

  const fetchOperation = useCallback(async () => {
    if (!id) return
    try {
      const data = await apiFetch<Operation>(`/operations/${id}`)
      setOperation(data)
    } catch {
      setOperation(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchOperation()
  }, [fetchOperation])

  // Determine active tab from the URL
  const basePath = `/operations/${id}`
  const subPath = location.pathname.replace(basePath, '').replace(/^\//, '')
  const activeTab = subPath || ''

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)', letterSpacing: 1 }}>
          LOADING OPERATION...
        </span>
      </div>
    )
  }

  if (!operation) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--color-danger)', letterSpacing: 1 }}>
          OPERATION NOT FOUND
        </span>
        <Link to="/operations" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-accent)', textDecoration: 'none' }}>
          &larr; Back to Operations
        </Link>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0, minWidth: 0, overflow: 'hidden', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 0 }}>
        <Link
          to="/operations"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: 1,
            color: 'var(--color-text-muted)',
            textDecoration: 'none',
            transition: 'color 150ms',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-accent)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-muted)')}
        >
          <ChevronLeft size={14} />
          OPERATIONS
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <h1 style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: 2,
            color: 'var(--color-text-bright)',
            margin: 0,
          }}>
            {operation.name}
          </h1>
          <ClassificationBadge classification={operation.classification} size="md" />
          <span
            className="status-badge"
            style={{
              borderColor: STATUS_COLORS[operation.status] || '#6b7280',
              color: STATUS_COLORS[operation.status] || '#6b7280',
            }}
          >
            {operation.status.replace(/_/g, ' ').toUpperCase()}
          </span>
          <span
            className="status-badge"
            style={{
              borderColor: operation.routing_mode === 'cross-domain' ? '#3b82f6' : '#6b7280',
              color: operation.routing_mode === 'cross-domain' ? '#3b82f6' : '#6b7280',
              fontSize: 9,
            }}
          >
            {operation.routing_mode === 'cross-domain' ? 'CROSS-DOMAIN' : 'LOCAL'}
          </span>
          {/* Route Cross-Domain button (high side only, local ops only) */}
          {isHighSide && operation.routing_mode !== 'cross-domain' && (
            <button
              onClick={async () => {
                setRouteLoading(true)
                try {
                  await apiFetch(`/operations/${id}/route`, { method: 'POST' })
                  fetchOperation()
                } catch {
                  // error handled
                } finally {
                  setRouteLoading(false)
                }
              }}
              disabled={routeLoading}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 12px',
                background: 'rgba(59,130,246,0.1)',
                border: '1px solid rgba(59,130,246,0.4)',
                borderRadius: 'var(--radius)',
                color: '#3b82f6',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: 0.5,
                cursor: routeLoading ? 'wait' : 'pointer',
                opacity: routeLoading ? 0.6 : 1,
              }}
            >
              <ArrowRightLeft size={12} />
              {routeLoading ? 'ROUTING...' : 'ROUTE CROSS-DOMAIN'}
            </button>
          )}
        </div>
        {/* Cross-domain status section */}
        {operation.routing_mode === 'cross-domain' && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '8px 12px',
            background: 'rgba(59,130,246,0.05)',
            border: '1px solid rgba(59,130,246,0.15)',
            borderRadius: 'var(--radius)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            flexWrap: 'wrap',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <ArrowRightLeft size={10} style={{ color: '#3b82f6' }} />
              <span style={{ color: 'var(--color-text-muted)', letterSpacing: 0.5 }}>CROSS-DOMAIN</span>
            </div>
            {operation.origin_enclave && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Origin:</span>
                <span style={{
                  color: operation.origin_enclave === 'low' ? '#3b82f6' : '#40c057',
                  fontWeight: 600,
                }}>
                  {operation.origin_enclave.toUpperCase()}
                </span>
              </div>
            )}
            {operation.linked_operation_id && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Linked:</span>
                <span style={{ color: 'var(--color-text-bright)' }}>
                  {operation.linked_operation_id.slice(0, 8)}...
                </span>
              </div>
            )}
            {typeof operation.cross_domain_command_count === 'number' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Commands:</span>
                <span style={{ color: 'var(--color-text-bright)', fontWeight: 600 }}>
                  {operation.cross_domain_command_count}
                </span>
              </div>
            )}
            {operation.transfer_status && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: 'var(--color-text-muted)' }}>Transfer:</span>
                <span style={{
                  color: operation.transfer_status === 'active' ? '#40c057'
                    : operation.transfer_status === 'pending' ? '#f59e0b'
                    : 'var(--color-text-bright)',
                  fontWeight: 600,
                }}>
                  {operation.transfer_status.toUpperCase()}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tab Bar */}
      <div className="c2-tabs" style={{ marginTop: 16 }}>
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`c2-tab${activeTab === key ? ' active' : ''}`}
            onClick={() => navigate(key ? `${basePath}/${key}` : basePath)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '24px 0', minHeight: 0 }}>
        <Outlet context={{ operation, refresh: fetchOperation }} />
      </div>
    </div>
  )
}
