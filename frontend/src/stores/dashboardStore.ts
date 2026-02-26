import { create } from 'zustand'
import { apiFetch } from '../lib/api'

// ── Types ──────────────────────────────────────────────

export interface DashboardWidget {
  id: string
  tab_id: string
  widget_type: string
  config: Record<string, unknown>
  position_x: number
  position_y: number
  width: number
  height: number
  data_source?: Record<string, unknown> | null
  created_at: string
}

export interface DashboardTab {
  id: string
  dashboard_id: string
  name: string
  tab_order: number
  widgets: DashboardWidget[]
  created_at: string
}

export interface Dashboard {
  id: string
  name: string
  description: string
  owner_id: string
  owner_name?: string
  is_template: boolean
  echelon_default?: string
  shared_with: unknown
  tabs: DashboardTab[]
  created_at: string
  updated_at: string
}

interface DashboardStore {
  dashboards: Dashboard[]
  currentDashboard: Dashboard | null
  currentTabId: string | null
  loading: boolean
  layoutDirty: boolean

  fetchDashboards: () => Promise<void>
  fetchDashboard: (id: string) => Promise<void>
  createDashboard: (name: string) => Promise<Dashboard | null>
  updateDashboard: (id: string, updates: Partial<Pick<Dashboard, 'name' | 'description' | 'shared_with'>>) => Promise<void>
  deleteDashboard: (id: string) => Promise<void>

  addTab: (dashboardId: string, name: string) => Promise<DashboardTab | null>
  updateTab: (dashboardId: string, tabId: string, updates: { name?: string; tab_order?: number }) => Promise<void>
  removeTab: (dashboardId: string, tabId: string) => Promise<void>

  addWidget: (dashboardId: string, tabId: string, widget: { widget_type: string; config?: Record<string, unknown>; position_x: number; position_y: number; width: number; height: number }) => Promise<DashboardWidget | null>
  updateWidget: (dashboardId: string, tabId: string, widgetId: string, updates: Partial<DashboardWidget>) => Promise<void>
  removeWidget: (dashboardId: string, tabId: string, widgetId: string) => Promise<void>
  updateLayout: (dashboardId: string, tabId: string, layouts: Array<{ widget_id: string; position_x: number; position_y: number; width: number; height: number }>) => Promise<void>

  setCurrentTab: (tabId: string | null) => void
  seedDashboard: (echelon?: string) => Promise<Dashboard | null>
}

let layoutDebounce: ReturnType<typeof setTimeout> | null = null

export const useDashboardStore = create<DashboardStore>((set, get) => ({
  dashboards: [],
  currentDashboard: null,
  currentTabId: null,
  loading: false,
  layoutDirty: false,

  fetchDashboards: async () => {
    set({ loading: true })
    try {
      const res = await apiFetch<{ data: Dashboard[] } | Dashboard[]>('/dashboards')
      const list = Array.isArray(res) ? res : (res.data ?? [])
      set({ dashboards: list, loading: false })
    } catch (err) {
      console.error('Failed to fetch dashboards:', err)
      set({ loading: false })
    }
  },

  fetchDashboard: async (id: string) => {
    set({ loading: true })
    try {
      const dashboard = await apiFetch<Dashboard>(`/dashboards/${id}`)
      set({
        currentDashboard: dashboard,
        currentTabId: dashboard.tabs?.[0]?.id ?? null,
        loading: false,
      })
      // Update in list
      const { dashboards } = get()
      const idx = dashboards.findIndex(d => d.id === id)
      if (idx >= 0) {
        const updated = [...dashboards]
        updated[idx] = dashboard
        set({ dashboards: updated })
      }
    } catch (err) {
      console.error('Failed to fetch dashboard:', err)
      set({ loading: false })
    }
  },

  createDashboard: async (name: string) => {
    try {
      const dashboard = await apiFetch<Dashboard>('/dashboards', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      await get().fetchDashboards()
      return dashboard
    } catch (err) {
      console.error('Failed to create dashboard:', err)
      return null
    }
  },

  updateDashboard: async (id, updates) => {
    try {
      await apiFetch(`/dashboards/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      })
      await get().fetchDashboard(id)
    } catch (err) {
      console.error('Failed to update dashboard:', err)
    }
  },

  deleteDashboard: async (id) => {
    try {
      await apiFetch(`/dashboards/${id}`, { method: 'DELETE' })
      const { dashboards, currentDashboard } = get()
      const remaining = dashboards.filter(d => d.id !== id)
      set({
        dashboards: remaining,
        currentDashboard: currentDashboard?.id === id ? null : currentDashboard,
      })
    } catch (err) {
      console.error('Failed to delete dashboard:', err)
    }
  },

  addTab: async (dashboardId, name) => {
    try {
      const tab = await apiFetch<DashboardTab>(`/dashboards/${dashboardId}/tabs`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      await get().fetchDashboard(dashboardId)
      return tab
    } catch (err) {
      console.error('Failed to add tab:', err)
      return null
    }
  },

  updateTab: async (dashboardId, tabId, updates) => {
    try {
      await apiFetch(`/dashboards/${dashboardId}/tabs/${tabId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      })
      await get().fetchDashboard(dashboardId)
    } catch (err) {
      console.error('Failed to update tab:', err)
    }
  },

  removeTab: async (dashboardId, tabId) => {
    try {
      await apiFetch(`/dashboards/${dashboardId}/tabs/${tabId}`, { method: 'DELETE' })
      const { currentTabId } = get()
      if (currentTabId === tabId) set({ currentTabId: null })
      await get().fetchDashboard(dashboardId)
    } catch (err) {
      console.error('Failed to remove tab:', err)
    }
  },

  addWidget: async (dashboardId, tabId, widget) => {
    try {
      const created = await apiFetch<DashboardWidget>(`/dashboards/${dashboardId}/tabs/${tabId}/widgets`, {
        method: 'POST',
        body: JSON.stringify(widget),
      })
      await get().fetchDashboard(dashboardId)
      return created
    } catch (err) {
      console.error('Failed to add widget:', err)
      return null
    }
  },

  updateWidget: async (dashboardId, tabId, widgetId, updates) => {
    try {
      await apiFetch(`/dashboards/${dashboardId}/tabs/${tabId}/widgets/${widgetId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      })
      // Optimistic update for config changes
      const { currentDashboard } = get()
      if (currentDashboard) {
        const updated = { ...currentDashboard }
        updated.tabs = updated.tabs.map(t => ({
          ...t,
          widgets: t.widgets.map(w => w.id === widgetId ? { ...w, ...updates } : w),
        }))
        set({ currentDashboard: updated })
      }
    } catch (err) {
      console.error('Failed to update widget:', err)
    }
  },

  removeWidget: async (dashboardId, tabId, widgetId) => {
    try {
      await apiFetch(`/dashboards/${dashboardId}/tabs/${tabId}/widgets/${widgetId}`, { method: 'DELETE' })
      await get().fetchDashboard(dashboardId)
    } catch (err) {
      console.error('Failed to remove widget:', err)
    }
  },

  updateLayout: async (dashboardId, tabId, layouts) => {
    // Optimistic update
    const { currentDashboard } = get()
    if (currentDashboard) {
      const updated = { ...currentDashboard }
      updated.tabs = updated.tabs.map(t => {
        if (t.id !== tabId) return t
        return {
          ...t,
          widgets: t.widgets.map(w => {
            const layout = layouts.find(l => l.widget_id === w.id)
            if (!layout) return w
            return { ...w, position_x: layout.position_x, position_y: layout.position_y, width: layout.width, height: layout.height }
          }),
        }
      })
      set({ currentDashboard: updated, layoutDirty: true })
    }

    // Debounced server persist
    if (layoutDebounce) clearTimeout(layoutDebounce)
    layoutDebounce = setTimeout(async () => {
      try {
        await apiFetch(`/dashboards/${dashboardId}/tabs/${tabId}/layout`, {
          method: 'PUT',
          body: JSON.stringify(layouts),
        })
        set({ layoutDirty: false })
      } catch (err) {
        console.error('Failed to persist layout:', err)
      }
    }, 300)
  },

  setCurrentTab: (tabId) => set({ currentTabId: tabId }),

  seedDashboard: async (echelon?: string) => {
    try {
      const res = await apiFetch<{ data: { seeded: boolean; dashboard?: Dashboard } }>('/dashboards/seed', {
        method: 'POST',
        body: JSON.stringify(echelon ? { echelon } : {}),
      })
      if (res.data?.seeded && res.data.dashboard) {
        await get().fetchDashboards()
        return res.data.dashboard
      }
      return null
    } catch (err) {
      console.error('Failed to seed dashboard:', err)
      return null
    }
  },
}))
