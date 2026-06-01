// Top-level error boundary. Catches render errors from the route tree and
// shows a dark-themed fallback that lets the user reload or go home.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, Shield } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', error, info.componentStack)
    } else {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', error.message)
    }
  }

  reset = () => {
    this.setState({ error: null })
  }

  reload = () => {
    window.location.reload()
  }

  goHome = () => {
    window.location.href = '/'
  }

  render() {
    if (!this.state.error) return this.props.children

    const err = this.state.error
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg)',
          padding: 24,
          fontFamily: 'var(--font-body)',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: '100%',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-strong)',
            borderTop: '2px solid var(--color-danger)',
            borderRadius: 'var(--radius)',
            padding: 32,
            textAlign: 'center',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4)',
          }}
        >
          <AlertTriangle
            size={42}
            strokeWidth={1.5}
            style={{ color: 'var(--color-danger)', marginBottom: 14 }}
          />
          <h1
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: 1.5,
              color: 'var(--color-text-bright)',
              margin: '0 0 10px 0',
            }}
          >
            SOMETHING WENT WRONG
          </h1>
          <p
            style={{
              fontSize: 13,
              color: 'var(--color-text-muted)',
              margin: '0 0 18px 0',
              lineHeight: 1.6,
            }}
          >
            An unexpected error occurred while rendering this view.
            Reloading the page usually fixes it. If the problem persists,
            contact your administrator.
          </p>

          {import.meta.env.DEV && err.message && (
            <pre
              style={{
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius)',
                padding: 10,
                margin: '0 0 18px 0',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-danger)',
                overflowX: 'auto',
                textAlign: 'left',
                maxHeight: 160,
              }}
            >
              {err.message}
            </pre>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              onClick={this.reload}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 16px',
                background: 'var(--color-accent)',
                border: 'none',
                borderRadius: 'var(--radius)',
                color: '#0a0e14',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 1,
                cursor: 'pointer',
              }}
            >
              <RefreshCw size={14} />
              RELOAD PAGE
            </button>
            <button
              onClick={this.goHome}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 16px',
                background: 'transparent',
                border: '1px solid var(--color-border-strong)',
                borderRadius: 'var(--radius)',
                color: 'var(--color-text)',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: 1,
                cursor: 'pointer',
              }}
            >
              <Shield size={14} />
              GO HOME
            </button>
          </div>
        </div>
      </div>
    )
  }
}
