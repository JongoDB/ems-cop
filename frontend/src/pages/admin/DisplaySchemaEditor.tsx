import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../../lib/api'

interface DisplaySchemaField {
  key: string
  label: string
  type: 'text' | 'select' | 'integer' | 'table' | 'markdown'
  options?: string[]
}

interface DisplaySchemaSection {
  key: string
  label: string
  fields: DisplaySchemaField[]
}

interface DisplaySchemaDefinition {
  sections: DisplaySchemaSection[]
}

interface DisplaySchema {
  id: string
  name: string
  schema_type: string
  definition: DisplaySchemaDefinition
  created_at: string
  updated_at: string
}

const EMPTY_TEMPLATE: DisplaySchemaDefinition = {
  sections: [
    {
      key: 'general',
      label: 'General',
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
      ],
    },
  ],
}

const MOCK_VALUES: Record<string, string> = {
  text: 'example',
  select: '',
  integer: '80',
  table: '3 items',
  markdown: 'notes text',
}

function getMockValue(field: DisplaySchemaField): string {
  if (field.type === 'select' && field.options?.length) {
    return field.options[0]
  }
  return MOCK_VALUES[field.type] ?? 'unknown'
}

export default function DisplaySchemaEditor() {
  const [schemas, setSchemas] = useState<DisplaySchema[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [editorText, setEditorText] = useState<string>('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  // Fetch all schemas on mount
  useEffect(() => {
    fetchSchemas()
  }, [])

  async function fetchSchemas() {
    try {
      const res = await apiFetch<DisplaySchema[] | { data: DisplaySchema[] }>('/display-schemas')
      const list = Array.isArray(res) ? res : (res.data ?? [])
      setSchemas(list)
      if (list.length > 0 && !selectedId) {
        selectSchema(list[0])
      }
    } catch (err) {
      console.error('Failed to fetch display schemas:', err)
    }
  }

  function selectSchema(schema: DisplaySchema) {
    setSelectedId(schema.id)
    setEditorText(JSON.stringify(schema.definition, null, 2))
    setParseError(null)
    setSaveMessage(null)
  }

  // Debounced JSON parse for live preview
  const [debouncedText, setDebouncedText] = useState(editorText)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(editorText), 300)
    return () => clearTimeout(timer)
  }, [editorText])

  const parsedDefinition = useMemo<DisplaySchemaDefinition | null>(() => {
    if (!debouncedText.trim()) return null
    try {
      const parsed = JSON.parse(debouncedText)
      setParseError(null)
      return parsed as DisplaySchemaDefinition
    } catch (e) {
      setParseError((e as Error).message)
      return null
    }
  }, [debouncedText])

  const isValid = parsedDefinition !== null && parseError === null

  const handleEditorChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditorText(e.target.value)
    setSaveMessage(null)
  }, [])

  const handleSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const schema = schemas.find(s => s.id === e.target.value)
    if (schema) selectSchema(schema)
  }, [schemas])

  async function handleSave() {
    if (!selectedId || !isValid) return
    setSaving(true)
    setSaveMessage(null)
    try {
      const definition = JSON.parse(editorText)
      await apiFetch(`/display-schemas/${selectedId}`, {
        method: 'PATCH',
        body: JSON.stringify({ definition }),
      })
      setSaveMessage('Saved successfully')
      // Refresh the schema list
      const res = await apiFetch<{ data: DisplaySchema[] }>('/display-schemas')
      setSchemas(res.data ?? [])
    } catch (err) {
      setSaveMessage(`Save failed: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  async function handleCloneDefault() {
    const schema = schemas.find(s => s.id === selectedId)
    if (!schema) return
    try {
      const created = await apiFetch<DisplaySchema>('/display-schemas', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Copy of ' + schema.name,
          schema_type: schema.schema_type,
          definition: schema.definition,
        }),
      })
      await fetchSchemas()
      if (created?.id) {
        setSelectedId(created.id)
        setEditorText(JSON.stringify(created.definition, null, 2))
      }
    } catch (err) {
      setSaveMessage(`Clone failed: ${(err as Error).message}`)
    }
  }

  async function handleNewSchema() {
    try {
      const created = await apiFetch<DisplaySchema>('/display-schemas', {
        method: 'POST',
        body: JSON.stringify({
          name: 'New Schema',
          schema_type: 'endpoint',
          definition: EMPTY_TEMPLATE,
        }),
      })
      await fetchSchemas()
      if (created?.id) {
        setSelectedId(created.id)
        setEditorText(JSON.stringify(created.definition, null, 2))
      }
    } catch (err) {
      setSaveMessage(`Create failed: ${(err as Error).message}`)
    }
  }

  return (
    <div style={styles.container}>
      {/* Top Bar */}
      <div style={styles.topBar}>
        <div style={styles.topBarLeft}>
          <label style={styles.label}>Schema</label>
          <select
            value={selectedId}
            onChange={handleSelectChange}
            style={styles.select}
          >
            {schemas.length === 0 && <option value="">No schemas</option>}
            {schemas.map(s => (
              <option key={s.id} value={s.id}>{s.name} ({s.schema_type})</option>
            ))}
          </select>
        </div>
        <div style={styles.topBarRight}>
          <button
            onClick={handleSave}
            disabled={!isValid || saving || !selectedId}
            style={{
              ...styles.button,
              ...(isValid && selectedId ? styles.buttonAccent : styles.buttonDisabled),
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleCloneDefault}
            disabled={!selectedId}
            style={{
              ...styles.button,
              ...(!selectedId ? styles.buttonDisabled : {}),
            }}
          >
            Clone Default
          </button>
          <button onClick={handleNewSchema} style={styles.button}>
            New Schema
          </button>
          {saveMessage && (
            <span style={{
              ...styles.saveMessage,
              color: saveMessage.startsWith('Save failed') ? 'var(--color-danger)' : 'var(--color-success, #4ade80)',
            }}>
              {saveMessage}
            </span>
          )}
        </div>
      </div>

      {/* Split Pane */}
      <div style={styles.splitPane}>
        {/* Left: JSON Editor */}
        <div style={styles.leftPane}>
          <textarea
            value={editorText}
            onChange={handleEditorChange}
            spellCheck={false}
            style={{
              ...styles.textarea,
              borderColor: parseError ? 'var(--color-danger, #ef4444)' : 'var(--color-border)',
            }}
          />
          {parseError && (
            <div style={styles.errorBar}>
              JSON Error: {parseError}
            </div>
          )}
        </div>

        {/* Right: Live Preview */}
        <div style={styles.rightPane}>
          <div style={styles.previewHeader}>Live Preview</div>
          {parsedDefinition?.sections ? (
            parsedDefinition.sections.map((section, si) => (
              <div key={section.key ?? si} style={styles.previewSection}>
                <div style={styles.sectionLabel}>{section.label}</div>
                {section.fields?.map((field, fi) => (
                  <div key={field.key ?? fi} style={styles.fieldRow}>
                    <span style={styles.fieldLabel}>{field.label}</span>
                    <span style={styles.fieldValue}>{getMockValue(field)}</span>
                  </div>
                ))}
              </div>
            ))
          ) : (
            <div style={styles.previewEmpty}>
              {editorText.trim() ? 'Invalid JSON - cannot preview' : 'Select a schema to preview'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--color-text)',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-surface)',
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
    textTransform: 'uppercase' as const,
  },
  select: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    padding: '4px 8px',
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    minWidth: 200,
  },
  button: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: 0.5,
    padding: '5px 12px',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    background: 'var(--color-bg-elevated)',
    color: 'var(--color-text)',
    cursor: 'pointer',
  },
  buttonAccent: {
    background: 'var(--color-accent, #3b82f6)',
    borderColor: 'var(--color-accent, #3b82f6)',
    color: '#fff',
  },
  buttonDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  saveMessage: {
    fontSize: 11,
    marginLeft: 4,
  },
  splitPane: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  leftPane: {
    width: '50%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-bg-surface)',
    borderRight: '1px solid var(--color-border)',
    position: 'relative' as const,
  },
  textarea: {
    flex: 1,
    width: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    lineHeight: 1.5,
    padding: 12,
    background: 'var(--color-bg-surface)',
    color: 'var(--color-text)',
    border: '1px solid var(--color-border)',
    borderRadius: 0,
    resize: 'none' as const,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  errorBar: {
    padding: '6px 12px',
    fontSize: 11,
    color: 'var(--color-danger, #ef4444)',
    background: 'rgba(239, 68, 68, 0.1)',
    borderTop: '1px solid var(--color-danger, #ef4444)',
    flexShrink: 0,
  },
  rightPane: {
    width: '50%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-bg-elevated)',
    overflow: 'auto',
    padding: 16,
  },
  previewHeader: {
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    color: 'var(--color-text-muted)',
    marginBottom: 16,
    paddingBottom: 8,
    borderBottom: '1px solid var(--color-border)',
  },
  previewSection: {
    marginBottom: 20,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: 0.5,
    color: 'var(--color-text)',
    marginBottom: 8,
    textTransform: 'uppercase' as const,
  },
  fieldRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '4px 0',
    borderBottom: '1px solid var(--color-border)',
  },
  fieldLabel: {
    color: 'var(--color-text-muted)',
    fontSize: 11,
  },
  fieldValue: {
    color: 'var(--color-text)',
    fontSize: 11,
  },
  previewEmpty: {
    color: 'var(--color-text-muted)',
    fontSize: 11,
    fontStyle: 'italic',
    textAlign: 'center' as const,
    marginTop: 40,
  },
}
