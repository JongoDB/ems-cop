import { useState, useCallback, useMemo } from 'react'
import { WidthProvider } from 'react-grid-layout'
import ReactGridLayout from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { Plus } from 'lucide-react'
import WidgetWrapper from './WidgetWrapper'
import AddWidgetModal from './AddWidgetModal'
import type { DashboardWidget } from '../../stores/dashboardStore'
import { useDashboardStore } from '../../stores/dashboardStore'

interface Props {
  widgets: DashboardWidget[]
  dashboardId: string
  tabId: string
}

const COLS = 12
const ROW_HEIGHT = 80

const AutoWidthGrid = WidthProvider(ReactGridLayout)

export default function WidgetGrid({ widgets, dashboardId, tabId }: Props) {
  const { addWidget, updateLayout } = useDashboardStore()
  const [modalOpen, setModalOpen] = useState(false)

  const layout = useMemo(() =>
    widgets.map(w => ({
      i: w.id,
      x: w.position_x,
      y: w.position_y,
      w: w.width,
      h: w.height,
    })),
    [widgets]
  )

  const handleLayoutChange = useCallback((newLayout: ReactGridLayout.Layout[]) => {
    const layouts = newLayout.map(item => ({
      widget_id: item.i,
      position_x: item.x,
      position_y: item.y,
      width: item.w,
      height: item.h,
    }))
    updateLayout(dashboardId, tabId, layouts)
  }, [dashboardId, tabId, updateLayout])

  const handleAddWidget = useCallback(async (widgetType: string, size: { w: number; h: number }) => {
    // Find next available y position
    let maxY = 0
    for (const w of widgets) {
      const bottom = w.position_y + w.height
      if (bottom > maxY) maxY = bottom
    }
    await addWidget(dashboardId, tabId, {
      widget_type: widgetType,
      config: {},
      position_x: 0,
      position_y: maxY,
      width: size.w,
      height: size.h,
    })
    setModalOpen(false)
  }, [dashboardId, tabId, widgets, addWidget])

  return (
    <div style={styles.container}>
      {widgets.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyText}>No widgets on this tab</p>
          <button style={styles.addBtnLarge} onClick={() => setModalOpen(true)}>
            <Plus size={14} />
            <span>Add Widget</span>
          </button>
        </div>
      ) : (
        <>
          <AutoWidthGrid
            layout={layout}
            cols={COLS}
            rowHeight={ROW_HEIGHT}
            isDraggable={true}
            isResizable={false}
            draggableHandle=".widget-drag-handle"
            onLayoutChange={handleLayoutChange}
            compactType="vertical"
            margin={[8, 8]}
          >
            {widgets.map(w => (
              <div key={w.id}>
                <WidgetWrapper widget={w} dashboardId={dashboardId} tabId={tabId} />
              </div>
            ))}
          </AutoWidthGrid>
          <div style={styles.addRow}>
            <button style={styles.addBtn} onClick={() => setModalOpen(true)}>
              <Plus size={12} />
              <span>Add Widget</span>
            </button>
          </div>
        </>
      )}
      <AddWidgetModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onAdd={handleAddWidget}
      />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    overflow: 'auto',
    padding: 8,
    background: 'var(--color-bg-primary)',
    position: 'relative',
    minWidth: 0,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 12,
  },
  emptyText: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--color-text-muted)',
    margin: 0,
  },
  addBtnLarge: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    background: 'none',
    border: '1px dashed var(--color-border)',
    borderRadius: 3,
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    cursor: 'pointer',
  },
  addRow: {
    display: 'flex',
    justifyContent: 'center',
    padding: '12px 0',
  },
  addBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 12px',
    background: 'none',
    border: '1px dashed var(--color-border)',
    borderRadius: 3,
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    cursor: 'pointer',
  },
}
