import { useEffect } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useCTIStore } from '../stores/ctiStore'
import { useEnclaveStore } from '../stores/enclaveStore'

export default function DegradedModeOverlay() {
  const { degraded, dismissed, dismiss, startPolling } = useCTIStore()
  const { enclave } = useEnclaveStore()

  // Start CTI polling when enclave is set
  useEffect(() => {
    if (!enclave) return
    const stopPolling = startPolling()
    return stopPolling
  }, [enclave, startPolling])

  // Don't render in single-enclave mode or when not degraded or when dismissed
  if (!enclave || !degraded || dismissed) return null

  return (
    <div className="degraded-banner" role="alert">
      <div className="degraded-banner-content">
        <AlertTriangle size={14} className="degraded-banner-icon" />
        <span className="degraded-banner-text">
          <strong>DEGRADED MODE</strong> — CTI link unavailable. Some features restricted. Risk 3+ operations blocked.
        </span>
      </div>
      <button
        className="degraded-banner-dismiss"
        onClick={dismiss}
        title="Dismiss"
        aria-label="Dismiss degraded mode notification"
      >
        <X size={14} />
      </button>
    </div>
  )
}
