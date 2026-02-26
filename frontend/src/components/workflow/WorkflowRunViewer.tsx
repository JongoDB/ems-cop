import { useState, useEffect } from 'react'
import { Clock, CheckCircle, XCircle, CornerDownLeft, AlertTriangle, Play, ArrowRight } from 'lucide-react'
import type { WorkflowRunHistoryEntry } from '../../types/workflow'
import { useWorkflowStore } from '../../stores/workflowStore'

interface Props {
  runId: string
  history?: WorkflowRunHistoryEntry[]
}

const ACTION_CONFIG: Record<string, { icon: typeof Clock; color: string; label: string }> = {
  entered: { icon: ArrowRight, color: 'var(--color-info)', label: 'ENTERED' },
  approved: { icon: CheckCircle, color: 'var(--color-success)', label: 'APPROVED' },
  auto_approved: { icon: CheckCircle, color: 'var(--color-success)', label: 'AUTO-APPROVED' },
  rejected: { icon: XCircle, color: 'var(--color-danger)', label: 'REJECTED' },
  kickback: { icon: CornerDownLeft, color: 'var(--color-warning)', label: 'KICKBACK' },
  escalated: { icon: AlertTriangle, color: 'var(--color-warning)', label: 'ESCALATED' },
  timed_out: { icon: Clock, color: 'var(--color-warning)', label: 'TIMED OUT' },
  complete: { icon: CheckCircle, color: 'var(--color-success)', label: 'COMPLETED' },
  aborted: { icon: XCircle, color: 'var(--color-danger)', label: 'ABORTED' },
}

export default function WorkflowRunViewer({ runId, history: initialHistory }: Props) {
  const [history, setHistory] = useState<WorkflowRunHistoryEntry[]>(initialHistory ?? [])
  const { fetchRunHistory } = useWorkflowStore()

  useEffect(() => {
    if (!initialHistory) {
      fetchRunHistory(runId).then(setHistory)
    }
  }, [runId, initialHistory, fetchRunHistory])

  if (history.length === 0) {
    return (
      <div className="wf-run-viewer">
        <div className="wf-run-empty">No history entries</div>
      </div>
    )
  }

  return (
    <div className="wf-run-viewer">
      <h3 className="detail-section-title">
        <Play size={14} />
        RUN HISTORY
      </h3>
      <div className="wf-timeline">
        {history.map((entry) => {
          const config = ACTION_CONFIG[entry.action] || { icon: ArrowRight, color: 'var(--color-text-muted)', label: entry.action.toUpperCase() }
          const Icon = config.icon
          return (
            <div key={entry.id} className="wf-timeline-entry">
              <div className="wf-timeline-dot" style={{ borderColor: config.color }}>
                <Icon size={10} style={{ color: config.color }} />
              </div>
              <div className="wf-timeline-content">
                <div className="wf-timeline-header">
                  <span className="wf-timeline-action" style={{ color: config.color }}>
                    {config.label}
                  </span>
                  <span className="wf-timeline-stage">{entry.stage_name}</span>
                  <span className="wf-timeline-time">
                    {new Date(entry.occurred_at).toLocaleString()}
                  </span>
                </div>
                {entry.comment && (
                  <p className="wf-timeline-comment">{entry.comment}</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
