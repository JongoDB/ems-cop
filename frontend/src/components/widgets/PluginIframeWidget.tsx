import { useState, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { ExternalLink, Pencil, AlertTriangle } from 'lucide-react'

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export default function PluginIframeWidget({ id, config, onConfigChange }: WidgetProps) {
  const configuredUrl = (config.url as string) || ''

  const [inputUrl, setInputUrl] = useState(configuredUrl)
  const [editing, setEditing] = useState(!configuredUrl)
  const [iframeError, setIframeError] = useState(false)
  const [validationError, setValidationError] = useState('')

  const saveUrl = useCallback(() => {
    const trimmed = inputUrl.trim()
    if (!trimmed) {
      setValidationError('URL is required')
      return
    }
    if (!isValidUrl(trimmed)) {
      setValidationError('URL must start with http:// or https://')
      return
    }
    setValidationError('')
    setIframeError(false)
    setEditing(false)
    onConfigChange?.({ ...config, url: trimmed })
  }, [inputUrl, config, onConfigChange])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveUrl()
  }

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
    position: 'relative',
  }

  const inputStyle: React.CSSProperties = {
    flex: 1,
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '6px 10px',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    outline: 'none',
  }

  const btnStyle: React.CSSProperties = {
    background: 'var(--color-accent)',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    padding: '6px 14px',
    fontSize: '11px',
    fontWeight: 600,
    cursor: 'pointer',
  }

  // Config form (no URL or editing)
  if (editing || !configuredUrl) {
    return (
      <div data-widget-id={id} style={containerStyle}>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '24px',
          }}
        >
          <ExternalLink size={28} style={{ color: 'var(--color-text-muted)' }} />
          <div style={{ color: 'var(--color-text-muted)', fontSize: '12px' }}>
            Enter a URL to embed
          </div>
          <div style={{ display: 'flex', gap: '8px', width: '100%', maxWidth: '400px' }}>
            <input
              type="text"
              value={inputUrl}
              onChange={e => {
                setInputUrl(e.target.value)
                setValidationError('')
              }}
              onKeyDown={handleKeyDown}
              placeholder="https://example.com"
              style={inputStyle}
              autoFocus
            />
            <button style={btnStyle} onClick={saveUrl}>
              Load
            </button>
          </div>
          {validationError && (
            <div style={{ color: '#ef4444', fontSize: '10px' }}>{validationError}</div>
          )}
          {configuredUrl && (
            <button
              onClick={() => {
                setEditing(false)
                setInputUrl(configuredUrl)
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--color-text-muted)',
                cursor: 'pointer',
                fontSize: '10px',
                textDecoration: 'underline',
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    )
  }

  // Iframe view
  return (
    <div data-widget-id={id} style={containerStyle}>
      {/* Edit button */}
      <button
        onClick={() => {
          setInputUrl(configuredUrl)
          setEditing(true)
        }}
        title="Edit URL"
        style={{
          position: 'absolute',
          top: '4px',
          right: '4px',
          zIndex: 10,
          background: 'var(--color-bg-elevated)',
          color: 'var(--color-text-muted)',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          padding: '3px 6px',
          fontSize: '10px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '3px',
          opacity: 0.7,
          transition: 'opacity 0.15s',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.7' }}
      >
        <Pencil size={10} />
        Edit
      </button>

      {iframeError ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            color: 'var(--color-text-muted)',
          }}
        >
          <AlertTriangle size={24} style={{ color: '#ef4444' }} />
          <div style={{ fontSize: '12px', color: '#ef4444' }}>Failed to load iframe</div>
          <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', maxWidth: '300px', textAlign: 'center', wordBreak: 'break-all' }}>
            {configuredUrl}
          </div>
          <button
            style={{ ...btnStyle, fontSize: '10px', padding: '4px 10px' }}
            onClick={() => {
              setIframeError(false)
              setInputUrl(configuredUrl)
              setEditing(true)
            }}
          >
            Change URL
          </button>
        </div>
      ) : (
        <iframe
          src={configuredUrl}
          sandbox="allow-scripts allow-same-origin"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            background: '#fff',
          }}
          title={`Plugin: ${configuredUrl}`}
          onError={() => setIframeError(true)}
        />
      )}
    </div>
  )
}
