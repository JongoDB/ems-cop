import { useState, useCallback, useMemo } from 'react'
import { X, ChevronRight, ChevronDown, Plus, Trash2, Eye } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

interface Mapping {
  source: string
  target: string
  transform?: string
}

interface NodeTypeRule {
  field: string
  operator: string
  value: string
  node_type: string
}

export interface TargetSchemaProps {
  mappings: Mapping[]
  onAddMapping: (source: string, target: string) => void
  onRemoveMapping: (target: string) => void
  onUpdateMapping: (target: string, updates: Partial<{ source: string; transform: string }>) => void
  sampleData?: { path: string; value: any } | null
  nodeTypeRules?: NodeTypeRule[]
  onNodeTypeRulesChange?: (rules: NodeTypeRule[]) => void
}

// ── Schema Definition ──────────────────────────────────────────────────────

interface SchemaField {
  key: string
  path: string
  required?: boolean
  expandable?: boolean
  children?: SchemaField[]
}

const TARGET_SCHEMA: SchemaField[] = [
  { key: 'ip_address', path: 'ip_address', required: true },
  { key: 'hostname', path: 'hostname' },
  { key: 'mac_address', path: 'mac_address' },
  { key: 'os', path: 'os' },
  { key: 'os_version', path: 'os_version' },
  { key: 'status', path: 'status' },
  { key: 'node_type', path: 'node_type' },
  {
    key: 'services',
    path: 'services',
    expandable: true,
    children: [
      { key: 'port', path: 'services.port' },
      { key: 'protocol', path: 'services.protocol' },
      { key: 'service', path: 'services.service' },
      { key: 'product', path: 'services.product' },
      { key: 'version', path: 'services.version' },
    ],
  },
  {
    key: 'metadata.vulnerabilities',
    path: 'metadata.vulnerabilities',
    expandable: true,
    children: [],
  },
  {
    key: 'metadata.interfaces',
    path: 'metadata.interfaces',
    expandable: true,
    children: [],
  },
  { key: 'metadata.notes', path: 'metadata.notes' },
]

const NODE_TYPE_OPTIONS = [
  'router', 'firewall', 'server', 'workstation', 'printer', 'vpn', 'iot', 'host', 'unknown',
]

const OPERATOR_OPTIONS = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'equals' },
  { value: 'port_open', label: 'port_open' },
  { value: 'service_running', label: 'service_running' },
]

const CONDITION_FIELDS = [
  'hostname', 'os', 'os_version', 'services.port', 'services.service', 'services.product', 'ip_address', 'mac_address',
]

// ── Component ──────────────────────────────────────────────────────────────

export default function TargetSchema({
  mappings,
  onAddMapping,
  onRemoveMapping,
  onUpdateMapping: _onUpdateMapping,
  sampleData,
  nodeTypeRules = [],
  onNodeTypeRulesChange,
}: TargetSchemaProps) {
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set(['services']))
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null)

  const mappingsByTarget = useMemo(() => {
    const map = new Map<string, Mapping>()
    for (const m of mappings) {
      map.set(m.target, m)
    }
    return map
  }, [mappings])

  const toggleExpand = useCallback((path: string) => {
    setExpandedFields(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, path: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOverTarget(path)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverTarget(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetPath: string) => {
    e.preventDefault()
    setDragOverTarget(null)
    const sourcePath = e.dataTransfer.getData('application/x-source-path')
    if (sourcePath) {
      onAddMapping(sourcePath, targetPath)
    }
  }, [onAddMapping])

  // Node type rules handlers
  const handleAddRule = useCallback(() => {
    onNodeTypeRulesChange?.([
      ...nodeTypeRules,
      { field: 'hostname', operator: 'contains', value: '', node_type: 'server' },
    ])
  }, [nodeTypeRules, onNodeTypeRulesChange])

  const handleRemoveRule = useCallback((index: number) => {
    const next = [...nodeTypeRules]
    next.splice(index, 1)
    onNodeTypeRulesChange?.(next)
  }, [nodeTypeRules, onNodeTypeRulesChange])

  const handleUpdateRule = useCallback((index: number, field: keyof NodeTypeRule, value: string) => {
    const next = [...nodeTypeRules]
    next[index] = { ...next[index], [field]: value }
    onNodeTypeRulesChange?.(next)
  }, [nodeTypeRules, onNodeTypeRulesChange])

  // Preview: apply mappings to sampleData
  const preview = useMemo(() => {
    if (!sampleData) return null
    const result: Record<string, string> = {}
    for (const m of mappings) {
      result[m.target] = m.source === sampleData.path ? String(sampleData.value ?? '') : `\${${m.source}}`
    }
    return result
  }, [mappings, sampleData])

  // Render a single field row
  function renderFieldRow(field: SchemaField, depth: number = 0) {
    const mapping = mappingsByTarget.get(field.path)
    const isExpanded = expandedFields.has(field.path)
    const isDragTarget = dragOverTarget === field.path

    return (
      <div key={field.path}>
        <div
          style={{
            ...styles.fieldRow,
            paddingLeft: 12 + depth * 16,
            borderColor: isDragTarget ? 'var(--color-accent)' : 'transparent',
            background: isDragTarget ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
          }}
          onDragOver={(e) => handleDragOver(e, field.path)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, field.path)}
        >
          {/* Expand toggle for expandable fields */}
          {field.expandable ? (
            <span
              style={styles.chevron}
              onClick={() => toggleExpand(field.path)}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          ) : (
            <span style={{ width: 18, flexShrink: 0 }} />
          )}

          {/* Field name */}
          <span style={{
            ...styles.fieldName,
            fontWeight: field.expandable ? 600 : 400,
          }}>
            {field.key}
          </span>

          {/* Required asterisk */}
          {field.required && (
            <span style={styles.requiredMark}>*</span>
          )}

          {/* Mapping info */}
          {mapping && (
            <div style={styles.mappingInfo}>
              <span style={styles.sourceBadge}>{mapping.source}</span>
              {mapping.transform && mapping.transform !== 'as_is' && (
                <span style={styles.transformTag}>{mapping.transform}</span>
              )}
              <button
                onClick={() => onRemoveMapping(field.path)}
                style={styles.removeBtn}
                title="Remove mapping"
              >
                <X size={10} />
              </button>
            </div>
          )}

          {/* Drop hint when not mapped */}
          {!mapping && (
            <span style={styles.dropHint}>drop here</span>
          )}
        </div>

        {/* Expanded children */}
        {field.expandable && isExpanded && field.children?.map(child =>
          renderFieldRow(child, depth + 1)
        )}
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.panelHeader}>
        <span style={styles.panelLabel}>TARGET SCHEMA</span>
        <span style={styles.statsLabel}>
          {mappings.length} mapped
        </span>
      </div>

      {/* Fields list */}
      <div style={styles.fieldsContainer}>
        {TARGET_SCHEMA.map(field => renderFieldRow(field))}
      </div>

      {/* Node Type Rules */}
      <div style={styles.rulesSection}>
        <div style={styles.rulesSectionHeader}>
          <span style={styles.sectionLabel}>NODE TYPE RULES</span>
          <button onClick={handleAddRule} style={styles.addRuleBtn} title="Add rule">
            <Plus size={11} />
          </button>
        </div>
        <div style={styles.rulesContainer}>
          {nodeTypeRules.length === 0 && (
            <div style={styles.rulesEmpty}>No rules defined</div>
          )}
          {nodeTypeRules.map((rule, i) => (
            <div key={i} style={styles.ruleRow}>
              <select
                value={rule.field}
                onChange={e => handleUpdateRule(i, 'field', e.target.value)}
                style={styles.ruleSelect}
              >
                {CONDITION_FIELDS.map(f => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
              <select
                value={rule.operator}
                onChange={e => handleUpdateRule(i, 'operator', e.target.value)}
                style={styles.ruleSelect}
              >
                {OPERATOR_OPTIONS.map(op => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>
              <input
                type="text"
                value={rule.value}
                onChange={e => handleUpdateRule(i, 'value', e.target.value)}
                placeholder="value"
                style={styles.ruleInput}
              />
              <select
                value={rule.node_type}
                onChange={e => handleUpdateRule(i, 'node_type', e.target.value)}
                style={styles.ruleSelect}
              >
                {NODE_TYPE_OPTIONS.map(nt => (
                  <option key={nt} value={nt}>{nt}</option>
                ))}
              </select>
              <button
                onClick={() => handleRemoveRule(i)}
                style={styles.ruleDeleteBtn}
                title="Delete rule"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Preview */}
      <div style={styles.previewSection}>
        <div style={styles.previewHeader}>
          <Eye size={12} style={{ color: 'var(--color-text-muted)', marginRight: 6 }} />
          <span style={styles.sectionLabel}>PREVIEW</span>
        </div>
        <div style={styles.previewContainer}>
          {!preview || mappings.length === 0 ? (
            <span style={styles.previewEmpty}>
              {sampleData ? 'Add mappings to see preview' : 'Drag a source field to see preview'}
            </span>
          ) : (
            <div style={styles.previewCard}>
              {Object.entries(preview).map(([key, val]) => (
                <div key={key} style={styles.previewRow}>
                  <span style={styles.previewKey}>{key}:</span>
                  <span style={styles.previewVal}>{val || '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
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
    justifyContent: 'space-between',
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
  statsLabel: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
  },
  fieldsContainer: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 8px',
    minHeight: 30,
    borderBottom: '1px solid rgba(255,255,255,0.03)',
    border: '1px solid transparent',
    borderRadius: 0,
    transition: 'border-color 0.12s, background 0.12s',
  },
  chevron: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    flexShrink: 0,
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
  },
  fieldName: {
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-primary)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  requiredMark: {
    fontSize: 14,
    color: '#ef4444',
    fontWeight: 700,
    marginLeft: 2,
    flexShrink: 0,
  },
  mappingInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    flexShrink: 0,
  },
  sourceBadge: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    color: '#60a5fa',
    background: 'rgba(96, 165, 250, 0.12)',
    border: '1px solid rgba(96, 165, 250, 0.25)',
    borderRadius: 3,
    padding: '1px 6px',
    whiteSpace: 'nowrap',
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  transformTag: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    padding: '1px 5px',
    whiteSpace: 'nowrap',
  },
  removeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    borderRadius: 2,
    padding: 0,
    opacity: 0.6,
  },
  dropHint: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    opacity: 0.4,
    marginLeft: 'auto',
    fontStyle: 'italic',
  },

  // Node Type Rules
  rulesSection: {
    borderTop: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  rulesSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px',
    background: 'var(--color-bg-elevated)',
    borderBottom: '1px solid var(--color-border)',
  },
  sectionLabel: {
    fontSize: 10,
    letterSpacing: 1,
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-sans)',
    fontWeight: 600,
  },
  addRuleBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: 0,
  },
  rulesContainer: {
    maxHeight: 120,
    overflow: 'auto',
    padding: '4px 8px',
  },
  rulesEmpty: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    opacity: 0.5,
    textAlign: 'center',
    padding: '6px 0',
    fontStyle: 'italic',
  },
  ruleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 0',
  },
  ruleSelect: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '2px 4px',
    background: 'var(--color-bg-primary)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    minWidth: 0,
    flex: 1,
  },
  ruleInput: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '2px 6px',
    background: 'var(--color-bg-primary)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    outline: 'none',
    flex: 1,
    minWidth: 0,
  },
  ruleDeleteBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: 0,
    opacity: 0.6,
    flexShrink: 0,
  },

  // Preview
  previewSection: {
    borderTop: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  previewHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px',
    background: 'var(--color-bg-elevated)',
    borderBottom: '1px solid var(--color-border)',
  },
  previewContainer: {
    maxHeight: 100,
    overflow: 'auto',
    padding: '6px 12px',
  },
  previewEmpty: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    opacity: 0.5,
    fontStyle: 'italic',
    textAlign: 'center',
    padding: '4px 0',
  },
  previewCard: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--color-border)',
    borderRadius: 4,
    padding: '6px 10px',
  },
  previewRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '1px 0',
  },
  previewKey: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  previewVal: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: '#4ade80',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
}
