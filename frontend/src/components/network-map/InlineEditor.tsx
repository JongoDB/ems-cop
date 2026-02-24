import { useState, useRef, useEffect, useCallback } from 'react'
import { Pencil } from 'lucide-react'

/* ------------------------------------------------------------------ */
/*  Shared styles & helpers                                           */
/* ------------------------------------------------------------------ */

type FlashState = 'idle' | 'success' | 'error'

function useFlash(): [FlashState, (s: 'success' | 'error') => void] {
  const [state, setState] = useState<FlashState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const flash = useCallback((s: 'success' | 'error') => {
    clearTimeout(timer.current)
    setState(s)
    timer.current = setTimeout(() => setState('idle'), 600)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  return [state, flash]
}

function flashBorder(state: FlashState): string {
  if (state === 'success') return 'var(--color-success)'
  if (state === 'error') return 'var(--color-danger)'
  return 'var(--color-border)'
}

const baseInputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  background: 'var(--color-bg-surface)',
  color: 'var(--color-text-bright)',
  borderRadius: 'var(--radius)',
  padding: '3px 6px',
  width: '100%',
  boxSizing: 'border-box',
  outline: 'none',
  transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
}

const pencilWrapStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  marginLeft: 4,
  opacity: 0,
  transition: 'opacity 0.15s ease',
  cursor: 'pointer',
  color: 'var(--color-text-muted)',
  flexShrink: 0,
}

/* ------------------------------------------------------------------ */
/*  InlineText                                                        */
/* ------------------------------------------------------------------ */

export interface InlineTextProps {
  value: string
  onSave: (newValue: string) => Promise<void>
  disabled?: boolean
  placeholder?: string
}

export function InlineText({ value, onSave, disabled, placeholder }: InlineTextProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [flashState, flash] = useFlash()
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync draft when value changes externally
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = async () => {
    const trimmed = draft.trim()
    if (trimmed === value || trimmed === '') {
      setDraft(value)
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onSave(trimmed)
      flash('success')
      setEditing(false)
    } catch {
      flash('error')
      // Stay in editing mode on error
    } finally {
      setSaving(false)
    }
  }

  const cancel = () => {
    setDraft(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        disabled={saving}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') cancel()
        }}
        onBlur={commit}
        style={{
          ...baseInputStyle,
          border: `1px solid ${flashBorder(flashState)}`,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = 'var(--color-accent)'
        }}
      />
    )
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--color-text)',
        cursor: disabled ? 'default' : 'pointer',
        borderBottom: `1px solid transparent`,
        transition: 'border-color 0.3s ease',
        borderColor: flashBorder(flashState) !== 'var(--color-border)' ? flashBorder(flashState) : 'transparent',
      }}
      onMouseEnter={(e) => {
        const icon = e.currentTarget.querySelector('.inline-pencil') as HTMLElement | null
        if (icon) icon.style.opacity = '0.6'
      }}
      onMouseLeave={(e) => {
        const icon = e.currentTarget.querySelector('.inline-pencil') as HTMLElement | null
        if (icon) icon.style.opacity = '0'
      }}
      onClick={() => { if (!disabled) setEditing(true) }}
    >
      {value || <span style={{ color: 'var(--color-text-muted)', fontStyle: 'italic' }}>{placeholder || 'empty'}</span>}
      {!disabled && (
        <span className="inline-pencil" style={pencilWrapStyle}>
          <Pencil size={10} />
        </span>
      )}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/*  InlineSelect                                                      */
/* ------------------------------------------------------------------ */

export interface InlineSelectProps {
  value: string
  options: string[]
  onSave: (newValue: string) => Promise<void>
  disabled?: boolean
  formatOption?: (opt: string) => string
}

export function InlineSelect({ value, options, onSave, disabled, formatOption }: InlineSelectProps) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [flashState, flash] = useFlash()
  const selectRef = useRef<HTMLSelectElement>(null)
  const fmt = formatOption ?? ((o: string) => o.replace(/_/g, ' ').toUpperCase())

  useEffect(() => {
    if (editing) selectRef.current?.focus()
  }, [editing])

  const commit = async (newValue: string) => {
    if (newValue === value) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onSave(newValue)
      flash('success')
      setEditing(false)
    } catch {
      flash('error')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <select
        ref={selectRef}
        value={value}
        disabled={saving}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
        style={{
          ...baseInputStyle,
          border: `1px solid ${flashBorder(flashState)}`,
          appearance: 'auto',
        }}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {fmt(opt)}
          </option>
        ))}
      </select>
    )
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        color: 'var(--color-text)',
        cursor: disabled ? 'default' : 'pointer',
        borderBottom: '1px solid transparent',
        transition: 'border-color 0.3s ease',
        borderColor: flashBorder(flashState) !== 'var(--color-border)' ? flashBorder(flashState) : 'transparent',
      }}
      onMouseEnter={(e) => {
        const icon = e.currentTarget.querySelector('.inline-pencil') as HTMLElement | null
        if (icon) icon.style.opacity = '0.6'
      }}
      onMouseLeave={(e) => {
        const icon = e.currentTarget.querySelector('.inline-pencil') as HTMLElement | null
        if (icon) icon.style.opacity = '0'
      }}
      onClick={() => { if (!disabled) setEditing(true) }}
    >
      {fmt(value)}
      {!disabled && (
        <span className="inline-pencil" style={pencilWrapStyle}>
          <Pencil size={10} />
        </span>
      )}
    </span>
  )
}
