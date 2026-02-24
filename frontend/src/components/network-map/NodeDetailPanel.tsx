import { useState } from 'react'
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
  Pencil,
  Plus,
} from 'lucide-react'
import type { NetworkNodeRecord, ServiceEntry } from './types'

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

const fieldRowStyle: React.CSSProperties = {
  position: 'relative',
}

const editIconStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  right: 0,
  color: 'var(--color-text-muted)',
  opacity: 0,
  cursor: 'pointer',
  transition: 'opacity 0.15s ease',
}

export default function NodeDetailPanel({ node, onClose }: NodeDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('overview')

  const NodeIcon = getNodeTypeIcon(node.node_type)
  const statusColor = getStatusColor(node.status)
  const services: ServiceEntry[] = Array.isArray(node.services) ? node.services : []

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
          const badge = tab.id === 'services' && services.length > 0 ? services.length : null
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
        {activeTab === 'overview' && renderOverviewTab(node, NodeIcon, statusColor, services)}
        {activeTab === 'services' && renderServicesTab(services)}
        {activeTab === 'vulns' && renderPlaceholderTab('NO VULNERABILITIES TRACKED', 'Add Vulnerability')}
        {activeTab === 'interfaces' && renderPlaceholderTab('NO INTERFACES CONFIGURED', 'Add Interface')}
        {activeTab === 'notes' && renderPlaceholderTab('NO NOTES', 'Add Note')}
      </div>
    </div>
  )
}

function FieldRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={fieldRowStyle}
      onMouseEnter={(e) => {
        const icon = e.currentTarget.querySelector('.edit-icon') as HTMLElement | null
        if (icon) icon.style.opacity = '0.6'
      }}
      onMouseLeave={(e) => {
        const icon = e.currentTarget.querySelector('.edit-icon') as HTMLElement | null
        if (icon) icon.style.opacity = '0'
      }}
    >
      <span style={detailLabelStyle}>{label}</span>
      <span style={detailValueStyle}>{value}</span>
      <span className="edit-icon" style={editIconStyle}>
        <Pencil size={10} />
      </span>
    </div>
  )
}

function renderOverviewTab(
  node: NetworkNodeRecord,
  NodeIcon: typeof Server,
  statusColor: string,
  services: ServiceEntry[],
) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
      {/* Hostname + IP */}
      <div
        style={fieldRowStyle}
        onMouseEnter={(e) => {
          const icon = e.currentTarget.querySelector('.edit-icon') as HTMLElement | null
          if (icon) icon.style.opacity = '0.6'
        }}
        onMouseLeave={(e) => {
          const icon = e.currentTarget.querySelector('.edit-icon') as HTMLElement | null
          if (icon) icon.style.opacity = '0'
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 6,
        }}>
          <NodeIcon size={16} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--color-text-bright)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {node.hostname || node.ip_address}
          </span>
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
        <span className="edit-icon" style={editIconStyle}>
          <Pencil size={10} />
        </span>
      </div>

      {/* Status + Type badges */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: 0.5,
          color: statusColor,
          background: 'var(--color-bg-surface)',
          border: `1px solid ${statusColor}`,
          borderRadius: 'var(--radius)',
          padding: '3px 8px',
          textTransform: 'uppercase',
        }}>
          {node.status}
        </span>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: 0.5,
          color: 'var(--color-accent)',
          background: 'rgba(77, 171, 247, 0.08)',
          border: '1px solid rgba(77, 171, 247, 0.2)',
          borderRadius: 'var(--radius)',
          padding: '3px 8px',
          textTransform: 'uppercase',
        }}>
          {node.node_type}
        </span>
      </div>

      {/* OS info */}
      {(node.os || node.os_version) && (
        <FieldRow
          label="OS"
          value={[node.os, node.os_version].filter(Boolean).join(' ')}
        />
      )}

      {/* MAC Address */}
      {node.mac_address && (
        <FieldRow label="MAC ADDRESS" value={node.mac_address} />
      )}

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

function renderServicesTab(services: ServiceEntry[]) {
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
        <button style={addButtonStyle}>
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
        gridTemplateColumns: '56px 44px 1fr 1fr 60px',
        gap: 6,
        padding: '0 10px 6px',
        borderBottom: '1px solid var(--color-border)',
      }}>
        {['PORT', 'PROTO', 'SERVICE', 'PRODUCT', 'VERSION'].map((h) => (
          <span key={h} style={{
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
            gridTemplateColumns: '56px 44px 1fr 1fr 60px',
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
        </div>
      ))}

      {/* Add button */}
      <button style={{ ...addButtonStyle, marginTop: 8, alignSelf: 'flex-start' }}>
        <Plus size={12} />
        ADD SERVICE
      </button>
    </div>
  )
}

function renderPlaceholderTab(message: string, addLabel: string) {
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
        {message}
      </span>
      <button style={addButtonStyle}>
        <Plus size={12} />
        {addLabel.toUpperCase()}
      </button>
    </div>
  )
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
