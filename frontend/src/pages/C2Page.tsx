import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { apiFetch } from '../lib/api'
import {
  Shield, Ticket, LogOut, Terminal, RefreshCw, Wifi, WifiOff,
} from 'lucide-react'
import { APP_VERSION } from '../version'
import TerminalPanel from '../components/TerminalPanel'

interface C2Session {
  id: string
  implant_id: string
  hostname: string
  os: string
  arch: string
  remote_addr: string
  transport: string
  is_alive: boolean
  last_message: string
}

interface CommandResult {
  output: string
  error: string
}

const QUICK_COMMANDS = ['ls', 'ps', 'whoami', 'ifconfig', 'netstat', 'pwd']

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = Math.max(0, now - then)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function osLabel(os: string): string {
  const lower = os.toLowerCase()
  if (lower.includes('linux')) return 'Linux'
  if (lower.includes('windows')) return 'Windows'
  if (lower.includes('darwin') || lower.includes('macos') || lower.includes('mac')) return 'macOS'
  return os || 'Unknown'
}

export default function C2Page() {
  const { user, roles, logout } = useAuth()
  const [sessions, setSessions] = useState<C2Session[]>([])
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'terminal' | 'commands'>('terminal')
  const [commandOutput, setCommandOutput] = useState<string>('')
  const [commandLoading, setCommandLoading] = useState(false)
  const [loading, setLoading] = useState(true)

  const fetchSessions = useCallback(async () => {
    try {
      const data = await apiFetch<C2Session[]>('/c2/sessions')
      setSessions(Array.isArray(data) ? data : [])
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch and polling
  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, 10000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  const executeCommand = async (command: string) => {
    if (!selectedSession) return
    setCommandLoading(true)
    setCommandOutput((prev) => prev + `\n$ ${command}\n`)
    try {
      const result = await apiFetch<CommandResult>(
        `/c2/sessions/${selectedSession}/execute`,
        {
          method: 'POST',
          body: JSON.stringify({ command }),
        }
      )
      if (result.error) {
        setCommandOutput((prev) => prev + `[ERROR] ${result.error}\n`)
      } else {
        setCommandOutput((prev) => prev + (result.output || '(no output)\n'))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Command failed'
      setCommandOutput((prev) => prev + `[ERROR] ${msg}\n`)
    } finally {
      setCommandLoading(false)
    }
  }

  const selectedSessionData = sessions.find((s) => s.id === selectedSession)
  const aliveSessions = sessions.filter((s) => s.is_alive).length

  return (
    <div className="app-shell">
      {/* Navbar */}
      <nav className="navbar">
        <div className="navbar-left">
          <Shield size={20} strokeWidth={1.5} className="navbar-icon" />
          <Link to="/" className="navbar-brand">EMS-COP</Link>
          <span className="navbar-version">{APP_VERSION}</span>
          <span className="navbar-sep">|</span>
          <Link to="/tickets" className="navbar-link">
            <Ticket size={14} />
            TICKETS
          </Link>
          <Link to="/c2" className="navbar-link active">
            <Terminal size={14} />
            C2
          </Link>
        </div>
        <div className="navbar-right">
          <div className="user-badge">
            <span className="user-name">{user?.display_name}</span>
            <div className="role-tags">
              {roles.map((role) => (
                <span key={role} className="role-tag">{role.toUpperCase()}</span>
              ))}
            </div>
          </div>
          <button onClick={logout} className="logout-btn" title="Logout">
            <LogOut size={16} />
          </button>
        </div>
      </nav>

      {/* C2 Layout */}
      <div className="c2-layout">
        {/* Left Sidebar — Sessions */}
        <aside className="c2-sidebar">
          <div className="c2-sidebar-header">
            <h2 className="c2-sidebar-title">SESSIONS</h2>
            <div className="c2-sidebar-meta">
              <span className="c2-session-count">
                {aliveSessions} / {sessions.length} alive
              </span>
              <button
                onClick={fetchSessions}
                className="c2-refresh-btn"
                title="Refresh sessions"
              >
                <RefreshCw size={12} />
              </button>
            </div>
          </div>

          <div className="c2-session-list">
            {loading ? (
              <div className="c2-session-empty">Loading sessions...</div>
            ) : sessions.length === 0 ? (
              <div className="c2-session-empty">No sessions found</div>
            ) : (
              sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-item ${selectedSession === session.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedSession(session.id)
                    setCommandOutput('')
                  }}
                >
                  <div className="session-item-top">
                    <span
                      className="session-status"
                      style={{
                        backgroundColor: session.is_alive
                          ? 'var(--color-success)'
                          : 'var(--color-danger)',
                      }}
                    />
                    <span className="session-hostname">{session.hostname || session.implant_id || session.id.slice(0, 8)}</span>
                    {session.is_alive ? (
                      <Wifi size={10} className="session-alive-icon" />
                    ) : (
                      <WifiOff size={10} className="session-dead-icon" />
                    )}
                  </div>
                  <div className="session-info">
                    <span className="session-os">{osLabel(session.os)}</span>
                    <span className="session-sep">&middot;</span>
                    <span className="session-addr">{session.remote_addr || '—'}</span>
                  </div>
                  <div className="session-info">
                    <span className="session-last-seen">{timeAgo(session.last_message)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Right Panel */}
        <div className="c2-main">
          {/* Session header */}
          {selectedSessionData && (
            <div className="c2-session-banner">
              <span
                className="session-status"
                style={{
                  backgroundColor: selectedSessionData.is_alive
                    ? 'var(--color-success)'
                    : 'var(--color-danger)',
                }}
              />
              <span className="c2-banner-host">{selectedSessionData.hostname}</span>
              <span className="c2-banner-detail">
                {osLabel(selectedSessionData.os)} &middot; {selectedSessionData.arch} &middot; {selectedSessionData.transport} &middot; {selectedSessionData.remote_addr}
              </span>
            </div>
          )}

          {/* Tabs */}
          <div className="c2-tabs">
            <button
              className={`c2-tab ${activeTab === 'terminal' ? 'active' : ''}`}
              onClick={() => setActiveTab('terminal')}
            >
              <Terminal size={12} />
              TERMINAL
            </button>
            <button
              className={`c2-tab ${activeTab === 'commands' ? 'active' : ''}`}
              onClick={() => setActiveTab('commands')}
            >
              COMMANDS
            </button>
          </div>

          {/* Tab Content */}
          <div className="c2-tab-content">
            {activeTab === 'terminal' ? (
              <TerminalPanel sessionId={selectedSession} />
            ) : (
              <div className="c2-commands-panel">
                {!selectedSession ? (
                  <div className="terminal-placeholder">
                    <div className="terminal-placeholder-content">
                      <p className="terminal-placeholder-text">Select a session to execute commands</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="cmd-grid">
                      {QUICK_COMMANDS.map((cmd) => (
                        <button
                          key={cmd}
                          className="cmd-btn"
                          onClick={() => executeCommand(cmd)}
                          disabled={commandLoading}
                        >
                          {cmd}
                        </button>
                      ))}
                    </div>
                    <div className="cmd-output-wrap">
                      <div className="cmd-output-header">
                        <span>OUTPUT</span>
                        {commandLoading && <span className="cmd-loading">Executing...</span>}
                      </div>
                      <pre className="cmd-output">
                        {commandOutput || 'Click a command button to execute...'}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
