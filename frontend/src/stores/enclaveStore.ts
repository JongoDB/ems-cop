import { create } from 'zustand'

export type EnclaveLevel = 'low' | 'high' | null
export type ClassificationLevel = 'UNCLASSIFIED' | 'CUI' | 'SECRET'

interface EnclaveState {
  enclave: EnclaveLevel
  isLowSide: boolean
  isHighSide: boolean
  maxClassification: ClassificationLevel
  setEnclave: (level: EnclaveLevel) => void
}

function detectEnclave(): EnclaveLevel {
  // Check window global (set by deployment config)
  if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__ENCLAVE__) {
    const val = (window as unknown as Record<string, unknown>).__ENCLAVE__ as string
    if (val === 'low' || val === 'high') return val
  }

  // Check environment variable injected at build time
  try {
    const envVal = import.meta.env?.VITE_ENCLAVE as string | undefined
    if (envVal === 'low' || envVal === 'high') return envVal
  } catch {
    // ignore
  }

  // Default: null (single-enclave mode — all classifications visible)
  return null
}

function getMaxClassification(enclave: EnclaveLevel): ClassificationLevel {
  if (enclave === 'high') return 'SECRET'
  if (enclave === 'low') return 'CUI'
  return 'UNCLASSIFIED'
}

const initialEnclave = detectEnclave()

export const useEnclaveStore = create<EnclaveState>((set) => ({
  enclave: initialEnclave,
  isLowSide: initialEnclave === 'low',
  isHighSide: initialEnclave === 'high',
  maxClassification: getMaxClassification(initialEnclave),
  setEnclave: (level) =>
    set({
      enclave: level,
      isLowSide: level === 'low',
      isHighSide: level === 'high',
      maxClassification: getMaxClassification(level),
    }),
}))
