import { Terminal } from 'lucide-react'

export default function C2Tab() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 60,
      background: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-border)',
      animation: 'fadeIn 0.3s ease',
    }}>
      <Terminal size={32} style={{ color: 'var(--color-border-strong)', marginBottom: 12 }} />
      <p style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        letterSpacing: 1,
        color: 'var(--color-text-muted)',
        margin: 0,
      }}>
        C2 integration coming in Phase 3 (M4c)
      </p>
    </div>
  )
}
