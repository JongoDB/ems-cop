import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../lib/api'
import type {
  CreateTunnelRequest,
  TopologyResponse,
  Tunnel,
  TunnelFilter,
  TunnelThroughputResponse,
} from '../lib/c2Topology'

// ─────────────────────────────────────────────
//  Query keys
// ─────────────────────────────────────────────

export const tunnelKeys = {
  all: ['c2', 'tunnels'] as const,
  topology: (operationId?: string) =>
    [...tunnelKeys.all, 'topology', operationId ?? 'all'] as const,
  list: (filter?: TunnelFilter) => [...tunnelKeys.all, 'list', filter ?? {}] as const,
  throughput: (tunnelId: string, range?: { from?: string; to?: string; granularity?: string }) =>
    [...tunnelKeys.all, 'throughput', tunnelId, range ?? {}] as const,
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function buildQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.append(k, v)
  }
  const qs = usp.toString()
  return qs ? `?${qs}` : ''
}

// ─────────────────────────────────────────────
//  Hooks
// ─────────────────────────────────────────────

/** Full topology snapshot — sessions, tunnels, providers. */
export function useTopology(operationId?: string) {
  return useQuery<TopologyResponse>({
    queryKey: tunnelKeys.topology(operationId),
    queryFn: async () => {
      const qs = buildQuery({ operation_id: operationId })
      try {
        return await apiFetch<TopologyResponse>(`/c2/topology${qs}`)
      } catch (err) {
        // Graceful empty state when backend is unreachable / 404
        const status = (err as { status?: number }).status
        if (status === 404 || status === 501) {
          return { sessions: [], tunnels: [], providers: [] }
        }
        throw err
      }
    },
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  })
}

/** List tunnels with optional filters. */
export function useTunnels(filter?: TunnelFilter) {
  return useQuery<Tunnel[]>({
    queryKey: tunnelKeys.list(filter),
    queryFn: async () => {
      const qs = buildQuery({
        operation_id: filter?.operation_id,
        provider: filter?.provider,
        tunnel_type: filter?.tunnel_type,
        status: filter?.status,
      })
      try {
        const res = await apiFetch<Tunnel[] | { data: Tunnel[] }>(`/c2/tunnels${qs}`)
        if (Array.isArray(res)) return res
        if (res && typeof res === 'object' && 'data' in res && Array.isArray(res.data)) {
          return res.data
        }
        return []
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404 || status === 501) return []
        throw err
      }
    },
    staleTime: 10_000,
  })
}

export function useCreateTunnel() {
  const qc = useQueryClient()
  return useMutation<Tunnel, Error, CreateTunnelRequest>({
    mutationFn: async (body) => {
      return await apiFetch<Tunnel>('/c2/tunnels', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: tunnelKeys.all })
      qc.invalidateQueries({ queryKey: tunnelKeys.topology(vars.operation_id ?? undefined) })
    },
  })
}

export function useDeleteTunnel() {
  const qc = useQueryClient()
  return useMutation<void, Error, { id: string; operationId?: string }>({
    mutationFn: async ({ id }) => {
      await apiFetch<void>(`/c2/tunnels/${id}`, { method: 'DELETE' })
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: tunnelKeys.all })
      qc.invalidateQueries({ queryKey: tunnelKeys.topology(vars.operationId) })
    },
  })
}

export function useTunnelThroughput(
  tunnelId: string | null,
  range?: { from?: string; to?: string; granularity?: string }
) {
  return useQuery<TunnelThroughputResponse>({
    queryKey: tunnelKeys.throughput(tunnelId ?? '', range),
    enabled: !!tunnelId,
    queryFn: async () => {
      const qs = buildQuery({
        from: range?.from,
        to: range?.to,
        granularity: range?.granularity,
      })
      try {
        return await apiFetch<TunnelThroughputResponse>(
          `/c2/tunnels/${tunnelId}/throughput${qs}`
        )
      } catch (err) {
        const status = (err as { status?: number }).status
        if (status === 404 || status === 501) {
          return { tunnel_id: tunnelId ?? '', points: [] }
        }
        throw err
      }
    },
    staleTime: 5_000,
    refetchInterval: 15_000,
  })
}
