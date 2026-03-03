import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import {
  Server, Radio, Plus, Trash2, X, RefreshCw,
  Wifi, WifiOff, Settings, AlertTriangle, CheckCircle, XCircle, Shield, Zap,
} from 'lucide-react'

// --- Types ---

type ProviderType = 'sliver' | 'mythic' | 'havoc'
type ConnectionMode = 'docker' | 'external'
type ConnectionStatus = 'connected' | 'disconnected' | 'connecting'

interface C2Provider {
  name: string
  type: ProviderType
  host: string
  port: number
  auth_config: Record<string, string>
  mode: ConnectionMode
  enabled: boolean
  connected: ConnectionStatus
  created_at?: string
  updated_at?: string
}

// --- Constants ---

const PROVIDER_TYPES: { value: ProviderType; label: string }[] = [
  { value: 'sliver', label: 'Sliver' },
  { value: 'mythic', label: 'Mythic' },
  { value: 'havoc', label: 'Havoc' },
]

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connected: 'var(--color-success)',
  disconnected: 'var(--color-danger)',
  connecting: 'var(--color-warning)',
}

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connected: 'CONNECTED',
  disconnected: 'OFFLINE',
  connecting: 'CONNECTING',
}

function providerTypeIcon(type: ProviderType) {
  switch (type) {
    case 'sliver': return <Shield size={14} style={{ color: '#e06c75' }} />
    case 'mythic': return <Zap size={14} style={{ color: '#c678dd' }} />
    case 'havoc': return <Radio size={14} style={{ color: '#e5c07b' }} />
    default: return <Server size={14} />
  }
}

function providerTypeLabel(type: ProviderType): string {
  switch (type) {
    case 'sliver': return 'Sliver'
    case 'mythic': return 'Mythic'
    case 'havoc': return 'Havoc'
    default: return type
  }
}

// --- Default auth config per provider type ---
function defaultAuthConfig(type: ProviderType): Record<string, string> {
  switch (type) {
    case 'sliver': return { operator_config: '' }
    case 'mythic': return { username: '', password: '' }
    case 'havoc': return { username: '', password: '' }
    default: return {}
  }
}

function defaultPort(type: ProviderType): number {
  switch (type) {
    case 'sliver': return 31337
    case 'mythic': return 7443
    case 'havoc': return 40056
    default: return 0
  }
}

// --- Component ---

export default function C2BackendsPage() {
  const [providers, setProviders] = useState<C2Provider[]>([])
  const [selected, setSelected] = useState<C2Provider | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<ProviderType>('sliver')
  const [formMode, setFormMode] = useState<ConnectionMode>('docker')
  const [formHost, setFormHost] = useState('')
  const [formPort, setFormPort] = useState<number>(31337)
  const [formAuthConfig, setFormAuthConfig] = useState<Record<string, string>>({ operator_config: '' })
  const [formEnabled, setFormEnabled] = useState(true)
  const [isEditing, setIsEditing] = useState(false)

  // --- Fetch ---

  const fetchProviders = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: C2Provider[] }>('/c2/providers')
      setProviders(res.data ?? [])
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load providers'
      setError(msg)
      setProviders([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchProviders() }, [fetchProviders])

  // --- Form helpers ---

  const resetForm = () => {
    setFormName('')
    setFormType('sliver')
    setFormMode('docker')
    setFormHost('')
    setFormPort(31337)
    setFormAuthConfig({ operator_config: '' })
    setFormEnabled(true)
    setTestResult(null)
    setIsEditing(false)
  }

  const populateForm = (p: C2Provider) => {
    setFormName(p.name)
    setFormType(p.type)
    setFormMode(p.mode)
    setFormHost(p.host)
    setFormPort(p.port)
    setFormAuthConfig(p.auth_config ?? defaultAuthConfig(p.type))
    setFormEnabled(p.enabled)
    setIsEditing(true)
  }

  const handleTypeChange = (newType: ProviderType) => {
    setFormType(newType)
    setFormPort(defaultPort(newType))
    setFormAuthConfig(defaultAuthConfig(newType))
  }

  // --- CRUD handlers ---

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await apiFetch('/c2/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: formName,
          type: formType,
          host: formMode === 'external' ? formHost : '',
          port: formPort,
          auth_config: formAuthConfig,
          mode: formMode,
          enabled: formEnabled,
        }),
      })
      resetForm()
      setShowCreate(false)
      await fetchProviders()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create provider'
      setError(msg)
    }
    setSaving(false)
  }

  const handleDelete = async (name: string) => {
    try {
      await apiFetch(`/c2/providers/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (selected?.name === name) setSelected(null)
      setShowDeleteConfirm(null)
      await fetchProviders()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete provider'
      setError(msg)
    }
  }

  const handleTestConnection = async (name: string) => {
    setTestResult(null)
    try {
      const res = await apiFetch<{ connected: boolean; error?: string }>(
        `/c2/providers/${encodeURIComponent(name)}/status`
      )
      setTestResult({ success: res.connected, error: res.error })
    } catch (err) {
      setTestResult({ success: false, error: (err as Error).message })
    }
  }

  const handleToggleEnabled = async (provider: C2Provider) => {
    try {
      await apiFetch(`/c2/providers/${encodeURIComponent(provider.name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !provider.enabled }),
      })
      await fetchProviders()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update provider'
      setError(msg)
    }
  }

  // --- Auth config field rendering ---

  const renderAuthFields = () => {
    if (formType === 'sliver') {
      return (
        <div className="form-group">
          <label className="form-label">OPERATOR CONFIG</label>
          <textarea
            className="form-input"
            value={formAuthConfig.operator_config ?? ''}
            onChange={(e) => setFormAuthConfig({ ...formAuthConfig, operator_config: e.target.value })}
            placeholder="Paste Sliver operator config JSON or file path..."
            rows={6}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11, resize: 'vertical' }}
          />
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
            Generated by: sliver-server operator --name ems --lhost host
          </div>
        </div>
      )
    }

    // Mythic and Havoc use username + password
    return (
      <>
        <div className="form-group">
          <label className="form-label">USERNAME</label>
          <input
            className="form-input"
            value={formAuthConfig.username ?? ''}
            onChange={(e) => setFormAuthConfig({ ...formAuthConfig, username: e.target.value })}
            placeholder={`${providerTypeLabel(formType)} username`}
          />
        </div>
        <div className="form-group">
          <label className="form-label">PASSWORD</label>
          <input
            className="form-input"
            type="password"
            value={formAuthConfig.password ?? ''}
            onChange={(e) => setFormAuthConfig({ ...formAuthConfig, password: e.target.value })}
            placeholder={`${providerTypeLabel(formType)} password`}
          />
        </div>
      </>
    )
  }

  // --- Stats ---
  const connectedCount = providers.filter(p => p.connected === 'connected').length
  const enabledCount = providers.filter(p => p.enabled).length

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', gap: 0 }}>
      {/* Provider List */}
      <div style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--color-border)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, letterSpacing: 2, color: 'var(--color-text-muted)', margin: 0 }}>
              C2 BACKENDS
            </h2>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
              {connectedCount}/{enabledCount} online
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="c2-refresh-btn"
              onClick={fetchProviders}
              title="Refresh providers"
              style={{ padding: 4 }}
            >
              <RefreshCw size={12} />
            </button>
            <button
              className="create-btn"
              style={{ padding: '5px 10px', fontSize: 10 }}
              onClick={() => { setShowCreate(true); setSelected(null); resetForm() }}
            >
              <Plus size={12} /> ADD
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 12px', margin: '8px 8px 0', borderRadius: 'var(--radius)',
              border: '1px solid var(--color-danger)', background: 'rgba(255,107,107,0.08)',
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-danger)',
              cursor: 'pointer',
            }}
            onClick={() => setError(null)}
          >
            {error} <span style={{ opacity: 0.6 }}>CLICK TO DISMISS</span>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              Loading providers...
            </div>
          ) : providers.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              No C2 backends configured. Click ADD to register one.
            </div>
          ) : (
            providers.map((p) => (
              <div
                key={p.name}
                onClick={() => { setSelected(p); setShowCreate(false); setTestResult(null) }}
                style={{
                  padding: '10px 12px', marginBottom: 4, cursor: 'pointer', borderRadius: 'var(--radius)',
                  border: `1px solid ${selected?.name === p.name ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: selected?.name === p.name ? 'rgba(77,171,247,0.06)' : 'var(--color-bg)',
                  transition: 'all 150ms ease',
                  opacity: p.enabled ? 1 : 0.5,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <div
                    style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: STATUS_COLORS[p.connected] ?? STATUS_COLORS.disconnected,
                      boxShadow: p.connected === 'connected' ? `0 0 6px ${STATUS_COLORS.connected}` : 'none',
                    }}
                  />
                  {providerTypeIcon(p.type)}
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-bright)', flex: 1 }}>
                    {p.name}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: 1,
                    padding: '2px 6px', borderRadius: 'var(--radius)',
                    border: `1px solid ${STATUS_COLORS[p.connected] ?? STATUS_COLORS.disconnected}`,
                    color: STATUS_COLORS[p.connected] ?? STATUS_COLORS.disconnected,
                  }}>
                    {STATUS_LABELS[p.connected] ?? 'UNKNOWN'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, paddingLeft: 30, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
                  <span>{providerTypeLabel(p.type)}</span>
                  <span>|</span>
                  <span>{p.mode === 'docker' ? 'Docker' : `${p.host}:${p.port}`}</span>
                  {!p.enabled && (
                    <>
                      <span>|</span>
                      <span style={{ color: 'var(--color-warning)' }}>DISABLED</span>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Detail / Create Panel */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {showCreate ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, letterSpacing: 1.5, color: 'var(--color-text-muted)', margin: 0 }}>
                {isEditing ? 'EDIT C2 BACKEND' : 'REGISTER C2 BACKEND'}
              </h3>
              <button
                style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }}
                onClick={() => { setShowCreate(false); resetForm() }}
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 500 }}>
              {/* Name */}
              <div className="form-group">
                <label className="form-label">NAME</label>
                <input
                  className="form-input"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. sliver-primary"
                  required
                  disabled={isEditing}
                />
              </div>

              {/* Type */}
              <div className="form-group">
                <label className="form-label">TYPE</label>
                <select
                  className="form-input"
                  value={formType}
                  onChange={(e) => handleTypeChange(e.target.value as ProviderType)}
                  disabled={isEditing}
                >
                  {PROVIDER_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>

              {/* Connection Mode */}
              <div className="form-group">
                <label className="form-label">CONNECTION MODE</label>
                <div style={{ display: 'flex', gap: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="conn-mode"
                      value="docker"
                      checked={formMode === 'docker'}
                      onChange={() => setFormMode('docker')}
                      style={{ accentColor: 'var(--color-accent)' }}
                    />
                    Docker (auto-discover)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="conn-mode"
                      value="external"
                      checked={formMode === 'external'}
                      onChange={() => setFormMode('external')}
                      style={{ accentColor: 'var(--color-accent)' }}
                    />
                    External (manual)
                  </label>
                </div>
              </div>

              {/* Host / Port (external only) */}
              {formMode === 'external' && (
                <div style={{ display: 'flex', gap: 12 }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">HOST</label>
                    <input
                      className="form-input"
                      value={formHost}
                      onChange={(e) => setFormHost(e.target.value)}
                      placeholder="e.g. 10.0.0.50"
                      required
                    />
                  </div>
                  <div className="form-group" style={{ width: 100 }}>
                    <label className="form-label">PORT</label>
                    <input
                      className="form-input"
                      type="number"
                      value={formPort}
                      onChange={(e) => setFormPort(parseInt(e.target.value) || 0)}
                      placeholder={String(defaultPort(formType))}
                      min={1}
                      max={65535}
                      required
                    />
                  </div>
                </div>
              )}

              {/* Auth Section */}
              <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 12, marginTop: 4 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: 1.5, color: 'var(--color-text-muted)', marginBottom: 12 }}>
                  AUTHENTICATION
                </div>
                {renderAuthFields()}
              </div>

              {/* Enabled toggle */}
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={formEnabled}
                    onChange={(e) => setFormEnabled(e.target.checked)}
                    style={{ accentColor: 'var(--color-accent)' }}
                  />
                  Enabled (auto-connect on startup)
                </label>
              </div>

              {/* Submit */}
              <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-start', marginTop: 4 }}>
                <button type="submit" className="submit-btn" disabled={saving}>
                  {saving ? 'SAVING...' : isEditing ? 'UPDATE' : 'REGISTER'}
                </button>
                <button type="button" className="transition-btn" onClick={() => { setShowCreate(false); resetForm() }}>
                  CANCEL
                </button>
              </div>
            </form>
          </div>
        ) : selected ? (
          <div>
            {/* Header with actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                {providerTypeIcon(selected.type)}
                <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-bright)', margin: 0 }}>
                  {selected.name}
                </h3>
              </div>
              <button
                style={{
                  padding: '5px 10px', fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: 1,
                  background: selected.enabled ? 'rgba(64,192,87,0.1)' : 'var(--color-bg)',
                  border: `1px solid ${selected.enabled ? 'var(--color-success)' : 'var(--color-border)'}`,
                  color: selected.enabled ? 'var(--color-success)' : 'var(--color-text-muted)',
                  borderRadius: 'var(--radius)', cursor: 'pointer',
                }}
                onClick={() => handleToggleEnabled(selected)}
              >
                {selected.enabled ? 'ENABLED' : 'DISABLED'}
              </button>
              <button
                className="transition-btn"
                onClick={() => {
                  populateForm(selected)
                  setShowCreate(true)
                }}
              >
                <Settings size={12} /> EDIT
              </button>
              <button
                className="transition-btn"
                onClick={() => handleTestConnection(selected.name)}
              >
                <RefreshCw size={12} /> TEST
              </button>
              <button
                className="transition-btn danger"
                onClick={() => setShowDeleteConfirm(selected.name)}
              >
                <Trash2 size={12} /> DELETE
              </button>
            </div>

            {/* Test result banner */}
            {testResult && (
              <div style={{
                padding: '8px 12px', marginBottom: 12, borderRadius: 'var(--radius)',
                border: `1px solid ${testResult.success ? 'var(--color-success)' : 'var(--color-danger)'}`,
                background: testResult.success ? 'rgba(64,192,87,0.08)' : 'rgba(255,107,107,0.08)',
                fontFamily: 'var(--font-mono)', fontSize: 11,
                color: testResult.success ? 'var(--color-success)' : 'var(--color-danger)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                {testResult.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
                {testResult.success ? 'Connection successful — provider is reachable' : `Connection failed: ${testResult.error}`}
              </div>
            )}

            {/* Connection status */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 16,
              background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
            }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: STATUS_COLORS[selected.connected] ?? STATUS_COLORS.disconnected,
                boxShadow: selected.connected === 'connected' ? `0 0 8px ${STATUS_COLORS.connected}` : 'none',
              }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: STATUS_COLORS[selected.connected] }}>
                {STATUS_LABELS[selected.connected] ?? 'UNKNOWN'}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>
                {selected.connected === 'connected' ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Wifi size={11} /> Active connection</span>
                ) : selected.connected === 'connecting' ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={11} /> Attempting to connect...</span>
                ) : (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><WifiOff size={11} /> No active connection</span>
                )}
              </span>
            </div>

            {/* Detail grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: '8px 12px', marginBottom: 20, fontSize: 13 }}>
              <span className="meta-label">TYPE</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                {providerTypeIcon(selected.type)} {providerTypeLabel(selected.type)}
              </span>
              <span className="meta-label">MODE</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {selected.mode === 'docker' ? 'Docker (auto-discover)' : 'External (manual)'}
              </span>
              {selected.mode === 'external' && (
                <>
                  <span className="meta-label">HOST</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{selected.host}</span>
                  <span className="meta-label">PORT</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{selected.port}</span>
                </>
              )}
              {selected.mode === 'docker' && (
                <>
                  <span className="meta-label">ENDPOINT</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)' }}>
                    Auto-resolved via Docker network
                  </span>
                </>
              )}
              <span className="meta-label">AUTH</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {selected.type === 'sliver' ? 'Operator Config' : 'Username/Password'}
                {selected.auth_config && Object.keys(selected.auth_config).length > 0 && (
                  <span style={{ color: 'var(--color-success)', marginLeft: 8 }}>configured</span>
                )}
              </span>
              {selected.updated_at && (
                <>
                  <span className="meta-label">LAST UPDATED</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {new Date(selected.updated_at).toLocaleString()}
                  </span>
                </>
              )}
            </div>

            {/* Docker mode info box */}
            {selected.mode === 'docker' && (
              <div style={{ padding: '10px 12px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: 1, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                  DOCKER MODE
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-primary)', lineHeight: '18px' }}>
                  This provider is running as a Docker service on the ems-net/endpoint-net bridge.
                  Connection details are auto-resolved via Docker DNS.
                  The C2 Gateway will connect on startup using the configured operator credentials.
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
            <Server size={48} style={{ color: 'var(--color-text-muted)', opacity: 0.3 }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>C2 Backend Management</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: '18px', maxWidth: 320 }}>
              Register and manage C2 framework connections.
              Supports Sliver, Mythic, and Havoc backends
              in Docker or external deployment modes.
            </span>
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="modal-overlay" onClick={() => setShowDeleteConfirm(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h3 className="modal-title">CONFIRM DELETE</h3>
              <button className="modal-close" onClick={() => setShowDeleteConfirm(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body" style={{ padding: '16px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <AlertTriangle size={20} style={{ color: 'var(--color-danger)', flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-primary)', lineHeight: '18px' }}>
                  Are you sure you want to remove the C2 backend <strong style={{ color: 'var(--color-text-bright)' }}>{showDeleteConfirm}</strong>?
                </span>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', lineHeight: '16px', padding: '8px 0 0 30px' }}>
                This will disconnect the provider and remove its configuration.
                Active sessions through this provider will be terminated.
              </div>
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="transition-btn" onClick={() => setShowDeleteConfirm(null)}>
                CANCEL
              </button>
              <button
                className="transition-btn danger"
                onClick={() => handleDelete(showDeleteConfirm)}
                style={{ background: 'rgba(255,107,107,0.1)' }}
              >
                <Trash2 size={12} /> DELETE BACKEND
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
