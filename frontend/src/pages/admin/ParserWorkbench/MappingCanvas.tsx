import { useState, useCallback, useMemo } from 'react'
import { ArrowRight, GitCommitHorizontal } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

interface Mapping {
  source: string
  target: string
  transform?: string
}

export interface MappingCanvasProps {
  mappings: Mapping[]
  onSelectMapping?: (target: string) => void
  onUpdateMapping?: (target: string, updates: Partial<{ source: string; transform: string }>) => void
  selectedMapping?: string | null
}

const TRANSFORM_OPTIONS = [
  { value: 'as_is', label: 'as_is' },
  { value: 'to_integer', label: 'to_integer' },
  { value: 'to_float', label: 'to_float' },
  { value: 'to_lowercase', label: 'to_lowercase' },
  { value: 'to_uppercase', label: 'to_uppercase' },
  { value: 'regex_extract', label: 'regex_extract' },
]

// All known target fields for counting unmapped
const ALL_TARGET_FIELDS = [
  'ip_address', 'hostname', 'mac_address', 'os', 'os_version',
  'status', 'node_type', 'services.port', 'services.protocol',
  'services.service', 'services.product', 'services.version',
  'metadata.vulnerabilities', 'metadata.interfaces', 'metadata.notes',
]

// ── Component ──────────────────────────────────────────────────────────────

export default function MappingCanvas({
  mappings,
  onSelectMapping,
  onUpdateMapping,
  selectedMapping,
}: MappingCanvasProps) {
  const [editTransform, setEditTransform] = useState<string>('')
  const [editPattern, setEditPattern] = useState<string>('')

  const unmappedCount = useMemo(() => {
    const mappedTargets = new Set(mappings.map(m => m.target))
    return ALL_TARGET_FIELDS.filter(f => !mappedTargets.has(f)).length
  }, [mappings])

  const selectedMappingObj = useMemo(() => {
    return mappings.find(m => m.target === selectedMapping)
  }, [mappings, selectedMapping])

  // Sync edit state when selection changes
  const currentTransform = selectedMappingObj?.transform || 'as_is'

  const handleSelectMapping = useCallback((target: string) => {
    onSelectMapping?.(target)
    const m = mappings.find(mp => mp.target === target)
    if (m) {
      setEditTransform(m.transform || 'as_is')
      // Extract regex pattern if present
      if (m.transform?.startsWith('regex_extract:')) {
        setEditPattern(m.transform.replace('regex_extract:', ''))
        setEditTransform('regex_extract')
      } else {
        setEditPattern('')
      }
    }
  }, [onSelectMapping, mappings])

  const handleTransformChange = useCallback((value: string) => {
    setEditTransform(value)
    if (!selectedMapping || !onUpdateMapping) return
    if (value === 'regex_extract') {
      onUpdateMapping(selectedMapping, { transform: `regex_extract:${editPattern}` })
    } else {
      onUpdateMapping(selectedMapping, { transform: value === 'as_is' ? undefined : value })
    }
  }, [selectedMapping, onUpdateMapping, editPattern])

  const handlePatternChange = useCallback((pattern: string) => {
    setEditPattern(pattern)
    if (!selectedMapping || !onUpdateMapping) return
    onUpdateMapping(selectedMapping, { transform: `regex_extract:${pattern}` })
  }, [selectedMapping, onUpdateMapping])

  function getMappingColor(m: Mapping): string {
    if (m.transform && m.transform !== 'as_is') {
      if (m.transform.startsWith('regex_extract')) return '#f97316' // orange for regex/filter
      return '#60a5fa' // blue for transforms
    }
    return '#4ade80' // green for direct
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.panelHeader}>
        <span style={styles.panelLabel}>MAPPINGS</span>
      </div>

      {/* Stats */}
      <div style={styles.statsBar}>
        <span style={styles.statItem}>
          <span style={styles.statNumber}>{mappings.length}</span> mapped
        </span>
        <span style={styles.statDivider}>/</span>
        <span style={styles.statItem}>
          <span style={styles.statNumber}>{unmappedCount}</span> unmapped
        </span>
      </div>

      {/* Mapping list */}
      <div style={styles.listContainer}>
        {mappings.length === 0 && (
          <div style={styles.emptyState}>
            <GitCommitHorizontal size={16} style={{ color: 'var(--color-text-muted)', opacity: 0.4, marginBottom: 6 }} />
            <span style={styles.emptyText}>
              Drag source fields to target schema to create mappings
            </span>
          </div>
        )}
        {mappings.map(m => {
          const color = getMappingColor(m)
          const isSelected = selectedMapping === m.target
          return (
            <div
              key={m.target}
              style={{
                ...styles.mappingRow,
                borderColor: isSelected ? 'var(--color-accent)' : 'transparent',
                background: isSelected ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
              }}
              onClick={() => handleSelectMapping(m.target)}
            >
              <span style={{ ...styles.mappingSource, color }}>{truncate(m.source, 18)}</span>
              <ArrowRight size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
              <span style={{ ...styles.mappingTarget, color }}>{truncate(m.target, 18)}</span>
              {m.transform && m.transform !== 'as_is' && (
                <span style={styles.miniTransformTag}>
                  {m.transform.startsWith('regex_extract') ? 'regex' : m.transform}
                </span>
              )}
            </div>
          )
        })}
      </div>

      {/* Transform editor */}
      {selectedMappingObj && (
        <div style={styles.transformEditor}>
          <div style={styles.transformHeader}>
            <span style={styles.transformLabel}>TRANSFORM</span>
            <span style={styles.transformTarget}>{selectedMappingObj.target}</span>
          </div>
          <div style={styles.transformBody}>
            <select
              value={editTransform || currentTransform}
              onChange={e => handleTransformChange(e.target.value)}
              style={styles.transformSelect}
            >
              {TRANSFORM_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {(editTransform === 'regex_extract' || currentTransform.startsWith('regex_extract')) && (
              <input
                type="text"
                value={editPattern}
                onChange={e => handlePatternChange(e.target.value)}
                placeholder="regex pattern..."
                style={styles.patternInput}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 2) + '..' : s
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 12px',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-elevated)',
    flexShrink: 0,
  },
  panelLabel: {
    fontSize: 11,
    letterSpacing: 1,
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-sans)',
    fontWeight: 600,
  },
  statsBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '6px 8px',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-elevated)',
    flexShrink: 0,
  },
  statItem: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
  },
  statNumber: {
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
  },
  statDivider: {
    fontSize: 10,
    color: 'var(--color-text-muted)',
    opacity: 0.4,
  },
  listContainer: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: 16,
  },
  emptyText: {
    fontSize: 10,
    fontFamily: 'var(--font-sans)',
    color: 'var(--color-text-muted)',
    opacity: 0.5,
    textAlign: 'center',
    lineHeight: 1.4,
  },
  mappingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 8px',
    minHeight: 26,
    borderBottom: '1px solid rgba(255,255,255,0.03)',
    border: '1px solid transparent',
    cursor: 'pointer',
    transition: 'border-color 0.1s, background 0.1s',
  },
  mappingSource: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: 1,
    minWidth: 0,
  },
  mappingTarget: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: 1,
    minWidth: 0,
  },
  miniTransformTag: {
    fontSize: 8,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid var(--color-border)',
    borderRadius: 2,
    padding: '0px 3px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  transformEditor: {
    borderTop: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  transformHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '5px 8px',
    background: 'var(--color-bg-elevated)',
    borderBottom: '1px solid var(--color-border)',
  },
  transformLabel: {
    fontSize: 9,
    letterSpacing: 1,
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-sans)',
    fontWeight: 600,
  },
  transformTarget: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    color: '#60a5fa',
  },
  transformBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '6px 8px',
  },
  transformSelect: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '3px 6px',
    background: 'var(--color-bg-primary)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    width: '100%',
  },
  patternInput: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '3px 6px',
    background: 'var(--color-bg-primary)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    outline: 'none',
    width: '100%',
  },
}
