import { useState, useEffect, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts'

interface SeverityCount {
  name: string
  value: number
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#3b82f6',
  info: '#6b7280',
}

export default function AlertStatsWidget({ id }: WidgetProps) {
  const [severityCounts, setSeverityCounts] = useState<SeverityCount[]>([])
  const [trendData, setTrendData] = useState<{ time: string; count: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'donut' | 'trend'>('donut')

  const fetchData = useCallback(async () => {
    try {
      const res = await apiFetch<{
        data: {
          by_severity?: Record<string, number>
          trend?: { time: string; count: number }[]
          total?: number
        }
      }>('/endpoints/alerts?stats=true')

      const bySeverity = res?.data?.by_severity
      if (bySeverity && typeof bySeverity === 'object') {
        setSeverityCounts(
          Object.entries(bySeverity).map(([name, value]) => ({ name, value: Number(value) || 0 }))
        )
      }

      const trend = res?.data?.trend
      if (Array.isArray(trend)) {
        setTrendData(trend)
      }
    } catch {
      setSeverityCounts([])
      setTrendData([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

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

  const tooltipStyle = {
    backgroundColor: 'var(--color-bg-elevated)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    fontSize: '11px',
    color: 'var(--color-text-primary)',
  }

  if (loading) {
    return (
      <div data-widget-id={id} style={containerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
          Loading alert stats...
        </div>
      </div>
    )
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        borderBottom: '1px solid var(--color-border)',
        fontSize: 10,
        flexShrink: 0,
      }}>
        <button
          onClick={() => setView('donut')}
          style={{
            background: view === 'donut' ? 'var(--color-accent)' : 'var(--color-bg-elevated)',
            color: view === 'donut' ? '#fff' : 'var(--color-text-muted)',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 10,
            cursor: 'pointer',
          }}
        >
          By Severity
        </button>
        <button
          onClick={() => setView('trend')}
          style={{
            background: view === 'trend' ? 'var(--color-accent)' : 'var(--color-bg-elevated)',
            color: view === 'trend' ? '#fff' : 'var(--color-text-muted)',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 10,
            cursor: 'pointer',
          }}
        >
          24h Trend
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: 4 }}>
        {view === 'donut' ? (
          severityCounts.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
              No alert data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={severityCounts}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius="45%"
                  outerRadius="75%"
                  paddingAngle={2}
                  label={({ name, value }) => `${name}: ${value}`}
                >
                  {severityCounts.map((entry, i) => (
                    <Cell key={i} fill={SEVERITY_COLORS[entry.name] || '#6b7280'} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          )
        ) : (
          trendData.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
              No trend data
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="time"
                  tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
                  axisLine={{ stroke: 'var(--color-border)' }}
                  tickLine={false}
                  width={32}
                />
                <Tooltip contentStyle={tooltipStyle} />
                <defs>
                  <linearGradient id={`alertTrend-${id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="count" stroke="#ef4444" strokeWidth={2} fill={`url(#alertTrend-${id})`} />
              </AreaChart>
            </ResponsiveContainer>
          )
        )}
      </div>
    </div>
  )
}
