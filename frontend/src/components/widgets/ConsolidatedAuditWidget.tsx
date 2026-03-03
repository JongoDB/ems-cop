import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/api'
import { useEnclaveStore } from '../../stores/enclaveStore'
import { ScrollText, ArrowUpRight, Clock, Activity } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts'
import type { WidgetProps } from './WidgetRegistry'

// ════════════════════════════════════════════
//  TYPES
// ════════════════════════════════════════════

interface AuditStats {
  total_24h: number
  low_count: number
  high_count: number
  cross_domain_ops: number
  last_event_at: string | null
  timeline: Array<{
    hour: string
    low: number
    high: number
  }>
}

// ════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never'
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return 'Unknown'
  }
}

function formatHourLabel(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString(undefined, { hour: '2-digit' })
  } catch {
    return iso
  }
}

// ════════════════════════════════════════════
//  COMPONENT
// ════════════════════════════════════════════

export default function ConsolidatedAuditWidget(_props: WidgetProps) {
  const navigate = useNavigate()
  const { enclave } = useEnclaveStore()
  const [stats, setStats] = useState<AuditStats | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchStats = useCallback(async () => {
    try {
      const data = await apiFetch<AuditStats>('/audit/consolidated/stats')
      setStats(data)
    } catch {
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStats()
    const interval = setInterval(fetchStats, 30000)
    return () => clearInterval(interval)
  }, [fetchStats])

  if (!enclave || enclave === 'low') {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 8,
        padding: 16,
      }}>
        <ScrollText size={24} style={{ color: 'var(--color-border-strong)' }} />
        <p style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--color-text-muted)',
          textAlign: 'center',
          margin: 0,
        }}>
          Consolidated audit is only available on the high side.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--color-text-muted)',
          letterSpacing: 1,
        }}>
          LOADING...
        </span>
      </div>
    )
  }

  const chartData = stats?.timeline
    ? stats.timeline.slice(-12).map((b) => ({
        hour: formatHourLabel(b.hour),
        low: b.low,
        high: b.high,
      }))
    : []

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 8,
        padding: 12,
        cursor: 'pointer',
      }}
      onClick={() => navigate('/audit/consolidated')}
      title="Click to open Consolidated Audit Trail"
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: 1,
          color: 'var(--color-text-muted)',
        }}>
          <ScrollText size={12} />
          CONSOLIDATED AUDIT
        </div>
        <ArrowUpRight size={12} style={{ color: 'var(--color-text-muted)' }} />
      </div>

      {/* Mini Bar Chart */}
      {chartData.length > 0 && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" />
              <XAxis
                dataKey="hour"
                tick={{ fill: 'var(--color-text-muted)', fontSize: 8, fontFamily: 'var(--font-mono)' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: 'var(--color-text-muted)', fontSize: 8, fontFamily: 'var(--font-mono)' }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--color-bg-primary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                }}
              />
              <Bar dataKey="low" name="LOW" stackId="a" fill="rgba(59,130,246,0.6)" radius={[0, 0, 0, 0]} />
              <Bar dataKey="high" name="HIGH" stackId="a" fill="rgba(64,192,87,0.6)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Stats */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr 1fr',
        gap: 8,
      }}>
        <StatBlock
          label="Total (24h)"
          value={stats?.total_24h ?? 0}
          icon={Activity}
        />
        <StatBlock
          label="Low Side"
          value={stats?.low_count ?? 0}
          color="#3b82f6"
        />
        <StatBlock
          label="High Side"
          value={stats?.high_count ?? 0}
          color="#40c057"
        />
        <StatBlock
          label="Cross-Domain"
          value={stats?.cross_domain_ops ?? 0}
          color="var(--color-accent)"
        />
      </div>

      {/* Last Event */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color: 'var(--color-text-muted)',
      }}>
        <Clock size={9} />
        Last event: {formatTimestamp(stats?.last_event_at ?? null)}
      </div>
    </div>
  )
}

function StatBlock({
  label,
  value,
  color,
  icon: Icon,
}: {
  label: string
  value: number
  color?: string
  icon?: typeof Activity
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      padding: '6px 8px',
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius)',
    }}>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 8,
        letterSpacing: 0.5,
        color: 'var(--color-text-muted)',
        display: 'flex',
        alignItems: 'center',
        gap: 3,
      }}>
        {Icon && <Icon size={8} />}
        {label}
      </span>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 14,
        fontWeight: 700,
        color: color || 'var(--color-text-bright)',
      }}>
        {value}
      </span>
    </div>
  )
}
