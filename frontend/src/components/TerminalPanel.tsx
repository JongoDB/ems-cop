import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getAccessToken } from '../lib/api'

interface TerminalPanelProps {
  sessionId: string | null
}

export default function TerminalPanel({ sessionId }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!sessionId || !containerRef.current) return

    // Create terminal
    const term = new Terminal({
      theme: {
        background: '#0a0e14',
        foreground: '#c5cdd8',
        cursor: '#4dabf7',
        cursorAccent: '#0a0e14',
        selectionBackground: 'rgba(77, 171, 247, 0.3)',
        black: '#0a0e14',
        red: '#ff6b6b',
        green: '#40c057',
        yellow: '#fab005',
        blue: '#4dabf7',
        magenta: '#8b5cf6',
        cyan: '#339af0',
        white: '#c5cdd8',
        brightBlack: '#495867',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffd43b',
        brightBlue: '#74c0fc',
        brightMagenta: '#b197fc',
        brightCyan: '#66d9e8',
        brightWhite: '#e8ecf1',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    // Small delay to let the DOM settle before fitting
    requestAnimationFrame(() => {
      try {
        fitAddon.fit()
      } catch {
        // Ignore fit errors during initialization
      }
    })

    terminalRef.current = term
    fitAddonRef.current = fitAddon

    // Connect WebSocket
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = getAccessToken() || ''
    const wsUrl = `${protocol}//${location.host}/api/v1/c2/sessions/${sessionId}/shell?token=${encodeURIComponent(token)}`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      term.writeln('\x1b[32m[*] Connected to session ' + sessionId.slice(0, 8) + '...\x1b[0m')
      term.writeln('')
    }

    ws.onmessage = (event) => {
      term.write(event.data)
    }

    ws.onerror = () => {
      term.writeln('\x1b[31m[!] WebSocket error\x1b[0m')
    }

    ws.onclose = (event) => {
      term.writeln('')
      term.writeln(`\x1b[33m[*] Connection closed (code: ${event.code})\x1b[0m`)
    }

    // Send terminal input to WebSocket
    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })

    // Handle resize
    const handleResize = () => {
      try {
        fitAddon.fit()
      } catch {
        // Ignore fit errors
      }
    }

    window.addEventListener('resize', handleResize)

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize)
      dataDisposable.dispose()
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      term.dispose()
      terminalRef.current = null
      wsRef.current = null
      fitAddonRef.current = null
    }
  }, [sessionId])

  if (!sessionId) {
    return (
      <div className="terminal-placeholder">
        <div className="terminal-placeholder-content">
          <span className="terminal-placeholder-icon">&#9632;</span>
          <p className="terminal-placeholder-text">Select a session to open terminal</p>
        </div>
      </div>
    )
  }

  return <div ref={containerRef} className="terminal-container" />
}
