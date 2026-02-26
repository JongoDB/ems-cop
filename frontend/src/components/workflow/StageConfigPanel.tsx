import type { CreateStageRequest } from '../../types/workflow'

interface Props {
  stage: CreateStageRequest
  onChange: (updates: Partial<CreateStageRequest>) => void
}

const STAGE_TYPES = ['action', 'approval', 'notification', 'condition', 'timer', 'terminal']
const ROLES = ['planner', 'mission_commander', 'supervisor', 'senior_leadership', 'operator', 'admin']

export default function StageConfigPanel({ stage, onChange }: Props) {
  const updateConfig = (key: string, value: unknown) => {
    onChange({ config: { ...stage.config, [key]: value } })
  }

  return (
    <div className="wf-config-panel">
      <h3 className="detail-section-title">STAGE PROPERTIES</h3>

      <div className="form-group">
        <label className="form-label">NAME</label>
        <input
          type="text"
          value={stage.name}
          onChange={e => onChange({ name: e.target.value })}
          className="form-input"
          placeholder="Stage name"
        />
      </div>

      <div className="form-group">
        <label className="form-label">TYPE</label>
        <select
          value={stage.stage_type}
          onChange={e => onChange({ stage_type: e.target.value })}
          className="form-input"
        >
          {STAGE_TYPES.map(t => (
            <option key={t} value={t}>{t.toUpperCase()}</option>
          ))}
        </select>
      </div>

      {/* Type-specific config */}
      {(stage.stage_type === 'approval' || stage.stage_type === 'action') && (
        <div className="form-group">
          <label className="form-label">REQUIRED ROLE</label>
          <select
            value={stage.config?.required_role || ''}
            onChange={e => updateConfig('required_role', e.target.value)}
            className="form-input"
          >
            <option value="">None</option>
            {ROLES.map(r => (
              <option key={r} value={r}>{r.replace('_', ' ').toUpperCase()}</option>
            ))}
          </select>
        </div>
      )}

      {stage.stage_type === 'approval' && (
        <>
          <div className="form-group">
            <label className="form-label">MIN APPROVALS</label>
            <input
              type="number"
              min={1}
              value={stage.config?.min_approvals ?? 1}
              onChange={e => updateConfig('min_approvals', parseInt(e.target.value) || 1)}
              className="form-input"
            />
          </div>
          <div className="form-group">
            <label className="form-label">APPROVAL MODE</label>
            <select
              value={(stage.config?.approval_mode as string) || 'any'}
              onChange={e => updateConfig('approval_mode', e.target.value)}
              className="form-input"
            >
              <option value="any">Any (single approval)</option>
              <option value="quorum">Quorum (M of N)</option>
              <option value="all">All (unanimous)</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">ESCALATION TIMEOUT (minutes)</label>
            <input
              type="number"
              min={0}
              value={stage.config?.escalation_timeout_minutes ?? 0}
              onChange={e => updateConfig('escalation_timeout_minutes', parseInt(e.target.value) || 0)}
              className="form-input"
              placeholder="0 = no timeout"
            />
          </div>
        </>
      )}

      {stage.stage_type === 'action' && (
        <div className="form-group">
          <label className="form-label">DESCRIPTION</label>
          <textarea
            value={(stage.config?.description as string) || ''}
            onChange={e => updateConfig('description', e.target.value)}
            className="form-input form-textarea"
            placeholder="Describe what happens at this stage"
            rows={3}
          />
        </div>
      )}

      {stage.stage_type === 'condition' && (
        <div className="form-group">
          <label className="form-label">EXPRESSION</label>
          <input
            type="text"
            value={(stage.config?.expression as string) || ''}
            onChange={e => updateConfig('expression', e.target.value)}
            className="form-input"
            placeholder="risk_level > 3"
          />
          <span className="form-hint">Fields from run context. Supports: &gt;, &lt;, ==, !=, &amp;&amp;, ||</span>
        </div>
      )}

      {stage.stage_type === 'timer' && (
        <>
          <div className="form-group">
            <label className="form-label">DURATION (minutes)</label>
            <input
              type="number"
              min={1}
              value={stage.config?.duration_minutes ?? 30}
              onChange={e => updateConfig('duration_minutes', parseInt(e.target.value) || 30)}
              className="form-input"
            />
          </div>
          <div className="form-group">
            <label className="form-label">TIMEOUT ACTION</label>
            <select
              value={(stage.config?.timeout_action as string) || 'escalate'}
              onChange={e => updateConfig('timeout_action', e.target.value)}
              className="form-input"
            >
              <option value="escalate">Escalate</option>
              <option value="auto_approve">Auto-approve</option>
              <option value="reject">Reject</option>
            </select>
          </div>
        </>
      )}
    </div>
  )
}
