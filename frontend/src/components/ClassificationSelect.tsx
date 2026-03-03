import { useEnclaveStore } from '../stores/enclaveStore'
import type { Classification } from './ClassificationBadge'

interface ClassificationSelectProps {
  value: Classification
  onChange: (value: Classification) => void
  disabled?: boolean
  enclave?: 'low' | 'high' | null
}

const OPTIONS: { value: Classification; label: string }[] = [
  { value: 'UNCLASS', label: 'UNCLASS' },
  { value: 'CUI', label: 'CUI' },
  { value: 'SECRET', label: 'SECRET' },
]

export default function ClassificationSelect({
  value,
  onChange,
  disabled = false,
  enclave,
}: ClassificationSelectProps) {
  const storeEnclave = useEnclaveStore((s) => s.enclave)
  const effectiveEnclave = enclave !== undefined ? enclave : storeEnclave

  // If low-side enclave, hide SECRET option
  const visibleOptions = effectiveEnclave === 'low'
    ? OPTIONS.filter((o) => o.value !== 'SECRET')
    : OPTIONS

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Classification)}
      disabled={disabled}
      className="form-input"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
      }}
    >
      {visibleOptions.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
