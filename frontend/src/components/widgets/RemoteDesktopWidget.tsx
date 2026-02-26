import { useState } from 'react'
import { Monitor } from 'lucide-react'
import type { WidgetProps } from './WidgetRegistry'

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
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
}

const mainStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: 24,
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
  cursor: 'not-allowed',
  opacity: 0.6,
}

const summaryStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-muted)',
  fontFamily: 'var(--font-mono)',
}

export default function RemoteDesktopWidget({ id, config, onConfigChange }: WidgetProps) {
  const [host, setHost] = useState<string>((config.host as string) ?? '')
  const [port, setPort] = useState<string>((config.port as string) ?? '5900')
  const [password, setPassword] = useState<string>((config.password as string) ?? '')
  const [showSettings, setShowSettings] = useState(false)

  const saveSettings = () => {
    onConfigChange?.({ ...config, host, port, password })
    setShowSettings(false)
  }

  const configured = Boolean(host)

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={headerStyle}>
        <Monitor size={14} />
        <span>Remote Desktop</span>
        <span style={{ marginLeft: 'auto' }}>
          <button
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              fontSize: 10,
              textDecoration: 'underline',
            }}
            onClick={() => setShowSettings(!showSettings)}
          >
            {showSettings ? 'Hide Settings' : 'Settings'}
          </button>
        </span>
      </div>

      {showSettings && (
        <div style={{ borderBottom: '1px solid var(--color-border)', padding: '6px 0' }}>
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
              placeholder="optional"
            />
          </div>
          <div style={{ ...settingsRowStyle, justifyContent: 'flex-end' }}>
            <button
              style={{
                ...btnStyle,
                cursor: 'pointer',
                opacity: 1,
                color: 'var(--color-text-primary)',
              }}
              onClick={saveSettings}
            >
              Save
            </button>
          </div>
        </div>
      )}

      <div style={mainStyle}>
        <Monitor size={48} style={{ color: 'var(--color-text-muted)', opacity: 0.3 }} />
        <span style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--color-text-primary)',
        }}>
          Remote Desktop
        </span>
        <span style={{
          fontSize: 11,
          color: 'var(--color-text-muted)',
          textAlign: 'center',
          lineHeight: '18px',
        }}>
          Coming in M6 — noVNC integration for graphical sessions
        </span>

        {configured && (
          <div style={summaryStyle}>
            {host}:{port}
          </div>
        )}

        <button
          style={btnStyle}
          disabled
          title="Available in M6"
        >
          Test Connection
        </button>
      </div>
    </div>
  )
}
