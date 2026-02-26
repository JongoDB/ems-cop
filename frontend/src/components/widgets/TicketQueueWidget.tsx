import { useState, useEffect, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'
import { useSocket } from '../../hooks/useSocket'
import { useWidgetEventBus } from '../../stores/widgetEventBus'

interface Ticket {
  id: string
  title: string
  status: string
  priority: string
  assignee?: { id: string; display_name?: string; username?: string } | null
  assignee_id?: string
  assignee_name?: string
  updated_at: string
}

interface PaginationInfo {
  page: number
  limit: number
  total: number
}

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280',
  submitted: '#3b82f6',
  in_review: '#f59e0b',
  approved: '#22c55e',
  in_progress: '#8b5cf6',
  completed: '#10b981',
  closed: '#6b7280',
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#22c55e',
}

const PAGE_SIZE = 20

function unwrapTickets(res: unknown): { data: Ticket[]; pagination: PaginationInfo | null } {
  if (Array.isArray(res)) return { data: res, pagination: null }
  if (res && typeof res === 'object' && 'data' in res) {
    const obj = res as { data: Ticket[]; pagination?: PaginationInfo }
    return { data: obj.data || [], pagination: obj.pagination || null }
  }
  return { data: [], pagination: null }
}

export default function TicketQueueWidget({ id, config }: WidgetProps) {
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [pagination, setPagination] = useState<PaginationInfo | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)

  const navigateToTicket = useWidgetEventBus(s => s.navigateToTicket)
  const { events: ticketEvents } = useSocket('ticket.*')

  const filter = (config.filter as Record<string, string>) || {}

  const fetchTickets = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(PAGE_SIZE))
      if (filter.status) params.set('status', filter.status)
      if (filter.priority) params.set('priority', filter.priority)
      if (filter.assignee_id) params.set('assignee_id', filter.assignee_id)

      const res = await apiFetch<unknown>(`/tickets?${params.toString()}`)
      const { data, pagination: pag } = unwrapTickets(res)
      setTickets(data)
      setPagination(pag)
    } catch {
      setTickets([])
    } finally {
      setLoading(false)
    }
  }, [page, filter.status, filter.priority, filter.assignee_id])

  useEffect(() => {
    fetchTickets()
  }, [fetchTickets])

  // Refetch on socket events
  useEffect(() => {
    if (ticketEvents.length > 0) fetchTickets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketEvents.length])

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchTickets, 30_000)
    return () => clearInterval(interval)
  }, [fetchTickets])

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso)
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    } catch {
      return iso
    }
  }

  const getAssigneeName = (t: Ticket) =>
    t.assignee?.display_name || t.assignee?.username || t.assignee_name || t.assignee_id || '--'

  const badgeStyle = (color: string): React.CSSProperties => ({
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: '9999px',
    fontSize: '10px',
    fontWeight: 600,
    color: '#fff',
    backgroundColor: color,
    whiteSpace: 'nowrap',
  })

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

  const totalPages = pagination ? Math.ceil(pagination.total / pagination.limit) : null

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {loading && tickets.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
            }}
          >
            Loading tickets...
          </div>
        ) : tickets.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
            }}
          >
            No tickets
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Title</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Priority</th>
                <th style={thStyle}>Assignee</th>
                <th style={thStyle}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map(t => (
                <tr
                  key={t.id}
                  onClick={() => navigateToTicket(t.id)}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={e => {
                    ;(e.currentTarget as HTMLElement).style.background = 'var(--color-bg-elevated)'
                  }}
                  onMouseLeave={e => {
                    ;(e.currentTarget as HTMLElement).style.background = ''
                  }}
                >
                  <td style={{ ...tdStyle, maxWidth: '200px' }}>{t.title}</td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(STATUS_COLORS[t.status] || '#6b7280')}>
                      {t.status.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={badgeStyle(PRIORITY_COLORS[t.priority] || '#6b7280')}>
                      {t.priority}
                    </span>
                  </td>
                  <td style={tdStyle}>{getAssigneeName(t)}</td>
                  <td style={{ ...tdStyle, color: 'var(--color-text-muted)' }}>
                    {formatDate(t.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 8px',
          borderTop: '1px solid var(--color-border)',
          fontSize: '10px',
          color: 'var(--color-text-muted)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page <= 1}
          style={{
            background: 'none',
            border: 'none',
            color: page <= 1 ? 'var(--color-border)' : 'var(--color-accent)',
            cursor: page <= 1 ? 'default' : 'pointer',
            fontSize: '10px',
            padding: '2px 6px',
          }}
        >
          Prev
        </button>
        <span>
          Page {page}
          {totalPages !== null && ` of ${totalPages}`}
        </span>
        <button
          onClick={() => setPage(p => p + 1)}
          disabled={totalPages !== null && page >= totalPages}
          style={{
            background: 'none',
            border: 'none',
            color:
              totalPages !== null && page >= totalPages
                ? 'var(--color-border)'
                : 'var(--color-accent)',
            cursor:
              totalPages !== null && page >= totalPages ? 'default' : 'pointer',
            fontSize: '10px',
            padding: '2px 6px',
          }}
        >
          Next
        </button>
      </div>
    </div>
  )
}
