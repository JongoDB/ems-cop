import { useState } from 'react'
import { Trash2, Plus } from 'lucide-react'
import type { CreateStageRequest, CreateTransitionRequest } from '../../types/workflow'

interface Props {
  selectedStageOrder: number
  stages: CreateStageRequest[]
  transitions: CreateTransitionRequest[]
  onAdd: (transition: CreateTransitionRequest) => void
  onRemove: (index: number) => void
}

const TRIGGER_OPTIONS: Record<string, string[]> = {
  approval: ['on_approve', 'on_reject', 'on_kickback', 'on_escalate', 'on_timeout'],
  action: ['on_complete'],
  condition: ['on_condition_true', 'on_condition_false'],
  timer: ['on_timeout', 'on_complete'],
  notification: ['on_complete'],
  terminal: [],
}

export default function TransitionEditor({ selectedStageOrder, stages, transitions, onAdd, onRemove }: Props) {
  const [newTrigger, setNewTrigger] = useState('')
  const [newTargetOrder, setNewTargetOrder] = useState<number | ''>('')

  const selectedStage = stages.find(s => s.stage_order === selectedStageOrder)
  const outgoing = transitions
    .map((t, idx) => ({ ...t, _idx: idx }))
    .filter(t => t.from_stage_order === selectedStageOrder)

  const availableTriggers = selectedStage
    ? (TRIGGER_OPTIONS[selectedStage.stage_type] || [])
    : []

  const handleAdd = () => {
    if (!newTrigger || newTargetOrder === '') return
    onAdd({
      from_stage_order: selectedStageOrder,
      to_stage_order: newTargetOrder as number,
      trigger: newTrigger,
      label: `${newTrigger.replace('on_', '').replace('_', ' ')}`,
    })
    setNewTrigger('')
    setNewTargetOrder('')
  }

  return (
    <div className="wf-transition-editor">
      <h3 className="detail-section-title">TRANSITIONS</h3>

      {outgoing.length === 0 && (
        <p className="wf-transition-empty">
          No explicit transitions. Will follow linear stage order.
        </p>
      )}

      {outgoing.map(t => {
        const target = stages.find(s => s.stage_order === t.to_stage_order)
        return (
          <div key={t._idx} className="wf-transition-row">
            <span className="wf-transition-trigger">{t.trigger}</span>
            <span className="wf-transition-arrow">&rarr;</span>
            <span className="wf-transition-target">{target?.name || `#${t.to_stage_order}`}</span>
            {t.label && <span className="wf-transition-label">{t.label}</span>}
            <button onClick={() => onRemove(t._idx)} className="wf-stage-action-btn danger">
              <Trash2 size={12} />
            </button>
          </div>
        )
      })}

      {availableTriggers.length > 0 && (
        <div className="wf-transition-add">
          <select value={newTrigger} onChange={e => setNewTrigger(e.target.value)} className="form-input">
            <option value="">Select trigger...</option>
            {availableTriggers.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select
            value={newTargetOrder}
            onChange={e => setNewTargetOrder(e.target.value ? parseInt(e.target.value) : '')}
            className="form-input"
          >
            <option value="">Target stage...</option>
            {stages.filter(s => s.stage_order !== selectedStageOrder).map(s => (
              <option key={s.stage_order} value={s.stage_order}>{s.name || `Stage #${s.stage_order}`}</option>
            ))}
          </select>
          <button onClick={handleAdd} disabled={!newTrigger || newTargetOrder === ''} className="wf-transition-add-btn">
            <Plus size={12} />
          </button>
        </div>
      )}
    </div>
  )
}
