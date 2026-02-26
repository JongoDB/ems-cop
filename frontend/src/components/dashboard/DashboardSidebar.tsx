import { useDashboardStore } from '../../stores/dashboardStore'
import { Plus, X } from 'lucide-react'
import { useState } from 'react'

export default function DashboardSidebar() {
  const { dashboards, currentDashboard, fetchDashboard, createDashboard, deleteDashboard } = useDashboardStore()
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  const handleCreate = async () => {
    const d = await createDashboard('Untitled Dashboard')
    if (d) await fetchDashboard(d.id)
  }

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await deleteDashboard(id)
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerText}>DASHBOARDS</span>
      </div>
      <div style={styles.list}>
        {dashboards.map(d => {
          const active = currentDashboard?.id === d.id
          const hovered = hoveredId === d.id
          return (
            <div
              key={d.id}
              style={{
                ...styles.item,
                ...(active ? styles.itemActive : {}),
                ...(hovered && !active ? styles.itemHover : {}),
              }}
              onClick={() => fetchDashboard(d.id)}
              onMouseEnter={() => setHoveredId(d.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <span style={styles.itemName}>{d.name}</span>
              {hovered && (
                <button
                  style={styles.deleteBtn}
                  onClick={(e) => handleDelete(e, d.id)}
                  title="Delete dashboard"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <button style={styles.createBtn} onClick={handleCreate}>
        <Plus size={13} />
        <span>New Dashboard</span>
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: 240,
    minWidth: 240,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-bg-primary)',
    borderRight: '1px solid var(--color-border)',
    height: '100%',
  },
  header: {
    padding: '12px 16px 8px',
    borderBottom: '1px solid var(--color-border)',
  },
  headerText: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: 1.5,
    color: 'var(--color-text-muted)',
    fontWeight: 600,
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '4px 0',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '7px 16px',
    cursor: 'pointer',
    borderLeft: '3px solid transparent',
    transition: 'background 0.1s',
  },
  itemActive: {
    borderLeftColor: 'var(--color-accent)',
    background: 'rgba(255,255,255,0.04)',
  },
  itemHover: {
    background: 'rgba(255,255,255,0.02)',
  },
  itemName: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--color-text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  deleteBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    marginLeft: 4,
  },
  createBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '10px 16px',
    background: 'none',
    border: 'none',
    borderTop: '1px solid var(--color-border)',
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
  },
}
