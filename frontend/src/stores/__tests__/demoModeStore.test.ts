import { describe, it, expect, beforeEach } from 'vitest'
import { useDemoModeStore } from '../demoModeStore'

const STORAGE_KEY = 'ems.demoMode'

describe('demoModeStore', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useDemoModeStore.setState({ enabled: false })
  })

  it('starts disabled by default', () => {
    expect(useDemoModeStore.getState().enabled).toBe(false)
  })

  it('toggle() flips the enabled flag', () => {
    useDemoModeStore.getState().toggle()
    expect(useDemoModeStore.getState().enabled).toBe(true)
    useDemoModeStore.getState().toggle()
    expect(useDemoModeStore.getState().enabled).toBe(false)
  })

  it('setEnabled() forces a value', () => {
    useDemoModeStore.getState().setEnabled(true)
    expect(useDemoModeStore.getState().enabled).toBe(true)
    useDemoModeStore.getState().setEnabled(false)
    expect(useDemoModeStore.getState().enabled).toBe(false)
  })

  it('toggle() persists the new value to localStorage', () => {
    useDemoModeStore.getState().toggle()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1')
    useDemoModeStore.getState().toggle()
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('0')
  })

  it('setEnabled() persists the new value to localStorage', () => {
    useDemoModeStore.getState().setEnabled(true)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1')
    useDemoModeStore.getState().setEnabled(false)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('0')
  })
})
