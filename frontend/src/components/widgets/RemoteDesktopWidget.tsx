import { useState, useRef, useCallback, useEffect } from 'react'
import { Monitor, Settings, Wifi, WifiOff, Maximize2, Camera } from 'lucide-react'
import RFB from '@novnc/novnc/core/rfb'
import { getAccessToken } from '../../lib/api'
import { useWidgetEventBus } from '../../stores/widgetEventBus'
import type { WidgetProps } from './WidgetRegistry'

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
  overflow: 'hidden',
  fontFamily: 'var(--font-sans)',
  background: '#000',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  background: 'var(--color-bg-primary)',
}

const settingsRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '0 8px 6px',
}

const inputStyle: React.CSSProperties = {
  background: 'var(--color-bg-elevated)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--color-text-muted)',
  minWidth: 50,
}

const btnStyle: React.CSSProperties = {
  background: 'var(--color-bg-elevated)',
  color: 'var(--color-text-muted)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '5px 12px',
  fontSize: 11,
  cursor: 'pointer',
}

const statusDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  flexShrink: 0,
}

export default function RemoteDesktopWidget({ id, config, onConfigChange }: WidgetProps) {
  const [host, setHost] = useState<string>((config.host as string) ?? '')
  const [port, setPort] = useState<string>((config.port as string) ?? '5900')
  const [password, setPassword] = useState<string>((config.password as string) ?? '')
  const [showSettings, setShowSettings] = useState(false)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)

  // Listen for VNC target selection from other widgets
  const vncTarget = useWidgetEventBus((s) => s.selectedVncTarget)
  useEffect(() => {
    if (vncTarget) {
      setHost(vncTarget.host)
      setPort(String(vncTarget.port))
    }
  }, [vncTarget])

  const disconnect = useCallback(() => {
    if (rfbRef.current) {
      rfbRef.current.disconnect()
      rfbRef.current = null
    }
    setConnected(false)
    setConnecting(false)
    setError(null)
  }, [])

  const connectVNC = useCallback(() => {
    if (!host || !containerRef.current) return
    disconnect()
    setConnecting(true)
    setError(null)

    const token = getAccessToken()
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/api/v1/c2/vnc/${host}/${port}?token=${token}`

    try {
      const rfb = new RFB(containerRef.current, url, {
        credentials: { password: password || undefined },
      })
      rfb.scaleViewport = true
      rfb.resizeSession = false
      rfb.background = '#0a0e14'

      rfb.addEventListener('connect', () => {
        setConnected(true)
        setConnecting(false)
      })
      rfb.addEventListener('disconnect', (e: CustomEvent) => {
        setConnected(false)
        setConnecting(false)
        if (e.detail?.clean === false) {
          setError('Connection lost')
        }
      })
      rfb.addEventListener('securityfailure', (e: CustomEvent) => {
        setError(`Auth failed: ${e.detail?.reason || 'unknown'}`)
        setConnecting(false)
      })

      rfbRef.current = rfb
    } catch (err) {
      setError((err as Error).message)
      setConnecting(false)
    }
  }, [host, port, password, disconnect])

  // Cleanup on unmount
  useEffect(() => () => disconnect(), [disconnect])

  const saveSettings = () => {
    onConfigChange?.({ ...config, host, port, password })
    setShowSettings(false)
  }

  const takeScreenshot = () => {
    if (!rfbRef.current) return
    const canvas = containerRef.current?.querySelector('canvas')
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `vnc-${host}-${Date.now()}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={headerStyle}>
        <Monitor size={14} />
        <span>Remote Desktop</span>
        <div style={{ ...statusDot, background: connected ? 'var(--color-success)' : connecting ? 'var(--color-warning)' : 'var(--color-text-muted)' }} />
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', fontWeight: 400 }}>
          {connected ? `${host}:${port}` : connecting ? 'Connecting...' : 'Disconnected'}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {connected && (
            <>
              <button style={{ ...btnStyle, padding: '2px 6px' }} onClick={takeScreenshot} title="Screenshot">
                <Camera size={12} />
              </button>
              <button
                style={{ ...btnStyle, padding: '2px 6px' }}
                onClick={() => { if (rfbRef.current) rfbRef.current.scaleViewport = !rfbRef.current.scaleViewport }}
                title="Toggle scaling"
              >
                <Maximize2 size={12} />
              </button>
            </>
          )}
          {connected ? (
            <button style={{ ...btnStyle, padding: '2px 6px', color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }} onClick={disconnect}>
              <WifiOff size={12} />
            </button>
          ) : (
            <button
              style={{ ...btnStyle, padding: '2px 6px', color: host ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
              onClick={connectVNC}
              disabled={!host || connecting}
            >
              <Wifi size={12} />
            </button>
          )}
          <button
            style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 10, padding: '2px 4px' }}
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings size={12} />
          </button>
        </span>
      </div>

      {showSettings && (
        <div style={{ borderBottom: '1px solid var(--color-border)', padding: '6px 0', background: 'var(--color-bg-primary)' }}>
          <div style={settingsRowStyle}>
            <span style={labelStyle}>Host</span>
            <input
              style={{ ...inputStyle, flex: 1 }}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="10.101.1.10"
              spellCheck={false}
            />
          </div>
          <div style={settingsRowStyle}>
            <span style={labelStyle}>Port</span>
            <input
              style={{ ...inputStyle, width: 70 }}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="5900"
            />
          </div>
          <div style={settingsRowStyle}>
            <span style={labelStyle}>Password</span>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="VNC password"
            />
          </div>
          <div style={{ ...settingsRowStyle, justifyContent: 'flex-end' }}>
            <button style={{ ...btnStyle, color: 'var(--color-text-primary)' }} onClick={saveSettings}>
              Save
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{
          padding: '6px 10px', fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--color-danger)', background: 'rgba(255,107,107,0.08)',
          borderBottom: '1px solid rgba(255,107,107,0.2)',
        }}>
          {error}
        </div>
      )}

      <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {!connected && !connecting && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 12,
            background: 'var(--color-bg-primary)',
          }}>
            <Monitor size={48} style={{ color: 'var(--color-text-muted)', opacity: 0.3 }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              Remote Desktop
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: '18px' }}>
              {host ? `Ready to connect to ${host}:${port}` : 'Configure a target host in settings'}
            </span>
            {host && (
              <button
                style={{ ...btnStyle, cursor: 'pointer', opacity: 1, color: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}
                onClick={connectVNC}
              >
                Connect
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
