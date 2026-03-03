import { ShieldCheck, Shield, ShieldAlert } from 'lucide-react'
import { useEnclaveStore } from '../stores/enclaveStore'
import type { Classification } from './ClassificationBadge'

interface ClassificationFilterProps {
  value: Classification | null
  onChange: (value: Classification | null) => void
  enclave?: 'low' | 'high' | null
}

const FILTER_OPTIONS: {
  value: Classification | null
  label: string
  icon: typeof Shield | null
  activeColor: string
}[] = [
  { value: null, label: 'ALL', icon: null, activeColor: 'var(--color-accent)' },
  { value: 'UNCLASS', label: 'UNCLASS', icon: ShieldCheck, activeColor: '#22c55e' },
  { value: 'CUI', label: 'CUI', icon: Shield, activeColor: '#f59e0b' },
  { value: 'SECRET', label: 'SECRET', icon: ShieldAlert, activeColor: '#ef4444' },
]

export default function ClassificationFilter({
  value,
  onChange,
  enclave,
}: ClassificationFilterProps) {
  const storeEnclave = useEnclaveStore((s) => s.enclave)
  const effectiveEnclave = enclave !== undefined ? enclave : storeEnclave

  // If low-side enclave, hide SECRET option
  const visibleOptions = effectiveEnclave === 'low'
    ? FILTER_OPTIONS.filter((o) => o.value !== 'SECRET')
    : FILTER_OPTIONS

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        background: 'var(--color-bg-surface)',
      }}
    >
      {visibleOptions.map((opt, idx) => {
        const isActive = value === opt.value
        const Icon = opt.icon
        return (
          <button
            key={opt.label}
            onClick={() => onChange(opt.value)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.05em',
              cursor: 'pointer',
              border: 'none',
              borderRight: idx < visibleOptions.length - 1 ? '1px solid var(--color-border)' : 'none',
              background: isActive ? 'rgba(255,255,255,0.06)' : 'transparent',
              color: isActive ? opt.activeColor : 'var(--color-text-muted)',
              transition: 'background 150ms, color 150ms',
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.background = 'transparent'
            }}
          >
            {Icon && <Icon size={11} />}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
