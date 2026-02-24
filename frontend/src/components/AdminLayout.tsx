import { Outlet, Link, useLocation } from 'react-router-dom'
import { Database, FileCode } from 'lucide-react'

const ADMIN_TABS = [
  { path: '/admin/display-schemas', label: 'Display Schemas', icon: Database },
  { path: '/admin/import-parsers', label: 'Import Parsers', icon: FileCode },
]

export default function AdminLayout() {
  const location = useLocation()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={styles.tabBar}>
        {ADMIN_TABS.map(({ path, label, icon: Icon }) => {
          const active = location.pathname === path
          return (
            <Link key={path} to={path} style={{ ...styles.tab, ...(active ? styles.tabActive : {}) }}>
              <Icon size={13} />
              {label}
            </Link>
          )
        })}
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Outlet />
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  tabBar: {
    display: 'flex',
    gap: 0,
    borderBottom: '1px solid var(--color-border)',
    background: 'var(--color-bg-primary)',
    flexShrink: 0,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: 0.5,
    color: 'var(--color-text-muted)',
    textDecoration: 'none',
    borderBottom: '2px solid transparent',
    cursor: 'pointer',
  },
  tabActive: {
    color: 'var(--color-accent)',
    borderBottomColor: 'var(--color-accent)',
  },
}
