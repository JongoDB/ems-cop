import { useState, useEffect, useCallback } from 'react'
import { Link, Outlet, useParams, useLocation, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { ChevronLeft, Eye, Network, Terminal, FileSearch, ScrollText } from 'lucide-react'

interface Operation {
  id: string
  name: string
  status: string
  risk_level: number
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
  { key: 'audit', label: 'AUDIT', icon: ScrollText },
]

export default function OperationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [operation, setOperation] = useState<Operation | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchOperation = useCallback(async () => {
    if (!id) return
    try {
      const data = await apiFetch<{ data: Operation }>(`/operations/${id}`)
      setOperation(data.data)
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
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, animation: 'fadeIn 0.3s ease' }}>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
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
          <span
            className="status-badge"
            style={{
              borderColor: STATUS_COLORS[operation.status] || '#6b7280',
              color: STATUS_COLORS[operation.status] || '#6b7280',
            }}
          >
            {operation.status.replace(/_/g, ' ').toUpperCase()}
          </span>
        </div>
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
      <div style={{ flex: 1, padding: '24px 0', minHeight: 0 }}>
        <Outlet context={{ operation, refresh: fetchOperation }} />
      </div>
    </div>
  )
}
