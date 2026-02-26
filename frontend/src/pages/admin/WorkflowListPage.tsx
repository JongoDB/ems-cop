import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Copy, Trash2, Star } from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { Workflow } from '../../types/workflow'

export default function WorkflowListPage() {
  const navigate = useNavigate()
  const { workflows, loading, error, fetchWorkflows, deleteWorkflow, cloneWorkflow } = useWorkflowStore()
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')

  useEffect(() => {
    fetchWorkflows()
  }, [fetchWorkflows])

  const handleCreate = async () => {
    if (!newName.trim()) return
    const wf = await useWorkflowStore.getState().createWorkflow({
      name: newName,
      description: '',
      is_template: true,
      is_default: false,
      stages: [
        { name: 'Start', stage_order: 1, stage_type: 'action', config: {} },
        { name: 'End', stage_order: 2, stage_type: 'terminal', config: {} },
      ],
      transitions: [],
    })
    if (wf) {
      navigate(`/admin/workflows/${wf.id}`)
    }
    setNewName('')
    setShowCreate(false)
  }

  const handleClone = async (e: React.MouseEvent, wf: Workflow) => {
    e.stopPropagation()
    const cloned = await cloneWorkflow(wf.id)
    if (cloned) {
      navigate(`/admin/workflows/${cloned.id}`)
    }
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await deleteWorkflow(id)
  }

  return (
    <div style={{ padding: '16px 0', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="tickets-toolbar">
        <div className="toolbar-left">
          <h1 className="page-title">WORKFLOWS</h1>
          <span className="ticket-count">{workflows.length} total</span>
        </div>
        <div className="toolbar-right">
          {showCreate ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                className="form-input"
                placeholder="Workflow name"
                style={{ width: 200, padding: '6px 10px', fontSize: 12 }}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
              <button onClick={handleCreate} className="create-btn" disabled={!newName.trim()}>CREATE</button>
              <button onClick={() => setShowCreate(false)} className="transition-btn">CANCEL</button>
            </div>
          ) : (
            <button onClick={() => setShowCreate(true)} className="create-btn">
              <Plus size={14} />
              NEW WORKFLOW
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="wf-error-banner" onClick={() => useWorkflowStore.setState({ error: null })}>
          {error}
          <span style={{ marginLeft: 8, opacity: 0.6, fontSize: 10 }}>CLICK TO DISMISS</span>
        </div>
      )}

      <div className="tickets-table-wrap">
        <table className="tickets-table">
          <thead>
            <tr>
              <th>NAME</th>
              <th>STAGES</th>
              <th>VERSION</th>
              <th>DEFAULT</th>
              <th>TEMPLATE</th>
              <th>CREATED</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="table-empty">Loading...</td></tr>
            ) : workflows.length === 0 ? (
              <tr><td colSpan={7} className="table-empty">No workflows found</td></tr>
            ) : (
              workflows.map(wf => (
                <tr
                  key={wf.id}
                  className="ticket-row"
                  onClick={() => navigate(`/admin/workflows/${wf.id}`)}
                >
                  <td className="title-cell">{wf.name}</td>
                  <td className="mono-cell">{wf.stages?.length ?? 0}</td>
                  <td className="mono-cell">v{wf.version}</td>
                  <td>
                    {wf.is_default && (
                      <Star size={14} style={{ color: 'var(--color-warning)' }} />
                    )}
                  </td>
                  <td>
                    {wf.is_template && (
                      <span className="status-badge" style={{ borderColor: 'var(--color-info)', color: 'var(--color-info)' }}>
                        TEMPLATE
                      </span>
                    )}
                  </td>
                  <td className="mono-cell">{new Date(wf.created_at).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button onClick={(e) => handleClone(e, wf)} className="wf-stage-action-btn" title="Clone">
                        <Copy size={12} />
                      </button>
                      <button onClick={(e) => handleDelete(e, wf.id)} className="wf-stage-action-btn danger" title="Delete">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
