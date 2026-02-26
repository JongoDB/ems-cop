import { useState, useEffect, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'

type ChartType = 'bar' | 'line' | 'area'
type DataSourceType = 'tickets_by_status' | 'sessions_over_time' | 'endpoint_health'

interface ChartDatum {
  name: string
  value: number
}

const STATUS_PALETTE: Record<string, string> = {
  draft: '#6b7280',
  submitted: '#3b82f6',
  in_review: '#f59e0b',
  approved: '#22c55e',
  in_progress: '#8b5cf6',
  completed: '#10b981',
  closed: '#94a3b8',
  healthy: '#22c55e',
  degraded: '#f59e0b',
  unreachable: '#ef4444',
  unknown: '#6b7280',
  offline: '#94a3b8',
}

const DEFAULT_COLOR = '#60a5fa'

const DATA_SOURCE_OPTIONS: { value: DataSourceType; label: string }[] = [
  { value: 'tickets_by_status', label: 'Tickets by Status' },
  { value: 'sessions_over_time', label: 'Sessions Over Time' },
  { value: 'endpoint_health', label: 'Endpoint Health' },
]

function objectToArray(obj: Record<string, number>): ChartDatum[] {
  return Object.entries(obj).map(([name, value]) => ({ name, value: Number(value) || 0 }))
}

export default function MetricsChartWidget({ id, config, onConfigChange }: WidgetProps) {
  const chartType = (config.chartType as ChartType) || 'bar'
  const dataSource = (config.dataSource as DataSourceType) || 'tickets_by_status'

  const [chartData, setChartData] = useState<ChartDatum[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const updateConfig = useCallback(
    (patch: Record<string, unknown>) => {
      onConfigChange?.({ ...config, ...patch })
    },
    [config, onConfigChange],
  )

  const fetchData = useCallback(async () => {
    try {
      setError(null)
      let data: ChartDatum[] = []

      if (dataSource === 'tickets_by_status') {
        const res = await apiFetch<{ data: { by_status?: Record<string, number>; total?: number } }>(
          '/dashboards/metrics/tickets',
        )
        const byStatus = res?.data?.by_status
        if (byStatus && typeof byStatus === 'object') {
          data = objectToArray(byStatus)
        }
      } else if (dataSource === 'sessions_over_time') {
        const res = await apiFetch<{
          data: { total?: number; sessions?: Array<{ date?: string; count?: number }> }
        }>('/dashboards/metrics/sessions')
        const sessions = res?.data?.sessions
        if (Array.isArray(sessions) && sessions.length > 0) {
          data = sessions.map(s => ({
            name: s.date || 'session',
            value: Number(s.count) || 0,
          }))
        } else {
          data = [{ name: 'Total', value: Number(res?.data?.total) || 0 }]
        }
      } else if (dataSource === 'endpoint_health') {
        const res = await apiFetch<{ data: { by_status?: Record<string, number>; total?: number } }>(
          '/dashboards/metrics/endpoints',
        )
        const byStatus = res?.data?.by_status
        if (byStatus && typeof byStatus === 'object') {
          data = objectToArray(byStatus)
        }
      }

      setChartData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
      setChartData([])
    } finally {
      setLoading(false)
    }
  }, [dataSource])

  // Initial fetch + polling
  useEffect(() => {
    setLoading(true)
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

  const getBarColor = (entry: ChartDatum) => STATUS_PALETTE[entry.name] || DEFAULT_COLOR

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    color: 'var(--color-text-primary)',
    background: 'var(--color-bg-primary)',
    overflow: 'hidden',
  }

  const toolbarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 8px',
    borderBottom: '1px solid var(--color-border)',
    fontSize: '10px',
    flexShrink: 0,
    flexWrap: 'wrap',
  }

  const chartBtnStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--color-accent)' : 'var(--color-bg-elevated)',
    color: active ? '#fff' : 'var(--color-text-muted)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '2px 8px',
    fontSize: '10px',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  })

  const selectStyle: React.CSSProperties = {
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '2px 6px',
    fontSize: '10px',
    outline: 'none',
    cursor: 'pointer',
  }

  const renderChart = () => {
    if (loading && chartData.length === 0) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
          Loading...
        </div>
      )
    }
    if (error) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ef4444', fontFamily: 'var(--font-sans)', fontSize: '11px' }}>
          {error}
        </div>
      )
    }
    if (chartData.length === 0) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
          No data
        </div>
      )
    }

    const tooltipStyle = {
      backgroundColor: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-border)',
      borderRadius: '4px',
      fontSize: '11px',
      color: 'var(--color-text-primary)',
    }

    const commonProps = {
      data: chartData,
      margin: { top: 8, right: 12, bottom: 4, left: 0 },
    }

    const axisProps = {
      tick: { fill: 'var(--color-text-muted)', fontSize: 10 },
      axisLine: { stroke: 'var(--color-border)' },
      tickLine: false as const,
    }

    if (chartType === 'line') {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart {...commonProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="name" {...axisProps} />
            <YAxis {...axisProps} width={32} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="value" stroke={DEFAULT_COLOR} strokeWidth={2} dot={{ r: 3, fill: DEFAULT_COLOR }} />
          </LineChart>
        </ResponsiveContainer>
      )
    }

    if (chartType === 'area') {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart {...commonProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="name" {...axisProps} />
            <YAxis {...axisProps} width={32} />
            <Tooltip contentStyle={tooltipStyle} />
            <defs>
              <linearGradient id={`areaGrad-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={DEFAULT_COLOR} stopOpacity={0.4} />
                <stop offset="95%" stopColor={DEFAULT_COLOR} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="value" stroke={DEFAULT_COLOR} strokeWidth={2} fill={`url(#areaGrad-${id})`} />
          </AreaChart>
        </ResponsiveContainer>
      )
    }

    // Default: bar
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart {...commonProps}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="name" {...axisProps} />
          <YAxis {...axisProps} width={32} />
          <Tooltip contentStyle={tooltipStyle} />
          <Bar dataKey="value" radius={[3, 3, 0, 0]}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={getBarColor(entry)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    )
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={toolbarStyle}>
        <div style={{ display: 'flex', gap: '2px' }}>
          {(['bar', 'line', 'area'] as ChartType[]).map(ct => (
            <button
              key={ct}
              style={chartBtnStyle(chartType === ct)}
              onClick={() => updateConfig({ chartType: ct })}
            >
              {ct.charAt(0).toUpperCase() + ct.slice(1)}
            </button>
          ))}
        </div>
        <select
          value={dataSource}
          onChange={e => updateConfig({ dataSource: e.target.value })}
          style={selectStyle}
        >
          {DATA_SOURCE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: '4px' }}>
        {renderChart()}
      </div>
    </div>
  )
}
