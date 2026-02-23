import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { apiFetch } from '../lib/api'
import { Shield, Ticket, LogOut, ChevronRight } from 'lucide-react'

interface TicketSummary {
  status: string
  count: number
}

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  draft: { label: 'DRAFT', color: 'var(--color-muted)' },
  submitted: { label: 'SUBMITTED', color: 'var(--color-info)' },
  in_review: { label: 'IN REVIEW', color: 'var(--color-warning)' },
  approved: { label: 'APPROVED', color: 'var(--color-success)' },
  rejected: { label: 'REJECTED', color: 'var(--color-danger)' },
  in_progress: { label: 'IN PROGRESS', color: 'var(--color-accent)' },
  paused: { label: 'PAUSED', color: 'var(--color-warning)' },
  completed: { label: 'COMPLETED', color: 'var(--color-success)' },
  closed: { label: 'CLOSED', color: 'var(--color-muted)' },
  cancelled: { label: 'CANCELLED', color: 'var(--color-muted)' },
}

export default function HomePage() {
  const { user, roles, logout } = useAuth()
  const [ticketCounts, setTicketCounts] = useState<TicketSummary[]>([])

  useEffect(() => {
    // Fetch ticket counts by status
    const statuses = Object.keys(STATUS_CONFIG)
    Promise.all(
      statuses.map((status) =>
        apiFetch<{ pagination: { total: number } }>(`/tickets?status=${status}&limit=1`)
          .then((data) => ({ status, count: data.pagination.total }))
          .catch(() => ({ status, count: 0 }))
      )
    ).then(setTicketCounts)
  }, [])

  const totalTickets = ticketCounts.reduce((sum, tc) => sum + tc.count, 0)
  const activeTickets = ticketCounts
    .filter((tc) => ['in_progress', 'in_review', 'submitted'].includes(tc.status))
    .reduce((sum, tc) => sum + tc.count, 0)

  return (
    <div className="app-shell">
      {/* Navbar */}
      <nav className="navbar">
        <div className="navbar-left">
          <Shield size={20} strokeWidth={1.5} className="navbar-icon" />
          <span className="navbar-brand">EMS-COP</span>
          <span className="navbar-sep">|</span>
          <Link to="/tickets" className="navbar-link">
            <Ticket size={14} />
            TICKETS
          </Link>
        </div>
        <div className="navbar-right">
          <div className="user-badge">
            <span className="user-name">{user?.display_name}</span>
            <div className="role-tags">
              {roles.map((role) => (
                <span key={role} className="role-tag">
                  {role.toUpperCase()}
                </span>
              ))}
            </div>
          </div>
          <button onClick={logout} className="logout-btn" title="Logout">
            <LogOut size={16} />
          </button>
        </div>
      </nav>

      {/* Main Content */}
      <main className="main-content">
        <div className="home-grid">
          {/* Welcome Section */}
          <section className="welcome-section">
            <div className="welcome-header">
              <h1 className="welcome-title">
                WELCOME, <span className="accent-text">{user?.display_name?.toUpperCase()}</span>
              </h1>
              <p className="welcome-sub">
                SESSION ACTIVE &bull; {new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC
              </p>
            </div>
          </section>

          {/* Quick Stats */}
          <section className="stats-row">
            <div className="stat-card">
              <span className="stat-value">{totalTickets}</span>
              <span className="stat-label">TOTAL TICKETS</span>
            </div>
            <div className="stat-card stat-active">
              <span className="stat-value">{activeTickets}</span>
              <span className="stat-label">ACTIVE</span>
            </div>
          </section>

          {/* Ticket Queue Summary */}
          <section className="queue-section">
            <div className="section-header">
              <h2 className="section-title">TICKET QUEUE</h2>
              <Link to="/tickets" className="section-action">
                VIEW ALL <ChevronRight size={14} />
              </Link>
            </div>
            <div className="queue-grid">
              {ticketCounts.map((tc) => {
                const cfg = STATUS_CONFIG[tc.status]
                if (!cfg || tc.count === 0) return null
                return (
                  <Link
                    key={tc.status}
                    to={`/tickets?status=${tc.status}`}
                    className="queue-item"
                  >
                    <span className="queue-indicator" style={{ backgroundColor: cfg.color }} />
                    <span className="queue-label">{cfg.label}</span>
                    <span className="queue-count">{tc.count}</span>
                  </Link>
                )
              })}
              {ticketCounts.every((tc) => tc.count === 0) && (
                <p className="queue-empty">No tickets in queue</p>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
