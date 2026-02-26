import { Plus } from 'lucide-react'
import type { DashboardTab } from '../../stores/dashboardStore'
import { useDashboardStore } from '../../stores/dashboardStore'

interface Props {
  tabs: DashboardTab[]
  currentTabId: string | null
  dashboardId: string
}

export default function TabBar({ tabs, currentTabId, dashboardId }: Props) {
  const { setCurrentTab, addTab } = useDashboardStore()

  const sorted = [...tabs].sort((a, b) => a.tab_order - b.tab_order)

  const handleAddTab = async () => {
    const tab = await addTab(dashboardId, `Tab ${tabs.length + 1}`)
    if (tab) setCurrentTab(tab.id)
  }

  return (
    <div style={styles.container}>
      {sorted.map(tab => {
        const active = tab.id === currentTabId
        return (
          <button
            key={tab.id}
            style={{ ...styles.tab, ...(active ? styles.tabActive : {}) }}
            onClick={() => setCurrentTab(tab.id)}
          >
            {tab.name}
          </button>
        )
      })}
      <button style={styles.addBtn} onClick={handleAddTab} title="Add tab">
        <Plus size={12} />
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    gap: 0,
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-primary)',
    flexShrink: 0,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 16px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: 0.5,
    color: 'var(--color-text-muted)',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
  },
  tabActive: {
    color: 'var(--color-accent)',
    borderBottomColor: 'var(--color-accent)',
  },
  addBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '8px 12px',
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    fontSize: 11,
  },
}
