import { useEffect } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import DashboardSidebar from '../components/dashboard/DashboardSidebar'
import DashboardView from '../components/dashboard/DashboardView'

export default function DashboardsPage() {
  const { fetchDashboards, fetchDashboard, seedDashboard } = useDashboardStore()

  useEffect(() => {
    let cancelled = false

    async function init() {
      await fetchDashboards()
      const { dashboards: loaded } = useDashboardStore.getState()

      if (loaded.length === 0) {
        await seedDashboard()
        await fetchDashboards()
      }

      if (cancelled) return

      const { dashboards: final, currentDashboard: current } = useDashboardStore.getState()
      if (final.length > 0 && !current) {
        await fetchDashboard(final[0].id)
      }
    }

    init()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={styles.container}>
      <DashboardSidebar />
      <DashboardView />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    width: '100%',
    height: '100%',
    flex: 1,
    overflow: 'hidden',
    background: 'var(--color-bg-primary)',
  },
}
