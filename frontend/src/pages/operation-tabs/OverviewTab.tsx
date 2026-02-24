import { useOutletContext } from 'react-router-dom'
import { Network, FileSearch, AlertTriangle, Calendar } from 'lucide-react'

interface Operation {
  id: string
  name: string
  status: string
  risk_level: number
  objective: string
  network_count: number
  finding_count: number
  created_at: string
  updated_at: string
}

const RISK_COLORS: Record<number, string> = {
  1: '#40c057',
  2: '#3b82f6',
  3: '#f59e0b',
  4: '#f97316',
  5: '#ef4444',
}

const RISK_LABELS: Record<number, string> = {
  1: 'MINIMAL',
  2: 'LOW',
  3: 'MODERATE',
  4: 'HIGH',
  5: 'CRITICAL',
}

export default function OverviewTab() {
  const { operation } = useOutletContext<{ operation: Operation; refresh: () => void }>()

  return (
    <div style={{ display: 'flex', gap: 24, animation: 'fadeIn 0.3s ease' }}>
      {/* Left column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Stats cards */}
        <div className="stats-row">
          <div className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Network size={16} style={{ color: 'var(--color-accent)' }} />
              <span className="stat-label">NETWORKS</span>
            </div>
            <span className="stat-value">{operation.network_count ?? 0}</span>
          </div>
          <div className="stat-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <FileSearch size={16} style={{ color: 'var(--color-warning)' }} />
              <span className="stat-label">FINDINGS</span>
            </div>
            <span className="stat-value">{operation.finding_count ?? 0}</span>
          </div>
        </div>

        {/* Objective */}
        <div style={{
          padding: 20,
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
        }}>
          <h3 className="detail-section-title">OBJECTIVE</h3>
          <p style={{
            margin: 0,
            fontSize: 13,
            lineHeight: 1.7,
            color: 'var(--color-text)',
          }}>
            {operation.objective || 'No objective defined.'}
          </p>
        </div>

        {/* Meta info */}
        <div style={{
          padding: 20,
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border)',
        }}>
          <h3 className="detail-section-title">DETAILS</h3>
          <div className="detail-meta" style={{ borderBottom: 'none', paddingBottom: 0, marginBottom: 0 }}>
            <div className="meta-row">
              <span className="meta-label">RISK LEVEL</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertTriangle size={12} style={{ color: RISK_COLORS[operation.risk_level] || '#6b7280' }} />
                <span
                  className="status-badge"
                  style={{
                    borderColor: RISK_COLORS[operation.risk_level] || '#6b7280',
                    color: RISK_COLORS[operation.risk_level] || '#6b7280',
                  }}
                >
                  LEVEL {operation.risk_level} - {RISK_LABELS[operation.risk_level] || 'UNKNOWN'}
                </span>
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-label">CREATED</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Calendar size={12} style={{ color: 'var(--color-text-muted)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}>
                  {new Date(operation.created_at).toLocaleString()}
                </span>
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-label">LAST UPDATED</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)' }}>
                {new Date(operation.updated_at).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Right column */}
      <div style={{
        width: 320,
        flexShrink: 0,
        padding: 20,
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border)',
        alignSelf: 'flex-start',
      }}>
        <h3 className="detail-section-title">RECENT ACTIVITY</h3>
        <p style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--color-text-muted)',
          margin: 0,
          letterSpacing: 0.5,
        }}>
          Activity feed coming in a future phase.
        </p>
      </div>
    </div>
  )
}
