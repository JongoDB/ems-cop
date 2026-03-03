import { create } from 'zustand'
import { apiFetch } from '../lib/api'

// ════════════════════════════════════════════
//  CTI API TYPES
// ════════════════════════════════════════════

export interface TransferApproval {
  id: string
  entity_type: string
  entity_ids: string[]
  classification: string
  direction: string
  policy: string
  status: 'pending' | 'approved' | 'rejected'
  requested_by: string
  requested_at: string
  reviewed_by?: string
  reviewed_at?: string
  rejection_reason?: string
}

export interface TransferRecord {
  id: string
  transfer_id: string
  direction: string
  classification: string
  entity_type: string
  status: string
  executed_at: string
  actor: string
  bytes_transferred?: number
  duration_ms?: number
}

export interface ProvenanceEvent {
  event_type: string
  component: string
  timestamp: string
  details?: string
  bytes?: number
}

export interface NiFiFlow {
  id: string
  name: string
  type: string
  status: 'running' | 'stopped' | 'error' | 'disabled'
  active_threads?: number
  flow_files_in?: number
  flow_files_out?: number
  flow_files_queued?: number
  bytes_in?: number
  bytes_out?: number
}

export interface NiFiSystemStatus {
  connected: boolean
  uptime?: string
  active_threads?: number
  total_threads?: number
  heap_used_mb?: number
  heap_max_mb?: number
  flow_file_count?: number
}

// ════════════════════════════════════════════
//  RESPONSE TYPES
// ════════════════════════════════════════════

interface CTIStatusResponse {
  connected: boolean
  degraded: boolean
  last_check: string | null
  pending_transfers?: number
  auth_sync_status?: string
  transfer_stats?: {
    sent_24h: number
    received_24h: number
    failed_24h: number
  }
}

interface NiFiStatusResponse {
  system: NiFiSystemStatus
  flows: NiFiFlow[]
}

// ════════════════════════════════════════════
//  STORE STATE
// ════════════════════════════════════════════

interface CTIState {
  connected: boolean
  degraded: boolean
  lastCheck: string | null
  pendingTransfers: number
  authSyncStatus: string
  transferStats: {
    sent24h: number
    received24h: number
    failed24h: number
  }
  dismissed: boolean

  // NiFi state
  nifiStatus: 'online' | 'offline' | 'unknown'
  nifiFlows: NiFiFlow[]
  nifiSystem: NiFiSystemStatus | null

  // Transfer approvals
  approvals: TransferApproval[]
  approvalsLoading: boolean

  // Transfer history
  transfers: TransferRecord[]
  transfersLoading: boolean

  // Actions
  setStatus: (connected: boolean, degraded: boolean) => void
  dismiss: () => void
  resetDismiss: () => void
  fetchStatus: () => Promise<void>
  startPolling: () => () => void
  fetchApprovals: (status?: string) => Promise<void>
  approveTransfer: (id: string) => Promise<void>
  rejectTransfer: (id: string, reason: string) => Promise<void>
  fetchTransfers: (params?: Record<string, string>) => Promise<void>
  fetchNiFiStatus: () => Promise<void>
  startNiFiFlow: (flowId: string) => Promise<void>
  stopNiFiFlow: (flowId: string) => Promise<void>
  fetchProvenance: (transferId: string) => Promise<ProvenanceEvent[]>
}

export const useCTIStore = create<CTIState>((set, get) => ({
  connected: true,
  degraded: false,
  lastCheck: null,
  pendingTransfers: 0,
  authSyncStatus: 'unknown',
  transferStats: {
    sent24h: 0,
    received24h: 0,
    failed24h: 0,
  },
  dismissed: false,

  // NiFi state
  nifiStatus: 'unknown',
  nifiFlows: [],
  nifiSystem: null,

  // Transfer approvals
  approvals: [],
  approvalsLoading: false,

  // Transfer history
  transfers: [],
  transfersLoading: false,

  setStatus: (connected, degraded) => {
    const prev = get()
    // If status changed, reset dismissal so the user sees the new state
    const dismissed = prev.connected === connected && prev.degraded === degraded
      ? prev.dismissed
      : false
    set({ connected, degraded, dismissed, lastCheck: new Date().toISOString() })
  },

  dismiss: () => set({ dismissed: true }),

  resetDismiss: () => set({ dismissed: false }),

  fetchStatus: async () => {
    try {
      const data = await apiFetch<CTIStatusResponse>('/auth/cti-status')
      const prev = get()
      const statusChanged = prev.connected !== data.connected || prev.degraded !== data.degraded
      set({
        connected: data.connected,
        degraded: data.degraded,
        lastCheck: data.last_check || new Date().toISOString(),
        pendingTransfers: data.pending_transfers ?? 0,
        authSyncStatus: data.auth_sync_status ?? 'unknown',
        transferStats: data.transfer_stats
          ? {
              sent24h: data.transfer_stats.sent_24h,
              received24h: data.transfer_stats.received_24h,
              failed24h: data.transfer_stats.failed_24h,
            }
          : prev.transferStats,
        dismissed: statusChanged ? false : prev.dismissed,
      })
    } catch {
      // If the endpoint doesn't exist or fails, assume connected (single-enclave mode)
    }
  },

  startPolling: () => {
    // Fetch immediately
    get().fetchStatus()
    // Then poll every 30s
    const interval = setInterval(() => {
      get().fetchStatus()
    }, 30000)
    return () => clearInterval(interval)
  },

  fetchApprovals: async (status?: string) => {
    set({ approvalsLoading: true })
    try {
      const params = status ? `?status=${status}` : ''
      const data = await apiFetch<{ data: TransferApproval[] }>(`/cti/approvals${params}`)
      set({ approvals: data.data ?? [] })
    } catch {
      set({ approvals: [] })
    } finally {
      set({ approvalsLoading: false })
    }
  },

  approveTransfer: async (id: string) => {
    await apiFetch(`/cti/approvals/${id}/approve`, { method: 'POST' })
    // Refresh approvals
    await get().fetchApprovals('pending')
  },

  rejectTransfer: async (id: string, reason: string) => {
    await apiFetch(`/cti/approvals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })
    // Refresh approvals
    await get().fetchApprovals('pending')
  },

  fetchTransfers: async (params?: Record<string, string>) => {
    set({ transfersLoading: true })
    try {
      const searchParams = new URLSearchParams(params)
      const data = await apiFetch<{ data: TransferRecord[] }>(`/cti/transfers?${searchParams.toString()}`)
      set({ transfers: data.data ?? [] })
    } catch {
      set({ transfers: [] })
    } finally {
      set({ transfersLoading: false })
    }
  },

  fetchNiFiStatus: async () => {
    try {
      const data = await apiFetch<NiFiStatusResponse>('/cti/nifi/status')
      set({
        nifiStatus: data.system?.connected ? 'online' : 'offline',
        nifiFlows: data.flows ?? [],
        nifiSystem: data.system ?? null,
      })
    } catch {
      set({ nifiStatus: 'unknown', nifiFlows: [], nifiSystem: null })
    }
  },

  startNiFiFlow: async (flowId: string) => {
    await apiFetch(`/cti/nifi/flows/${flowId}/start`, { method: 'POST' })
    await get().fetchNiFiStatus()
  },

  stopNiFiFlow: async (flowId: string) => {
    await apiFetch(`/cti/nifi/flows/${flowId}/stop`, { method: 'POST' })
    await get().fetchNiFiStatus()
  },

  fetchProvenance: async (transferId: string) => {
    try {
      const data = await apiFetch<{ data: ProvenanceEvent[] }>(`/cti/nifi/provenance?transfer_id=${transferId}`)
      return data.data ?? []
    } catch {
      return []
    }
  },
}))
