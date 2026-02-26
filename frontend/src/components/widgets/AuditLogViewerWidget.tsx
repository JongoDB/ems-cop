import { useState, useEffect, useRef, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'
import { useSocket } from '../../hooks/useSocket'

interface AuditEvent {
  id: string
  timestamp: string
  event_type: string
  actor?: string
  actor_name?: string
  description?: string
  message?: string
  details?: Record<string, unknown>
}

const MAX_EVENTS = 500

const TYPE_COLORS: Record<string, string> = {
  auth: '#3b82f6',
  ticket: '#8b5cf6',
  workflow: '#f59e0b',
  operation: '#10b981',
  c2: '#ef4444',
  endpoint: '#60a5fa',
  system: '#6b7280',
}

function getTypeColor(eventType: string): string {
  const prefix = eventType.split('.')[0]
  return TYPE_COLORS[prefix] || '#94a3b8'
}

function unwrap(res: unknown): AuditEvent[] {
  if (Array.isArray(res)) return res
  if (res && typeof res === 'object' && 'data' in res && Array.isArray((res as { data: unknown }).data))
    return (res as { data: AuditEvent[] }).data
  return []
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  } catch {
    return iso
  }
}

export default function AuditLogViewerWidget({ id, config }: WidgetProps) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [paused, setPaused] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const shouldScroll = useRef(true)

  const eventTypeFilter = (config.event_type as string) || ''
  const actorFilter = (config.actor as string) || ''

  const { events: socketEvents } = useSocket('audit.events')

  // Initial fetch
  useEffect(() => {
    apiFetch<unknown>('/audit/events?limit=50')
      .then(res => {
        const data = unwrap(res)
        setEvents(data.slice(-MAX_EVENTS))
      })
      .catch(() => {})
  }, [])

  // Append socket events
  useEffect(() => {
    if (socketEvents.length === 0) return
    const latest = socketEvents[socketEvents.length - 1] as unknown as AuditEvent
    if (!latest || !latest.id) return

    setEvents(prev => {
      // Deduplicate by id
      if (prev.some(e => e.id === latest.id)) return prev
      const next = [...prev, latest]
      return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
    })
  }, [socketEvents.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll
  useEffect(() => {
    if (!paused && shouldScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events, paused])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    shouldScroll.current = scrollHeight - scrollTop - clientHeight < 40
  }, [])

  // Filter events for display
  const displayed = events.filter(e => {
    if (eventTypeFilter && !e.event_type.includes(eventTypeFilter)) return false
    if (actorFilter) {
      const actor = e.actor_name || e.actor || ''
      if (!actor.toLowerCase().includes(actorFilter.toLowerCase())) return false
    }
    return true
  })

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    color: 'var(--color-text-primary)',
    background: 'var(--color-bg-primary)',
    overflow: 'hidden',
  }

  const toolbarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
    borderBottom: '1px solid var(--color-border)',
    fontSize: '10px',
    flexShrink: 0,
  }

  const btnStyle: React.CSSProperties = {
    background: paused ? 'var(--color-accent)' : 'var(--color-bg-elevated)',
    color: paused ? '#fff' : 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '2px 8px',
    fontSize: '10px',
    cursor: 'pointer',
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={toolbarStyle}>
        <span style={{ color: 'var(--color-text-muted)' }}>
          {displayed.length} event{displayed.length !== 1 ? 's' : ''}
        </span>
        <button style={btnStyle} onClick={() => setPaused(p => !p)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
      >
        {displayed.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--color-text-muted)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            No audit events
          </div>
        ) : (
          displayed.map((evt, i) => (
            <div
              key={evt.id || i}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '8px',
                padding: '3px 8px',
                background: i % 2 === 0 ? 'transparent' : 'var(--color-bg-elevated)',
                lineHeight: '18px',
              }}
            >
              <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
                {formatTime(evt.timestamp)}
              </span>
              <span
                style={{
                  display: 'inline-block',
                  padding: '0 5px',
                  borderRadius: '3px',
                  fontSize: '10px',
                  fontWeight: 600,
                  color: '#fff',
                  backgroundColor: getTypeColor(evt.event_type),
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {evt.event_type}
              </span>
              <span style={{ color: 'var(--color-accent)', flexShrink: 0 }}>
                {evt.actor_name || evt.actor || 'system'}
              </span>
              <span
                style={{
                  color: 'var(--color-text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {evt.description || evt.message || ''}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
