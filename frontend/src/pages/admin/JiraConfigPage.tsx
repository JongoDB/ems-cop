import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../../lib/api'
import { Plus, X, ExternalLink, RefreshCw, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'

interface JiraConfig {
  id: string
  name: string
  base_url: string
  auth: { type?: string; email?: string; token?: string }
  project_key: string
  operation_id: string | null
  field_mappings: Record<string, Record<string, string>>
  sync_direction: string
  webhook_secret: string | null
  is_active: boolean
  linked_tickets?: number
  created_at: string
  updated_at: string
}

interface SyncLogEntry {
  id: string
  direction: string
  action: string
  status: string
  error_message: string | null
  created_at: string
}

const STATUS_COLORS: Record<string, string> = {
  success: 'var(--color-success)',
  error: 'var(--color-danger)',
  skipped: 'var(--color-text-muted)',
}

export default function JiraConfigPage() {
  const [configs, setConfigs] = useState<JiraConfig[]>([])
  const [selected, setSelected] = useState<JiraConfig | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([])
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [loading, setLoading] = useState(true)

  // Form state
  const [formName, setFormName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formToken, setFormToken] = useState('')
  const [formProjectKey, setFormProjectKey] = useState('')
  const [formDirection, setFormDirection] = useState('both')
  const [formWebhookSecret, setFormWebhookSecret] = useState('')

  const fetchConfigs = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: JiraConfig[] }>('/notifications/jira/configs')
      setConfigs(res.data)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  const fetchLog = useCallback(async (configId: string) => {
    try {
      const res = await apiFetch<{ data: SyncLogEntry[] }>(`/notifications/jira/log?config_id=${configId}&limit=20`)
      setSyncLog(res.data)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchConfigs() }, [fetchConfigs])

  useEffect(() => {
    if (selected) fetchLog(selected.id)
  }, [selected, fetchLog])

  const resetForm = () => {
    setFormName('')
    setFormUrl('')
    setFormEmail('')
    setFormToken('')
    setFormProjectKey('')
    setFormDirection('both')
    setFormWebhookSecret('')
    setTestResult(null)
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await apiFetch('/notifications/jira/configs', {
        method: 'POST',
        body: JSON.stringify({
          name: formName,
          base_url: formUrl,
          auth: { type: 'api_token', email: formEmail, token: formToken },
          project_key: formProjectKey,
          sync_direction: formDirection,
          webhook_secret: formWebhookSecret || null,
        }),
      })
      resetForm()
      setShowCreate(false)
      fetchConfigs()
    } catch { /* ignore */ }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this Jira configuration?')) return
    try {
      await apiFetch(`/notifications/jira/configs/${id}`, { method: 'DELETE' })
      if (selected?.id === id) setSelected(null)
      fetchConfigs()
    } catch { /* ignore */ }
  }

  const handleToggleActive = async (config: JiraConfig) => {
    try {
      await apiFetch(`/notifications/jira/configs/${config.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !config.is_active }),
      })
      fetchConfigs()
    } catch { /* ignore */ }
  }

  const handleTestConnection = async (id: string) => {
    setTestResult(null)
    try {
      const res = await apiFetch<{ success: boolean; error?: string }>(`/notifications/jira/configs/${id}/test`, { method: 'POST' })
      setTestResult(res)
    } catch (err) {
      setTestResult({ success: false, error: (err as Error).message })
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', gap: 0 }}>
      {/* Config List */}
      <div style={{ width: 400, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--color-border)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
          <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, letterSpacing: 2, color: 'var(--color-text-muted)', margin: 0 }}>
            JIRA CONFIGURATIONS
          </h2>
          <button className="create-btn" style={{ padding: '5px 10px', fontSize: 10 }} onClick={() => { setShowCreate(true); setSelected(null); resetForm(); }}>
            <Plus size={12} /> ADD
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
          {loading ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>Loading...</div>
          ) : configs.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              No Jira configurations. Click ADD to create one.
            </div>
          ) : configs.map((c) => (
            <div
              key={c.id}
              onClick={() => { setSelected(c); setShowCreate(false); setTestResult(null); }}
              style={{
                padding: '10px 12px', marginBottom: 4, cursor: 'pointer', borderRadius: 'var(--radius)',
                border: `1px solid ${selected?.id === c.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                background: selected?.id === c.id ? 'rgba(77,171,247,0.06)' : 'var(--color-bg)',
                transition: 'all 150ms ease',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.is_active ? 'var(--color-success)' : 'var(--color-text-muted)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--color-text-bright)', flex: 1 }}>{c.name}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-accent)' }}>{c.project_key}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, paddingLeft: 16, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
                <span>{c.base_url.replace(/^https?:\/\//, '')}</span>
                <span>|</span>
                <span>{c.sync_direction}</span>
                {c.linked_tickets != null && <><span>|</span><span>{c.linked_tickets} linked</span></>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Detail / Create Panel */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {showCreate ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, letterSpacing: 1.5, color: 'var(--color-text-muted)', margin: 0 }}>
                NEW JIRA CONFIGURATION
              </h3>
              <button style={{ background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer' }} onClick={() => setShowCreate(false)}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 500 }}>
              <div className="form-group">
                <label className="form-label">NAME</label>
                <input className="form-input" value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Production Jira" required />
              </div>
              <div className="form-group">
                <label className="form-label">BASE URL</label>
                <input className="form-input" value={formUrl} onChange={(e) => setFormUrl(e.target.value)} placeholder="https://myorg.atlassian.net" required />
              </div>
              <div className="form-group">
                <label className="form-label">AUTH EMAIL</label>
                <input className="form-input" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} placeholder="user@company.com" />
              </div>
              <div className="form-group">
                <label className="form-label">API TOKEN</label>
                <input className="form-input" type="password" value={formToken} onChange={(e) => setFormToken(e.target.value)} placeholder="Jira API token" />
              </div>
              <div className="form-group">
                <label className="form-label">PROJECT KEY</label>
                <input className="form-input" value={formProjectKey} onChange={(e) => setFormProjectKey(e.target.value)} placeholder="OPS" required />
              </div>
              <div className="form-group">
                <label className="form-label">SYNC DIRECTION</label>
                <select className="form-input" value={formDirection} onChange={(e) => setFormDirection(e.target.value)}>
                  <option value="both">Both (bidirectional)</option>
                  <option value="outbound">Outbound only (EMS → Jira)</option>
                  <option value="inbound">Inbound only (Jira → EMS)</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">WEBHOOK SECRET (optional)</label>
                <input className="form-input" value={formWebhookSecret} onChange={(e) => setFormWebhookSecret(e.target.value)} placeholder="shared secret for webhook validation" />
              </div>
              <button type="submit" className="submit-btn" style={{ alignSelf: 'flex-start' }}>CREATE</button>
            </form>
          </div>
        ) : selected ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: 'var(--color-text-bright)', margin: 0, flex: 1 }}>
                {selected.name}
              </h3>
              <button
                style={{
                  padding: '5px 10px', fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: 1,
                  background: selected.is_active ? 'rgba(64,192,87,0.1)' : 'var(--color-bg)',
                  border: `1px solid ${selected.is_active ? 'var(--color-success)' : 'var(--color-border)'}`,
                  color: selected.is_active ? 'var(--color-success)' : 'var(--color-text-muted)',
                  borderRadius: 'var(--radius)', cursor: 'pointer',
                }}
                onClick={() => handleToggleActive(selected)}
              >
                {selected.is_active ? 'ACTIVE' : 'INACTIVE'}
              </button>
              <button
                className="transition-btn"
                onClick={() => handleTestConnection(selected.id)}
              >
                <RefreshCw size={12} /> TEST
              </button>
              <button
                className="transition-btn danger"
                onClick={() => handleDelete(selected.id)}
              >
                <X size={12} /> DELETE
              </button>
            </div>

            {testResult && (
              <div style={{
                padding: '8px 12px', marginBottom: 12, borderRadius: 'var(--radius)',
                border: `1px solid ${testResult.success ? 'var(--color-success)' : 'var(--color-danger)'}`,
                background: testResult.success ? 'rgba(64,192,87,0.08)' : 'rgba(255,107,107,0.08)',
                fontFamily: 'var(--font-mono)', fontSize: 11,
                color: testResult.success ? 'var(--color-success)' : 'var(--color-danger)',
              }}>
                {testResult.success ? 'Connection successful' : `Connection failed: ${testResult.error}`}
              </div>
            )}

            {/* Config details */}
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 12px', marginBottom: 20, fontSize: 13 }}>
              <span className="meta-label">URL</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{selected.base_url}</span>
              <span className="meta-label">PROJECT</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{selected.project_key}</span>
              <span className="meta-label">DIRECTION</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{selected.sync_direction}</span>
              <span className="meta-label">LINKED</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{selected.linked_tickets ?? 0} tickets</span>
              <span className="meta-label">UPDATED</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{new Date(selected.updated_at).toLocaleString()}</span>
            </div>

            {/* Sync Log */}
            <h4 style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: 1.5, color: 'var(--color-text-muted)', margin: '0 0 10px' }}>
              RECENT SYNC LOG
            </h4>
            {syncLog.length === 0 ? (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)', padding: '12px 0' }}>
                No sync activity yet
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {syncLog.map((entry) => {
                  const StatusIcon = entry.status === 'success' ? CheckCircle : entry.status === 'error' ? XCircle : AlertTriangle
                  return (
                    <div key={entry.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
                      background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
                      fontSize: 11, fontFamily: 'var(--font-mono)',
                    }}>
                      <StatusIcon size={12} style={{ color: STATUS_COLORS[entry.status] || 'var(--color-text-muted)', flexShrink: 0 }} />
                      <span style={{ color: 'var(--color-text-muted)', width: 60, flexShrink: 0 }}>{entry.direction}</span>
                      <span style={{ color: 'var(--color-text-bright)', flex: 1 }}>{entry.action}</span>
                      {entry.error_message && (
                        <span style={{ color: 'var(--color-danger)', fontSize: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {entry.error_message}
                        </span>
                      )}
                      <span style={{ color: 'var(--color-text-muted)', fontSize: 9 }}>
                        {new Date(entry.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Webhook URL info */}
            <div style={{ marginTop: 20, padding: '10px 12px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: 1, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                JIRA WEBHOOK URL
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-accent)', wordBreak: 'break-all' }}>
                {`${location.origin}/api/v1/notifications/jira/webhook`}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)', marginTop: 4 }}>
                Configure this URL in your Jira project webhook settings
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
            <ExternalLink size={48} style={{ color: 'var(--color-text-muted)', opacity: 0.3 }} />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>Jira Integration</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'center', lineHeight: '18px' }}>
              Select a configuration or create a new one to enable bidirectional ticket sync with Jira
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
