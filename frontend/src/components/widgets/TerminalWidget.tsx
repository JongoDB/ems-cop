import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useSocketStore } from '../../stores/socketStore'
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

type TerminalStatus = 'idle' | 'connecting' | 'ready' | 'closed' | 'error'

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
  gap: 8,
  padding: '6px 8px',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
}

const selectStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--color-bg-elevated)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  outline: 'none',
}

const statusDotStyle = (color: string): React.CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: color,
  flexShrink: 0,
})

const termContainerStyle: React.CSSProperties = {
  flex: 1,
  position: 'relative',
  overflow: 'hidden',
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(13, 17, 23, 0.85)',
  color: 'var(--color-text-muted)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  zIndex: 10,
}

export default function TerminalWidget({ id, config: _config }: WidgetProps) {
  const termRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  const [sessions, setSessions] = useState<C2Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const activeSessionRef = useRef<string | null>(null)
  activeSessionRef.current = activeSessionId

  // Fetch sessions
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await apiFetch<{ sessions: C2Session[] }>('/c2/sessions')
        if (!cancelled) setSessions(res.sessions ?? [])
      } catch {
        // silently ignore — sessions list just stays empty
      }
    }
    load()
    const interval = setInterval(load, 30000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  // Initialize xterm
  useEffect(() => {
    if (!termRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#4ade80',
        selectionBackground: '#264f78',
        black: '#0d1117',
        red: '#ef4444',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#c9d1d9',
        brightBlack: '#6e7681',
        brightRed: '#ff7b72',
        brightGreen: '#7ee787',
        brightYellow: '#fde68a',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      scrollback: 1000,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(termRef.current)

    // Delay initial fit to ensure container is laid out
    requestAnimationFrame(() => {
      try { fitAddon.fit() } catch { /* ignore */ }
    })

    terminalRef.current = term
    fitAddonRef.current = fitAddon

    return () => {
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  // ResizeObserver for auto-fit
  useEffect(() => {
    const el = termRef.current
    if (!el) return

    const ro = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit()
        const term = terminalRef.current
        if (term && activeSessionRef.current) {
          useSocketStore.getState().terminalResize(
            activeSessionRef.current,
            term.cols,
            term.rows
          )
        }
      } catch { /* ignore */ }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Handle terminal data input
  useEffect(() => {
    const term = terminalRef.current
    if (!term) return

    const disposable = term.onData((data) => {
      const sid = activeSessionRef.current
      if (sid) {
        useSocketStore.getState().terminalInput(sid, data)
      }
    })
    return () => disposable.dispose()
  }, [])

  // Socket event handlers
  useEffect(() => {
    const store = useSocketStore.getState()

    const cleanupData = store.onTerminalData((sessionId, data) => {
      if (sessionId === activeSessionRef.current && terminalRef.current) {
        terminalRef.current.write(data)
      }
    })

    const cleanupReady = store.onTerminalReady((sessionId) => {
      if (sessionId === activeSessionRef.current) {
        setStatus('ready')
        terminalRef.current?.focus()
        // Send initial resize
        const term = terminalRef.current
        if (term) {
          store.terminalResize(sessionId, term.cols, term.rows)
        }
      }
    })

    const cleanupClosed = store.onTerminalClosed((sessionId) => {
      if (sessionId === activeSessionRef.current) {
        setStatus('closed')
      }
    })

    const cleanupError = store.onTerminalError((msg) => {
      setErrorMsg(msg)
      setStatus('error')
    })

    return () => {
      cleanupData()
      cleanupReady()
      cleanupClosed()
      cleanupError()
    }
  }, [])

  // Select session handler
  const selectSession = useCallback((sessionId: string | null) => {
    const store = useSocketStore.getState()
    const prevId = activeSessionRef.current

    // Close previous
    if (prevId) {
      store.terminalClose(prevId)
    }

    // Clear terminal
    terminalRef.current?.clear()

    if (!sessionId) {
      setActiveSessionId(null)
      setStatus('idle')
      return
    }

    setActiveSessionId(sessionId)
    setStatus('connecting')
    setErrorMsg(null)
    store.terminalOpen(sessionId)
  }, [])

  // Listen to widgetEventBus for session selection
  useEffect(() => {
    const unsub = useWidgetEventBus.subscribe((state) => {
      const busSessionId = state.selectedSessionId
      if (busSessionId && busSessionId !== activeSessionRef.current) {
        selectSession(busSessionId)
      }
    })
    return unsub
  }, [selectSession])

  // Listen for pending commands
  useEffect(() => {
    const unsub = useWidgetEventBus.subscribe((state) => {
      if (state.pendingCommand && activeSessionRef.current && status === 'ready') {
        const cmd = useWidgetEventBus.getState().consumeCommand()
        if (cmd && terminalRef.current) {
          useSocketStore.getState().terminalInput(activeSessionRef.current, cmd + '\n')
        }
      }
    })
    return unsub
  }, [status])

  // Cleanup session on unmount
  useEffect(() => {
    return () => {
      const sid = activeSessionRef.current
      if (sid) {
        useSocketStore.getState().terminalClose(sid)
      }
    }
  }, [])

  const statusColor = status === 'ready' ? '#4ade80'
    : status === 'connecting' ? '#facc15'
    : status === 'error' ? '#ef4444'
    : status === 'closed' ? '#6e7681'
    : '#6e7681'

  const statusLabel = status === 'ready' ? 'Connected'
    : status === 'connecting' ? 'Connecting...'
    : status === 'error' ? 'Error'
    : status === 'closed' ? 'Disconnected'
    : 'No session'

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={headerStyle}>
        <div style={statusDotStyle(statusColor)} title={statusLabel} />
        <select
          style={selectStyle}
          value={activeSessionId ?? ''}
          onChange={(e) => selectSession(e.target.value || null)}
        >
          <option value="">Select session...</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.hostname} ({s.os}) — {s.transport} — {s.remote_addr}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
          {statusLabel}
        </span>
      </div>

      <div style={termContainerStyle}>
        <div ref={termRef} style={{ width: '100%', height: '100%' }} />

        {status === 'idle' && (
          <div style={overlayStyle}>
            Select a session to connect
          </div>
        )}

        {status === 'closed' && (
          <div style={overlayStyle}>
            Session disconnected
          </div>
        )}

        {status === 'error' && (
          <div style={overlayStyle}>
            {errorMsg || 'Terminal error'}
          </div>
        )}
      </div>
    </div>
  )
}
