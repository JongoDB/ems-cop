import { Outlet, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Shield, LogOut, Crosshair, Ticket, LayoutDashboard, Settings } from 'lucide-react'
import { APP_VERSION } from '../version'

const NAV_ITEMS = [
  { path: '/operations', label: 'OPERATIONS', icon: Crosshair },
  { path: '/tickets', label: 'TICKETS', icon: Ticket },
  { path: '/dashboards', label: 'DASHBOARDS', icon: LayoutDashboard },
]

export default function AppLayout() {
  const { user, roles, logout } = useAuth()
  const location = useLocation()

  return (
    <div className="app-shell">
      <nav className="navbar">
        <div className="navbar-left">
          <Shield size={20} strokeWidth={1.5} className="navbar-icon" />
          <Link to="/operations" className="navbar-brand">EMS-COP</Link>
          <span className="navbar-version">{APP_VERSION}</span>
          <span className="navbar-sep">|</span>
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              className={`navbar-link${location.pathname.startsWith(path) ? ' active' : ''}`}
            >
              <Icon size={14} />
              {label}
            </Link>
          ))}
          {roles.includes('admin') && (
            <Link
              to="/admin/display-schemas"
              className={`navbar-link${location.pathname.startsWith('/admin') ? ' active' : ''}`}
            >
              <Settings size={14} />
              ADMIN
            </Link>
          )}
        </div>
        <div className="navbar-right">
          <div className="user-badge">
            <span className="user-name">{user?.display_name}</span>
            <div className="role-tags">
              {roles.map((role) => (
                <span key={role} className="role-tag">{role.toUpperCase()}</span>
              ))}
            </div>
          </div>
          <button onClick={logout} className="logout-btn" title="Logout">
            <LogOut size={16} />
          </button>
        </div>
      </nav>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  )
}
