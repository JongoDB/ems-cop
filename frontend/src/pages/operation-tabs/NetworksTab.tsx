import { Network } from 'lucide-react'

export default function NetworksTab() {
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
      <Network size={32} style={{ color: 'var(--color-border-strong)', marginBottom: 12 }} />
      <p style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        letterSpacing: 1,
        color: 'var(--color-text-muted)',
        margin: 0,
      }}>
        Network map coming in Phase 2 (M4b)
      </p>
    </div>
  )
}
