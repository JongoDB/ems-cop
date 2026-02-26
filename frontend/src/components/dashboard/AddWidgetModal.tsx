import { X } from 'lucide-react'
import * as Icons from 'lucide-react'
import { widgetRegistry } from '../widgets/WidgetRegistry'
import type { WidgetDefinition } from '../widgets/WidgetRegistry'

interface Props {
  open: boolean
  onClose: () => void
  onAdd: (widgetType: string, size: { w: number; h: number }) => void
}

const CATEGORY_LABELS: Record<string, string> = {
  c2: 'C2 / Command & Control',
  monitoring: 'Monitoring',
  management: 'Management',
  collaboration: 'Collaboration',
  analytics: 'Analytics',
  integration: 'Integration',
}

function getIcon(iconName: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const IconComp = (Icons as any)[iconName] as React.ComponentType<{ size?: number }> | undefined
  return IconComp ? <IconComp size={18} /> : null
}

export default function AddWidgetModal({ open, onClose, onAdd }: Props) {
  if (!open) return null

  // Group widgets by category
  const grouped: Record<string, WidgetDefinition[]> = {}
  for (const def of widgetRegistry.values()) {
    if (!grouped[def.category]) grouped[def.category] = []
    grouped[def.category].push(def)
  }

  const categories = Object.keys(CATEGORY_LABELS).filter(c => grouped[c]?.length)

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>Add Widget</span>
          <button style={styles.closeBtn} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div style={styles.body}>
          {categories.map(cat => (
            <div key={cat}>
              <div style={styles.categoryHeader}>{CATEGORY_LABELS[cat]}</div>
              <div style={styles.grid}>
                {grouped[cat].map(def => (
                  <button
                    key={def.type}
                    style={styles.card}
                    onClick={() => onAdd(def.type, def.defaultSize)}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border)' }}
                  >
                    <div style={styles.cardIcon}>{getIcon(def.icon)}</div>
                    <div style={styles.cardName}>{def.name}</div>
                    <div style={styles.cardDesc}>{def.description}</div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10000,
  },
  modal: {
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    width: 640,
    maxHeight: '80vh',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--color-border)',
  },
  title: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    letterSpacing: 0.5,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: 2,
    display: 'flex',
    alignItems: 'center',
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    padding: 16,
  },
  categoryHeader: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: 1.5,
    color: 'var(--color-text-muted)',
    fontWeight: 600,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 12,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
    marginBottom: 8,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 4,
    padding: '10px 12px',
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'border-color 0.1s',
  },
  cardIcon: {
    color: 'var(--color-accent)',
    marginBottom: 2,
  },
  cardName: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
  },
  cardDesc: {
    fontFamily: 'var(--font-sans)',
    fontSize: 10,
    color: 'var(--color-text-muted)',
    lineHeight: 1.3,
  },
}
