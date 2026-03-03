import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'
import { useSocket } from '../hooks/useSocket'
import SeverityBadge from './SeverityBadge'
import MitreBadge from './MitreBadge'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface Alert {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  source_system: string
  status: string
  mitre_techniques?: string[]
  raw_payload?: Record<string, unknown>
  created_at: string
}

interface AlertFeedProps {
  limit?: number
  className?: string
}

export default function AlertFeed({ limit = 20, className = '' }: AlertFeedProps) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const { events } = useSocket('alert.*')

  const fetchAlerts = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      params.set('limit', String(limit))
      params.set('sort', 'created_at')
      params.set('order', 'desc')
      const res = await apiFetch<{ data: Alert[] }>(`/endpoints/alerts?${params.toString()}`)
      setAlerts(res.data || [])
    } catch {
      setAlerts([])
    } finally {
      setLoading(false)
    }
  }, [limit])

  useEffect(() => {
    fetchAlerts()
    const interval = setInterval(fetchAlerts, 30000)
    return () => clearInterval(interval)
  }, [fetchAlerts])

  // Re-fetch on socket events
  useEffect(() => {
    if (events.length > 0) fetchAlerts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length])

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch {
      return iso
    }
  }

  return (
    <div className={className}>
      {loading ? (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)', padding: 8 }}>
          Loading alerts...
        </div>
      ) : alerts.length === 0 ? (
        <div style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)', padding: 8 }}>
          No alerts
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {alerts.map((alert) => (
            <div
              key={alert.id}
              style={{
                padding: '6px 8px',
                borderBottom: '1px solid var(--color-border)',
                cursor: 'pointer',
                animation: 'fadeIn 0.3s ease',
              }}
              onClick={() => setExpandedId(expandedId === alert.id ? null : alert.id)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                <SeverityBadge severity={alert.severity} />
                <span style={{
                  flex: 1,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-text-bright)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {alert.title}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--color-text-muted)',
                  whiteSpace: 'nowrap',
                }}>
                  {alert.source_system}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--color-text-muted)',
                  whiteSpace: 'nowrap',
                }}>
                  {formatTime(alert.created_at)}
                </span>
                {alert.mitre_techniques && alert.mitre_techniques.length > 0 && (
                  <MitreBadge techniques={alert.mitre_techniques} />
                )}
                {expandedId === alert.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </div>

              {expandedId === alert.id && alert.raw_payload && (
                <pre style={{
                  marginTop: 6,
                  padding: 8,
                  background: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--color-text-muted)',
                  overflow: 'auto',
                  maxHeight: 200,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>
                  {JSON.stringify(alert.raw_payload, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
