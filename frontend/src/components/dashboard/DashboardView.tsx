import { useDashboardStore } from '../../stores/dashboardStore'
import DashboardHeader from './DashboardHeader'
import TabBar from './TabBar'
import WidgetGrid from './WidgetGrid'

export default function DashboardView() {
  const { currentDashboard, currentTabId, loading } = useDashboardStore()

  if (loading) {
    return (
      <div style={styles.center}>
        <span style={styles.statusText}>Loading...</span>
      </div>
    )
  }

  if (!currentDashboard) {
    return (
      <div style={styles.center}>
        <span style={styles.statusText}>Select or create a dashboard</span>
      </div>
    )
  }

  const currentTab = currentDashboard.tabs.find(t => t.id === currentTabId)
  const widgets = currentTab?.widgets ?? []

  return (
    <div style={styles.container}>
      <DashboardHeader dashboard={currentDashboard} />
      <TabBar
        tabs={currentDashboard.tabs}
        currentTabId={currentTabId}
        dashboardId={currentDashboard.id}
      />
      <WidgetGrid
        widgets={widgets}
        dashboardId={currentDashboard.id}
        tabId={currentTabId ?? ''}
      />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    height: '100%',
    overflow: 'hidden',
  },
  center: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    height: '100%',
  },
  statusText: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--color-text-muted)',
    letterSpacing: 0.5,
  },
}
