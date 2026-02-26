export interface WorkflowStage {
  id: string
  workflow_id: string
  name: string
  stage_order: number
  stage_type: 'action' | 'approval' | 'notification' | 'condition' | 'timer' | 'terminal'
  config: StageConfig
  created_at: string
}

export interface StageConfig {
  required_role?: string
  description?: string
  min_approvals?: number
  approval_mode?: 'any' | 'quorum' | 'all'
  auto_approve_conditions?: Record<string, Record<string, number>>
  escalation_timeout_minutes?: number
  escalation_target_role?: string
  expression?: string
  true_stage_id?: string
  false_stage_id?: string
  duration_minutes?: number
  timeout_action?: 'escalate' | 'auto_approve' | 'reject'
}

export interface WorkflowTransition {
  id: string
  workflow_id: string
  from_stage_id: string
  to_stage_id: string
  trigger: string
  condition_expr?: string | null
  label?: string | null
  created_at: string
}

export interface Workflow {
  id: string
  name: string
  description: string
  version: number
  is_template: boolean
  is_default: boolean
  created_by?: string | null
  created_at: string
  updated_at: string
  stages: WorkflowStage[]
  transitions: WorkflowTransition[]
}

export interface WorkflowRun {
  id: string
  workflow_id: string
  ticket_id?: string | null
  current_stage_id?: string | null
  current_stage?: WorkflowStage | null
  status: 'active' | 'paused' | 'completed' | 'aborted'
  context: Record<string, unknown>
  started_at: string
  completed_at?: string | null
  history?: WorkflowRunHistoryEntry[]
  workflow_name?: string
}

export interface WorkflowRunHistoryEntry {
  id: string
  run_id: string
  stage_id: string
  stage_name: string
  action: string
  actor_id?: string | null
  comment?: string | null
  metadata: Record<string, unknown>
  occurred_at: string
}

export interface CreateWorkflowRequest {
  name: string
  description: string
  is_template: boolean
  is_default: boolean
  stages: CreateStageRequest[]
  transitions: CreateTransitionRequest[]
}

export interface CreateStageRequest {
  name: string
  stage_order: number
  stage_type: string
  config: StageConfig
}

export interface CreateTransitionRequest {
  from_stage_order: number
  to_stage_order: number
  trigger: string
  condition_expr?: string | null
  label?: string | null
}
