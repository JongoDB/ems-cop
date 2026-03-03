import { useState, useEffect, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'
import SeverityBadge from '../SeverityBadge'

interface Incident {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  status: string
  created_at: string
}

function timeSince(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diff = now - then
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
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

export default function IncidentTimelineWidget({ id }: WidgetProps) {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading] = useState(true)

  const fetchIncidents = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: Incident[] }>(
        '/tickets/incidents?status=new,investigating,containing,contained,remediating&sort=created_at&order=desc&limit=20'
      )
      setIncidents(res.data || [])
    } catch {
      setIncidents([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchIncidents()
    const interval = setInterval(fetchIncidents, 30_000)
    return () => clearInterval(interval)
  }, [fetchIncidents])

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    color: 'var(--color-text-primary)',
    background: 'var(--color-bg-primary)',
    overflow: 'hidden',
  }

  if (loading) {
    return (
      <div data-widget-id={id} style={containerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
          Loading incidents...
        </div>
      </div>
    )
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
        {incidents.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
            No active incidents
          </div>
        ) : (
          incidents.map((incident, index) => (
            <div
              key={incident.id}
              style={{
                display: 'flex',
                gap: 12,
                paddingBottom: 12,
                marginBottom: 12,
                borderBottom: index < incidents.length - 1 ? '1px solid var(--color-border)' : undefined,
              }}
            >
              {/* Timeline dot and line */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12 }}>
                <div style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: STATUS_COLORS[incident.status] || '#6b7280',
                  flexShrink: 0,
                  marginTop: 4,
                }} />
                {index < incidents.length - 1 && (
                  <div style={{
                    width: 1,
                    flex: 1,
                    background: 'var(--color-border)',
                    marginTop: 4,
                  }} />
                )}
              </div>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <SeverityBadge severity={incident.severity} />
                  <span
                    className="status-badge"
                    style={{
                      borderColor: STATUS_COLORS[incident.status] || '#6b7280',
                      color: STATUS_COLORS[incident.status] || '#6b7280',
                      fontSize: 9,
                    }}
                  >
                    {incident.status.toUpperCase()}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--color-text-muted)',
                    marginLeft: 'auto',
                  }}>
                    {timeSince(incident.created_at)}
                  </span>
                </div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-text-bright)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {incident.title}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
