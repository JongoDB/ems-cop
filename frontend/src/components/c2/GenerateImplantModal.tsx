// Generate Implant modal — posts an ImplantSpec to the c2-gateway and shows
// the resulting binary's metadata (the bytes live on the C2 server's
// `sliver-builds` volume; the API does not stream them today).

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  X,
  Info,
  Loader,
  CheckCircle,
  AlertTriangle,
  Cpu,
} from 'lucide-react'
import { useTopology } from '../../hooks/useTunnels'
import {
  useGenerateImplant,
  type ImplantArch,
  type ImplantFormat,
  type ImplantOS,
  type ImplantSpec,
  type ImplantTransport,
} from '../../hooks/useGenerateImplant'
import type { ProviderInfo } from '../../lib/c2Topology'

interface GenerateImplantModalProps {
  open: boolean
  onClose: () => void
  defaultProvider?: string
}

const OS_OPTIONS: { value: ImplantOS; label: string }[] = [
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
  { value: 'darwin', label: 'macOS' },
]

const ARCH_OPTIONS: ImplantArch[] = ['amd64', 'arm64', '386']

const FORMAT_OPTIONS: { value: ImplantFormat; label: string; hint: string }[] = [
  { value: 'exe', label: 'Executable (.exe / ELF)', hint: 'Standalone binary' },
  { value: 'shared', label: 'Shared library (.so / .dll)', hint: 'Loadable library' },
  { value: 'service', label: 'Service binary', hint: 'Installable as a system service' },
  { value: 'shellcode', label: 'Shellcode', hint: 'Position-independent code blob' },
]

const TRANSPORT_OPTIONS: { value: ImplantTransport; label: string }[] = [
  { value: 'mtls', label: 'mTLS' },
  { value: 'https', label: 'HTTPS' },
  { value: 'http', label: 'HTTP' },
  { value: 'dns', label: 'DNS' },
  { value: 'wg', label: 'WireGuard' },
]

function defaultC2Url(provider: ProviderInfo | undefined): string {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'c2-server'
  switch (provider?.type) {
    case 'sliver':
      return `mtls://${host}:8888`
    case 'mythic':
      return `https://${host}:7443`
    case 'havoc':
      return `https://${host}:40056`
    case 'merlin':
      return `https://${host}:443`
    default:
      return `https://${host}:443`
  }
}

function placeholderForProvider(provider: ProviderInfo | undefined): string {
  switch (provider?.type) {
    case 'sliver':
      return 'mtls://sliver-server:8888'
    case 'mythic':
      return 'https://mythic-server:7443'
    case 'havoc':
      return 'https://havoc-server:40056'
    case 'merlin':
      return 'https://merlin-server:443'
    default:
      return 'https://c2-server:443'
  }
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function OSIcon({ size = 14 }: { size?: number }) {
  // No good per-OS lucide icons that read at this size in the version we
  // have pinned — keep a single generic Cpu chip for clarity.
  return <Cpu size={size} />
}

export default function GenerateImplantModal({
  open,
  onClose,
  defaultProvider,
}: GenerateImplantModalProps) {
  const topologyQuery = useTopology()
  const providers: ProviderInfo[] = useMemo(
    () => topologyQuery.data?.providers ?? [],
    [topologyQuery.data]
  )

  const connectedProviders = useMemo(
    () => providers.filter((p) => p.connected),
    [providers]
  )

  const initialProvider = useMemo(() => {
    if (defaultProvider && providers.find((p) => p.name === defaultProvider)) {
      return defaultProvider
    }
    return connectedProviders[0]?.name ?? providers[0]?.name ?? ''
  }, [defaultProvider, providers, connectedProviders])

  const [provider, setProvider] = useState<string>(initialProvider)
  const [os, setOS] = useState<ImplantOS>('windows')
  const [arch, setArch] = useState<ImplantArch>('amd64')
  const [format, setFormat] = useState<ImplantFormat>('exe')
  const [transport, setTransport] = useState<ImplantTransport>('https')
  const [c2Url, setC2Url] = useState<string>(() => defaultC2Url(undefined))
  const [skipSymbols, setSkipSymbols] = useState<boolean>(true)
  const [showHelp, setShowHelp] = useState<boolean>(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement | null>(null)

  const generate = useGenerateImplant()

  // Sync provider when the topology data lands or the modal re-opens.
  useEffect(() => {
    if (open) setProvider(initialProvider)
  }, [open, initialProvider])

  // When the user changes provider, update the placeholder/default if the
  // current value still matches a previous provider's default.
  const selectedProvider = useMemo(
    () => providers.find((p) => p.name === provider),
    [providers, provider]
  )
  useEffect(() => {
    // Only auto-fill when empty so we don't overwrite user input.
    if (!c2Url) setC2Url(defaultC2Url(selectedProvider))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProvider?.name])

  // Reset form mutation/result when (re)opening.
  useEffect(() => {
    if (open) {
      generate.reset()
      setSubmitError(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Disable arch=386 for darwin.
  useEffect(() => {
    if (os === 'darwin' && arch === '386') setArch('amd64')
  }, [os, arch])

  // Esc to close.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const noConnected = connectedProviders.length === 0
  const inFlight = generate.isPending
  const hasSucceeded = generate.isSuccess && generate.data && !submitError
  const result = generate.data

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitError(null)
    if (!provider) {
      setSubmitError('Pick a provider.')
      return
    }
    if (!c2Url.trim()) {
      setSubmitError('C2 callback URL is required.')
      return
    }
    const spec: ImplantSpec = {
      os,
      arch,
      format,
      transport,
      c2_url: c2Url.trim(),
      skip_symbols: skipSymbols,
    }
    try {
      await generate.mutateAsync({ provider, spec })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to generate implant')
    }
  }

  const handleAnother = () => {
    generate.reset()
    setSubmitError(null)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
        role="dialog"
        aria-modal="true"
        aria-label="Generate Implant"
      >
        <div className="modal-header">
          <span className="modal-title">GENERATE IMPLANT</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form ref={formRef} onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Success state */}
            {hasSucceeded && result && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  border: '1px solid rgba(64,192,87,0.4)',
                  background: 'rgba(64,192,87,0.08)',
                  borderRadius: 'var(--radius)',
                  padding: 12,
                  marginBottom: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    color: 'var(--color-success)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    letterSpacing: 0.5,
                  }}
                >
                  <CheckCircle size={14} />
                  IMPLANT BUILT
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--color-text-bright)',
                  }}
                >
                  {result.name}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {formatBytes(result.size)} · stored on C2 server (sliver-builds volume)
                </div>
              </div>
            )}

            {/* Provider */}
            <div className="form-group">
              <label className="form-label">PROVIDER</label>
              <select
                className="form-input"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                disabled={inFlight || providers.length === 0}
                required
              >
                {providers.length === 0 && <option value="">— no providers —</option>}
                {providers.map((p) => (
                  <option key={p.name} value={p.name} disabled={!p.connected}>
                    {p.name} {p.connected ? '✓' : '(disconnected)'}
                  </option>
                ))}
              </select>
              {noConnected && (
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--color-danger, #ff6b6b)',
                  }}
                >
                  No connected providers. Bring one online to generate implants.
                </div>
              )}
            </div>

            {/* OS chips */}
            <div className="form-group">
              <label className="form-label">OPERATING SYSTEM</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {OS_OPTIONS.map((opt) => (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => setOS(opt.value)}
                    disabled={inFlight}
                    style={chipStyle(os === opt.value)}
                  >
                    <OSIcon size={12} />
                    <span style={{ marginLeft: 6 }}>{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Arch chips */}
            <div className="form-group">
              <label className="form-label">ARCHITECTURE</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {ARCH_OPTIONS.map((a) => {
                  const disabled = inFlight || (os === 'darwin' && a === '386')
                  return (
                    <button
                      type="button"
                      key={a}
                      onClick={() => !disabled && setArch(a)}
                      disabled={disabled}
                      title={
                        os === 'darwin' && a === '386'
                          ? '386 is not supported on darwin'
                          : undefined
                      }
                      style={{
                        ...chipStyle(arch === a),
                        opacity: disabled && os === 'darwin' && a === '386' ? 0.4 : undefined,
                      }}
                    >
                      {a}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Format */}
            <div className="form-group">
              <label className="form-label">FORMAT</label>
              <select
                className="form-input"
                value={format}
                onChange={(e) => setFormat(e.target.value as ImplantFormat)}
                disabled={inFlight}
              >
                {FORMAT_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Transport */}
            <div className="form-group">
              <label className="form-label">TRANSPORT</label>
              <select
                className="form-input"
                value={transport}
                onChange={(e) => setTransport(e.target.value as ImplantTransport)}
                disabled={inFlight}
              >
                {TRANSPORT_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {/* C2 URL */}
            <div className="form-group">
              <label
                className="form-label"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                C2 CALLBACK URL
                <button
                  type="button"
                  aria-label="What is the C2 callback URL?"
                  onClick={() => setShowHelp((v) => !v)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--color-text-muted)',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'inline-flex',
                  }}
                >
                  <Info size={12} />
                </button>
              </label>
              <input
                type="text"
                className="form-input"
                placeholder={placeholderForProvider(selectedProvider)}
                value={c2Url}
                onChange={(e) => setC2Url(e.target.value)}
                disabled={inFlight}
              />
              {showHelp && (
                <div
                  style={{
                    marginTop: 6,
                    padding: '6px 8px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius)',
                    background: 'var(--color-bg-surface)',
                    fontFamily: 'var(--font-body)',
                    fontSize: 11,
                    color: 'var(--color-text-muted)',
                    lineHeight: 1.5,
                  }}
                >
                  Where the implant should call back to. This is the address the
                  compromised host will reach — typically the C2 listener on your
                  redirector or directly on the team server.
                </div>
              )}
            </div>

            {/* Skip symbols */}
            <div className="form-group">
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  letterSpacing: 0.5,
                  color: 'var(--color-text)',
                  cursor: inFlight ? 'not-allowed' : 'pointer',
                  textTransform: 'uppercase',
                }}
              >
                <input
                  type="checkbox"
                  checked={skipSymbols}
                  onChange={(e) => setSkipSymbols(e.target.checked)}
                  disabled={inFlight}
                />
                STRIP SYMBOLS (production-ish)
              </label>
            </div>

            {/* Loading hint */}
            {inFlight && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                  background: 'var(--color-bg-surface)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--color-text-muted)',
                }}
              >
                <Loader size={14} className="spin" />
                Compiling — Sliver builds can take 30-90 seconds…
              </div>
            )}

            {/* Error */}
            {submitError && (
              <div
                role="alert"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
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
                <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>{submitError}</span>
              </div>
            )}
          </div>

          <div className="modal-footer">
            {hasSucceeded ? (
              <>
                <button
                  type="button"
                  className="submit-btn"
                  onClick={handleAnother}
                  style={{ marginRight: 8 }}
                >
                  GENERATE ANOTHER
                </button>
                <button
                  type="button"
                  className="submit-btn"
                  onClick={onClose}
                  style={{ background: 'var(--color-bg-surface)', color: 'var(--color-text)' }}
                >
                  CLOSE
                </button>
              </>
            ) : (
              <button
                type="submit"
                className="submit-btn"
                disabled={inFlight || noConnected}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  opacity: noConnected ? 0.5 : undefined,
                }}
              >
                {inFlight && <Loader size={12} className="spin" />}
                {inFlight ? 'GENERATING…' : 'GENERATE IMPLANT'}
              </button>
            )}
          </div>
        </form>

        <style>{`
          @keyframes spin { to { transform: rotate(360deg) } }
          .spin { animation: spin 0.9s linear infinite; }
        `}</style>
      </div>
    </div>
  )
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: 0.5,
    padding: '5px 10px',
    borderRadius: 'var(--radius)',
    cursor: 'pointer',
    border: '1px solid',
    borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
    background: active ? 'rgba(77,171,247,0.10)' : 'var(--color-bg-surface)',
    color: active ? 'var(--color-accent)' : 'var(--color-text)',
    textTransform: 'uppercase',
  }
}
