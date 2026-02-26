import { create } from 'zustand'
import { apiFetch } from '../lib/api'
import type {
  Workflow,
  WorkflowRun,
  WorkflowRunHistoryEntry,
  CreateWorkflowRequest,
} from '../types/workflow'

interface WorkflowStore {
  workflows: Workflow[]
  currentWorkflow: Workflow | null
  currentRun: WorkflowRun | null
  loading: boolean
  error: string | null

  fetchWorkflows: () => Promise<void>
  fetchWorkflow: (id: string) => Promise<void>
  createWorkflow: (req: CreateWorkflowRequest) => Promise<Workflow | null>
  updateWorkflow: (id: string, req: Partial<CreateWorkflowRequest>) => Promise<void>
  deleteWorkflow: (id: string) => Promise<void>
  cloneWorkflow: (id: string) => Promise<Workflow | null>

  fetchWorkflowRun: (id: string) => Promise<WorkflowRun | null>
  fetchRunByTicket: (ticketId: string) => Promise<WorkflowRun | null>
  approveRun: (runId: string, comment?: string) => Promise<WorkflowRun | null>
  rejectRun: (runId: string, comment?: string, targetStageId?: string) => Promise<WorkflowRun | null>
  kickbackRun: (runId: string, comment?: string, targetStageId?: string) => Promise<WorkflowRun | null>
  completeStage: (runId: string, comment?: string) => Promise<WorkflowRun | null>
  abortRun: (runId: string) => Promise<void>
  fetchRunHistory: (runId: string) => Promise<WorkflowRunHistoryEntry[]>
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  workflows: [],
  currentWorkflow: null,
  currentRun: null,
  loading: false,
  error: null,

  fetchWorkflows: async () => {
    set({ loading: true })
    try {
      const res = await apiFetch<{ data: Workflow[] }>('/workflows')
      set({ workflows: res.data ?? [], loading: false })
    } catch (err) {
      console.error('Failed to fetch workflows:', err)
      set({ loading: false })
    }
  },

  fetchWorkflow: async (id: string) => {
    set({ loading: true })
    try {
      const wf = await apiFetch<Workflow>(`/workflows/${id}`)
      set({ currentWorkflow: wf, loading: false })
    } catch (err) {
      console.error('Failed to fetch workflow:', err)
      set({ loading: false })
    }
  },

  createWorkflow: async (req) => {
    try {
      const wf = await apiFetch<Workflow>('/workflows', {
        method: 'POST',
        body: JSON.stringify(req),
      })
      await get().fetchWorkflows()
      return wf
    } catch (err) {
      console.error('Failed to create workflow:', err)
      return null
    }
  },

  updateWorkflow: async (id, req) => {
    try {
      await apiFetch(`/workflows/${id}`, {
        method: 'PUT',
        body: JSON.stringify(req),
      })
      await get().fetchWorkflow(id)
    } catch (err) {
      console.error('Failed to update workflow:', err)
    }
  },

  deleteWorkflow: async (id) => {
    set({ error: null })
    try {
      await apiFetch(`/workflows/${id}`, { method: 'DELETE' })
      const { workflows, currentWorkflow } = get()
      set({
        workflows: workflows.filter(w => w.id !== id),
        currentWorkflow: currentWorkflow?.id === id ? null : currentWorkflow,
      })
    } catch (err: any) {
      const msg = err?.message || 'Failed to delete workflow'
      console.error('Failed to delete workflow:', err)
      set({ error: msg })
    }
  },

  cloneWorkflow: async (id) => {
    set({ error: null })
    try {
      const wf = await apiFetch<Workflow>(`/workflows/${id}/clone`, { method: 'POST' })
      await get().fetchWorkflows()
      return wf
    } catch (err: any) {
      const msg = err?.message || 'Failed to clone workflow'
      console.error('Failed to clone workflow:', err)
      set({ error: msg })
      return null
    }
  },

  fetchWorkflowRun: async (id) => {
    try {
      const run = await apiFetch<WorkflowRun>(`/workflow-runs/${id}`)
      set({ currentRun: run })
      return run
    } catch (err) {
      console.error('Failed to fetch workflow run:', err)
      return null
    }
  },

  fetchRunByTicket: async (ticketId) => {
    try {
      const res = await apiFetch<{ data: WorkflowRun[] }>(`/workflow-runs?ticket_id=${ticketId}&limit=1`)
      const runs = res.data ?? []
      if (runs.length > 0) {
        set({ currentRun: runs[0] })
        return runs[0]
      }
      return null
    } catch (err) {
      console.error('Failed to fetch run by ticket:', err)
      return null
    }
  },

  approveRun: async (runId, comment) => {
    try {
      const run = await apiFetch<WorkflowRun>(`/workflow-runs/${runId}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'approve', comment: comment || '' }),
      })
      set({ currentRun: run })
      return run
    } catch (err) {
      console.error('Failed to approve run:', err)
      return null
    }
  },

  rejectRun: async (runId, comment, targetStageId) => {
    try {
      const run = await apiFetch<WorkflowRun>(`/workflow-runs/${runId}/action`, {
        method: 'POST',
        body: JSON.stringify({
          action: 'reject',
          comment: comment || '',
          target_stage_id: targetStageId || undefined,
        }),
      })
      set({ currentRun: run })
      return run
    } catch (err) {
      console.error('Failed to reject run:', err)
      return null
    }
  },

  kickbackRun: async (runId, comment, targetStageId) => {
    try {
      const run = await apiFetch<WorkflowRun>(`/workflow-runs/${runId}/action`, {
        method: 'POST',
        body: JSON.stringify({
          action: 'kickback',
          comment: comment || '',
          target_stage_id: targetStageId || undefined,
        }),
      })
      set({ currentRun: run })
      return run
    } catch (err) {
      console.error('Failed to kickback run:', err)
      return null
    }
  },

  completeStage: async (runId, comment) => {
    try {
      const run = await apiFetch<WorkflowRun>(`/workflow-runs/${runId}/action`, {
        method: 'POST',
        body: JSON.stringify({ action: 'complete', comment: comment || '' }),
      })
      set({ currentRun: run })
      return run
    } catch (err) {
      console.error('Failed to complete stage:', err)
      return null
    }
  },

  abortRun: async (runId) => {
    try {
      await apiFetch(`/workflow-runs/${runId}/abort`, { method: 'POST' })
      set({ currentRun: null })
    } catch (err) {
      console.error('Failed to abort run:', err)
    }
  },

  fetchRunHistory: async (runId) => {
    try {
      const res = await apiFetch<{ data: WorkflowRunHistoryEntry[] }>(`/workflow-runs/${runId}/history`)
      return res.data ?? []
    } catch (err) {
      console.error('Failed to fetch run history:', err)
      return []
    }
  },
}))
