import { useState, useEffect, useCallback, useMemo } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'
import { useSocket } from '../../hooks/useSocket'
import { useWidgetEventBus } from '../../stores/widgetEventBus'

interface Endpoint {
  id: string
  hostname: string
  addresses?: string[]
  ip_address?: string
  ip_addresses?: Array<{ address: string; version?: number; interface?: string }> | null
  os?: string
  operating_system?: string
  health_status?: string
  status?: string
  last_checkin?: string
  last_seen?: string
  first_seen?: string
  environment?: string
  architecture?: string
}

type SortField = 'hostname' | 'ip' | 'os' | 'health' | 'last_checkin'
type SortDir = 'asc' | 'desc'

const HEALTH_COLORS: Record<string, string> = {
  healthy: '#22c55e',
  degraded: '#f59e0b',
  unreachable: '#ef4444',
  unknown: '#6b7280',
}

function unwrap(res: unknown): Endpoint[] {
  if (Array.isArray(res)) return res
  if (res && typeof res === 'object' && 'data' in res && Array.isArray((res as { data: unknown }).data))
    return (res as { data: Endpoint[] }).data
  return []
}

function getIP(ep: Endpoint): string {
  if (ep.ip_addresses && Array.isArray(ep.ip_addresses) && ep.ip_addresses.length > 0)
    return ep.ip_addresses[0].address
  if (ep.addresses && ep.addresses.length > 0) return ep.addresses[0]
  return ep.ip_address || '--'
}

function getOS(ep: Endpoint): string {
  return ep.os || ep.operating_system || '--'
}

function getHealth(ep: Endpoint): string {
  return ep.health_status || ep.status || 'unknown'
}

function getCheckin(ep: Endpoint): string {
  const raw = ep.last_checkin || ep.last_seen
  if (!raw) return '--'
  try {
    const d = new Date(raw)
    return (
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    )
  } catch {
    return raw
  }
}

export default function EndpointTableWidget({ id }: WidgetProps) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [loading, setLoading] = useState(false)
  const [sortField, setSortField] = useState<SortField>('hostname')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const navigateToEndpoint = useWidgetEventBus(s => s.navigateToEndpoint)
  const { events: endpointEvents } = useSocket('endpoint.*')

  const fetchEndpoints = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<unknown>('/endpoints')
      setEndpoints(unwrap(res))
    } catch {
      setEndpoints([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchEndpoints()
  }, [fetchEndpoints])

  // Refetch on socket events
  useEffect(() => {
    if (endpointEvents.length > 0) fetchEndpoints()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointEvents.length])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const sorted = useMemo(() => {
    const arr = [...endpoints]
    const dir = sortDir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      let va = ''
      let vb = ''
      switch (sortField) {
        case 'hostname':
          va = a.hostname || ''
          vb = b.hostname || ''
          break
        case 'ip':
          va = getIP(a)
          vb = getIP(b)
          break
        case 'os':
          va = getOS(a)
          vb = getOS(b)
          break
        case 'health':
          va = getHealth(a)
          vb = getHealth(b)
          break
        case 'last_checkin':
          va = a.last_checkin || a.last_seen || ''
          vb = b.last_checkin || b.last_seen || ''
          break
      }
      return va.localeCompare(vb) * dir
    })
    return arr
  }, [endpoints, sortField, sortDir])

  const arrow = (field: SortField) => {
    if (sortField !== field) return ''
    return sortDir === 'asc' ? ' \u25B2' : ' \u25BC'
  }

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
    cursor: 'pointer',
    userSelect: 'none',
  }

  const tdStyle: React.CSSProperties = {
    padding: '5px 8px',
    borderBottom: '1px solid var(--color-border)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {loading && endpoints.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
            }}
          >
            Loading endpoints...
          </div>
        ) : endpoints.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
            }}
          >
            No endpoints registered
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle} onClick={() => handleSort('hostname')}>
                  Hostname{arrow('hostname')}
                </th>
                <th style={thStyle} onClick={() => handleSort('ip')}>
                  IP{arrow('ip')}
                </th>
                <th style={thStyle} onClick={() => handleSort('os')}>
                  OS{arrow('os')}
                </th>
                <th style={thStyle} onClick={() => handleSort('health')}>
                  Health{arrow('health')}
                </th>
                <th style={thStyle} onClick={() => handleSort('last_checkin')}>
                  Last Checkin{arrow('last_checkin')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(ep => {
                const health = getHealth(ep)
                return (
                  <tr
                    key={ep.id}
                    onClick={() => navigateToEndpoint(ep.id)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={e => {
                      ;(e.currentTarget as HTMLElement).style.background = 'var(--color-bg-elevated)'
                    }}
                    onMouseLeave={e => {
                      ;(e.currentTarget as HTMLElement).style.background = ''
                    }}
                  >
                    <td style={tdStyle}>{ep.hostname}</td>
                    <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                      {getIP(ep)}
                    </td>
                    <td style={tdStyle}>{getOS(ep)}</td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                        }}
                      >
                        <span
                          style={{
                            width: '7px',
                            height: '7px',
                            borderRadius: '50%',
                            backgroundColor: HEALTH_COLORS[health] || '#6b7280',
                            flexShrink: 0,
                          }}
                        />
                        {health}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--color-text-muted)' }}>
                      {getCheckin(ep)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
