import { useState, useCallback, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { Shield, RotateCcw, Play } from 'lucide-react'

type ActionType = 'isolate_host' | 'kill_process' | 'block_ip' | 'disable_account' | 'quarantine_file'

interface ContainmentAction {
  id: string
  action_type: ActionType
  target: Record<string, string>
  status: string
  executed_at: string
  rolled_back_at?: string | null
}

interface ContainmentPanelProps {
  incidentId: string
  className?: string
}

const ACTION_LABELS: Record<ActionType, string> = {
  isolate_host: 'Isolate Host',
  kill_process: 'Kill Process',
  block_ip: 'Block IP',
  disable_account: 'Disable Account',
  quarantine_file: 'Quarantine File',
}

const ACTION_FIELDS: Record<ActionType, { key: string; label: string }[]> = {
  isolate_host: [
    { key: 'session_id', label: 'Session ID' },
    { key: 'hostname', label: 'Hostname' },
  ],
  kill_process: [
    { key: 'session_id', label: 'Session ID' },
    { key: 'process', label: 'Process Name/PID' },
  ],
  block_ip: [{ key: 'ip', label: 'IP Address' }],
  disable_account: [{ key: 'username', label: 'Username' }],
  quarantine_file: [
    { key: 'session_id', label: 'Session ID' },
    { key: 'hostname', label: 'Hostname' },
  ],
}

const STATUS_COLORS: Record<string, string> = {
  pending: '#f59e0b',
  executing: '#3b82f6',
  completed: '#22c55e',
  failed: '#ef4444',
  rolled_back: '#6b7280',
}

export default function ContainmentPanel({ incidentId, className = '' }: ContainmentPanelProps) {
  const [actionType, setActionType] = useState<ActionType>('isolate_host')
  const [target, setTarget] = useState<Record<string, string>>({})
  const [actions, setActions] = useState<ContainmentAction[]>([])
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState(false)

  const fetchActions = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch<{ data: ContainmentAction[] }>(
        `/c2/containment?incident_id=${incidentId}`
      )
      setActions(res.data || [])
    } catch {
      setActions([])
    } finally {
      setLoading(false)
    }
  }, [incidentId])

  useEffect(() => {
    fetchActions()
  }, [fetchActions])

  const handleExecute = async () => {
    setExecuting(true)
    try {
      await apiFetch('/c2/containment/execute', {
        method: 'POST',
        body: JSON.stringify({
          incident_id: incidentId,
          action_type: actionType,
          target,
        }),
      })
      setTarget({})
      await fetchActions()
    } catch {
      // error handled by apiFetch
    } finally {
      setExecuting(false)
    }
  }

  const handleRollback = async (actionId: string) => {
    try {
      await apiFetch(`/c2/containment/${actionId}/rollback`, { method: 'POST' })
      await fetchActions()
    } catch {
      // error handled by apiFetch
    }
  }

  const fields = ACTION_FIELDS[actionType] || []

  return (
    <div className={className}>
      <h3 style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 1,
        color: 'var(--color-text-bright)',
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <Shield size={14} />
        CONTAINMENT ACTIONS
      </h3>

      {/* Execute form */}
      <div style={{
        padding: 12,
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius)',
        marginBottom: 16,
        background: 'var(--color-bg-elevated)',
      }}>
        <div style={{ marginBottom: 8 }}>
          <label className="form-label" style={{ fontSize: 10 }}>ACTION TYPE</label>
          <select
            value={actionType}
            onChange={(e) => {
              setActionType(e.target.value as ActionType)
              setTarget({})
            }}
            className="form-input"
            style={{ fontSize: 11, padding: '4px 8px' }}
          >
            {(Object.keys(ACTION_LABELS) as ActionType[]).map((key) => (
              <option key={key} value={key}>{ACTION_LABELS[key]}</option>
            ))}
          </select>
        </div>

        {fields.map((field) => (
          <div key={field.key} style={{ marginBottom: 8 }}>
            <label className="form-label" style={{ fontSize: 10 }}>{field.label.toUpperCase()}</label>
            <input
              type="text"
              value={target[field.key] || ''}
              onChange={(e) => setTarget({ ...target, [field.key]: e.target.value })}
              className="form-input"
              style={{ fontSize: 11, padding: '4px 8px' }}
              placeholder={field.label}
            />
          </div>
        ))}

        <button
          onClick={handleExecute}
          disabled={executing}
          className="submit-btn"
          style={{ fontSize: 10, padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <Play size={10} />
          {executing ? 'EXECUTING...' : 'EXECUTE'}
        </button>
      </div>

      {/* Action history */}
      <div>
        {loading ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            Loading actions...
          </div>
        ) : actions.length === 0 ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            No containment actions yet
          </div>
        ) : (
          actions.map((action) => (
            <div
              key={action.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 0',
                borderBottom: '1px solid var(--color-border)',
                fontSize: 11,
              }}
            >
              <div>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, marginRight: 8 }}>
                  {ACTION_LABELS[action.action_type] || action.action_type}
                </span>
                <span
                  className="status-badge"
                  style={{
                    borderColor: STATUS_COLORS[action.status] || '#6b7280',
                    color: STATUS_COLORS[action.status] || '#6b7280',
                    fontSize: 9,
                  }}
                >
                  {action.status.toUpperCase()}
                </span>
              </div>
              {action.status === 'completed' && !action.rolled_back_at && (
                <button
                  onClick={() => handleRollback(action.id)}
                  style={{
                    background: 'none',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <RotateCcw size={10} />
                  ROLLBACK
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
