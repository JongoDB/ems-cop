import { useState, useEffect, useCallback } from 'react'
import { Plus, Save, Copy } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import SourceInspector from './ParserWorkbench/SourceInspector'
import TargetSchema from './ParserWorkbench/TargetSchema'
import MappingCanvas from './ParserWorkbench/MappingCanvas'

// ── Types ──────────────────────────────────────────────────────────────────

interface ImportParser {
  id: string
  name: string
  description?: string
  source_format: string
  definition: any
  created_at: string
  updated_at: string
}

interface Mapping {
  source: string
  target: string
  transform?: string
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ParserWorkbench() {
  const [parsers, setParsers] = useState<ImportParser[]>([])
  const [selectedParserId, setSelectedParserId] = useState<string>('')
  const [definition, setDefinition] = useState<any>(null)
  const [mappings, setMappings] = useState<Mapping[]>([])
  const [sampleData, setSampleData] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [selectedMapping, setSelectedMapping] = useState<string | null>(null)
  const [nodeTypeRules, setNodeTypeRules] = useState<any[]>([])

  // Derived mapped fields for the source inspector
  const mappedFields = new Map<string, string>(
    mappings.map(m => [m.source, m.target])
  )

  // Fetch parsers on mount
  useEffect(() => {
    fetchParsers()
  }, [])

  async function fetchParsers() {
    try {
      const res = await apiFetch<ImportParser[] | { data: ImportParser[] }>('/import-parsers')
      const list = Array.isArray(res) ? res : (res.data ?? [])
      setParsers(list)
      if (list.length > 0 && !selectedParserId) {
        selectParser(list[0])
      }
    } catch (err) {
      console.error('Failed to fetch import parsers:', err)
    }
  }

  function selectParser(parser: ImportParser) {
    setSelectedParserId(parser.id)
    setDefinition(parser.definition)
    setMappings(parser.definition?.mappings ?? [])
    setNodeTypeRules(parser.definition?.node_type_rules ?? [])
    setSaveMessage(null)
  }

  const handleSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const parser = parsers.find(p => p.id === e.target.value)
    if (parser) selectParser(parser)
  }, [parsers])

  const handleFieldDragStart = useCallback((path: string, sampleValue: any) => {
    setSampleData({ path, value: sampleValue })
  }, [])

  async function handleSave() {
    if (!selectedParserId) return
    setSaving(true)
    setSaveMessage(null)
    try {
      const updatedDef = { ...definition, mappings, node_type_rules: nodeTypeRules }
      await apiFetch(`/import-parsers/${selectedParserId}`, {
        method: 'PATCH',
        body: JSON.stringify({ definition: updatedDef }),
      })
      setSaveMessage('Saved successfully')
      await fetchParsers()
    } catch (err) {
      setSaveMessage(`Save failed: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleClone() {
    const parser = parsers.find(p => p.id === selectedParserId)
    if (!parser) return
    try {
      const created = await apiFetch<ImportParser>('/import-parsers', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Copy of ' + parser.name,
          source_format: parser.source_format,
          definition: parser.definition,
        }),
      })
      await fetchParsers()
      if (created?.id) {
        setSelectedParserId(created.id)
        setDefinition(created.definition)
        setMappings(created.definition?.mappings ?? [])
      }
    } catch (err) {
      setSaveMessage(`Clone failed: ${(err as Error).message}`)
    }
  }

  async function handleNew() {
    try {
      const created = await apiFetch<ImportParser>('/import-parsers', {
        method: 'POST',
        body: JSON.stringify({
          name: 'New Parser',
          source_format: 'json',
          definition: { mappings: [] },
        }),
      })
      await fetchParsers()
      if (created?.id) {
        setSelectedParserId(created.id)
        setDefinition(created.definition)
        setMappings([])
      }
    } catch (err) {
      setSaveMessage(`Create failed: ${(err as Error).message}`)
    }
  }

  const handleAddMapping = useCallback((source: string, target: string) => {
    setMappings(prev => {
      const existing = prev.findIndex(m => m.target === target)
      if (existing >= 0) {
        const updated = [...prev]
        updated[existing] = { ...updated[existing], source }
        return updated
      }
      return [...prev, { source, target }]
    })
  }, [])

  const handleRemoveMapping = useCallback((target: string) => {
    setMappings(prev => prev.filter(m => m.target !== target))
    if (selectedMapping === target) setSelectedMapping(null)
  }, [selectedMapping])

  const handleUpdateMapping = useCallback((target: string, updates: Partial<{ source: string; transform: string }>) => {
    setMappings(prev => prev.map(m => m.target === target ? { ...m, ...updates } : m))
  }, [])

  const selectedParser = parsers.find(p => p.id === selectedParserId)

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <div style={styles.topBarLeft}>
          <label style={styles.label}>PARSER</label>
          <select
            value={selectedParserId}
            onChange={handleSelectChange}
            style={styles.select}
          >
            {parsers.length === 0 && <option value="">No parsers</option>}
            {parsers.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {selectedParser && (
            <span style={styles.parserDesc}>
              {selectedParser.description || selectedParser.source_format?.toUpperCase()}
            </span>
          )}
        </div>
        <div style={styles.topBarRight}>
          <button
            onClick={handleSave}
            disabled={saving || !selectedParserId}
            style={{
              ...styles.button,
              ...(selectedParserId ? styles.buttonAccent : styles.buttonDisabled),
            }}
          >
            <Save size={12} style={{ marginRight: 4 }} />
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleClone}
            disabled={!selectedParserId}
            style={{
              ...styles.button,
              ...(!selectedParserId ? styles.buttonDisabled : {}),
            }}
          >
            <Copy size={12} style={{ marginRight: 4 }} />
            Clone
          </button>
          <button onClick={handleNew} style={styles.button}>
            <Plus size={12} style={{ marginRight: 4 }} />
            New Parser
          </button>
          {saveMessage && (
            <span style={{
              ...styles.saveMsg,
              color: saveMessage.startsWith('Save failed') || saveMessage.startsWith('Clone failed') || saveMessage.startsWith('Create failed')
                ? '#ef4444'
                : '#4ade80',
            }}>
              {saveMessage}
            </span>
          )}
        </div>
      </div>

      {/* Three-panel layout */}
      <div style={styles.panelLayout}>
        {/* Left: Source Inspector — 30% */}
        <div style={styles.leftPanel}>
          <SourceInspector
            onFieldDragStart={handleFieldDragStart}
            mappedFields={mappedFields}
          />
        </div>

        {/* Center: Mapping Canvas — 15% */}
        <div style={styles.centerPanel}>
          <MappingCanvas
            mappings={mappings}
            selectedMapping={selectedMapping}
            onSelectMapping={setSelectedMapping}
            onUpdateMapping={handleUpdateMapping}
          />
        </div>

        {/* Right: Target Schema — 55% */}
        <div style={styles.rightPanel}>
          <TargetSchema
            mappings={mappings}
            onAddMapping={handleAddMapping}
            onRemoveMapping={handleRemoveMapping}
            onUpdateMapping={handleUpdateMapping}
            sampleData={sampleData}
            nodeTypeRules={nodeTypeRules}
            onNodeTypeRulesChange={setNodeTypeRules}
          />
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
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--color-text-primary)',
    background: 'var(--color-bg-primary)',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-elevated)',
    gap: 12,
    flexShrink: 0,
  },
  topBarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  topBarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 11,
    letterSpacing: 1,
    color: 'var(--color-text-muted)',
    fontFamily: 'var(--font-sans)',
    fontWeight: 600,
  },
  select: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    padding: '4px 8px',
    background: 'var(--color-bg-primary)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    minWidth: 200,
  },
  parserDesc: {
    fontSize: 11,
    fontFamily: 'var(--font-sans)',
    color: 'var(--color-text-muted)',
    marginLeft: 4,
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: 0.5,
    padding: '5px 12px',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text-primary)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  buttonAccent: {
    background: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
    color: '#fff',
  },
  buttonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  saveMsg: {
    fontSize: 11,
    marginLeft: 4,
    fontFamily: 'var(--font-mono)',
  },
  panelLayout: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  leftPanel: {
    width: '30%',
    borderRight: '1px solid var(--color-border)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  centerPanel: {
    width: '15%',
    borderRight: '1px solid var(--color-border)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  rightPanel: {
    width: '55%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
}
