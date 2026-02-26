import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ChevronLeft, Save, Star } from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflowStore'
import StageList from '../../components/workflow/StageList'
import StageConfigPanel from '../../components/workflow/StageConfigPanel'
import TransitionEditor from '../../components/workflow/TransitionEditor'
import type { CreateStageRequest, CreateTransitionRequest } from '../../types/workflow'

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>()
  const { currentWorkflow, loading, fetchWorkflow, updateWorkflow } = useWorkflowStore()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [stages, setStages] = useState<CreateStageRequest[]>([])
  const [transitions, setTransitions] = useState<CreateTransitionRequest[]>([])
  const [selectedStageIdx, setSelectedStageIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const loadWorkflow = useCallback(async () => {
    if (id) await fetchWorkflow(id)
  }, [id, fetchWorkflow])

  useEffect(() => {
    loadWorkflow()
  }, [loadWorkflow])

  useEffect(() => {
    if (currentWorkflow) {
      setName(currentWorkflow.name)
      setDescription(currentWorkflow.description)
      setIsDefault(currentWorkflow.is_default)
      setStages(currentWorkflow.stages.map(s => ({
        name: s.name,
        stage_order: s.stage_order,
        stage_type: s.stage_type,
        config: s.config,
      })))

      // Build reverse map
      const stageIDToOrder: Record<string, number> = {}
      currentWorkflow.stages.forEach(s => { stageIDToOrder[s.id] = s.stage_order })

      setTransitions(currentWorkflow.transitions.map(t => ({
        from_stage_order: stageIDToOrder[t.from_stage_id] || 0,
        to_stage_order: stageIDToOrder[t.to_stage_id] || 0,
        trigger: t.trigger,
        condition_expr: t.condition_expr,
        label: t.label,
      })))
      setDirty(false)
    }
  }, [currentWorkflow])

  const handleSave = async () => {
    if (!id) return
    setSaving(true)
    await updateWorkflow(id, {
      name,
      description,
      is_default: isDefault,
      stages,
      transitions,
    })
    setDirty(false)
    setSaving(false)
  }

  const handleReorder = (fromIdx: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? fromIdx - 1 : fromIdx + 1
    handleMoveStage(fromIdx, targetIdx)
  }

  const handleMoveStage = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return
    if (toIdx < 0 || toIdx >= stages.length) return

    const newStages = [...stages]
    const [moved] = newStages.splice(fromIdx, 1)
    newStages.splice(toIdx, 0, moved)

    // Reassign stage_orders sequentially
    const reordered = newStages.map((s, i) => ({ ...s, stage_order: i + 1 }))
    setStages(reordered)

    // Adjust selected index to follow the selection
    if (selectedStageIdx === fromIdx) setSelectedStageIdx(toIdx)
    else if (selectedStageIdx !== null) {
      let newSel = selectedStageIdx
      if (fromIdx < selectedStageIdx && toIdx >= selectedStageIdx) newSel--
      else if (fromIdx > selectedStageIdx && toIdx <= selectedStageIdx) newSel++
      setSelectedStageIdx(newSel)
    }

    setDirty(true)
  }

  const handleRemoveStage = (idx: number) => {
    const removed = stages[idx]
    const newStages = stages.filter((_, i) => i !== idx)
    // Remove transitions referencing removed stage
    const newTrans = transitions.filter(
      t => t.from_stage_order !== removed.stage_order && t.to_stage_order !== removed.stage_order
    )
    setStages(newStages)
    setTransitions(newTrans)
    if (selectedStageIdx === idx) setSelectedStageIdx(null)
    else if (selectedStageIdx !== null && selectedStageIdx > idx) setSelectedStageIdx(selectedStageIdx - 1)
    setDirty(true)
  }

  const handleAddStage = () => {
    const maxOrder = stages.reduce((max, s) => Math.max(max, s.stage_order), 0)
    setStages([...stages, {
      name: '',
      stage_order: maxOrder + 1,
      stage_type: 'action',
      config: {},
    }])
    setSelectedStageIdx(stages.length)
    setDirty(true)
  }

  const handleStageChange = (updates: Partial<CreateStageRequest>) => {
    if (selectedStageIdx === null) return
    const newStages = [...stages]
    newStages[selectedStageIdx] = { ...newStages[selectedStageIdx], ...updates }
    setStages(newStages)
    setDirty(true)
  }

  const handleAddTransition = (t: CreateTransitionRequest) => {
    setTransitions([...transitions, t])
    setDirty(true)
  }

  const handleRemoveTransition = (idx: number) => {
    setTransitions(transitions.filter((_, i) => i !== idx))
    setDirty(true)
  }

  if (loading && !currentWorkflow) {
    return (
      <div style={{ padding: 24, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)' }}>
        LOADING WORKFLOW...
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0', borderBottom: '1px solid var(--color-border)' }}>
        <Link
          to="/admin/workflows"
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)', textDecoration: 'none' }}
        >
          <ChevronLeft size={14} />
          WORKFLOWS
        </Link>
        <input
          type="text"
          value={name}
          onChange={e => { setName(e.target.value); setDirty(true) }}
          className="form-input"
          style={{ flex: 1, maxWidth: 400, padding: '4px 8px', fontSize: 14, fontWeight: 600, background: 'transparent', border: '1px solid transparent' }}
          onFocus={e => e.target.style.borderColor = 'var(--color-border)'}
          onBlur={e => e.target.style.borderColor = 'transparent'}
        />
        {currentWorkflow && (
          <span className="mono-cell">v{currentWorkflow.version}</span>
        )}
        <button
          onClick={() => { setIsDefault(!isDefault); setDirty(true) }}
          className={`wf-stage-action-btn${isDefault ? ' active' : ''}`}
          title="Set as default"
        >
          <Star size={14} style={{ color: isDefault ? 'var(--color-warning)' : undefined }} />
        </button>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className="create-btn"
        >
          <Save size={14} />
          {saving ? 'SAVING...' : 'SAVE'}
        </button>
      </div>

      {/* Two-column editor */}
      <div style={{ display: 'flex', flex: 1, gap: 0, minHeight: 0, overflow: 'hidden' }}>
        {/* Left: Stage list */}
        <div style={{ width: 320, flexShrink: 0, borderRight: '1px solid var(--color-border)', overflowY: 'auto', padding: 16 }}>
          <StageList
            stages={stages}
            selectedIndex={selectedStageIdx}
            onSelect={setSelectedStageIdx}
            onReorder={handleReorder}
            onMove={handleMoveStage}
            onRemove={handleRemoveStage}
            onAdd={handleAddStage}
          />
        </div>

        {/* Right: Config + Transitions */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {selectedStageIdx !== null && stages[selectedStageIdx] ? (
            <>
              <StageConfigPanel
                stage={stages[selectedStageIdx]}
                onChange={handleStageChange}
              />
              <div style={{ marginTop: 24 }}>
                <TransitionEditor
                  selectedStageOrder={stages[selectedStageIdx].stage_order}
                  stages={stages}
                  transitions={transitions}
                  onAdd={handleAddTransition}
                  onRemove={handleRemoveTransition}
                />
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)' }}>
              SELECT A STAGE TO EDIT
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
