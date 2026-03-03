import { useState, useEffect, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'

interface IOCHit {
  id: string
  ioc_type: string
  value: string
  threat_level: string
  match_count: number
  last_seen: string
}

const THREAT_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  info: '#6b7280',
}

export default function IOCHitsWidget({ id }: WidgetProps) {
  const [iocs, setIOCs] = useState<IOCHit[]>([])
  const [loading, setLoading] = useState(true)

  const fetchIOCs = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: IOCHit[] }>(
        '/endpoints/iocs?sort=last_seen&order=desc&limit=20'
      )
      setIOCs(res.data || [])
    } catch {
      setIOCs([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchIOCs()
    const interval = setInterval(fetchIOCs, 30_000)
    return () => clearInterval(interval)
  }, [fetchIOCs])

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

  const thStyle: React.CSSProperties = {
    padding: '6px 8px',
    textAlign: 'left',
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    borderBottom: '1px solid var(--color-border)',
    whiteSpace: 'nowrap',
    fontSize: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  }

  const tdStyle: React.CSSProperties = {
    padding: '5px 8px',
    borderBottom: '1px solid var(--color-border)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    } catch {
      return iso
    }
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {loading && iocs.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
            Loading IOCs...
          </div>
        ) : iocs.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
            No IOC hits
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Value</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Threat</th>
                <th style={thStyle}>Hits</th>
                <th style={thStyle}>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {iocs.map((ioc) => (
                <tr key={ioc.id}>
                  <td style={{ ...tdStyle, maxWidth: 180, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                    {ioc.value}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      padding: '1px 4px',
                      borderRadius: '9999px',
                      fontSize: 9,
                      fontWeight: 600,
                      background: 'var(--color-bg-elevated)',
                      color: 'var(--color-text-muted)',
                    }}>
                      {ioc.ioc_type}
                    </span>
                  </td>
                  <td style={tdStyle}>
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
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                    {ioc.match_count}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--color-text-muted)', fontSize: 10 }}>
                    {formatDate(ioc.last_seen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
