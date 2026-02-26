import { useState, useRef } from 'react'
import { ChevronUp, ChevronDown, Trash2, Plus, GripVertical } from 'lucide-react'
import type { CreateStageRequest } from '../../types/workflow'

const STAGE_TYPE_COLORS: Record<string, string> = {
  action: '#3b82f6',
  approval: '#f59e0b',
  notification: '#339af0',
  condition: '#8b5cf6',
  timer: '#f97316',
  terminal: '#6b7280',
}

interface Props {
  stages: CreateStageRequest[]
  selectedIndex: number | null
  onSelect: (index: number) => void
  onReorder: (fromIndex: number, direction: 'up' | 'down') => void
  onMove: (fromIndex: number, toIndex: number) => void
  onRemove: (index: number) => void
  onAdd: () => void
}

export default function StageList({ stages, selectedIndex, onSelect, onReorder, onMove, onRemove, onAdd }: Props) {
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const dragNodeRef = useRef<HTMLDivElement | null>(null)

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    setDragIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
    // Store index as text for the drag operation
    e.dataTransfer.setData('text/plain', String(idx))
    // Make the drag image slightly transparent
    if (dragNodeRef.current) {
      dragNodeRef.current.style.opacity = '0.5'
    }
  }

  const handleDragEnd = () => {
    if (dragNodeRef.current) {
      dragNodeRef.current.style.opacity = '1'
    }
    if (dragIdx !== null && overIdx !== null && dragIdx !== overIdx) {
      onMove(dragIdx, overIdx)
    }
    setDragIdx(null)
    setOverIdx(null)
  }

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIdx(idx)
  }

  const handleDragLeave = () => {
    setOverIdx(null)
  }

  return (
    <div className="wf-stage-list">
      {stages.map((stage, idx) => (
        <div key={idx} className="wf-stage-item-wrap">
          {idx > 0 && <div className={`wf-stage-connector${dragIdx !== null && overIdx === idx && dragIdx !== idx ? ' drag-over' : ''}`} />}
          <div
            ref={dragIdx === idx ? dragNodeRef : undefined}
            className={`wf-stage-card${selectedIndex === idx ? ' selected' : ''}${dragIdx !== null && overIdx === idx && dragIdx !== idx ? ' drop-target' : ''}${dragIdx === idx ? ' dragging' : ''}`}
            onClick={() => onSelect(idx)}
            draggable
            onDragStart={e => handleDragStart(e, idx)}
            onDragEnd={handleDragEnd}
            onDragOver={e => handleDragOver(e, idx)}
            onDragLeave={handleDragLeave}
          >
            <div className="wf-stage-card-header">
              <div className="wf-stage-drag-handle" title="Drag to reorder">
                <GripVertical size={12} />
              </div>
              <span
                className="wf-stage-type-badge"
                style={{ borderColor: STAGE_TYPE_COLORS[stage.stage_type] || '#6b7280', color: STAGE_TYPE_COLORS[stage.stage_type] || '#6b7280' }}
              >
                {stage.stage_type.toUpperCase()}
              </span>
              <span className="wf-stage-order">#{stage.stage_order}</span>
            </div>
            <div className="wf-stage-card-name">{stage.name || 'Untitled Stage'}</div>
            <div className="wf-stage-card-actions">
              <button
                onClick={(e) => { e.stopPropagation(); onReorder(idx, 'up'); }}
                disabled={idx === 0}
                className="wf-stage-action-btn"
                title="Move up"
              >
                <ChevronUp size={12} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onReorder(idx, 'down'); }}
                disabled={idx === stages.length - 1}
                className="wf-stage-action-btn"
                title="Move down"
              >
                <ChevronDown size={12} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onRemove(idx); }}
                className="wf-stage-action-btn danger"
                title="Remove"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        </div>
      ))}
      <button onClick={onAdd} className="wf-add-stage-btn">
        <Plus size={14} />
        ADD STAGE
      </button>
    </div>
  )
}
