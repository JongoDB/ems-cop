// Global command palette: Cmd/Ctrl+K to open. Arrow nav, Enter to invoke, Esc to close.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Search,
  ArrowRight,
  Crosshair,
  Ticket,
  LayoutDashboard,
  Terminal,
  Network,
  Bell,
  AlertTriangle,
  FileSearch,
  ArrowRightLeft,
  ScrollText,
  Settings,
  LogOut,
  Plus,
  Shield,
  Cpu,
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { apiFetch, setAccessToken } from '../lib/api'
import { useEnclaveStore } from '../stores/enclaveStore'
import { useDemoModeStore } from '../stores/demoModeStore'

type CommandIcon = typeof Search

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  icon: CommandIcon
  keywords?: string
  group: string
  run: () => void
}

interface CommandPaletteProps {
  // Optional override hooks for tests / programmatic control.
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function fuzzyMatch(query: string, command: PaletteCommand): boolean {
  if (!query) return true
  const q = query.toLowerCase().trim()
  const haystack = `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''} ${command.group}`.toLowerCase()
  // Substring match works well enough; also allow a loose char-sequence match.
  if (haystack.includes(q)) return true
  let i = 0
  for (const c of haystack) {
    if (c === q[i]) i++
    if (i >= q.length) return true
  }
  return false
}

export default function CommandPalette({ open: controlledOpen, onOpenChange }: CommandPaletteProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = useCallback(
    (v: boolean) => {
      if (onOpenChange) onOpenChange(v)
      else setInternalOpen(v)
    },
    [onOpenChange]
  )

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((s) => s.user)
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const clearAuth = useAuthStore((s) => s.clearAuth)
  const roles = user?.roles ?? []
  const enclave = useEnclaveStore((s) => s.enclave)

  const logout = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' })
    } catch {
      // best-effort
    }
    setAccessToken(null)
    clearAuth()
    navigate('/login')
  }, [clearAuth, navigate])

  // Build the command list from current app state — keeps the palette in sync
  // with the navbar in AppLayout.tsx.
  const commands = useMemo<PaletteCommand[]>(() => {
    const close = () => setOpen(false)
    const go = (path: string) => () => {
      navigate(path)
      close()
    }

    const list: PaletteCommand[] = [
      { id: 'nav-home', group: 'Navigation', label: 'Go to Home', hint: '/', icon: Shield, run: go('/') },
      { id: 'nav-operations', group: 'Navigation', label: 'Go to Operations', hint: '/operations', icon: Crosshair, keywords: 'ops missions', run: go('/operations') },
      { id: 'nav-tickets', group: 'Navigation', label: 'Go to Tickets', hint: '/tickets', icon: Ticket, run: go('/tickets') },
      { id: 'nav-dashboards', group: 'Navigation', label: 'Go to Dashboards', hint: '/dashboards', icon: LayoutDashboard, run: go('/dashboards') },
      { id: 'nav-c2', group: 'Navigation', label: 'Go to C2', hint: '/c2', icon: Terminal, keywords: 'sessions implants', run: go('/c2') },
      { id: 'nav-topology', group: 'Navigation', label: 'Go to Topology', hint: '/c2/topology', icon: Network, keywords: 'graph tunnels pivot', run: go('/c2/topology') },
      { id: 'nav-alerts', group: 'DCO', label: 'Go to Alerts', hint: '/alerts', icon: Bell, run: go('/alerts') },
      { id: 'nav-incidents', group: 'DCO', label: 'Go to Incidents', hint: '/incidents', icon: AlertTriangle, run: go('/incidents') },
      { id: 'nav-iocs', group: 'DCO', label: 'Go to IOCs', hint: '/iocs', icon: Search, keywords: 'indicators threat', run: go('/iocs') },
      { id: 'nav-findings', group: 'Navigation', label: 'Go to Findings Lineage', hint: '/findings/lineage', icon: FileSearch, run: go('/findings/lineage') },
    ]

    if (enclave) {
      list.push({
        id: 'nav-transfers',
        group: 'Navigation',
        label: 'Go to Cross-Domain Transfers',
        hint: '/transfers/approvals',
        icon: ArrowRightLeft,
        run: go('/transfers/approvals'),
      })
    }

    if (enclave === 'high' || !enclave) {
      list.push({
        id: 'nav-audit',
        group: 'Navigation',
        label: 'Go to Consolidated Audit',
        hint: '/audit/consolidated',
        icon: ScrollText,
        run: go('/audit/consolidated'),
      })
    }

    if (roles.includes('admin')) {
      list.push({
        id: 'nav-admin',
        group: 'Admin',
        label: 'Go to Admin',
        hint: '/admin',
        icon: Settings,
        run: go('/admin/display-schemas'),
      })
    }

    // Quick actions — context-aware.
    if (location.pathname.startsWith('/c2/topology')) {
      list.push({
        id: 'action-create-tunnel',
        group: 'Actions',
        label: 'Create Tunnel',
        hint: 'New C2 tunnel on this page',
        icon: Plus,
        keywords: 'new pivot portfwd socks',
        run: () => {
          // Dispatch a custom event the topology page listens for. Avoids
          // a hard import dependency from the palette into page state.
          window.dispatchEvent(new CustomEvent('ems:topology:new-tunnel'))
          close()
        },
      })
    }

    // Generate Implant — always available. Routes to the topology page if
    // we aren't already there, then dispatches an event the page listens
    // for to open the modal.
    list.push({
      id: 'action-generate-implant',
      group: 'Actions',
      label: 'Generate Implant',
      hint: 'Build a new C2 implant binary',
      icon: Cpu,
      keywords: 'new payload sliver mythic havoc binary build',
      run: () => {
        const dispatch = () =>
          window.dispatchEvent(new CustomEvent('ems:topology:generate-implant'))
        if (!location.pathname.startsWith('/c2/topology')) {
          navigate('/c2/topology')
          // Defer the dispatch until after the topology page has mounted
          // and registered its event listener.
          setTimeout(dispatch, 50)
        } else {
          dispatch()
        }
        close()
      },
    })

    list.push({
      id: 'action-toggle-demo-mode',
      group: 'Actions',
      label: 'Toggle Demo Mode',
      hint: 'Topology — example data on/off',
      icon: Network,
      keywords: 'demo example fixture topology preview offline',
      run: () => {
        useDemoModeStore.getState().toggle()
        close()
      },
    })

    list.push({
      id: 'action-logout',
      group: 'Actions',
      label: 'Logout',
      hint: 'Sign out and return to login',
      icon: LogOut,
      keywords: 'signout exit quit',
      run: () => {
        close()
        void logout()
      },
    })

    return list
  }, [navigate, setOpen, location.pathname, roles, enclave, logout])

  const filtered = useMemo(() => commands.filter((c) => fuzzyMatch(query, c)), [commands, query])

  // Group filtered commands while preserving ordering.
  const grouped = useMemo(() => {
    const map = new Map<string, PaletteCommand[]>()
    for (const c of filtered) {
      const arr = map.get(c.group) ?? []
      arr.push(c)
      map.set(c.group, arr)
    }
    return Array.from(map.entries())
  }, [filtered])

  // Keyboard: open with Cmd/Ctrl+K, close with Esc.
  // Only registers listeners when the user is authenticated and not on login.
  const enabled = isAuthenticated && location.pathname !== '/login'
  useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent) => {
      const isToggle = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)
      if (isToggle) {
        e.preventDefault()
        setOpen(!open)
        return
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled, open, setOpen])

  // Focus input + reset state when opening.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      // Defer focus to next tick so the input is mounted.
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  // Clamp active index when filtered list shrinks.
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(Math.max(0, filtered.length - 1))
    }
  }, [filtered.length, activeIndex])

  // Scroll active item into view.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLButtonElement>(`[data-cmd-index="${activeIndex}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[activeIndex]
      if (cmd) cmd.run()
    }
  }

  if (!enabled || !open) return null

  // Walking index for data-cmd-index so the highlight maps to the flat
  // filtered list (not the grouped index).
  let flatIndex = -1

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(2px)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '92vw',
          background: 'var(--color-bg-elevated)',
          border: '1px solid var(--color-border-strong)',
          borderTop: '2px solid var(--color-accent)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '70vh',
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <Search size={16} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search…"
            aria-label="Command palette search"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--color-text-bright)',
              fontFamily: 'var(--font-body)',
              fontSize: 14,
            }}
          />
          <kbd
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              padding: '2px 6px',
              border: '1px solid var(--color-border-strong)',
              borderRadius: 'var(--radius)',
              color: 'var(--color-text-muted)',
              background: 'var(--color-bg-surface)',
            }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          style={{
            overflowY: 'auto',
            maxHeight: '55vh',
            padding: '6px 0',
          }}
        >
          {filtered.length === 0 && (
            <div
              style={{
                padding: '24px 16px',
                textAlign: 'center',
                color: 'var(--color-text-muted)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                letterSpacing: 0.5,
              }}
            >
              No commands match “{query}”
            </div>
          )}

          {grouped.map(([group, items]) => (
            <div key={group}>
              <div
                style={{
                  padding: '6px 14px 4px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  letterSpacing: 1.2,
                  textTransform: 'uppercase',
                  color: 'var(--color-text-muted)',
                }}
              >
                {group}
              </div>
              {items.map((cmd) => {
                flatIndex++
                const idx = flatIndex
                const active = idx === activeIndex
                const Icon = cmd.icon
                return (
                  <button
                    key={cmd.id}
                    data-cmd-index={idx}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={() => cmd.run()}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 14px',
                      background: active ? 'var(--color-bg-hover)' : 'transparent',
                      border: 'none',
                      borderLeft: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
                      cursor: 'pointer',
                      textAlign: 'left',
                      color: active ? 'var(--color-text-bright)' : 'var(--color-text)',
                      fontFamily: 'var(--font-body)',
                      fontSize: 13,
                    }}
                  >
                    <Icon
                      size={14}
                      style={{ color: active ? 'var(--color-accent)' : 'var(--color-text-muted)', flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>{cmd.label}</span>
                    {cmd.hint && (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          color: 'var(--color-text-muted)',
                          letterSpacing: 0.4,
                        }}
                      >
                        {cmd.hint}
                      </span>
                    )}
                    {active && <ArrowRight size={12} style={{ color: 'var(--color-accent)' }} />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 14px',
            borderTop: '1px solid var(--color-border)',
            background: 'var(--color-bg-surface)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: 0.4,
            color: 'var(--color-text-muted)',
          }}
        >
          <span>{filtered.length} result{filtered.length === 1 ? '' : 's'}</span>
          <span>
            <kbd style={kbdStyle}>↑↓</kbd> navigate <kbd style={kbdStyle}>↵</kbd> select
          </span>
        </div>
      </div>
    </div>
  )
}

const kbdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  padding: '1px 5px',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 'var(--radius)',
  color: 'var(--color-text-muted)',
  background: 'var(--color-bg-elevated)',
  margin: '0 3px',
}
