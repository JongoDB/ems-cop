import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import SeverityBadge from '../components/SeverityBadge'
import MitreBadge from '../components/MitreBadge'
import ClassificationBadge from '../components/ClassificationBadge'
import ContainmentPanel from '../components/ContainmentPanel'
import IOCSearchBar from '../components/IOCSearchBar'
import type { IOC } from '../components/IOCSearchBar'
import {
  ChevronLeft, Eye, AlertTriangle, Shield, Search, ScrollText,
  ArrowRight,
} from 'lucide-react'

interface Incident {
  id: string
  title: string
  description?: string
  incident_severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'
  severity?: 'critical' | 'high' | 'medium' | 'low' | 'info'
  priority?: string
  status: string
  alert_source?: string
  source?: string
  ticket_type?: string
  classification?: string
  mitre_techniques?: string[]
  containment_status?: string
  assigned_to?: string
  assignee_name?: string
  creator_name?: string
  playbook_execution_id?: string
  created_at: string
  updated_at: string
}

interface LinkedAlert {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  source_system: string
  raw_payload?: Record<string, unknown>
  created_at: string
}

interface LinkedIOC {
  id: string
  ioc_type: string
  value: string
  threat_level: string
  is_active: boolean
  first_seen: string
  last_seen: string
}

interface AuditEntry {
  id: string
  action: string
  actor: string
  details?: string
  timestamp: string
}

const TABS = [
  { key: 'overview', label: 'OVERVIEW', icon: Eye },
  { key: 'alerts', label: 'ALERTS', icon: AlertTriangle },
  { key: 'response', label: 'RESPONSE', icon: Shield },
  { key: 'iocs', label: 'IOCs', icon: Search },
  { key: 'audit', label: 'AUDIT', icon: ScrollText },
]

const STATUS_COLORS: Record<string, string> = {
  new: '#3b82f6',
  investigating: '#f59e0b',
  containing: '#f97316',
  contained: '#8b5cf6',
  remediating: '#a855f7',
  resolved: '#22c55e',
  closed: '#6b7280',
}

const INCIDENT_TRANSITIONS: Record<string, { action: string; label: string }[]> = {
  new: [{ action: 'investigate', label: 'START INVESTIGATION' }],
  investigating: [
    { action: 'contain', label: 'START CONTAINMENT' },
    { action: 'resolve', label: 'RESOLVE' },
  ],
  containing: [
    { action: 'contained', label: 'MARK CONTAINED' },
    { action: 'fail_contain', label: 'CONTAINMENT FAILED' },
  ],
  contained: [{ action: 'remediate', label: 'START REMEDIATION' }],
  remediating: [{ action: 'resolve', label: 'RESOLVE' }],
  resolved: [{ action: 'close', label: 'CLOSE' }],
}

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [incident, setIncident] = useState<Incident | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('overview')

  // Tab data
  const [linkedAlerts, setLinkedAlerts] = useState<LinkedAlert[]>([])
  const [linkedIOCs, setLinkedIOCs] = useState<LinkedIOC[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null)

  const fetchIncident = useCallback(async () => {
    if (!id) return
    try {
      const res = await apiFetch<{ data: Incident }>(`/tickets/${id}`)
      setIncident(res.data ?? res as unknown as Incident)
    } catch {
      setIncident(null)
    } finally {
      setLoading(false)
    }
  }, [id])

  const fetchAlerts = useCallback(async () => {
    if (!id) return
    try {
      const res = await apiFetch<{ data: LinkedAlert[] }>(`/tickets/incidents/${id}/alerts`)
      setLinkedAlerts(res.data || [])
    } catch {
      setLinkedAlerts([])
    }
  }, [id])

  const fetchIOCs = useCallback(async () => {
    if (!id) return
    try {
      const res = await apiFetch<{ data: LinkedIOC[] }>(`/tickets/incidents/${id}/iocs`)
      setLinkedIOCs(res.data || [])
    } catch {
      setLinkedIOCs([])
    }
  }, [id])

  const fetchAudit = useCallback(async () => {
    if (!id) return
    try {
      const res = await apiFetch<{ data: AuditEntry[] }>(`/audit?entity_type=incident&entity_id=${id}`)
      setAuditEntries(res.data || [])
    } catch {
      setAuditEntries([])
    }
  }, [id])

  useEffect(() => {
    fetchIncident()
  }, [fetchIncident])

  useEffect(() => {
    if (activeTab === 'alerts') fetchAlerts()
    if (activeTab === 'iocs') fetchIOCs()
    if (activeTab === 'audit') fetchAudit()
  }, [activeTab, fetchAlerts, fetchIOCs, fetchAudit])

  const handleTransition = async (action: string) => {
    if (!id) return
    try {
      await apiFetch(`/tickets/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      fetchIncident()
    } catch {
      // error handled
    }
  }

  const handleAddIOC = async (ioc: IOC) => {
    if (!id) return
    try {
      await apiFetch(`/tickets/incidents/${id}/iocs`, {
        method: 'POST',
        body: JSON.stringify({ ioc_id: ioc.id }),
      })
      fetchIOCs()
    } catch {
      // error handled
    }
  }

  if (loading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-muted)', letterSpacing: 1 }}>
          LOADING INCIDENT...
        </span>
      </div>
    )
  }

  if (!incident) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--color-danger)', letterSpacing: 1 }}>
          INCIDENT NOT FOUND
        </span>
        <Link to="/incidents" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-accent)', textDecoration: 'none' }}>
          &larr; Back to Incidents
        </Link>
      </div>
    )
  }

  const transitions = INCIDENT_TRANSITIONS[incident.status] || []

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0, minWidth: 0, overflow: 'hidden', animation: 'fadeIn 0.3s ease' }}>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 0 }}>
        <Link
          to="/incidents"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: 1,
            color: 'var(--color-text-muted)',
            textDecoration: 'none',
            transition: 'color 150ms',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-accent)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-muted)')}
        >
          <ChevronLeft size={14} />
          INCIDENTS
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <h1 style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 18,
            fontWeight: 700,
            letterSpacing: 2,
            color: 'var(--color-text-bright)',
            margin: 0,
          }}>
            {incident.title}
          </h1>
          <SeverityBadge severity={(incident.incident_severity || incident.severity || 'medium') as 'critical' | 'high' | 'medium' | 'low' | 'info'} />
          <ClassificationBadge classification={incident.classification} size="md" />
          <span
            className="status-badge"
            style={{
              borderColor: STATUS_COLORS[incident.status] || '#6b7280',
              color: STATUS_COLORS[incident.status] || '#6b7280',
            }}
          >
            {incident.status.toUpperCase()}
          </span>
        </div>

        {/* Transition buttons */}
        {transitions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {transitions.map((t) => (
              <button
                key={t.action}
                onClick={() => handleTransition(t.action)}
                className="transition-btn"
                style={{ fontSize: 10, padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 4 }}
              >
                <ArrowRight size={10} />
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tab Bar */}
      <div className="c2-tabs" style={{ marginTop: 16 }}>
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={`c2-tab${activeTab === key ? ' active' : ''}`}
            onClick={() => setActiveTab(key)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '24px 0', minHeight: 0, overflow: 'auto' }}>
        {activeTab === 'overview' && (
          <div>
            <div className="detail-meta">
              <div className="meta-row">
                <span className="meta-label">STATUS</span>
                <span className="status-badge" style={{ borderColor: STATUS_COLORS[incident.status], color: STATUS_COLORS[incident.status] }}>
                  {incident.status.toUpperCase()}
                </span>
              </div>
              <div className="meta-row">
                <span className="meta-label">SEVERITY</span>
                <SeverityBadge severity={(incident.incident_severity || incident.severity || 'medium') as 'critical' | 'high' | 'medium' | 'low' | 'info'} />
              </div>
              <div className="meta-row">
                <span className="meta-label">SOURCE</span>
                <span>{incident.alert_source || incident.source || '--'}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">ASSIGNED TO</span>
                <span>{incident.assignee_name || 'Unassigned'}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">CONTAINMENT</span>
                <span>{incident.containment_status || 'none'}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">CREATED</span>
                <span className="mono-cell">{new Date(incident.created_at).toLocaleString()}</span>
              </div>
              <div className="meta-row">
                <span className="meta-label">UPDATED</span>
                <span className="mono-cell">{new Date(incident.updated_at).toLocaleString()}</span>
              </div>
            </div>

            {incident.mitre_techniques && incident.mitre_techniques.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 1, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                  MITRE ATT&CK TECHNIQUES
                </h3>
                <MitreBadge techniques={incident.mitre_techniques} />
              </div>
            )}

            {incident.description && (
              <div className="detail-description" style={{ marginTop: 16 }}>
                <h3 className="detail-section-title">DESCRIPTION</h3>
                <p>{incident.description}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'alerts' && (
          <div>
            <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: 1, color: 'var(--color-text-bright)', marginBottom: 12 }}>
              LINKED ALERTS ({linkedAlerts.length})
            </h3>
            {linkedAlerts.length === 0 ? (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                No linked alerts
              </div>
            ) : (
              <div className="tickets-table-wrap">
                <table className="tickets-table">
                  <thead>
                    <tr>
                      <th>SEVERITY</th>
                      <th>TITLE</th>
                      <th>SOURCE</th>
                      <th>CREATED</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linkedAlerts.map((alert) => (
                      <>
                        <tr
                          key={alert.id}
                          className="ticket-row"
                          onClick={() => setExpandedAlertId(expandedAlertId === alert.id ? null : alert.id)}
                        >
                          <td><SeverityBadge severity={alert.severity} /></td>
                          <td className="title-cell">{alert.title}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{alert.source_system}</td>
                          <td className="mono-cell">{new Date(alert.created_at).toLocaleString()}</td>
                        </tr>
                        {expandedAlertId === alert.id && alert.raw_payload && (
                          <tr key={`${alert.id}-payload`}>
                            <td colSpan={4} style={{ padding: 0 }}>
                              <pre style={{
                                padding: 12,
                                background: 'var(--color-bg-primary)',
                                fontSize: 10,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--color-text-muted)',
                                overflow: 'auto',
                                maxHeight: 200,
                                margin: 0,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                              }}>
                                {JSON.stringify(alert.raw_payload, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'response' && (
          <div>
            <ContainmentPanel incidentId={id!} />
          </div>
        )}

        {activeTab === 'iocs' && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 1, color: 'var(--color-text-muted)', marginBottom: 8 }}>
                ADD IOC
              </h3>
              <IOCSearchBar onSelect={handleAddIOC} />
            </div>

            <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: 1, color: 'var(--color-text-bright)', marginBottom: 12 }}>
              LINKED IOCs ({linkedIOCs.length})
            </h3>
            {linkedIOCs.length === 0 ? (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                No linked IOCs
              </div>
            ) : (
              <div className="tickets-table-wrap">
                <table className="tickets-table">
                  <thead>
                    <tr>
                      <th>TYPE</th>
                      <th>VALUE</th>
                      <th>THREAT</th>
                      <th>ACTIVE</th>
                      <th>FIRST SEEN</th>
                      <th>LAST SEEN</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linkedIOCs.map((ioc) => (
                      <tr key={ioc.id}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{ioc.ioc_type}</td>
                        <td className="title-cell" style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{ioc.value}</td>
                        <td>{ioc.threat_level}</td>
                        <td>{ioc.is_active ? 'YES' : 'NO'}</td>
                        <td className="mono-cell">{new Date(ioc.first_seen).toLocaleDateString()}</td>
                        <td className="mono-cell">{new Date(ioc.last_seen).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === 'audit' && (
          <div>
            <h3 style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: 1, color: 'var(--color-text-bright)', marginBottom: 12 }}>
              AUDIT TRAIL ({auditEntries.length})
            </h3>
            {auditEntries.length === 0 ? (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                No audit entries
              </div>
            ) : (
              auditEntries.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    padding: '8px 0',
                    borderBottom: '1px solid var(--color-border)',
                    fontSize: 11,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--color-text-bright)' }}>
                      {entry.action}
                    </span>
                    <span style={{ color: 'var(--color-text-muted)' }}>by</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-accent)' }}>
                      {entry.actor}
                    </span>
                    <span style={{
                      marginLeft: 'auto',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--color-text-muted)',
                    }}>
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                  </div>
                  {entry.details && (
                    <div style={{ marginTop: 4, color: 'var(--color-text-muted)', fontSize: 10 }}>
                      {entry.details}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}
