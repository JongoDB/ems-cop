import { useState, useRef } from 'react'
import {
  ArrowLeft,
  Plus,
  Trash2,
  ExternalLink,
  Check,
  X,
  Shield,
} from 'lucide-react'
import type { NetworkNodeRecord, ServiceEntry, VulnEntry, ExploitEntry } from './types'

interface VulnDrillDownProps {
  vuln: VulnEntry
  node: NetworkNodeRecord
  onBack: () => void
  onSave: (updated: VulnEntry) => Promise<void>
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ff4444',
  high: '#ff8800',
  medium: '#ffcc00',
  low: '#4488ff',
  info: '#888888',
}

const STATUS_OPTIONS: VulnEntry['status'][] = [
  'unverified',
  'confirmed',
  'exploited',
  'mitigated',
  'accepted_risk',
]

const EXPLOIT_TYPES: ExploitEntry['type'][] = ['metasploit', 'exploitdb', 'poc_url', 'custom']

const EXPLOIT_TYPE_COLORS: Record<string, string> = {
  metasploit: '#4488ff',
  exploitdb: '#ff8800',
  poc_url: '#ffcc00',
  custom: '#888888',
}

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: 1,
  color: 'var(--color-text-muted)',
  display: 'block',
  marginBottom: 4,
}

const addButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)',
  padding: '6px 12px',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: 0.5,
  color: 'var(--color-text-muted)',
}

const deleteButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--color-text-muted)',
  padding: 2,
  borderRadius: 'var(--radius)',
  transition: 'color 0.15s ease',
}

const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  background: 'var(--color-bg-surface)',
  color: 'var(--color-text-bright)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius)',
  padding: '6px 8px',
  width: '100%',
  boxSizing: 'border-box' as const,
  outline: 'none',
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  paddingBottom: 14,
  borderBottom: '1px solid var(--color-border)',
}

export default function VulnDrillDown({ vuln, node, onBack, onSave }: VulnDrillDownProps) {
  const [draft, setDraft] = useState<VulnEntry>({ ...vuln, exploits: [...(vuln.exploits || [])] })
  const [showExploitForm, setShowExploitForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const notesRef = useRef<HTMLTextAreaElement>(null)

  const sevColor = SEVERITY_COLORS[draft.severity] || '#888'
  const services: ServiceEntry[] = Array.isArray(node.services) ? node.services : []

  const save = async (updated: VulnEntry) => {
    setSaving(true)
    try {
      await onSave(updated)
      setDraft(updated)
    } finally {
      setSaving(false)
    }
  }

  const handleStatusChange = (newStatus: VulnEntry['status']) => {
    const updated = { ...draft, status: newStatus }
    save(updated)
  }

  const handleDescriptionBlur = () => {
    const val = descRef.current?.value ?? ''
    if (val !== (draft.description || '')) {
      const updated = { ...draft, description: val }
      save(updated)
    }
  }

  const handleNotesBlur = () => {
    const val = notesRef.current?.value ?? ''
    if (val !== (draft.attack_notes || '')) {
      const updated = { ...draft, attack_notes: val }
      save(updated)
    }
  }

  const handleAddExploit = (exploit: ExploitEntry) => {
    const exploits = [...(draft.exploits || []), exploit]
    const updated = { ...draft, exploits }
    save(updated)
    setShowExploitForm(false)
  }

  const handleDeleteExploit = (index: number) => {
    const exploits = (draft.exploits || []).filter((_, i) => i !== index)
    const updated = { ...draft, exploits }
    save(updated)
  }

  const handleToggleVerified = (index: number) => {
    const exploits = [...(draft.exploits || [])]
    exploits[index] = { ...exploits[index], verified: !exploits[index].verified }
    const updated = { ...draft, exploits }
    save(updated)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
      {/* Back button */}
      <button
        onClick={onBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: 0.5,
          color: 'var(--color-accent)',
          padding: 0,
        }}
      >
        <ArrowLeft size={12} />
        VULNERABILITIES
      </button>

      {/* CVE Summary */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shield size={14} style={{ color: sevColor, flexShrink: 0 }} />
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--color-text-bright)',
          }}>
            {draft.cve_id}
          </span>
        </div>

        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--color-text)',
        }}>
          {draft.title}
        </span>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Severity badge */}
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.5,
            color: sevColor,
            background: `${sevColor}1a`,
            border: `1px solid ${sevColor}40`,
            borderRadius: 'var(--radius)',
            padding: '2px 8px',
            textTransform: 'uppercase',
          }}>
            {draft.severity}
          </span>

          {/* CVSS */}
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--color-text-muted)',
          }}>
            CVSS {draft.cvss.toFixed(1)}
          </span>

          {/* Exploit indicator */}
          {draft.exploit_available && (
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: '#ff4444',
              background: 'rgba(255, 68, 68, 0.1)',
              border: '1px solid rgba(255, 68, 68, 0.3)',
              borderRadius: 'var(--radius)',
              padding: '2px 6px',
              letterSpacing: 0.5,
            }}>
              EXPLOIT AVAILABLE
            </span>
          )}
        </div>

        {/* Description */}
        <div>
          <span style={labelStyle}>DESCRIPTION</span>
          <textarea
            ref={descRef}
            defaultValue={draft.description || ''}
            onBlur={handleDescriptionBlur}
            placeholder="Add vulnerability description..."
            rows={3}
            style={{
              ...inputStyle,
              resize: 'vertical',
              minHeight: 60,
            }}
          />
        </div>
      </div>

      {/* Affected Services */}
      <div style={sectionStyle}>
        <span style={labelStyle}>AFFECTED SERVICES</span>
        {services.length === 0 ? (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--color-text-muted)',
            fontStyle: 'italic',
          }}>
            No services on this node
          </span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {services.map((svc, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius)',
                padding: '5px 8px',
              }}>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--color-accent)',
                  minWidth: 44,
                }}>
                  {svc.port}/{svc.protocol}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-text)',
                }}>
                  {svc.service || svc.product || '-'}
                </span>
                {svc.version && (
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--color-text-muted)',
                  }}>
                    {svc.version}
                  </span>
                )}
              </div>
            ))}
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--color-text-muted)',
              fontStyle: 'italic',
              marginTop: 2,
            }}>
              Verify manually which services are affected
            </span>
          </div>
        )}
      </div>

      {/* Known Exploits */}
      <div style={sectionStyle}>
        <span style={labelStyle}>KNOWN EXPLOITS ({(draft.exploits || []).length})</span>

        {(draft.exploits || []).map((exp, i) => (
          <div key={i} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            padding: '8px 10px',
          }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {/* Type badge */}
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  color: EXPLOIT_TYPE_COLORS[exp.type] || '#888',
                  background: `${EXPLOIT_TYPE_COLORS[exp.type] || '#888'}1a`,
                  border: `1px solid ${EXPLOIT_TYPE_COLORS[exp.type] || '#888'}40`,
                  borderRadius: 10,
                  padding: '1px 7px',
                  textTransform: 'uppercase',
                }}>
                  {exp.type.replace(/_/g, ' ')}
                </span>
                {/* Verified indicator */}
                <button
                  onClick={() => handleToggleVerified(i)}
                  title={exp.verified ? 'Verified' : 'Unverified'}
                  style={{
                    ...deleteButtonStyle,
                    color: exp.verified ? 'var(--color-success)' : 'var(--color-text-muted)',
                  }}
                >
                  {exp.verified ? <Check size={12} /> : <X size={12} />}
                </button>
              </div>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--color-text-bright)',
              }}>
                {exp.reference}
              </span>
              {exp.url && (
                <a
                  href={exp.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--color-accent)',
                    textDecoration: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {exp.url}
                  <ExternalLink size={10} />
                </a>
              )}
              {exp.notes && (
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  color: 'var(--color-text-muted)',
                  fontStyle: 'italic',
                }}>
                  {exp.notes}
                </span>
              )}
            </div>
            <button
              onClick={() => handleDeleteExploit(i)}
              style={deleteButtonStyle}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
              title="Remove exploit"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}

        {showExploitForm ? (
          <ExploitAddForm
            onAdd={handleAddExploit}
            onCancel={() => setShowExploitForm(false)}
          />
        ) : (
          <button
            onClick={() => setShowExploitForm(true)}
            style={{ ...addButtonStyle, alignSelf: 'flex-start' }}
            disabled={saving}
          >
            <Plus size={12} />
            ADD EXPLOIT
          </button>
        )}
      </div>

      {/* Attack Notes */}
      <div style={sectionStyle}>
        <span style={labelStyle}>ATTACK NOTES</span>
        <textarea
          ref={notesRef}
          defaultValue={draft.attack_notes || ''}
          onBlur={handleNotesBlur}
          placeholder="Operator notes, attack path details, payloads used..."
          rows={4}
          style={{
            ...inputStyle,
            resize: 'vertical',
            minHeight: 80,
          }}
        />
      </div>

      {/* Status */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={labelStyle}>STATUS</span>
        <select
          value={draft.status}
          onChange={(e) => handleStatusChange(e.target.value as VulnEntry['status'])}
          disabled={saving}
          style={{
            ...inputStyle,
            appearance: 'auto' as const,
            width: 'auto',
          }}
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt.replace(/_/g, ' ').toUpperCase()}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Exploit Add Form                                                   */
/* ------------------------------------------------------------------ */

function ExploitAddForm({
  onAdd,
  onCancel,
}: {
  onAdd: (exploit: ExploitEntry) => void
  onCancel: () => void
}) {
  const [type, setType] = useState<ExploitEntry['type']>('metasploit')
  const [reference, setReference] = useState('')
  const [url, setUrl] = useState('')
  const [verified, setVerified] = useState(false)
  const [notes, setNotes] = useState('')

  const handleSubmit = () => {
    if (!reference.trim()) return
    onAdd({
      type,
      reference: reference.trim(),
      url: url.trim() || undefined,
      verified,
      notes: notes.trim() || undefined,
    })
  }

  const formInputStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    background: 'var(--color-bg-surface)',
    color: 'var(--color-text-bright)',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '5px 8px',
    width: '100%',
    boxSizing: 'border-box' as const,
    outline: 'none',
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius)',
      padding: 10,
    }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <span style={labelStyle}>TYPE</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ExploitEntry['type'])}
            style={{ ...formInputStyle, appearance: 'auto' as const }}
          >
            {EXPLOIT_TYPES.map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, ' ').toUpperCase()}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 2 }}>
          <span style={labelStyle}>REFERENCE</span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="exploit/module/name"
            style={formInputStyle}
          />
        </div>
      </div>

      <div>
        <span style={labelStyle}>URL</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://..."
          style={formInputStyle}
        />
      </div>

      <div>
        <span style={labelStyle}>NOTES</span>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Additional notes..."
          style={formInputStyle}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
            style={{ margin: 0 }}
          />
          VERIFIED
        </label>
      </div>

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          style={{
            ...addButtonStyle,
            fontSize: 9,
            padding: '4px 10px',
          }}
        >
          CANCEL
        </button>
        <button
          onClick={handleSubmit}
          disabled={!reference.trim()}
          style={{
            ...addButtonStyle,
            fontSize: 9,
            padding: '4px 10px',
            color: reference.trim() ? 'var(--color-accent)' : 'var(--color-text-muted)',
            borderColor: reference.trim() ? 'var(--color-accent)' : 'var(--color-border)',
            opacity: reference.trim() ? 1 : 0.5,
          }}
        >
          <Plus size={10} />
          ADD
        </button>
      </div>
    </div>
  )
}
