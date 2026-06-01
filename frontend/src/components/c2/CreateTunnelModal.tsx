// Modal form to create a new C2 tunnel.

import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import {
  PROVIDER_COLORS,
  TUNNEL_TYPE_LABELS,
} from '../../lib/c2Topology'
import type {
  C2Provider,
  CreateTunnelRequest,
  ImplantSession,
  Tunnel,
  TunnelType,
} from '../../lib/c2Topology'
import { useCreateTunnel } from '../../hooks/useTunnels'

interface CreateTunnelModalProps {
  open: boolean
  operationId?: string | null
  sessions: ImplantSession[]
  tunnels: Tunnel[]
  onClose: () => void
  defaultSessionId?: string
}

const TUNNEL_TYPES: TunnelType[] = ['portfwd_local', 'portfwd_remote', 'socks5', 'pivot_relay']

function needsDst(type: TunnelType): boolean {
  return type === 'portfwd_local' || type === 'portfwd_remote'
}

function needsListen(type: TunnelType): boolean {
  return type !== 'portfwd_remote'
}

export default function CreateTunnelModal({
  open,
  operationId,
  sessions,
  tunnels,
  onClose,
  defaultSessionId,
}: CreateTunnelModalProps) {
  const aliveSessions = useMemo(() => sessions.filter((s) => s.is_alive), [sessions])
  const relayParents = useMemo(
    () => tunnels.filter((t) => t.tunnel_type === 'pivot_relay' && t.status === 'active'),
    [tunnels]
  )

  const [srcSessionId, setSrcSessionId] = useState<string>(
    defaultSessionId || aliveSessions[0]?.id || ''
  )
  const [tunnelType, setTunnelType] = useState<TunnelType>('portfwd_local')
  const [dstHost, setDstHost] = useState('')
  const [dstPort, setDstPort] = useState<string>('')
  const [listenPort, setListenPort] = useState<string>('')
  const [parentTunnelId, setParentTunnelId] = useState<string>('')
  const [classification, setClassification] = useState<string>('UNCLASSIFIED')
  const [error, setError] = useState<string | null>(null)

  const createMutation = useCreateTunnel()

  const selectedSession = sessions.find((s) => s.id === srcSessionId)
  const provider: C2Provider | undefined = selectedSession?.provider

  if (!open) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!srcSessionId || !provider) {
      setError('Pick a source session.')
      return
    }
    const body: CreateTunnelRequest = {
      operation_id: operationId ?? null,
      provider,
      tunnel_type: tunnelType,
      src_session_id: srcSessionId,
      classification,
    }
    if (needsListen(tunnelType)) {
      const lp = parseInt(listenPort, 10)
      if (!Number.isFinite(lp) || lp <= 0 || lp > 65535) {
        setError('Listen port must be 1-65535.')
        return
      }
      body.listen_port = lp
    }
    if (needsDst(tunnelType)) {
      if (!dstHost.trim()) {
        setError('Destination host required.')
        return
      }
      const dp = parseInt(dstPort, 10)
      if (!Number.isFinite(dp) || dp <= 0 || dp > 65535) {
        setError('Destination port must be 1-65535.')
        return
      }
      body.dst_host = dstHost.trim()
      body.dst_port = dp
    }
    if (parentTunnelId) {
      body.parent_tunnel_id = parentTunnelId
    }

    try {
      await createMutation.mutateAsync(body)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tunnel')
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 460 }}
      >
        <div className="modal-header">
          <span className="modal-title">NEW TUNNEL</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Source session */}
            <div className="form-group">
              <label className="form-label">SOURCE SESSION</label>
              <select
                className="form-input"
                value={srcSessionId}
                onChange={(e) => setSrcSessionId(e.target.value)}
                required
              >
                <option value="">— select —</option>
                {aliveSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.provider}] {s.implant_name} · {s.hostname}
                  </option>
                ))}
              </select>
              {provider && (
                <span
                  style={{
                    display: 'inline-block',
                    marginTop: 6,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    letterSpacing: 0.5,
                    color: PROVIDER_COLORS[provider],
                  }}
                >
                  PROVIDER: {provider.toUpperCase()}
                </span>
              )}
            </div>

            {/* Tunnel type */}
            <div className="form-group">
              <label className="form-label">TUNNEL TYPE</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {TUNNEL_TYPES.map((t) => (
                  <button
                    type="button"
                    key={t}
                    onClick={() => setTunnelType(t)}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      letterSpacing: 0.5,
                      padding: '5px 10px',
                      borderRadius: 'var(--radius)',
                      cursor: 'pointer',
                      border: '1px solid',
                      borderColor:
                        tunnelType === t ? 'var(--color-accent)' : 'var(--color-border)',
                      background:
                        tunnelType === t
                          ? 'rgba(77,171,247,0.10)'
                          : 'var(--color-bg-surface)',
                      color:
                        tunnelType === t ? 'var(--color-accent)' : 'var(--color-text)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {TUNNEL_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>

            {/* Destination */}
            {needsDst(tunnelType) && (
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="form-group" style={{ flex: 2 }}>
                  <label className="form-label">DST HOST</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="10.0.5.32"
                    value={dstHost}
                    onChange={(e) => setDstHost(e.target.value)}
                  />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">DST PORT</label>
                  <input
                    type="number"
                    className="form-input"
                    placeholder="3389"
                    value={dstPort}
                    onChange={(e) => setDstPort(e.target.value)}
                    min={1}
                    max={65535}
                  />
                </div>
              </div>
            )}

            {needsListen(tunnelType) && (
              <div className="form-group">
                <label className="form-label">LISTEN PORT</label>
                <input
                  type="number"
                  className="form-input"
                  placeholder="1080"
                  value={listenPort}
                  onChange={(e) => setListenPort(e.target.value)}
                  min={1}
                  max={65535}
                />
              </div>
            )}

            {/* Parent tunnel (optional) */}
            <div className="form-group">
              <label className="form-label">PARENT TUNNEL (CHAIN)</label>
              <select
                className="form-input"
                value={parentTunnelId}
                onChange={(e) => setParentTunnelId(e.target.value)}
              >
                <option value="">— direct (no chain) —</option>
                {relayParents.map((t) => (
                  <option key={t.id} value={t.id}>
                    relay :{t.listen_port ?? '?'} via {t.src_implant_name ?? t.src_session_id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>

            {/* Classification */}
            <div className="form-group">
              <label className="form-label">CLASSIFICATION</label>
              <select
                className="form-input"
                value={classification}
                onChange={(e) => setClassification(e.target.value)}
              >
                <option value="UNCLASSIFIED">UNCLASSIFIED</option>
                <option value="CUI">CUI</option>
                <option value="SECRET">SECRET</option>
              </select>
            </div>

            {error && (
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: '#ff6b6b',
                  border: '1px solid #ff6b6b66',
                  background: '#ff6b6b11',
                  borderRadius: 'var(--radius)',
                  padding: '6px 8px',
                  marginTop: 4,
                }}
              >
                {error}
              </div>
            )}
          </div>

          <div className="modal-footer">
            <button
              type="submit"
              className="submit-btn"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'CREATING…' : 'CREATE TUNNEL'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
