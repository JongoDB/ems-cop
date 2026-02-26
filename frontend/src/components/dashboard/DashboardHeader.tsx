import { useState, useRef, useEffect } from 'react'
import { Share2, Trash2 } from 'lucide-react'
import type { Dashboard } from '../../stores/dashboardStore'
import { useDashboardStore } from '../../stores/dashboardStore'

interface Props {
  dashboard: Dashboard
}

export default function DashboardHeader({ dashboard }: Props) {
  const { updateDashboard, deleteDashboard } = useDashboardStore()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(dashboard.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setEditName(dashboard.name)
  }, [dashboard.name])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commitName = () => {
    setEditing(false)
    const trimmed = editName.trim()
    if (trimmed && trimmed !== dashboard.name) {
      updateDashboard(dashboard.id, { name: trimmed })
    } else {
      setEditName(dashboard.name)
    }
  }

  const handleDelete = () => {
    if (window.confirm(`Delete dashboard "${dashboard.name}"?`)) {
      deleteDashboard(dashboard.id)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.left}>
        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { setEditing(false); setEditName(dashboard.name) } }}
            style={styles.nameInput}
          />
        ) : (
          <span style={styles.name} onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {dashboard.name}
          </span>
        )}
        {dashboard.echelon_default && (
          <span style={styles.echelonBadge}>{dashboard.echelon_default.toUpperCase()}</span>
        )}
      </div>
      <div style={styles.right}>
        <button style={styles.iconBtn} title="Share" onClick={() => {}}>
          <Share2 size={13} />
        </button>
        <button style={styles.iconBtn} title="Delete dashboard" onClick={handleDelete}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-primary)',
    flexShrink: 0,
  },
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    cursor: 'default',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  nameInput: {
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-accent)',
    borderRadius: 2,
    padding: '2px 6px',
    outline: 'none',
    width: 260,
  },
  echelonBadge: {
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    letterSpacing: 1,
    color: 'var(--color-accent)',
    border: '1px solid var(--color-accent)',
    borderRadius: 2,
    padding: '1px 5px',
    flexShrink: 0,
  },
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    borderRadius: 2,
  },
}
