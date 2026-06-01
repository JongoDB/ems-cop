// Friendly empty-state block. Shown inside table cells (use <td colSpan>) or
// as a stand-alone block.

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: ReactNode
  action?: ReactNode
  compact?: boolean
}

export default function EmptyState({ icon: Icon, title, description, action, compact }: EmptyStateProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: compact ? '28px 16px' : '48px 16px',
        textAlign: 'center',
        gap: 8,
      }}
    >
      <Icon
        size={compact ? 32 : 44}
        strokeWidth={1.25}
        style={{ color: 'var(--color-border-strong)', marginBottom: 4 }}
      />
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: compact ? 12 : 13,
          letterSpacing: 1,
          color: 'var(--color-text-bright)',
        }}
      >
        {title}
      </div>
      {description && (
        <div
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: 12,
            color: 'var(--color-text-muted)',
            maxWidth: 420,
            lineHeight: 1.6,
          }}
        >
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: 6 }}>{action}</div>}
    </div>
  )
}

// Lightweight shimmer rows for tables. Pass `rows` and `cols` to match
// the surrounding table structure.
export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="ticket-row" style={{ pointerEvents: 'none' }}>
          {Array.from({ length: cols }).map((__, c) => (
            <td key={c}>
              <div className="skel-bar" style={{ width: `${50 + ((r + c) * 13) % 40}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}
