import { Check } from 'lucide-react'
import type { WorkflowStage } from '../../types/workflow'

interface Props {
  stages: WorkflowStage[]
  currentStageId?: string | null
  completedStageIds?: string[]
  status?: string
}

export default function WorkflowProgressBar({ stages, currentStageId, completedStageIds = [], status }: Props) {
  const sorted = [...stages].sort((a, b) => a.stage_order - b.stage_order)
  const currentIdx = sorted.findIndex(s => s.id === currentStageId)
  const isComplete = status === 'completed'

  return (
    <div className="wf-progress-bar">
      {sorted.map((stage, idx) => {
        const isCurrent = stage.id === currentStageId && !isComplete
        const isCompleted = isComplete || idx < currentIdx || completedStageIds.includes(stage.id)
        const isUpcoming = !isCurrent && !isCompleted

        let nodeClass = 'wf-progress-node'
        if (isCompleted) nodeClass += ' completed'
        else if (isCurrent) nodeClass += ' current'
        else if (isUpcoming) nodeClass += ' upcoming'

        return (
          <div key={stage.id} className="wf-progress-step">
            {idx > 0 && (
              <div className={`wf-progress-connector${isCompleted || isCurrent ? ' filled' : ''}`} />
            )}
            <div className={nodeClass}>
              {isCompleted ? <Check size={12} /> : <span className="wf-progress-number">{idx + 1}</span>}
            </div>
            <span className={`wf-progress-label${isCurrent ? ' current' : ''}${isCompleted ? ' completed' : ''}`}>
              {stage.name}
            </span>
          </div>
        )
      })}
    </div>
  )
}
