import { useEffect, useState, useRef, useMemo } from 'react'
import { Search, ChevronRight, ChevronDown } from 'lucide-react'
import { useWidgetEventBus } from '../../stores/widgetEventBus'
import { apiFetch } from '../../lib/api'
import type { WidgetProps } from './WidgetRegistry'

interface C2Command {
  name: string
  description: string
  syntax: string
  category: string
  risk_level: number
}

const RISK_COLORS: Record<number, string> = {
  1: '#4ade80',
  2: '#60a5fa',
  3: '#facc15',
  4: '#fb923c',
  5: '#ef4444',
}

const CATEGORY_ORDER = ['recon', 'lateral_movement', 'persistence', 'exfiltration', 'general']

const FALLBACK_COMMANDS: C2Command[] = [
  { name: 'ls', description: 'List directory contents', syntax: 'ls', category: 'recon', risk_level: 1 },
  { name: 'whoami', description: 'Print current user', syntax: 'whoami', category: 'recon', risk_level: 1 },
  { name: 'ifconfig', description: 'Show network interfaces', syntax: 'ifconfig', category: 'recon', risk_level: 1 },
  { name: 'pwd', description: 'Print working directory', syntax: 'pwd', category: 'recon', risk_level: 1 },
  { name: 'ps', description: 'List running processes', syntax: 'ps', category: 'recon', risk_level: 2 },
]

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  width: '100%',
  overflow: 'hidden',
  fontFamily: 'var(--font-sans)',
  background: 'var(--color-bg-primary)',
}

const searchContainerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  borderBottom: '1px solid var(--color-border)',
  flexShrink: 0,
}

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  color: 'var(--color-text-primary)',
  fontSize: 12,
  fontFamily: 'var(--font-mono)',
  outline: 'none',
}

const listContainerStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
}

const categoryHeaderStyle = (expanded: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 8px',
  cursor: 'pointer',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--color-text-muted)',
  background: expanded ? 'rgba(255,255,255,0.02)' : 'transparent',
  borderBottom: '1px solid var(--color-border)',
  userSelect: 'none',
})

const commandRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 8px 4px 24px',
  cursor: 'pointer',
  fontSize: 11,
  borderBottom: '1px solid rgba(255,255,255,0.03)',
  transition: 'background 0.1s',
}

const riskBadgeStyle = (level: number): React.CSSProperties => ({
  fontSize: 9,
  fontWeight: 700,
  color: RISK_COLORS[level] ?? '#6e7681',
  border: `1px solid ${RISK_COLORS[level] ?? '#6e7681'}`,
  borderRadius: 3,
  padding: '0px 4px',
  lineHeight: '14px',
  flexShrink: 0,
})

const countBadgeStyle: React.CSSProperties = {
  fontSize: 9,
  background: 'rgba(255,255,255,0.08)',
  color: 'var(--color-text-muted)',
  borderRadius: 8,
  padding: '0 5px',
  lineHeight: '14px',
}

function formatCategory(cat: string): string {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export default function CommandPaletteWidget({ id }: WidgetProps) {
  const [commands, setCommands] = useState<C2Command[]>([])
  const [search, setSearch] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(CATEGORY_ORDER))
  const searchRef = useRef<HTMLInputElement>(null)

  const executeCommand = useWidgetEventBus(s => s.executeCommand)

  // Fetch commands
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await apiFetch<{ commands: C2Command[] }>('/c2/commands')
        if (!cancelled) {
          const cmds = res.commands ?? []
          setCommands(cmds.length > 0 ? cmds : FALLBACK_COMMANDS)
        }
      } catch {
        if (!cancelled) setCommands(FALLBACK_COMMANDS)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Auto-focus search
  useEffect(() => {
    const timer = setTimeout(() => searchRef.current?.focus(), 100)
    return () => clearTimeout(timer)
  }, [])

  // Filtered and grouped commands
  const grouped = useMemo(() => {
    const lower = search.toLowerCase()
    const filtered = commands.filter(c =>
      c.name.toLowerCase().includes(lower) ||
      c.description.toLowerCase().includes(lower)
    )

    const groups = new Map<string, C2Command[]>()
    for (const cmd of filtered) {
      const cat = cmd.category || 'general'
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(cmd)
    }

    // Sort categories by defined order, unknowns at end
    const sorted = [...groups.entries()].sort(([a], [b]) => {
      const ia = CATEGORY_ORDER.indexOf(a)
      const ib = CATEGORY_ORDER.indexOf(b)
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
    })

    return sorted
  }, [commands, search])

  const toggleCategory = (cat: string) => {
    setExpandedCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={searchContainerStyle}>
        <Search size={13} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
        <input
          ref={searchRef}
          style={searchInputStyle}
          placeholder="Search commands..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />
      </div>

      <div style={listContainerStyle}>
        {grouped.length === 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--color-text-muted)',
            fontSize: 12,
          }}>
            No matching commands
          </div>
        )}

        {grouped.map(([category, cmds]) => {
          const expanded = expandedCategories.has(category)
          return (
            <div key={category}>
              <div
                style={categoryHeaderStyle(expanded)}
                onClick={() => toggleCategory(category)}
              >
                {expanded
                  ? <ChevronDown size={12} />
                  : <ChevronRight size={12} />
                }
                <span>{formatCategory(category)}</span>
                <span style={countBadgeStyle}>{cmds.length}</span>
              </div>

              {expanded && cmds.map((cmd) => (
                <div
                  key={`${category}-${cmd.name}`}
                  style={commandRowStyle}
                  onClick={() => executeCommand(cmd.syntax)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                  title={`Syntax: ${cmd.syntax}`}
                >
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 600,
                    color: 'var(--color-text-primary)',
                    whiteSpace: 'nowrap',
                  }}>
                    {cmd.name}
                  </span>
                  <span style={{
                    color: 'var(--color-text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}>
                    {cmd.description}
                  </span>
                  <span style={riskBadgeStyle(cmd.risk_level)}>
                    R{cmd.risk_level}
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
