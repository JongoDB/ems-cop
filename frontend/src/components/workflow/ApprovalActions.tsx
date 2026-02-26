import { useState } from 'react'
import { CheckCircle, XCircle, CornerDownLeft } from 'lucide-react'
import type { WorkflowRun, WorkflowTransition } from '../../types/workflow'
import { useWorkflowStore } from '../../stores/workflowStore'
import { useAuthStore } from '../../stores/authStore'

interface Props {
  run: WorkflowRun
  transitions?: WorkflowTransition[]
  onAction?: () => void
}

export default function ApprovalActions({ run, transitions = [], onAction }: Props) {
  const [comment, setComment] = useState('')
  const [loading, setLoading] = useState(false)
  const [kickbackTarget, setKickbackTarget] = useState<string | undefined>(undefined)
  const { approveRun, rejectRun, kickbackRun, completeStage } = useWorkflowStore()
  const user = useAuthStore(s => s.user)

  const stage = run.current_stage
  if (!stage || run.status !== 'active') return null

  const userRoles = user?.roles ?? []
  const requiredRole = stage.config?.required_role
  const hasPermission = !requiredRole ||
    userRoles.includes(requiredRole) ||
    userRoles.includes('admin')

  // Get kickback targets
  const kickbackTransitions = transitions.filter(
    t => t.from_stage_id === stage.id && (t.trigger === 'on_reject' || t.trigger === 'on_kickback')
  )

  const handleAction = async (action: 'approve' | 'reject' | 'kickback' | 'complete') => {
    setLoading(true)
    try {
      switch (action) {
        case 'approve':
          await approveRun(run.id, comment)
          break
        case 'reject':
          await rejectRun(run.id, comment, kickbackTarget)
          break
        case 'kickback':
          await kickbackRun(run.id, comment, kickbackTarget)
          break
        case 'complete':
          await completeStage(run.id, comment)
          break
      }
      setComment('')
      onAction?.()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="wf-approval-actions">
      <div className="wf-approval-banner">
        <span className="wf-approval-stage-type">{stage.stage_type.toUpperCase()}</span>
        <span className="wf-approval-stage-name">{stage.name}</span>
        {requiredRole && (
          <span className={`wf-approval-role${hasPermission ? ' has-role' : ' no-role'}`}>
            {requiredRole.replace('_', ' ').toUpperCase()}
          </span>
        )}
      </div>

      {hasPermission && (
        <>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            className="form-input form-textarea wf-approval-comment"
            placeholder="Add a comment (optional)..."
            rows={2}
          />

          {kickbackTransitions.length > 0 && (stage.stage_type === 'approval') && (
            <div className="wf-kickback-select">
              <label className="form-label">KICKBACK TARGET</label>
              <select
                value={kickbackTarget || ''}
                onChange={e => setKickbackTarget(e.target.value || undefined)}
                className="form-input"
              >
                <option value="">Default (previous stage)</option>
                {kickbackTransitions.map(t => (
                  <option key={t.id} value={t.to_stage_id}>{t.label || t.trigger}</option>
                ))}
              </select>
            </div>
          )}

          <div className="wf-approval-buttons">
            {stage.stage_type === 'approval' && (
              <>
                <button
                  onClick={() => handleAction('approve')}
                  disabled={loading}
                  className="wf-btn-approve"
                >
                  <CheckCircle size={14} />
                  APPROVE
                </button>
                <button
                  onClick={() => handleAction(kickbackTransitions.length > 0 ? 'kickback' : 'reject')}
                  disabled={loading}
                  className="wf-btn-reject"
                >
                  {kickbackTransitions.length > 0 ? (
                    <><CornerDownLeft size={14} /> KICKBACK</>
                  ) : (
                    <><XCircle size={14} /> REJECT</>
                  )}
                </button>
              </>
            )}
            {stage.stage_type === 'action' && (
              <button
                onClick={() => handleAction('complete')}
                disabled={loading}
                className="wf-btn-approve"
              >
                <CheckCircle size={14} />
                MARK COMPLETE
              </button>
            )}
          </div>
        </>
      )}

      {!hasPermission && (
        <div className="wf-approval-waiting">
          Waiting for <strong>{requiredRole?.replace('_', ' ')}</strong> to take action
        </div>
      )}
    </div>
  )
}
