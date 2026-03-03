import { useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../lib/api'
import { Server, Shield, Zap, Radio, ChevronDown, Wifi, WifiOff } from 'lucide-react'

type ProviderType = 'sliver' | 'mythic' | 'havoc'
type ConnectionStatus = 'connected' | 'disconnected' | 'connecting'

interface C2Provider {
  name: string
  type: ProviderType
  host: string
  port: number
  mode: string
  enabled: boolean
  connected: ConnectionStatus
}

interface C2ProviderSelectProps {
  value: string | null
  onChange: (name: string | null) => void
  showAllOption?: boolean
  allLabel?: string
  compact?: boolean
}

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connected: 'var(--color-success)',
  disconnected: 'var(--color-danger)',
  connecting: 'var(--color-warning)',
}

function providerTypeIcon(type: ProviderType, size = 12) {
  switch (type) {
    case 'sliver': return <Shield size={size} style={{ color: '#e06c75' }} />
    case 'mythic': return <Zap size={size} style={{ color: '#c678dd' }} />
    case 'havoc': return <Radio size={size} style={{ color: '#e5c07b' }} />
    default: return <Server size={size} />
  }
}

export default function C2ProviderSelect({
  value,
  onChange,
  showAllOption = true,
  allLabel = 'All Providers',
  compact = false,
}: C2ProviderSelectProps) {
  const [providers, setProviders] = useState<C2Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const fetchProviders = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: C2Provider[] }>('/c2/providers')
      setProviders((res.data ?? []).filter(p => p.enabled))
    } catch {
      setProviders([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchProviders() }, [fetchProviders])

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const selectedProvider = providers.find(p => p.name === value)

  const renderSelectedLabel = () => {
    if (loading) {
      return <span style={{ color: 'var(--color-text-muted)' }}>Loading...</span>
    }
    if (!value || !selectedProvider) {
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Server size={12} style={{ color: 'var(--color-text-muted)' }} />
          <span>{showAllOption ? allLabel : 'Select Provider'}</span>
        </span>
      )
    }
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: STATUS_COLORS[selectedProvider.connected],
          flexShrink: 0,
        }} />
        {providerTypeIcon(selectedProvider.type)}
        <span>{selectedProvider.name}</span>
      </span>
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: compact ? '4px 8px' : '6px 12px',
          fontFamily: 'var(--font-mono)', fontSize: compact ? 10 : 11,
          color: 'var(--color-text-primary)', background: 'var(--color-bg)',
          border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
          cursor: 'pointer', whiteSpace: 'nowrap',
          minWidth: compact ? 120 : 160,
        }}
      >
        {renderSelectedLabel()}
        <ChevronDown size={12} style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', flexShrink: 0 }} />
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4,
          minWidth: 220, maxHeight: 280, overflowY: 'auto',
          background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          zIndex: 100,
        }}>
          {showAllOption && (
            <button
              onClick={() => { onChange(null); setOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '8px 12px', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'left',
                background: value === null ? 'rgba(77,171,247,0.08)' : 'transparent',
                color: value === null ? 'var(--color-accent)' : 'var(--color-text-primary)',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <Server size={12} style={{ color: 'var(--color-text-muted)' }} />
              {allLabel}
            </button>
          )}

          {providers.length === 0 && !loading ? (
            <div style={{
              padding: '12px', fontFamily: 'var(--font-mono)', fontSize: 10,
              color: 'var(--color-text-muted)', textAlign: 'center',
            }}>
              No providers available
            </div>
          ) : (
            providers.map((p) => (
              <button
                key={p.name}
                onClick={() => { onChange(p.name); setOpen(false) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '8px 12px', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'left',
                  background: value === p.name ? 'rgba(77,171,247,0.08)' : 'transparent',
                  color: value === p.name ? 'var(--color-accent)' : 'var(--color-text-primary)',
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: STATUS_COLORS[p.connected],
                  flexShrink: 0,
                }} />
                {providerTypeIcon(p.type)}
                <span style={{ flex: 1 }}>{p.name}</span>
                {p.connected === 'connected' ? (
                  <Wifi size={10} style={{ color: 'var(--color-success)' }} />
                ) : (
                  <WifiOff size={10} style={{ color: 'var(--color-danger)' }} />
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// Export a hook for use elsewhere
export function useC2Providers() {
  const [providers, setProviders] = useState<C2Provider[]>([])
  const [loading, setLoading] = useState(true)

  const fetch = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: C2Provider[] }>('/c2/providers')
      setProviders((res.data ?? []).filter(p => p.enabled))
    } catch {
      setProviders([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetch() }, [fetch])

  return { providers, loading, refetch: fetch }
}
