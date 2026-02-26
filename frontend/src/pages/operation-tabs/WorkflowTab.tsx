import { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { useWorkflowStore } from '../../stores/workflowStore'
import WorkflowProgressBar from '../../components/workflow/WorkflowProgressBar'
import WorkflowRunViewer from '../../components/workflow/WorkflowRunViewer'
import ApprovalActions from '../../components/workflow/ApprovalActions'
import type { Workflow, WorkflowRun } from '../../types/workflow'

interface OperationContext {
  operation: {
    id: string
    name: string
    workflow_id?: string | null
    metadata?: Record<string, unknown>
  }
  refresh: () => void
}

export default function WorkflowTab() {
  const { operation } = useOutletContext<OperationContext>()
  const { fetchWorkflowRun } = useWorkflowStore()
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        // Fetch workflow definition if operation has one
        const wfId = operation.workflow_id
        if (wfId) {
          const wf = await apiFetch<Workflow>(`/workflows/${wfId}`)
          setWorkflow(wf)
        }

        // Fetch active runs for tickets in this operation
        const res = await apiFetch<{ data: WorkflowRun[] }>(`/workflow-runs?limit=50`)
        // Filter runs whose context has this operation_id
        const opRuns = res.data?.filter(r => {
          const ctx = r.context as Record<string, unknown>
          return ctx?.operation_id === operation.id
        }) ?? []
        setRuns(opRuns)
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [operation.id, operation.workflow_id, fetchWorkflowRun])

  const refreshRuns = async () => {
    try {
      const res = await apiFetch<{ data: WorkflowRun[] }>(`/workflow-runs?limit=50`)
      const opRuns = res.data?.filter(r => {
        const ctx = r.context as Record<string, unknown>
        return ctx?.operation_id === operation.id
      }) ?? []
      setRuns(opRuns)
    } catch { /* ignore */ }
  }

  if (loading) {
    return (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)', padding: 24 }}>
        LOADING WORKFLOW...
      </div>
    )
  }

  if (!workflow && runs.length === 0) {
    return (
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)', padding: 24 }}>
        No workflow assigned to this operation.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {workflow && (
        <div style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <h3 className="detail-section-title" style={{ margin: 0 }}>WORKFLOW</h3>
            <span className="mono-cell">{workflow.name}</span>
            <span className="mono-cell">v{workflow.version}</span>
          </div>
          <WorkflowProgressBar
            stages={workflow.stages}
            currentStageId={undefined}
            status="completed"
          />
        </div>
      )}

      {runs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h3 className="detail-section-title">ACTIVE RUNS ({runs.length})</h3>
          {runs.map(run => (
            <div key={run.id} style={{ background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border)', padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <span className="status-badge" style={{
                  borderColor: run.status === 'active' ? 'var(--color-info)' : run.status === 'completed' ? 'var(--color-success)' : 'var(--color-text-muted)',
                  color: run.status === 'active' ? 'var(--color-info)' : run.status === 'completed' ? 'var(--color-success)' : 'var(--color-text-muted)',
                }}>
                  {run.status.toUpperCase()}
                </span>
                {run.workflow_name && <span className="mono-cell">{run.workflow_name}</span>}
                {run.ticket_id && <span className="mono-cell">Ticket: {run.ticket_id.substring(0, 8)}...</span>}
              </div>

              {workflow && (
                <WorkflowProgressBar
                  stages={workflow.stages}
                  currentStageId={run.current_stage_id}
                  status={run.status}
                />
              )}

              {run.status === 'active' && run.current_stage && (
                <div style={{ marginTop: 16 }}>
                  <ApprovalActions
                    run={run}
                    transitions={workflow?.transitions ?? []}
                    onAction={refreshRuns}
                  />
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <WorkflowRunViewer runId={run.id} history={run.history} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
