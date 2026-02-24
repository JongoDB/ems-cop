import { useState, useRef, useCallback } from 'react'
import {
  X,
  Info,
  Network,
  ShieldAlert,
  Cable,
  StickyNote,
  Server,
  Wifi,
  Shield,
  Monitor,
  Activity,
  Plus,
  Trash2,
  Check,
  Eye,
  Pencil,
} from 'lucide-react'
import type { NetworkNodeRecord, ServiceEntry, VulnEntry, InterfaceEntry } from './types'
import { InlineText, InlineSelect } from './InlineEditor'
import { DEVICE_TYPES } from './DeviceIcons'
import { apiFetch } from '../../lib/api'
import VulnDrillDown from './VulnDrillDown'

interface NodeDetailPanelProps {
  node: NetworkNodeRecord
  onClose: () => void
  onNodeUpdate: (updated: NetworkNodeRecord) => void
}

type TabId = 'overview' | 'services' | 'vulns' | 'interfaces' | 'notes'

interface TabDef {
  id: TabId
  label: string
  icon: typeof Info
}

const tabs: TabDef[] = [
  { id: 'overview', label: 'OVERVIEW', icon: Info },
  { id: 'services', label: 'SERVICES', icon: Network },
  { id: 'vulns', label: 'VULNS', icon: ShieldAlert },
  { id: 'interfaces', label: 'INTERFACES', icon: Cable },
  { id: 'notes', label: 'NOTES', icon: StickyNote },
]

const STATUS_OPTIONS = ['discovered', 'alive', 'compromised', 'offline']

function getNodeTypeIcon(nodeType: string) {
  switch (nodeType) {
    case 'server': return Server
    case 'router': return Wifi
    case 'firewall': return Shield
    case 'workstation': return Monitor
    case 'switch': return Network
    case 'access_point': return Wifi
    case 'vpn': return Shield
    case 'printer': return Server
    case 'iot': return Activity
    case 'host': return Monitor
    case 'unknown': return Network
    default: return Network
  }
}

function getStatusColor(status: string) {
  switch (status) {
    case 'alive': return 'var(--color-success)'
    case 'compromised': return 'var(--color-danger)'
    case 'offline': return 'var(--color-border)'
    default: return 'var(--color-text-muted)'
  }
}

const detailLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: 1,
  color: 'var(--color-text-muted)',
  display: 'block',
  marginBottom: 4,
}

const detailValueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--color-text)',
  display: 'block',
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

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ff4444',
  high: '#ff8800',
  medium: '#ffcc00',
  low: '#4488ff',
  info: '#888888',
}

export default function NodeDetailPanel({ node, onClose, onNodeUpdate }: NodeDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [vulnDrillDown, setVulnDrillDown] = useState<VulnEntry | null>(null)
  const [showVulnForm, setShowVulnForm] = useState(false)
  const [notesMode, setNotesMode] = useState<'edit' | 'preview'>('edit')
  const [notesValue, setNotesValue] = useState<string | null>(null)
  const notesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const NodeIcon = getNodeTypeIcon(node.node_type)
  const statusColor = getStatusColor(node.status)
  const services: ServiceEntry[] = Array.isArray(node.services) ? node.services : []
  const metadata = (node.metadata as Record<string, unknown>) || {}
  const vulns: VulnEntry[] = Array.isArray(metadata.vulnerabilities) ? (metadata.vulnerabilities as VulnEntry[]) : []
  const interfaces: InterfaceEntry[] = Array.isArray(metadata.interfaces) ? (metadata.interfaces as InterfaceEntry[]) : []
  const notes: string = typeof metadata.notes === 'string' ? (metadata.notes as string) : ''

  const handleFieldSave = async (field: string, value: string) => {
    const updated = await apiFetch<NetworkNodeRecord>(`/nodes/${node.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ [field]: value }),
    })
    onNodeUpdate(updated)
  }

  const handleServicesUpdate = async (newServices: ServiceEntry[]) => {
    const updated = await apiFetch<NetworkNodeRecord>(`/nodes/${node.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ services: newServices }),
    })
    onNodeUpdate(updated)
  }

  const handleAddService = () => {
    const newService: ServiceEntry = {
      port: 0,
      protocol: 'tcp',
      service: '',
      product: '',
      version: '',
    }
    handleServicesUpdate([...services, newService])
  }

  const handleDeleteService = (index: number) => {
    const newServices = services.filter((_, i) => i !== index)
    handleServicesUpdate(newServices)
  }

  const handleVulnsUpdate = async (newVulns: VulnEntry[]) => {
    const updated = await apiFetch<NetworkNodeRecord>(`/nodes/${node.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ metadata: { ...metadata, vulnerabilities: newVulns } }),
    })
    onNodeUpdate(updated)
  }

  const handleAddVuln = (vuln: VulnEntry) => {
    handleVulnsUpdate([...vulns, vuln])
    setShowVulnForm(false)
  }

  const handleVulnClick = (vuln: VulnEntry) => {
    setVulnDrillDown(vuln)
  }

  const handleDeleteVuln = (index: number) => {
    const newVulns = vulns.filter((_, i) => i !== index)
    handleVulnsUpdate(newVulns)
  }

  const handleVulnUpdate = async (updatedVuln: VulnEntry) => {
    const newVulns = vulns.map((v) => v.cve_id === updatedVuln.cve_id ? updatedVuln : v)
    await handleVulnsUpdate(newVulns)
    setVulnDrillDown(updatedVuln)
  }

  const handleInterfacesUpdate = async (newInterfaces: InterfaceEntry[]) => {
    const updated = await apiFetch<NetworkNodeRecord>(`/nodes/${node.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ metadata: { ...metadata, interfaces: newInterfaces } }),
    })
    onNodeUpdate(updated)
  }

  const handleAddInterface = () => {
    const newIface: InterfaceEntry = {
      name: '',
      mac: '',
      ips: [],
      state: 'up',
    }
    handleInterfacesUpdate([...interfaces, newIface])
  }

  const handleDeleteInterface = (index: number) => {
    handleInterfacesUpdate(interfaces.filter((_, i) => i !== index))
  }

  const handleNotesUpdate = useCallback(async (newNotes: string) => {
    const updated = await apiFetch<NetworkNodeRecord>(`/nodes/${node.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ metadata: { ...metadata, notes: newNotes } }),
    })
    onNodeUpdate(updated)
  }, [node.id, metadata, onNodeUpdate])

  const handleNotesChange = useCallback((value: string) => {
    setNotesValue(value)
    if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current)
    notesSaveTimer.current = setTimeout(() => {
      handleNotesUpdate(value)
    }, 1000)
  }, [handleNotesUpdate])

  const handleNotesBlur = useCallback(() => {
    if (notesSaveTimer.current) {
      clearTimeout(notesSaveTimer.current)
      notesSaveTimer.current = null
    }
    const current = notesValue !== null ? notesValue : notes
    if (current !== notes) {
      handleNotesUpdate(current)
    }
  }, [notesValue, notes, handleNotesUpdate])

  return (
    <div style={{
      width: 380,
      flexShrink: 0,
      background: 'var(--color-bg-elevated)',
      borderLeft: '1px solid var(--color-border)',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '14px 16px',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: 1,
          color: 'var(--color-text-muted)',
        }}>
          NODE DETAILS
        </span>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--color-text-muted)',
            padding: 2,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--color-border)',
        padding: '0 8px',
        gap: 0,
        overflowX: 'auto',
        flexShrink: 0,
      }}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id
          const TabIcon = tab.icon
          const badge = (tab.id === 'services' && services.length > 0) ? services.length
            : (tab.id === 'vulns' && vulns.length > 0) ? vulns.length
            : (tab.id === 'interfaces' && interfaces.length > 0) ? interfaces.length
            : null
          const hasDot = tab.id === 'notes' && notes.length > 0
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '9px 10px',
                background: 'transparent',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--color-accent)' : '2px solid transparent',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                letterSpacing: 0.5,
                color: isActive ? 'var(--color-text-bright)' : 'var(--color-text-muted)',
                transition: 'color 0.15s ease, border-color 0.15s ease',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = 'var(--color-text)'
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = 'var(--color-text-muted)'
              }}
            >
              <TabIcon size={12} />
              {tab.label}
              {badge !== null && (
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  background: 'var(--color-accent)',
                  color: '#000',
                  borderRadius: 8,
                  padding: '1px 5px',
                  fontWeight: 700,
                  lineHeight: '14px',
                }}>
                  {badge}
                </span>
              )}
              {hasDot && (
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--color-accent)',
                  flexShrink: 0,
                }} />
              )}
            </button>
          )
        })}
      </div>

      {/* Tab content */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
      }}>
        {activeTab === 'overview' && renderOverviewTab(node, NodeIcon, statusColor, services, handleFieldSave)}
        {activeTab === 'services' && renderServicesTab(services, handleAddService, handleDeleteService)}
        {activeTab === 'vulns' && !vulnDrillDown && renderVulnsTab(vulns, showVulnForm, setShowVulnForm, handleAddVuln, handleVulnClick, handleDeleteVuln)}
        {activeTab === 'vulns' && vulnDrillDown && (
          <VulnDrillDown
            vuln={vulnDrillDown}
            node={node}
            onBack={() => setVulnDrillDown(null)}
            onSave={handleVulnUpdate}
          />
        )}
        {activeTab === 'interfaces' && renderInterfacesTab(interfaces, handleAddInterface, handleDeleteInterface)}
        {activeTab === 'notes' && renderNotesTab(
          notesValue !== null ? notesValue : notes,
          notesMode,
          setNotesMode,
          handleNotesChange,
          handleNotesBlur,
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Overview Tab                                                      */
/* ------------------------------------------------------------------ */

function renderOverviewTab(
  node: NetworkNodeRecord,
  NodeIcon: typeof Server,
  statusColor: string,
  services: ServiceEntry[],
  onFieldSave: (field: string, value: string) => Promise<void>,
) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
      {/* Hostname + IP */}
      <div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
        }}>
          <NodeIcon size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
          <InlineText
            value={node.hostname || node.ip_address}
            onSave={(v) => onFieldSave('hostname', v)}
          />
        </div>
        {node.hostname && (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--color-text)',
            display: 'block',
            marginLeft: 24,
          }}>
            {node.ip_address}
          </span>
        )}
      </div>

      {/* Status + Type badges (editable via InlineSelect) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <span style={detailLabelStyle}>STATUS</span>
          <span style={{
            display: 'inline-block',
            color: statusColor,
            background: 'var(--color-bg-surface)',
            border: `1px solid ${statusColor}`,
            borderRadius: 'var(--radius)',
            padding: '3px 8px',
          }}>
            <InlineSelect
              value={node.status}
              options={STATUS_OPTIONS}
              onSave={(v) => onFieldSave('status', v)}
            />
          </span>
        </div>
        <div>
          <span style={detailLabelStyle}>NODE TYPE</span>
          <span style={{
            display: 'inline-block',
            color: 'var(--color-accent)',
            background: 'rgba(77, 171, 247, 0.08)',
            border: '1px solid rgba(77, 171, 247, 0.2)',
            borderRadius: 'var(--radius)',
            padding: '3px 8px',
          }}>
            <InlineSelect
              value={node.node_type}
              options={DEVICE_TYPES}
              onSave={(v) => onFieldSave('node_type', v)}
            />
          </span>
        </div>
      </div>

      {/* OS info */}
      <div>
        <span style={detailLabelStyle}>OS</span>
        <InlineText
          value={[node.os, node.os_version].filter(Boolean).join(' ')}
          onSave={(v) => onFieldSave('os', v)}
          placeholder="unknown"
        />
      </div>

      {/* MAC Address */}
      <div>
        <span style={detailLabelStyle}>MAC ADDRESS</span>
        <InlineText
          value={node.mac_address || ''}
          onSave={(v) => onFieldSave('mac_address', v)}
          placeholder="none"
        />
      </div>

      {/* Service summary */}
      {services.length > 0 && (
        <div>
          <span style={detailLabelStyle}>
            SERVICES ({services.length})
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--color-text-muted)',
          }}>
            {services.map((s) => `${s.port}/${s.protocol}`).join(', ')}
          </span>
        </div>
      )}

      {/* Timestamps */}
      <div style={{ marginTop: 'auto', paddingTop: 12, borderTop: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={detailLabelStyle}>DISCOVERED</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
            {new Date(node.created_at).toLocaleString()}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={detailLabelStyle}>UPDATED</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-muted)' }}>
            {new Date(node.updated_at).toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Services Tab                                                      */
/* ------------------------------------------------------------------ */

function renderServicesTab(
  services: ServiceEntry[],
  onAdd: () => void,
  onDelete: (index: number) => void,
) {
  if (services.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        gap: 12,
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: 1,
          color: 'var(--color-text-muted)',
        }}>
          NO SERVICES DISCOVERED
        </span>
        <button onClick={onAdd} style={addButtonStyle}>
          <Plus size={12} />
          ADD SERVICE
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '56px 44px 1fr 1fr 60px 24px',
        gap: 6,
        padding: '0 10px 6px',
        borderBottom: '1px solid var(--color-border)',
      }}>
        {['PORT', 'PROTO', 'SERVICE', 'PRODUCT', 'VERSION', ''].map((h, i) => (
          <span key={i} style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            letterSpacing: 1,
            color: 'var(--color-text-muted)',
          }}>
            {h}
          </span>
        ))}
      </div>

      {/* Service rows */}
      {services.map((svc, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '56px 44px 1fr 1fr 60px 24px',
            gap: 6,
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            padding: '8px 10px',
            alignItems: 'center',
          }}
        >
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-accent)',
          }}>
            {svc.port}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--color-text-muted)',
            textTransform: 'uppercase',
          }}>
            {svc.protocol}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-bright)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {svc.service || '-'}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--color-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {svc.product || '-'}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--color-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {svc.version || '-'}
          </span>
          <button
            onClick={() => onDelete(i)}
            style={deleteButtonStyle}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
            title="Remove service"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}

      {/* Add button */}
      <button onClick={onAdd} style={{ ...addButtonStyle, marginTop: 8, alignSelf: 'flex-start' }}>
        <Plus size={12} />
        ADD SERVICE
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Vulns Tab                                                         */
/* ------------------------------------------------------------------ */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

const vulnFormInputStyle: React.CSSProperties = {
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

const vulnFormLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  letterSpacing: 1,
  color: 'var(--color-text-muted)',
  display: 'block',
  marginBottom: 3,
}

function renderVulnsTab(
  vulns: VulnEntry[],
  showForm: boolean,
  setShowForm: (v: boolean) => void,
  onAdd: (vuln: VulnEntry) => void,
  onClick: (vuln: VulnEntry) => void,
  onDelete: (index: number) => void,
) {
  if (vulns.length === 0 && !showForm) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        gap: 12,
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: 1,
          color: 'var(--color-text-muted)',
        }}>
          NO VULNERABILITIES TRACKED
        </span>
        <button onClick={() => setShowForm(true)} style={addButtonStyle}>
          <Plus size={12} />
          ADD VULNERABILITY
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
      {vulns.length > 0 && (
        <>
          {/* Column headers */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '90px 62px 42px 28px 70px 24px',
            gap: 4,
            padding: '0 10px 6px',
            borderBottom: '1px solid var(--color-border)',
          }}>
            {['CVE', 'SEVERITY', 'CVSS', 'EXP', 'STATUS', ''].map((h, i) => (
              <span key={i} style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 8,
                letterSpacing: 1,
                color: 'var(--color-text-muted)',
              }}>
                {h}
              </span>
            ))}
          </div>

          {/* Vuln rows */}
          {[...vulns]
            .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
            .map((vuln) => {
              const origIndex = vulns.findIndex((v) => v.cve_id === vuln.cve_id)
              const sevColor = SEVERITY_COLORS[vuln.severity] || '#888'
              return (
                <div
                  key={vuln.cve_id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '90px 62px 42px 28px 70px 24px',
                    gap: 4,
                    background: 'var(--color-bg-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius)',
                    padding: '8px 10px',
                    alignItems: 'center',
                    cursor: 'pointer',
                    transition: 'border-color 0.15s ease',
                  }}
                  onClick={() => onClick(vuln)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-accent)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--color-border)'
                  }}
                >
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--color-text-bright)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {vuln.cve_id}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: 0.5,
                    color: sevColor,
                    background: `${sevColor}1a`,
                    border: `1px solid ${sevColor}40`,
                    borderRadius: 'var(--radius)',
                    padding: '1px 5px',
                    textTransform: 'uppercase',
                    textAlign: 'center',
                  }}>
                    {vuln.severity}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--color-text-muted)',
                  }}>
                    {vuln.cvss.toFixed(1)}
                  </span>
                  <span style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: vuln.exploit_available ? '#ff4444' : 'var(--color-text-muted)',
                  }}>
                    {vuln.exploit_available ? <Check size={12} /> : <X size={12} />}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    color: 'var(--color-text-muted)',
                    textTransform: 'uppercase',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {vuln.status.replace(/_/g, ' ')}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(origIndex)
                    }}
                    style={deleteButtonStyle}
                    onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
                    title="Remove vulnerability"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            })}
        </>
      )}

      {/* Add form or button */}
      {showForm ? (
        <VulnAddForm onAdd={onAdd} onCancel={() => setShowForm(false)} />
      ) : (
        <button
          onClick={() => setShowForm(true)}
          style={{ ...addButtonStyle, marginTop: 8, alignSelf: 'flex-start' }}
        >
          <Plus size={12} />
          ADD VULNERABILITY
        </button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Vuln Add Form (inline)                                            */
/* ------------------------------------------------------------------ */

function VulnAddForm({
  onAdd,
  onCancel,
}: {
  onAdd: (vuln: VulnEntry) => void
  onCancel: () => void
}) {
  const [cveId, setCveId] = useState('')
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<VulnEntry['severity']>('medium')
  const [cvss, setCvss] = useState('5.0')
  const [exploitAvailable, setExploitAvailable] = useState(false)

  const canSubmit = cveId.trim() && title.trim()

  const handleSubmit = () => {
    if (!canSubmit) return
    onAdd({
      cve_id: cveId.trim(),
      title: title.trim(),
      severity,
      cvss: parseFloat(cvss) || 0,
      exploit_available: exploitAvailable,
      status: 'unverified',
    })
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
      marginTop: 8,
    }}>
      <div>
        <span style={vulnFormLabelStyle}>CVE ID</span>
        <input
          value={cveId}
          onChange={(e) => setCveId(e.target.value)}
          placeholder="CVE-2024-XXXXX"
          style={vulnFormInputStyle}
        />
      </div>
      <div>
        <span style={vulnFormLabelStyle}>TITLE</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Vulnerability title"
          style={vulnFormInputStyle}
        />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <span style={vulnFormLabelStyle}>SEVERITY</span>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as VulnEntry['severity'])}
            style={{ ...vulnFormInputStyle, appearance: 'auto' as const }}
          >
            {['critical', 'high', 'medium', 'low', 'info'].map((s) => (
              <option key={s} value={s}>{s.toUpperCase()}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <span style={vulnFormLabelStyle}>CVSS</span>
          <input
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={cvss}
            onChange={(e) => setCvss(e.target.value)}
            style={vulnFormInputStyle}
          />
        </div>
      </div>
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
          checked={exploitAvailable}
          onChange={(e) => setExploitAvailable(e.target.checked)}
          style={{ margin: 0 }}
        />
        EXPLOIT AVAILABLE
      </label>
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
          disabled={!canSubmit}
          style={{
            ...addButtonStyle,
            fontSize: 9,
            padding: '4px 10px',
            color: canSubmit ? 'var(--color-accent)' : 'var(--color-text-muted)',
            borderColor: canSubmit ? 'var(--color-accent)' : 'var(--color-border)',
            opacity: canSubmit ? 1 : 0.5,
          }}
        >
          <Plus size={10} />
          ADD
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Interfaces Tab                                                    */
/* ------------------------------------------------------------------ */

const STATE_COLORS: Record<string, string> = {
  up: 'var(--color-success)',
  down: 'var(--color-danger)',
  unknown: 'var(--color-text-muted)',
}

function renderInterfacesTab(
  interfaces: InterfaceEntry[],
  onAdd: () => void,
  onDelete: (index: number) => void,
) {
  if (interfaces.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        gap: 12,
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: 1,
          color: 'var(--color-text-muted)',
        }}>
          NO INTERFACES CONFIGURED
        </span>
        <button onClick={onAdd} style={addButtonStyle}>
          <Plus size={12} />
          ADD INTERFACE
        </button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
      {/* Column headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '52px 1fr 1fr 42px 36px 24px',
        gap: 4,
        padding: '0 10px 6px',
        borderBottom: '1px solid var(--color-border)',
      }}>
        {['NAME', 'MAC', 'IPS', 'VLAN', 'STATE', ''].map((h, i) => (
          <span key={i} style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            letterSpacing: 1,
            color: 'var(--color-text-muted)',
          }}>
            {h}
          </span>
        ))}
      </div>

      {/* Interface rows */}
      {interfaces.map((iface, i) => {
        const stateColor = STATE_COLORS[iface.state] || 'var(--color-text-muted)'
        return (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: '52px 1fr 1fr 42px 36px 24px',
              gap: 4,
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              padding: '8px 10px',
              alignItems: 'center',
            }}
          >
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--color-accent)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {iface.name || '-'}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--color-text-muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {iface.mac || '-'}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--color-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {iface.ips.length > 0 ? iface.ips.join(', ') : '-'}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--color-text-muted)',
              textAlign: 'center',
            }}>
              {iface.vlan != null ? iface.vlan : '-'}
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              fontWeight: 600,
              color: stateColor,
              textTransform: 'uppercase',
            }}>
              {iface.state}
            </span>
            <button
              onClick={() => onDelete(i)}
              style={deleteButtonStyle}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
              title="Remove interface"
            >
              <Trash2 size={12} />
            </button>
          </div>
        )
      })}

      {/* Add button */}
      <button onClick={onAdd} style={{ ...addButtonStyle, marginTop: 8, alignSelf: 'flex-start' }}>
        <Plus size={12} />
        ADD INTERFACE
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Notes Tab                                                         */
/* ------------------------------------------------------------------ */

function renderMarkdown(source: string): string {
  let html = source
    // Escape HTML entities first to prevent injection
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Code blocks (``` ... ```)
  html = html.replace(/```([\s\S]*?)```/g, (_m, code: string) =>
    `<pre style="background:var(--color-bg-surface);border:1px solid var(--color-border);border-radius:var(--radius);padding:8px;overflow-x:auto;font-family:var(--font-mono);font-size:11px;color:var(--color-text-bright);margin:4px 0">${code.trim()}</pre>`,
  )

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code style="background:var(--color-bg-surface);padding:1px 4px;border-radius:2px;font-family:var(--font-mono);font-size:11px;color:var(--color-accent)">$1</code>')

  // Headers
  html = html.replace(/^## (.+)$/gm, '<h4 style="font-family:var(--font-mono);font-size:12px;color:var(--color-text-bright);margin:8px 0 4px;letter-spacing:0.5px">$1</h4>')
  html = html.replace(/^# (.+)$/gm, '<h3 style="font-family:var(--font-mono);font-size:13px;color:var(--color-text-bright);margin:8px 0 4px;letter-spacing:0.5px">$1</h3>')

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--color-text-bright)">$1</strong>')

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Bullet lists — group consecutive lines starting with -
  html = html.replace(/(^- .+$(\n- .+$)*)/gm, (block) => {
    const items = block.split('\n').map((line) =>
      `<li style="margin:2px 0">${line.replace(/^- /, '')}</li>`,
    ).join('')
    return `<ul style="margin:4px 0;padding-left:16px;list-style:disc">${items}</ul>`
  })

  // Line breaks
  html = html.replace(/\n/g, '<br/>')

  return html
}

function renderNotesTab(
  notes: string,
  mode: 'edit' | 'preview',
  setMode: (m: 'edit' | 'preview') => void,
  onChange: (value: string) => void,
  onBlur: () => void,
) {
  const toggleBtnStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    background: active ? 'var(--color-bg-surface)' : 'transparent',
    border: active ? '1px solid var(--color-accent)' : '1px solid var(--color-border)',
    borderRadius: 'var(--radius)',
    padding: '4px 10px',
    cursor: 'pointer',
    fontFamily: 'var(--font-mono)',
    fontSize: 9,
    letterSpacing: 0.5,
    color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
    transition: 'all 0.15s ease',
  })

  // Content is sanitized: renderMarkdown escapes all HTML entities before processing
  const renderedHtml = notes
    ? renderMarkdown(notes)
    : '<span style="color:var(--color-text-muted);font-style:italic">No notes yet</span>'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, gap: 8 }}>
      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 4 }}>
        <button onClick={() => setMode('edit')} style={toggleBtnStyle(mode === 'edit')}>
          <Pencil size={10} />
          EDIT
        </button>
        <button onClick={() => setMode('preview')} style={toggleBtnStyle(mode === 'preview')}>
          <Eye size={10} />
          PREVIEW
        </button>
      </div>

      {/* Content area */}
      {mode === 'edit' ? (
        <textarea
          value={notes}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder="Operator notes... (supports markdown)"
          style={{
            flex: 1,
            width: '100%',
            minHeight: 200,
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            color: 'var(--color-text-bright)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: '1.5',
            padding: 10,
            resize: 'none',
            outline: 'none',
            boxSizing: 'border-box' as const,
          }}
        />
      ) : (
        <div
          style={{
            flex: 1,
            width: '100%',
            minHeight: 200,
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            color: 'var(--color-text)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            lineHeight: '1.5',
            padding: 10,
            overflowY: 'auto',
            boxSizing: 'border-box' as const,
          }}
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}
    </div>
  )
}
