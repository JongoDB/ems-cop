import { useState, useCallback, useRef, useMemo } from 'react'
import { ChevronRight, ChevronDown, GripVertical, Upload, Search, FileJson, FileText, FileSpreadsheet } from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

interface TreeNode {
  key: string
  path: string
  type: 'object' | 'array' | 'value'
  value?: any
  children?: TreeNode[]
  arrayLength?: number
}

export interface SourceInspectorProps {
  onFieldDragStart: (path: string, sampleValue: any) => void
  mappedFields?: Map<string, string>  // sourcePath → targetName
}

// ── Parsers ────────────────────────────────────────────────────────────────

function detectFormat(filename: string, content: string): 'xml' | 'json' | 'csv' | 'tsv' | null {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'xml') return 'xml'
  if (ext === 'json') return 'json'
  if (ext === 'tsv') return 'tsv'
  if (ext === 'csv') return 'csv'
  // Fallback: sniff content
  const trimmed = content.trim()
  if (trimmed.startsWith('<')) return 'xml'
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  // Check for tabs vs commas in first line
  const firstLine = trimmed.split('\n')[0] ?? ''
  if (firstLine.includes('\t')) return 'tsv'
  if (firstLine.includes(',')) return 'csv'
  return null
}

function parseXmlToTree(content: string): TreeNode[] {
  const parser = new DOMParser()
  const doc = parser.parseFromString(content, 'text/xml')
  const errorNode = doc.querySelector('parsererror')
  if (errorNode) throw new Error('Invalid XML: ' + errorNode.textContent?.slice(0, 100))

  function walkElement(el: Element, parentPath: string): TreeNode {
    const path = parentPath ? `${parentPath}.${el.tagName}` : el.tagName
    const children: TreeNode[] = []

    // Attributes
    for (const attr of Array.from(el.attributes)) {
      children.push({
        key: `@${attr.name}`,
        path: `${path}.@${attr.name}`,
        type: 'value',
        value: attr.value,
      })
    }

    // Child elements
    const childElements = Array.from(el.children)
    if (childElements.length > 0) {
      // Group repeated tag names as arrays
      const grouped = new Map<string, Element[]>()
      for (const child of childElements) {
        const existing = grouped.get(child.tagName) ?? []
        existing.push(child)
        grouped.set(child.tagName, existing)
      }
      for (const [, elems] of grouped) {
        if (elems.length > 1) {
          const arrayPath = `${path}.${elems[0].tagName}`
          children.push({
            key: elems[0].tagName,
            path: arrayPath,
            type: 'array',
            arrayLength: elems.length,
            children: [walkElement(elems[0], `${arrayPath}[0]`)],
          })
        } else {
          children.push(walkElement(elems[0], path))
        }
      }
    } else {
      // Text content leaf
      const text = el.textContent?.trim()
      if (text && children.length === 0) {
        return { key: el.tagName, path, type: 'value', value: text }
      }
      if (text && children.length > 0) {
        children.push({ key: '#text', path: `${path}.#text`, type: 'value', value: text })
      }
    }

    if (children.length === 0) {
      return { key: el.tagName, path, type: 'value', value: '' }
    }

    return { key: el.tagName, path, type: 'object', children }
  }

  return [walkElement(doc.documentElement, '')]
}

function buildJsonTree(data: any, parentPath: string, parentKey: string): TreeNode {
  if (Array.isArray(data)) {
    const path = parentPath
    const children: TreeNode[] = []
    if (data.length > 0) {
      children.push(buildJsonTree(data[0], `${path}[0]`, '[0]'))
    }
    return { key: parentKey, path, type: 'array', arrayLength: data.length, children }
  }
  if (data !== null && typeof data === 'object') {
    const path = parentPath
    const children = Object.entries(data).map(([k, v]) => {
      const childPath = path ? `${path}.${k}` : k
      return buildJsonTree(v, childPath, k)
    })
    return { key: parentKey, path, type: 'object', children }
  }
  return { key: parentKey, path: parentPath, type: 'value', value: data }
}

function parseJsonToTree(content: string): TreeNode[] {
  const data = JSON.parse(content)
  if (Array.isArray(data)) {
    return [buildJsonTree(data, '', 'root')]
  }
  if (typeof data === 'object' && data !== null) {
    return Object.entries(data).map(([k, v]) => buildJsonTree(v, k, k))
  }
  return [{ key: 'root', path: 'root', type: 'value', value: data }]
}

function parseCsvToTree(content: string, separator: string): TreeNode[] {
  const lines = content.trim().split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return []

  const headers = lines[0].split(separator).map(h => h.trim().replace(/^"|"$/g, ''))
  const rows = lines.slice(1)

  return [{
    key: 'rows',
    path: 'rows',
    type: 'array',
    arrayLength: rows.length,
    children: [{
      key: '[0]',
      path: 'rows[0]',
      type: 'object',
      children: headers.map(h => {
        const firstRow = rows[0]?.split(separator) ?? []
        const idx = headers.indexOf(h)
        const val = firstRow[idx]?.trim().replace(/^"|"$/g, '') ?? ''
        return {
          key: h,
          path: `rows[].${h}`,
          type: 'value' as const,
          value: val,
        }
      }),
    }],
  }]
}

// ── Tree Node Component ────────────────────────────────────────────────────

interface TreeNodeRowProps {
  node: TreeNode
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  onDragStart: (path: string, sampleValue: any) => void
  mappedFields?: Map<string, string>
  filter: string
}

function matchesFilter(node: TreeNode, filter: string): boolean {
  if (!filter) return true
  const lower = filter.toLowerCase()
  if (node.path.toLowerCase().includes(lower)) return true
  if (node.key.toLowerCase().includes(lower)) return true
  if (node.children) return node.children.some(c => matchesFilter(c, filter))
  return false
}

function TreeNodeRow({ node, depth, expanded, onToggle, onDragStart, mappedFields, filter }: TreeNodeRowProps) {
  if (filter && !matchesFilter(node, filter)) return null

  const isExpanded = expanded.has(node.path)
  const isLeaf = node.type === 'value'
  const isMapped = mappedFields?.has(node.path)
  const mappedTarget = mappedFields?.get(node.path)

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', node.path)
    e.dataTransfer.setData('application/x-source-path', node.path)
    e.dataTransfer.effectAllowed = 'copy'
    onDragStart(node.path, node.value)
  }

  const truncateValue = (val: any): string => {
    if (val === null || val === undefined) return 'null'
    const str = String(val)
    return str.length > 40 ? str.slice(0, 37) + '...' : str
  }

  return (
    <>
      <div
        style={{
          ...styles.treeRow,
          paddingLeft: 8 + depth * 16,
        }}
        onClick={() => !isLeaf && onToggle(node.path)}
      >
        {/* Expand/collapse or spacer */}
        <span style={styles.chevron}>
          {!isLeaf ? (
            isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : (
            <span style={{ width: 14, display: 'inline-block' }} />
          )}
        </span>

        {/* Mapped indicator */}
        {isMapped && <span style={styles.mappedDot} />}

        {/* Key name */}
        <span style={{
          ...styles.nodeKey,
          fontWeight: isLeaf ? 400 : 600,
          color: isLeaf ? 'var(--color-text-secondary)' : 'var(--color-text-primary)',
        }}>
          {node.key}
        </span>

        {/* Array count */}
        {node.type === 'array' && (
          <span style={styles.arrayBadge}>[{node.arrayLength} items]</span>
        )}

        {/* Leaf value */}
        {isLeaf && node.value !== undefined && (
          <span style={styles.leafValue}>{truncateValue(node.value)}</span>
        )}

        {/* Mapped target badge */}
        {isMapped && mappedTarget && (
          <span style={styles.mappedBadge}>{mappedTarget}</span>
        )}

        {/* Drag handle for leaves */}
        {isLeaf && (
          <span
            draggable
            onDragStart={handleDragStart}
            style={styles.dragHandle}
            title={`Drag "${node.path}" to map`}
          >
            <GripVertical size={12} />
          </span>
        )}
      </div>

      {/* Expanded children */}
      {!isLeaf && isExpanded && node.children?.map(child => (
        <TreeNodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onDragStart={onDragStart}
          mappedFields={mappedFields}
          filter={filter}
        />
      ))}
    </>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function SourceInspector({ onFieldDragStart, mappedFields }: SourceInspectorProps) {
  const [tree, setTree] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [format, setFormat] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback((file: File) => {
    setError(null)
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (e) => {
      const content = e.target?.result as string
      try {
        const detected = detectFormat(file.name, content)
        if (!detected) {
          setError('Could not detect file format. Supported: .xml, .json, .csv, .tsv')
          return
        }
        setFormat(detected)

        let nodes: TreeNode[] = []
        switch (detected) {
          case 'xml':
            nodes = parseXmlToTree(content)
            break
          case 'json':
            nodes = parseJsonToTree(content)
            break
          case 'csv':
            nodes = parseCsvToTree(content, ',')
            break
          case 'tsv':
            nodes = parseCsvToTree(content, '\t')
            break
        }
        setTree(nodes)

        // Auto-expand first two levels
        const autoExpand = new Set<string>()
        for (const node of nodes) {
          autoExpand.add(node.path)
          if (node.children) {
            for (const child of node.children) {
              autoExpand.add(child.path)
            }
          }
        }
        setExpanded(autoExpand)
      } catch (err) {
        setError(`Parse error: ${(err as Error).message}`)
        setTree([])
      }
    }
    reader.readAsText(file)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false)
  }, [])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }, [handleFile])

  const toggleNode = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    const all = new Set<string>()
    function walk(nodes: TreeNode[]) {
      for (const n of nodes) {
        if (n.type !== 'value') {
          all.add(n.path)
          if (n.children) walk(n.children)
        }
      }
    }
    walk(tree)
    setExpanded(all)
  }, [tree])

  const collapseAll = useCallback(() => {
    setExpanded(new Set())
  }, [])

  const formatIcon = useMemo(() => {
    switch (format) {
      case 'json': return <FileJson size={14} style={{ color: 'var(--color-accent)' }} />
      case 'xml': return <FileText size={14} style={{ color: 'var(--color-accent)' }} />
      case 'csv':
      case 'tsv': return <FileSpreadsheet size={14} style={{ color: 'var(--color-accent)' }} />
      default: return null
    }
  }, [format])

  return (
    <div style={styles.container}>
      {/* Panel header */}
      <div style={styles.panelHeader}>
        <span style={styles.panelLabel}>SOURCE INSPECTOR</span>
        {fileName && (
          <span style={styles.fileInfo}>
            {formatIcon}
            <span style={{ marginLeft: 4 }}>{fileName}</span>
          </span>
        )}
      </div>

      {/* Upload zone */}
      <div
        style={{
          ...styles.uploadZone,
          borderColor: isDragOver ? 'var(--color-accent)' : 'var(--color-border)',
          background: isDragOver ? 'rgba(59, 130, 246, 0.08)' : 'var(--color-bg-primary)',
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
      >
        <Upload size={18} style={{ color: 'var(--color-text-muted)', marginBottom: 4 }} />
        <span style={styles.uploadText}>
          {fileName ? 'Drop or click to replace file' : 'Drop sample file or click to browse'}
        </span>
        <span style={styles.uploadHint}>.xml, .json, .csv, .tsv</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xml,.json,.csv,.tsv"
          style={{ display: 'none' }}
          onChange={handleFileInput}
        />
      </div>

      {/* Error display */}
      {error && (
        <div style={styles.errorBar}>{error}</div>
      )}

      {/* Search + controls */}
      {tree.length > 0 && (
        <div style={styles.searchBar}>
          <Search size={13} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          <input
            type="text"
            placeholder="Filter fields..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={styles.searchInput}
          />
          <button onClick={expandAll} style={styles.treeControl} title="Expand all">+</button>
          <button onClick={collapseAll} style={styles.treeControl} title="Collapse all">&minus;</button>
        </div>
      )}

      {/* Tree view */}
      <div style={styles.treeContainer}>
        {tree.length === 0 && !error && (
          <div style={styles.emptyState}>
            <span style={styles.emptyText}>Upload a sample data file to inspect its structure</span>
          </div>
        )}
        {tree.map(node => (
          <TreeNodeRow
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={toggleNode}
            onDragStart={onFieldDragStart}
            mappedFields={mappedFields}
            filter={filter}
          />
        ))}
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
  fileInfo: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-secondary)',
  },
  uploadZone: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px 12px',
    margin: 8,
    border: '1px dashed var(--color-border)',
    borderRadius: 4,
    cursor: 'pointer',
    transition: 'border-color 0.15s, background 0.15s',
    flexShrink: 0,
  },
  uploadText: {
    fontSize: 11,
    fontFamily: 'var(--font-sans)',
    color: 'var(--color-text-secondary)',
  },
  uploadHint: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    marginTop: 2,
  },
  errorBar: {
    padding: '6px 12px',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: '#ef4444',
    background: 'rgba(239, 68, 68, 0.1)',
    borderBottom: '1px solid rgba(239, 68, 68, 0.3)',
    flexShrink: 0,
  },
  searchBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 8px',
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-elevated)',
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    padding: '3px 8px',
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-primary)',
    outline: 'none',
  },
  treeControl: {
    width: 22,
    height: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border)',
    borderRadius: 3,
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    lineHeight: 1,
    padding: 0,
  },
  treeContainer: {
    flex: 1,
    overflow: 'auto',
    background: 'var(--color-bg-primary)',
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: 24,
  },
  emptyText: {
    fontSize: 11,
    fontFamily: 'var(--font-sans)',
    color: 'var(--color-text-muted)',
    fontStyle: 'italic',
    textAlign: 'center',
  },
  treeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    cursor: 'default',
    minHeight: 26,
    borderBottom: '1px solid rgba(255,255,255,0.03)',
    userSelect: 'none',
  },
  chevron: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    flexShrink: 0,
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
  },
  nodeKey: {
    fontSize: 12,
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  arrayBadge: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    marginLeft: 4,
    flexShrink: 0,
  },
  leafValue: {
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--color-text-muted)',
    marginLeft: 8,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
  },
  mappedDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#22c55e',
    flexShrink: 0,
  },
  mappedBadge: {
    fontSize: 9,
    fontFamily: 'var(--font-mono)',
    color: '#22c55e',
    background: 'rgba(34, 197, 94, 0.12)',
    border: '1px solid rgba(34, 197, 94, 0.25)',
    borderRadius: 3,
    padding: '1px 5px',
    marginLeft: 4,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  dragHandle: {
    display: 'flex',
    alignItems: 'center',
    marginLeft: 'auto',
    padding: '2px 4px',
    cursor: 'grab',
    color: 'var(--color-text-muted)',
    opacity: 0.5,
    flexShrink: 0,
  },
}
