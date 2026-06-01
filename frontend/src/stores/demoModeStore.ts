// Demo mode store — a tiny global toggle that swaps the C2 topology page
// (and the TunnelTopologyWidget) over to a hand-curated fixture instead of
// the live API/socket data. Persisted to localStorage so it survives page
// reloads.

import { create } from 'zustand'

const STORAGE_KEY = 'ems.demoMode'

interface DemoModeState {
  enabled: boolean
  toggle: () => void
  setEnabled: (v: boolean) => void
}

function readInitial(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persist(v: boolean) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, v ? '1' : '0')
  } catch {
    // localStorage may be unavailable (private mode, quota, etc.) — ignore.
  }
}

export const useDemoModeStore = create<DemoModeState>((set, get) => ({
  enabled: readInitial(),
  toggle: () => {
    const next = !get().enabled
    persist(next)
    set({ enabled: next })
  },
  setEnabled: (v: boolean) => {
    persist(v)
    set({ enabled: v })
  },
}))
