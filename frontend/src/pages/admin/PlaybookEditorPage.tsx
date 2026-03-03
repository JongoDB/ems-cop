import { useState, useCallback, useEffect } from 'react'
import { apiFetch } from '../../lib/api'
import ClassificationSelect from '../../components/ClassificationSelect'
import type { Classification } from '../../components/ClassificationBadge'
import {
  Plus, X, Play, ToggleLeft, ToggleRight,
  ChevronDown, ChevronUp,
} from 'lucide-react'

interface TriggerConditions {
  severity_threshold?: string
  mitre_techniques?: string[]
  alert_source?: string
  ioc_type?: string
}

interface PlaybookDefinition {
  id: string
  name: string
  description: string
  trigger_conditions: TriggerConditions
  linked_workflow_id?: string
  priority: number
  classification?: string
  is_active: boolean
  created_at: string
}

interface PlaybookExecution {
  id: string
  playbook_id: string
  incident_id: string
  status: string
  started_at: string
  completed_at?: string
}

interface Workflow {
  id: string
  name: string
}

export default function PlaybookEditorPage() {
  const [playbooks, setPlaybooks] = useState<PlaybookDefinition[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [loading, setLoading] = useState(true)

  // Create/Edit form
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formSeverity, setFormSeverity] = useState('')
  const [formMitre, setFormMitre] = useState('')
  const [formAlertSource, setFormAlertSource] = useState('')
  const [formIocType, setFormIocType] = useState('')
  const [formWorkflow, setFormWorkflow] = useState('')
  const [formPriority, setFormPriority] = useState(10)
  const [formClassification, setFormClassification] = useState<Classification>('UNCLASS')

  // Manual trigger
  const [triggerPlaybookId, setTriggerPlaybookId] = useState<string | null>(null)
  const [triggerIncidentId, setTriggerIncidentId] = useState('')

  // Execution history
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [executions, setExecutions] = useState<PlaybookExecution[]>([])

  const fetchPlaybooks = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<{ data: PlaybookDefinition[] }>('/c2/containment/playbooks')
      setPlaybooks(res.data || [])
    } catch {
      setPlaybooks([])
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: Workflow[] }>('/workflows')
      setWorkflows(res.data || [])
    } catch {
      setWorkflows([])
    }
  }, [])

  const fetchExecutions = useCallback(async (playbookId: string) => {
    try {
      const res = await apiFetch<{ data: PlaybookExecution[] }>(
        `/c2/containment/playbooks/${playbookId}/executions`
      )
      setExecutions(res.data || [])
    } catch {
      setExecutions([])
    }
  }, [])

  useEffect(() => {
    fetchPlaybooks()
    fetchWorkflows()
  }, [fetchPlaybooks, fetchWorkflows])

  const resetForm = () => {
    setEditId(null)
    setFormName('')
    setFormDesc('')
    setFormSeverity('')
    setFormMitre('')
    setFormAlertSource('')
    setFormIocType('')
    setFormWorkflow('')
    setFormPriority(10)
    setFormClassification('UNCLASS')
  }

  const openCreate = () => {
    resetForm()
    setShowForm(true)
  }

  const openEdit = (pb: PlaybookDefinition) => {
    setEditId(pb.id)
    setFormName(pb.name)
    setFormDesc(pb.description)
    setFormSeverity(pb.trigger_conditions.severity_threshold || '')
    setFormMitre((pb.trigger_conditions.mitre_techniques || []).join(', '))
    setFormAlertSource(pb.trigger_conditions.alert_source || '')
    setFormIocType(pb.trigger_conditions.ioc_type || '')
    setFormWorkflow(pb.linked_workflow_id || '')
    setFormPriority(pb.priority)
    setFormClassification((pb.classification || 'UNCLASS') as Classification)
    setShowForm(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formName.trim()) return

    const body = {
      name: formName,
      description: formDesc,
      trigger_conditions: {
        severity_threshold: formSeverity || undefined,
        mitre_techniques: formMitre ? formMitre.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        alert_source: formAlertSource || undefined,
        ioc_type: formIocType || undefined,
      },
      linked_workflow_id: formWorkflow || undefined,
      priority: formPriority,
      classification: formClassification,
    }

    try {
      if (editId) {
        await apiFetch(`/c2/containment/playbooks/${editId}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
      } else {
        await apiFetch('/c2/containment/playbooks', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      }
      setShowForm(false)
      resetForm()
      fetchPlaybooks()
    } catch {
      // error handled
    }
  }

  const handleToggleActive = async (pb: PlaybookDefinition) => {
    try {
      await apiFetch(`/c2/containment/playbooks/${pb.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !pb.is_active }),
      })
      fetchPlaybooks()
    } catch {
      // error handled
    }
  }

  const handleManualTrigger = async () => {
    if (!triggerPlaybookId || !triggerIncidentId.trim()) return
    try {
      await apiFetch(`/c2/containment/playbooks/${triggerPlaybookId}/trigger`, {
        method: 'POST',
        body: JSON.stringify({ incident_id: triggerIncidentId }),
      })
      setTriggerPlaybookId(null)
      setTriggerIncidentId('')
    } catch {
      // error handled
    }
  }

  const handleExpand = (pbId: string) => {
    if (expandedId === pbId) {
      setExpandedId(null)
    } else {
      setExpandedId(pbId)
      fetchExecutions(pbId)
    }
  }

  const formatTriggerSummary = (tc: TriggerConditions): string => {
    const parts: string[] = []
    if (tc.severity_threshold) parts.push(`severity >= ${tc.severity_threshold}`)
    if (tc.mitre_techniques?.length) parts.push(`MITRE: ${tc.mitre_techniques.join(', ')}`)
    if (tc.alert_source) parts.push(`source: ${tc.alert_source}`)
    if (tc.ioc_type) parts.push(`IOC type: ${tc.ioc_type}`)
    return parts.length > 0 ? parts.join(' | ') : 'No conditions'
  }

  return (
    <div style={{ padding: '16px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Toolbar */}
      <div className="tickets-toolbar">
        <div className="toolbar-left">
          <h1 className="page-title">PLAYBOOKS</h1>
          <span className="ticket-count">{playbooks.length} total</span>
        </div>
        <div className="toolbar-right">
          <button onClick={openCreate} className="create-btn">
            <Plus size={14} />
            NEW PLAYBOOK
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="tickets-table-wrap">
        <table className="tickets-table">
          <thead>
            <tr>
              <th>NAME</th>
              <th>DESCRIPTION</th>
              <th>TRIGGERS</th>
              <th>WORKFLOW</th>
              <th>PRIORITY</th>
              <th>ACTIVE</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="table-empty">Loading...</td></tr>
            ) : playbooks.length === 0 ? (
              <tr><td colSpan={7} className="table-empty">No playbooks defined</td></tr>
            ) : (
              playbooks.map((pb) => (
                <>
                  <tr key={pb.id} className="ticket-row">
                    <td className="title-cell">{pb.name}</td>
                    <td style={{ fontSize: 10, color: 'var(--color-text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {pb.description || '--'}
                    </td>
                    <td style={{ fontSize: 10, color: 'var(--color-text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatTriggerSummary(pb.trigger_conditions)}
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                      {pb.linked_workflow_id
                        ? workflows.find((w) => w.id === pb.linked_workflow_id)?.name || pb.linked_workflow_id.slice(0, 8)
                        : '--'}
                    </td>
                    <td className="mono-cell">{pb.priority}</td>
                    <td>
                      <span style={{ color: pb.is_active ? '#22c55e' : '#6b7280', fontWeight: 600, fontSize: 10 }}>
                        {pb.is_active ? 'YES' : 'NO'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleToggleActive(pb) }}
                          className="wf-stage-action-btn"
                          title={pb.is_active ? 'Deactivate' : 'Activate'}
                        >
                          {pb.is_active ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); openEdit(pb) }}
                          className="wf-stage-action-btn"
                          title="Edit"
                        >
                          EDIT
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setTriggerPlaybookId(pb.id); setTriggerIncidentId('') }}
                          className="wf-stage-action-btn"
                          title="Manual Trigger"
                        >
                          <Play size={12} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleExpand(pb.id) }}
                          className="wf-stage-action-btn"
                          title="Execution History"
                        >
                          {expandedId === pb.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === pb.id && (
                    <tr key={`${pb.id}-history`}>
                      <td colSpan={7} style={{ padding: 0 }}>
                        <div style={{
                          padding: '8px 16px',
                          background: 'var(--color-bg-elevated)',
                          borderBottom: '1px solid var(--color-border)',
                        }}>
                          <h4 style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                            EXECUTION HISTORY
                          </h4>
                          {executions.length === 0 ? (
                            <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>No executions</div>
                          ) : (
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                              <thead>
                                <tr>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--color-text-muted)' }}>ID</th>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--color-text-muted)' }}>INCIDENT</th>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--color-text-muted)' }}>STATUS</th>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--color-text-muted)' }}>STARTED</th>
                                  <th style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--color-text-muted)' }}>COMPLETED</th>
                                </tr>
                              </thead>
                              <tbody>
                                {executions.map((exec) => (
                                  <tr key={exec.id}>
                                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{exec.id.slice(0, 8)}</td>
                                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{exec.incident_id.slice(0, 8)}</td>
                                    <td style={{ padding: '4px 8px' }}>
                                      <span className="status-badge" style={{
                                        borderColor: exec.status === 'completed' ? '#22c55e' : exec.status === 'failed' ? '#ef4444' : '#f59e0b',
                                        color: exec.status === 'completed' ? '#22c55e' : exec.status === 'failed' ? '#ef4444' : '#f59e0b',
                                        fontSize: 9,
                                      }}>
                                        {exec.status.toUpperCase()}
                                      </span>
                                    </td>
                                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{new Date(exec.started_at).toLocaleString()}</td>
                                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{exec.completed_at ? new Date(exec.completed_at).toLocaleString() : '--'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Create/Edit Modal */}
      {showForm && (
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <span className="modal-title">{editId ? 'EDIT PLAYBOOK' : 'NEW PLAYBOOK'}</span>
              <button className="modal-close" onClick={() => setShowForm(false)}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">NAME</label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="form-input"
                    placeholder="Playbook name"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">DESCRIPTION</label>
                  <textarea
                    value={formDesc}
                    onChange={(e) => setFormDesc(e.target.value)}
                    className="form-input form-textarea"
                    placeholder="Description..."
                    rows={2}
                  />
                </div>

                <div style={{
                  padding: 12,
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                  marginBottom: 8,
                }}>
                  <h4 style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: 1, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                    TRIGGER CONDITIONS
                  </h4>
                  <div className="form-group">
                    <label className="form-label">SEVERITY THRESHOLD</label>
                    <select value={formSeverity} onChange={(e) => setFormSeverity(e.target.value)} className="form-input">
                      <option value="">No threshold</option>
                      <option value="critical">CRITICAL</option>
                      <option value="high">HIGH</option>
                      <option value="medium">MEDIUM</option>
                      <option value="low">LOW</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">MITRE TECHNIQUES (comma separated)</label>
                    <input
                      type="text"
                      value={formMitre}
                      onChange={(e) => setFormMitre(e.target.value)}
                      className="form-input"
                      placeholder="T1566, T1059.001"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">ALERT SOURCE</label>
                    <select value={formAlertSource} onChange={(e) => setFormAlertSource(e.target.value)} className="form-input">
                      <option value="">Any source</option>
                      <option value="siem">SIEM</option>
                      <option value="edr">EDR</option>
                      <option value="ids">IDS</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">IOC TYPE</label>
                    <select value={formIocType} onChange={(e) => setFormIocType(e.target.value)} className="form-input">
                      <option value="">Any type</option>
                      <option value="ip">IP</option>
                      <option value="domain">Domain</option>
                      <option value="hash_sha256">Hash (SHA256)</option>
                      <option value="url">URL</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">LINKED WORKFLOW</label>
                  <select value={formWorkflow} onChange={(e) => setFormWorkflow(e.target.value)} className="form-input">
                    <option value="">None</option>
                    {workflows.map((wf) => (
                      <option key={wf.id} value={wf.id}>{wf.name}</option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">PRIORITY</label>
                  <input
                    type="number"
                    value={formPriority}
                    onChange={(e) => setFormPriority(Number(e.target.value))}
                    className="form-input"
                    min={1}
                    max={100}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">CLASSIFICATION</label>
                  <ClassificationSelect
                    value={formClassification}
                    onChange={setFormClassification}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="submit" className="submit-btn">
                  {editId ? 'UPDATE PLAYBOOK' : 'CREATE PLAYBOOK'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manual Trigger Dialog */}
      {triggerPlaybookId && (
        <div className="modal-overlay" onClick={() => setTriggerPlaybookId(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <span className="modal-title">TRIGGER PLAYBOOK</span>
              <button className="modal-close" onClick={() => setTriggerPlaybookId(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">INCIDENT ID</label>
                <input
                  type="text"
                  value={triggerIncidentId}
                  onChange={(e) => setTriggerIncidentId(e.target.value)}
                  className="form-input"
                  placeholder="Enter incident ID"
                />
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={handleManualTrigger} className="submit-btn" disabled={!triggerIncidentId.trim()}>
                <Play size={12} />
                TRIGGER
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
