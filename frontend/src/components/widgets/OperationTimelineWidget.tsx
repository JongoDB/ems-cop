import { useState, useEffect, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'
import { ChevronDown } from 'lucide-react'

interface Operation {
  id: string
  name?: string
  title?: string
  status: string
  phase?: string
  created_at: string
  updated_at: string
}

interface AuditEvent {
  id: string
  timestamp: string
  event_type: string
  description?: string
  message?: string
  actor?: string
  actor_name?: string
}

interface TimelineEntry {
  id: string
  timestamp: string
  label: string
  description: string
  isCurrent: boolean
}

const PHASE_COLORS: Record<string, string> = {
  planning: '#3b82f6',
  approval: '#f59e0b',
  execution: '#8b5cf6',
  reporting: '#10b981',
  completed: '#22c55e',
  cancelled: '#ef4444',
  active: '#22c55e',
  paused: '#f59e0b',
  draft: '#6b7280',
}

function getPhaseColor(phase: string): string {
  return PHASE_COLORS[phase?.toLowerCase()] || 'var(--color-accent)'
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    return (
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    )
  } catch {
    return iso
  }
}

function unwrapList<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res
  if (res && typeof res === 'object' && 'data' in res) {
    const d = (res as { data: unknown }).data
    if (Array.isArray(d)) return d
  }
  return []
}

export default function OperationTimelineWidget({ id, config, onConfigChange }: WidgetProps) {
  const operationId = (config.operation_id as string) || ''

  const [operations, setOperations] = useState<Operation[]>([])
  const [operation, setOperation] = useState<Operation | null>(null)
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  // Fetch operations list for selector
  useEffect(() => {
    apiFetch<unknown>('/operations?limit=50')
      .then(res => setOperations(unwrapList<Operation>(res)))
      .catch(() => setOperations([]))
  }, [])

  const selectOperation = useCallback(
    (opId: string) => {
      onConfigChange?.({ ...config, operation_id: opId })
      setDropdownOpen(false)
    },
    [config, onConfigChange],
  )

  // Fetch operation details + audit events
  useEffect(() => {
    if (!operationId) {
      setOperation(null)
      setTimeline([])
      return
    }

    setLoading(true)

    const fetchOp = apiFetch<Operation | { data: Operation }>(`/operations/${operationId}`)
      .then(res => {
        const op = (res && typeof res === 'object' && 'data' in res)
          ? (res as { data: Operation }).data
          : res as Operation
        setOperation(op)
        return op
      })
      .catch(() => null)

    const fetchEvents = apiFetch<unknown>(
      `/audit/events?resource_type=operation&resource_id=${operationId}&limit=50`,
    )
      .then(res => unwrapList<AuditEvent>(res))
      .catch(() => [] as AuditEvent[])

    Promise.all([fetchOp, fetchEvents]).then(([op, events]) => {
      const entries: TimelineEntry[] = []

      if (op) {
        entries.push({
          id: 'created',
          timestamp: op.created_at,
          label: 'Created',
          description: `Operation "${op.name || op.title || op.id}" created`,
          isCurrent: false,
        })
      }

      // Add audit events
      events.forEach(evt => {
        entries.push({
          id: evt.id,
          timestamp: evt.timestamp,
          label: evt.event_type.replace(/^operation\./, '').replace(/_/g, ' '),
          description: evt.description || evt.message || evt.event_type,
          isCurrent: false,
        })
      })

      if (op) {
        entries.push({
          id: 'current',
          timestamp: op.updated_at,
          label: op.phase || op.status,
          description: `Current: ${op.phase ? `Phase: ${op.phase}, ` : ''}Status: ${op.status}`,
          isCurrent: true,
        })
      }

      // Sort by timestamp
      entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

      // Mark only the last as current
      if (entries.length > 0) {
        entries.forEach(e => (e.isCurrent = false))
        entries[entries.length - 1].isCurrent = true
      }

      setTimeline(entries)
      setLoading(false)
    })
  }, [operationId])

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

  const selectorBarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 8px',
    borderBottom: '1px solid var(--color-border)',
    fontSize: '10px',
    flexShrink: 0,
    position: 'relative',
  }

  const dropdownBtnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '3px 8px',
    fontSize: '10px',
    cursor: 'pointer',
    maxWidth: '220px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }

  const dropdownMenuStyle: React.CSSProperties = {
    position: 'absolute',
    top: '100%',
    left: '8px',
    zIndex: 100,
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    maxHeight: '200px',
    overflow: 'auto',
    minWidth: '200px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  }

  const dropdownItemStyle = (active: boolean): React.CSSProperties => ({
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: '11px',
    background: active ? 'var(--color-accent)' : 'transparent',
    color: active ? '#fff' : 'var(--color-text-primary)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  })

  const selectedOp = operations.find(o => o.id === operationId)
  const selectedLabel = selectedOp
    ? selectedOp.name || selectedOp.title || selectedOp.id.slice(0, 8)
    : 'Select operation...'

  if (!operationId) {
    return (
      <div data-widget-id={id} style={containerStyle}>
        <div style={selectorBarStyle}>
          <span style={{ color: 'var(--color-text-muted)' }}>Operation:</span>
          <button style={dropdownBtnStyle} onClick={() => setDropdownOpen(o => !o)}>
            {selectedLabel}
            <ChevronDown size={12} />
          </button>
          {dropdownOpen && (
            <div style={dropdownMenuStyle}>
              {operations.length === 0 ? (
                <div style={{ padding: '8px 10px', color: 'var(--color-text-muted)', fontSize: '10px' }}>
                  No operations found
                </div>
              ) : (
                operations.map(op => (
                  <div
                    key={op.id}
                    style={dropdownItemStyle(op.id === operationId)}
                    onClick={() => selectOperation(op.id)}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-primary)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                  >
                    {op.name || op.title || op.id.slice(0, 8)} — {op.status}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--color-text-muted)',
          }}
        >
          Select an operation to view its timeline
        </div>
      </div>
    )
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      {/* Selector bar */}
      <div style={selectorBarStyle}>
        <span style={{ color: 'var(--color-text-muted)' }}>Operation:</span>
        <button style={dropdownBtnStyle} onClick={() => setDropdownOpen(o => !o)}>
          {selectedLabel}
          <ChevronDown size={12} />
        </button>
        {dropdownOpen && (
          <div style={dropdownMenuStyle}>
            {operations.map(op => (
              <div
                key={op.id}
                style={dropdownItemStyle(op.id === operationId)}
                onClick={() => selectOperation(op.id)}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-primary)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                {op.name || op.title || op.id.slice(0, 8)} — {op.status}
              </div>
            ))}
          </div>
        )}
        {operation && (
          <span
            style={{
              marginLeft: 'auto',
              display: 'inline-block',
              padding: '1px 6px',
              borderRadius: '9999px',
              fontSize: '10px',
              fontWeight: 600,
              color: '#fff',
              backgroundColor: getPhaseColor(operation.phase || operation.status),
            }}
          >
            {operation.phase || operation.status}
          </span>
        )}
      </div>

      {/* Timeline content */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '12px 16px' }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
            Loading timeline...
          </div>
        ) : timeline.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
            No timeline data
          </div>
        ) : (
          <div style={{ position: 'relative', paddingLeft: '24px' }}>
            {/* Vertical line */}
            <div
              style={{
                position: 'absolute',
                left: '7px',
                top: '4px',
                bottom: '4px',
                width: '2px',
                background: 'var(--color-border)',
              }}
            />
            {timeline.map((entry, i) => {
              const dotColor = entry.isCurrent
                ? getPhaseColor(operation?.phase || operation?.status || '')
                : 'var(--color-text-muted)'
              return (
                <div
                  key={entry.id + '-' + i}
                  style={{
                    position: 'relative',
                    marginBottom: i < timeline.length - 1 ? '16px' : 0,
                    paddingLeft: '12px',
                  }}
                >
                  {/* Dot */}
                  <div
                    style={{
                      position: 'absolute',
                      left: '-20px',
                      top: '3px',
                      width: entry.isCurrent ? '12px' : '8px',
                      height: entry.isCurrent ? '12px' : '8px',
                      borderRadius: '50%',
                      background: dotColor,
                      border: entry.isCurrent ? '2px solid var(--color-bg-primary)' : 'none',
                      boxShadow: entry.isCurrent ? `0 0 8px ${dotColor}` : 'none',
                    }}
                  />
                  {/* Timestamp */}
                  <div
                    style={{
                      fontSize: '10px',
                      color: 'var(--color-text-muted)',
                      fontFamily: 'var(--font-mono)',
                      marginBottom: '2px',
                    }}
                  >
                    {formatTimestamp(entry.timestamp)}
                  </div>
                  {/* Label */}
                  <div
                    style={{
                      fontSize: '11px',
                      fontWeight: entry.isCurrent ? 600 : 400,
                      color: entry.isCurrent ? 'var(--color-accent)' : 'var(--color-text-primary)',
                      textTransform: 'capitalize',
                    }}
                  >
                    {entry.label}
                  </div>
                  {/* Description */}
                  <div
                    style={{
                      fontSize: '10px',
                      color: 'var(--color-text-muted)',
                      marginTop: '1px',
                    }}
                  >
                    {entry.description}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
