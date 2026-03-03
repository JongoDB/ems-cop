import { useState, useEffect, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { apiFetch } from '../../lib/api'

interface TechniqueCount {
  technique_id: string
  tactic: string
  count: number
}

const TACTIC_ORDER = [
  'reconnaissance',
  'resource-development',
  'initial-access',
  'execution',
  'persistence',
  'privilege-escalation',
  'defense-evasion',
  'credential-access',
  'discovery',
  'lateral-movement',
  'collection',
  'command-and-control',
  'exfiltration',
  'impact',
]

function heatColor(count: number, maxCount: number): string {
  if (count === 0 || maxCount === 0) return 'transparent'
  const intensity = Math.min(count / maxCount, 1)
  const r = Math.round(239 * intensity + 99 * (1 - intensity))
  const g = Math.round(68 * intensity + 102 * (1 - intensity))
  const b = Math.round(68 * intensity + 241 * (1 - intensity))
  const a = 0.3 + intensity * 0.7
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

export default function MitreHeatmapWidget({ id }: WidgetProps) {
  const [techniques, setTechniques] = useState<TechniqueCount[]>([])
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: TechniqueCount[] }>(
        '/endpoints/alerts?aggregate=mitre'
      )
      setTechniques(res.data || [])
    } catch {
      setTechniques([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 60_000)
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

  if (loading) {
    return (
      <div data-widget-id={id} style={containerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
          Loading MITRE data...
        </div>
      </div>
    )
  }

  // Group by tactic
  const tacticMap = new Map<string, TechniqueCount[]>()
  for (const t of techniques) {
    const tactic = t.tactic || 'unknown'
    if (!tacticMap.has(tactic)) tacticMap.set(tactic, [])
    tacticMap.get(tactic)!.push(t)
  }

  const maxCount = techniques.reduce((max, t) => Math.max(max, t.count), 0)

  const orderedTactics = TACTIC_ORDER.filter((t) => tacticMap.has(t))
  // Add any tactics not in our order list
  for (const t of tacticMap.keys()) {
    if (!orderedTactics.includes(t)) orderedTactics.push(t)
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {techniques.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-muted)' }}>
            No MITRE technique data
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {orderedTactics.map((tactic) => {
              const techs = tacticMap.get(tactic) || []
              return (
                <div key={tactic} style={{ minWidth: 80, flex: '0 0 auto' }}>
                  <div style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    fontWeight: 600,
                    color: 'var(--color-text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    marginBottom: 4,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {tactic.replace(/-/g, ' ')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {techs.map((tech) => (
                      <a
                        key={tech.technique_id}
                        href={`https://attack.mitre.org/techniques/${tech.technique_id.split('.').join('/')}/`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 4,
                          padding: '2px 4px',
                          background: heatColor(tech.count, maxCount),
                          borderRadius: 2,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 9,
                          color: 'var(--color-text-bright)',
                          textDecoration: 'none',
                          whiteSpace: 'nowrap',
                        }}
                        title={`${tech.technique_id}: ${tech.count} hits`}
                      >
                        <span>{tech.technique_id}</span>
                        <span style={{ fontSize: 8, opacity: 0.7 }}>{tech.count}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
