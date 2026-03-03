import { useEnclaveStore } from '../stores/enclaveStore'

interface BannerConfig {
  label: string
  classification: string
  bgClass: string
}

// Always show the maximum authorized classification for the enclave.
// The banner must not dynamically change based on current data — it
// represents the enclave's maximum classification level at all times.
function getBannerConfig(
  enclave: 'low' | 'high' | null,
): BannerConfig | null {
  if (!enclave) return null

  if (enclave === 'high') {
    return {
      label: 'SECRET // HIGH SIDE',
      classification: 'SECRET',
      bgClass: 'enclave-banner-secret',
    }
  }

  // Low side — always show CUI (max authorized classification)
  return {
    label: 'CUI // LOW SIDE',
    classification: 'CUI',
    bgClass: 'enclave-banner-cui',
  }
}

export default function EnclaveBanner() {
  const { enclave } = useEnclaveStore()
  const config = getBannerConfig(enclave)

  if (!config) return null

  return (
    <div className={`enclave-banner ${config.bgClass}`} role="banner" aria-label={`Classification: ${config.classification}`}>
      <span className="enclave-banner-text">
        {config.label}
      </span>
    </div>
  )
}
