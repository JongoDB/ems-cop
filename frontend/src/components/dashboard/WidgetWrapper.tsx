import React, { Suspense, useState, useCallback } from 'react'
import { GripVertical, Maximize2, Minimize2, X } from 'lucide-react'
import { widgetRegistry } from '../widgets/WidgetRegistry'
import type { DashboardWidget } from '../../stores/dashboardStore'
import { useDashboardStore } from '../../stores/dashboardStore'

interface Props {
  widget: DashboardWidget
  dashboardId: string
  tabId: string
}

const SIZE_PRESETS: Record<string, { w: number; h: number }> = {
  S: { w: 4, h: 3 },
  M: { w: 6, h: 4 },
  L: { w: 8, h: 6 },
}

function getSizeLabel(w: number, h: number): string {
  for (const [label, size] of Object.entries(SIZE_PRESETS)) {
    if (size.w === w && size.h === h) return label
  }
  return ''
}

class WidgetErrorBoundary extends React.Component<
  { children: React.ReactNode; widgetType: string },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode; widgetType: string }) {
    super(props)
    this.state = { hasError: false, error: '' }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          padding: 16,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: '#f87171',
          gap: 6,
        }}>
          <span>Widget error: {this.props.widgetType}</span>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{this.state.error}</span>
        </div>
      )
    }
    return this.props.children
  }
}

export default function WidgetWrapper({ widget, dashboardId, tabId }: Props) {
  const { updateWidget, removeWidget, updateLayout } = useDashboardStore()
  const [isFullscreen, setIsFullscreen] = useState(false)

  const definition = widgetRegistry.get(widget.widget_type)
  const WidgetComponent = definition?.component

  const currentSize = getSizeLabel(widget.width, widget.height)

  const handleResize = useCallback(async (label: string) => {
    const size = SIZE_PRESETS[label]
    if (!size) return
    await updateWidget(dashboardId, tabId, widget.id, { width: size.w, height: size.h })
    // Trigger layout update so react-grid-layout picks up the change
    const { currentDashboard } = useDashboardStore.getState()
    if (currentDashboard) {
      const tab = currentDashboard.tabs.find(t => t.id === tabId)
      if (tab) {
        const layouts = tab.widgets.map(w => ({
          widget_id: w.id,
          position_x: w.position_x,
          position_y: w.position_y,
          width: w.id === widget.id ? size.w : w.width,
          height: w.id === widget.id ? size.h : w.height,
        }))
        await updateLayout(dashboardId, tabId, layouts)
      }
    }
  }, [dashboardId, tabId, widget.id, updateWidget, updateLayout])

  const handleRemove = () => {
    removeWidget(dashboardId, tabId, widget.id)
  }

  const handleConfigChange = useCallback((config: Record<string, unknown>) => {
    updateWidget(dashboardId, tabId, widget.id, { config })
  }, [dashboardId, tabId, widget.id, updateWidget])

  const containerStyle: React.CSSProperties = isFullscreen
    ? { ...styles.container, ...styles.fullscreen }
    : styles.container

  return (
    <div style={containerStyle}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={styles.topLeft}>
          <div className="widget-drag-handle" style={styles.dragHandle}>
            <GripVertical size={12} />
          </div>
          <span style={styles.typeName}>{definition?.name ?? widget.widget_type}</span>
        </div>
        <div style={styles.topRight}>
          {Object.keys(SIZE_PRESETS).map(label => (
            <button
              key={label}
              style={{
                ...styles.sizeBtn,
                ...(currentSize === label ? styles.sizeBtnActive : {}),
              }}
              onClick={() => handleResize(label)}
              title={`Size ${label}`}
            >
              {label}
            </button>
          ))}
          <button style={styles.iconBtn} onClick={() => setIsFullscreen(!isFullscreen)} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            {isFullscreen ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
          </button>
          <button style={styles.iconBtn} onClick={handleRemove} title="Remove widget">
            <X size={11} />
          </button>
        </div>
      </div>
      {/* Widget content */}
      <div style={styles.content}>
        {WidgetComponent ? (
          <WidgetErrorBoundary widgetType={widget.widget_type}>
            <Suspense fallback={<LoadingSpinner />}>
              <WidgetComponent
                id={widget.id}
                config={widget.config}
                dataSource={widget.data_source as import('../widgets/WidgetRegistry').DataSourceConfig | undefined}
                isFullscreen={isFullscreen}
                onConfigChange={handleConfigChange}
              />
            </Suspense>
          </WidgetErrorBoundary>
        ) : (
          <div style={styles.unknownWidget}>
            <span>Unknown widget: {widget.widget_type}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function LoadingSpinner() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--color-text-muted)',
    }}>
      Loading...
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  fullscreen: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    borderRadius: 0,
    border: 'none',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 6px',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-primary)',
    flexShrink: 0,
    minHeight: 28,
  },
  topLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  dragHandle: {
    cursor: 'grab',
    color: 'var(--color-text-muted)',
    display: 'flex',
    alignItems: 'center',
  },
  typeName: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--color-text-muted)',
    letterSpacing: 0.5,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  topRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
  },
  sizeBtn: {
    background: 'none',
    border: '1px solid transparent',
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    padding: '1px 5px',
    cursor: 'pointer',
    borderRadius: 2,
    fontWeight: 600,
  },
  sizeBtnActive: {
    color: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
  },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: 3,
    display: 'flex',
    alignItems: 'center',
    borderRadius: 2,
  },
  content: {
    flex: 1,
    overflow: 'auto',
    position: 'relative',
  },
  unknownWidget: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--color-text-muted)',
  },
}
