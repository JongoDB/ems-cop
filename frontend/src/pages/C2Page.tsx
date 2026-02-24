import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { apiFetch } from '../lib/api'
import {
  Shield, Ticket, LogOut, Terminal, RefreshCw, Wifi, WifiOff,
  Plus, Lock, Pencil, Trash2, X,
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

interface CommandPreset {
  id: string
  name: string
  command: string
  description: string
  os: string
  scope: string
  created_by: string | null
  sort_order: number
}

const FALLBACK_COMMANDS: CommandPreset[] = [
  { id: 'f1', name: 'ls', command: 'ls', description: 'List files', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f2', name: 'ps', command: 'ps', description: 'Processes', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f3', name: 'whoami', command: 'whoami', description: 'Current user', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f4', name: 'pwd', command: 'pwd', description: 'Working directory', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f5', name: 'ifconfig', command: 'ifconfig', description: 'Interfaces', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f6', name: 'netstat', command: 'netstat', description: 'Network stats', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
]

function detectOS(os: string): 'linux' | 'windows' | 'macos' {
  const lower = os.toLowerCase()
  if (lower.includes('windows')) return 'windows'
  if (lower.includes('darwin') || lower.includes('macos') || lower.includes('mac')) return 'macos'
  return 'linux'
}

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

  // Command presets
  const [presets, setPresets] = useState<CommandPreset[]>([])
  const [showPresetModal, setShowPresetModal] = useState(false)
  const [editingPreset, setEditingPreset] = useState<CommandPreset | null>(null)
  const [presetForm, setPresetForm] = useState({ name: '', command: '', description: '', scope: 'user' })

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; preset: CommandPreset } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const isAdmin = roles.includes('admin')

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

  const selectedSessionData = sessions.find((s) => s.id === selectedSession)
  const sessionOS = selectedSessionData ? detectOS(selectedSessionData.os) : 'linux'

  const fetchPresets = useCallback(async () => {
    try {
      const data = await apiFetch<{ data: CommandPreset[] }>(`/commands/presets?os=${sessionOS}`)
      setPresets(data.data && data.data.length > 0 ? data.data : FALLBACK_COMMANDS)
    } catch {
      setPresets(FALLBACK_COMMANDS)
    }
  }, [sessionOS])

  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, 10000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  useEffect(() => {
    if (selectedSession) {
      fetchPresets()
    }
  }, [selectedSession, fetchPresets])

  useEffect(() => {
    const handleClick = () => setContextMenu(null)
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

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

  const handlePresetSubmit = async () => {
    if (!presetForm.name || !presetForm.command) return
    try {
      if (editingPreset) {
        await apiFetch(`/commands/presets/${editingPreset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: presetForm.name,
            command: presetForm.command,
            description: presetForm.description,
          }),
        })
      } else {
        await apiFetch('/commands/presets', {
          method: 'POST',
          body: JSON.stringify({
            name: presetForm.name,
            command: presetForm.command,
            description: presetForm.description,
            os: sessionOS,
            scope: presetForm.scope,
          }),
        })
      }
      setShowPresetModal(false)
      setEditingPreset(null)
      setPresetForm({ name: '', command: '', description: '', scope: 'user' })
      fetchPresets()
    } catch (err) {
      console.error('Failed to save preset:', err)
    }
  }

  const handleDeletePreset = async (preset: CommandPreset) => {
    if (!confirm(`Delete "${preset.name}"?`)) return
    try {
      await apiFetch(`/commands/presets/${preset.id}`, { method: 'DELETE' })
      fetchPresets()
    } catch (err) {
      console.error('Failed to delete preset:', err)
    }
  }

  const openEditModal = (preset: CommandPreset) => {
    setEditingPreset(preset)
    setPresetForm({
      name: preset.name,
      command: preset.command,
      description: preset.description,
      scope: preset.scope,
    })
    setShowPresetModal(true)
    setContextMenu(null)
  }

  const openAddModal = () => {
    setEditingPreset(null)
    setPresetForm({ name: '', command: '', description: '', scope: 'user' })
    setShowPresetModal(true)
  }

  const canEditPreset = (preset: CommandPreset) => {
    if (preset.scope === 'global') return isAdmin
    return preset.created_by === user?.id
  }

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
                      {presets.map((preset) => (
                        <button
                          key={preset.id}
                          className="cmd-btn"
                          onClick={() => executeCommand(preset.command)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            if (canEditPreset(preset)) {
                              setContextMenu({ x: e.clientX, y: e.clientY, preset })
                            }
                          }}
                          disabled={commandLoading}
                          title={`${preset.description}\n\n$ ${preset.command}`}
                        >
                          {preset.scope === 'global' && <Lock size={8} className="cmd-scope-icon" />}
                          {preset.name}
                        </button>
                      ))}
                      <button
                        className="cmd-btn cmd-add-btn"
                        onClick={openAddModal}
                        title="Add custom command"
                      >
                        <Plus size={14} />
                      </button>
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

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="cmd-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className="cmd-context-item"
            onClick={() => openEditModal(contextMenu.preset)}
          >
            <Pencil size={12} /> Edit
          </button>
          <button
            className="cmd-context-item cmd-context-danger"
            onClick={() => {
              handleDeletePreset(contextMenu.preset)
              setContextMenu(null)
            }}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}

      {/* Add/Edit Preset Modal */}
      {showPresetModal && (
        <div className="modal-overlay" onClick={() => setShowPresetModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{editingPreset ? 'EDIT COMMAND' : 'ADD COMMAND'}</h3>
              <button className="modal-close" onClick={() => setShowPresetModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">NAME</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Open Ports"
                  value={presetForm.name}
                  onChange={(e) => setPresetForm({ ...presetForm, name: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">COMMAND</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. ss -tlnp"
                  value={presetForm.command}
                  onChange={(e) => setPresetForm({ ...presetForm, command: e.target.value })}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="form-group">
                <label className="form-label">DESCRIPTION</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Short description for tooltip"
                  value={presetForm.description}
                  onChange={(e) => setPresetForm({ ...presetForm, description: e.target.value })}
                />
              </div>
              {!editingPreset && isAdmin && (
                <div className="form-group">
                  <label className="form-label">SCOPE</label>
                  <select
                    className="form-input"
                    value={presetForm.scope}
                    onChange={(e) => setPresetForm({ ...presetForm, scope: e.target.value })}
                  >
                    <option value="user">Personal (only you)</option>
                    <option value="global">Global (all operators)</option>
                  </select>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="submit-btn" onClick={handlePresetSubmit}>
                {editingPreset ? 'SAVE' : 'ADD COMMAND'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
