import { useEffect, useState, useCallback } from 'react'
import {
  Laptop,
  Monitor,
  Smartphone,
  Wifi,
  WifiOff,
  RefreshCw,
} from 'lucide-react'
import { useSocket } from '../../hooks/useSocket'
import { useWidgetEventBus } from '../../stores/widgetEventBus'
import { apiFetch } from '../../lib/api'
import type { WidgetProps } from './WidgetRegistry'

interface C2Session {
  id: string
  name: string
  hostname: string
  os: string
  transport: string
  remote_addr: string
  last_checkin: string
  status: string
  pid: number
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
  overflow: 'hidden',
  fontFamily: 'var(--font-sans)',
  background: 'var(--color-bg-primary)',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '6px 8px',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
}

const titleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  background: 'var(--color-accent)',
  color: '#fff',
  borderRadius: 8,
  padding: '1px 6px',
  fontWeight: 600,
  lineHeight: '16px',
}

const tableContainerStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
}

const rowStyle = (selected: boolean): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: '20px 1fr 60px 70px 80px',
  gap: 4,
  padding: '5px 8px',
  alignItems: 'center',
  cursor: 'pointer',
  fontSize: 11,
  borderBottom: '1px solid var(--color-border)',
  background: selected ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
  transition: 'background 0.1s',
})

const statusBadge = (status: string): React.CSSProperties => {
  const color = status === 'active' ? '#4ade80'
    : status === 'dormant' ? '#facc15'
    : '#ef4444'
  return {
    fontSize: 10,
    color,
    border: `1px solid ${color}`,
    borderRadius: 4,
    padding: '1px 5px',
    textAlign: 'center',
    lineHeight: '14px',
  }
}

const emptyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: 'var(--color-text-muted)',
  fontSize: 12,
  gap: 8,
}

const errorStyle: React.CSSProperties = {
  ...emptyStyle,
  color: '#ef4444',
}

const refreshBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--color-text-muted)',
  cursor: 'pointer',
  padding: 4,
  borderRadius: 4,
  display: 'flex',
  alignItems: 'center',
}

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  if (diff < 0) return 'just now'
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function OsIcon({ os }: { os: string }) {
  const lower = os.toLowerCase()
  if (lower.includes('windows') || lower.includes('win')) {
    return <Monitor size={14} style={{ color: '#60a5fa' }} />
  }
  if (lower.includes('android') || lower.includes('ios') || lower.includes('mobile')) {
    return <Smartphone size={14} style={{ color: '#c084fc' }} />
  }
  return <Laptop size={14} style={{ color: '#4ade80' }} />
}

export default function SliverC2PanelWidget({ id }: WidgetProps) {
  const [sessions, setSessions] = useState<C2Session[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const selectedSessionId = useWidgetEventBus(s => s.selectedSessionId)
  const selectSession = useWidgetEventBus(s => s.selectSession)

  // Live updates via socket
  const { events } = useSocket('c2.session.*')

  const fetchSessions = useCallback(async () => {
    try {
      const res = await apiFetch<{ sessions: C2Session[] }>('/c2/sessions')
      setSessions(res.sessions ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  // Auto-refresh every 30s
  useEffect(() => {
    const interval = setInterval(fetchSessions, 30000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  // Process live events to update session list
  useEffect(() => {
    if (events.length === 0) return
    // On any c2 session event, just refetch for simplicity
    fetchSessions()
  }, [events.length, fetchSessions])

  const activeSessions = sessions.filter(s => s.status === 'active')

  if (error && sessions.length === 0) {
    return (
      <div data-widget-id={id} style={containerStyle}>
        <div style={headerStyle}>
          <span style={titleStyle}>C2 Sessions</span>
        </div>
        <div style={errorStyle}>
          <WifiOff size={24} />
          <span>{error}</span>
          <button style={refreshBtnStyle} onClick={fetchSessions}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>
          C2 Sessions
          <span style={badgeStyle}>{activeSessions.length}</span>
        </span>
        <button
          style={refreshBtnStyle}
          onClick={fetchSessions}
          title="Refresh sessions"
        >
          <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
        </button>
      </div>

      {sessions.length === 0 ? (
        <div style={emptyStyle}>
          <Wifi size={24} style={{ opacity: 0.4 }} />
          <span>No active sessions</span>
        </div>
      ) : (
        <div style={tableContainerStyle}>
          {/* Column headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '20px 1fr 60px 70px 80px',
            gap: 4,
            padding: '4px 8px',
            fontSize: 10,
            color: 'var(--color-text-muted)',
            borderBottom: '1px solid var(--color-border)',
            position: 'sticky',
            top: 0,
            background: 'var(--color-bg-primary)',
            zIndex: 1,
          }}>
            <span />
            <span>Host</span>
            <span>Transport</span>
            <span>Checkin</span>
            <span>Status</span>
          </div>

          {sessions.map((session) => (
            <div
              key={session.id}
              style={rowStyle(session.id === selectedSessionId)}
              onClick={() => selectSession(session.id)}
              onMouseEnter={(e) => {
                if (session.id !== selectedSessionId) {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
                }
              }}
              onMouseLeave={(e) => {
                if (session.id !== selectedSessionId) {
                  e.currentTarget.style.background = 'transparent'
                }
              }}
              title={`PID: ${session.pid}\nAddr: ${session.remote_addr}\nName: ${session.name}`}
            >
              <OsIcon os={session.os} />
              <span style={{
                color: 'var(--color-text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono)',
              }}>
                {session.hostname}
              </span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {session.transport}
              </span>
              <span style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                {relativeTime(session.last_checkin)}
              </span>
              <span style={statusBadge(session.status)}>
                {session.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
