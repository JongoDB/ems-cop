import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LoginPage from './pages/LoginPage'
import TicketsPage from './pages/TicketsPage'
import C2Page from './pages/C2Page'
import OperationsPage from './pages/OperationsPage'
import OperationDetailPage from './pages/OperationDetailPage'
import OverviewTab from './pages/operation-tabs/OverviewTab'
import NetworksTab from './pages/operation-tabs/NetworksTab'
import C2Tab from './pages/operation-tabs/C2Tab'
import FindingsTab from './pages/operation-tabs/FindingsTab'
import AuditTab from './pages/operation-tabs/AuditTab'
import DisplaySchemaEditor from './pages/admin/DisplaySchemaEditor'
import ProtectedRoute from './components/ProtectedRoute'
import AppLayout from './components/AppLayout'

const queryClient = new QueryClient()

function DashboardsPlaceholder() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 60,
      background: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-border)',
    }}>
      <p style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        letterSpacing: 1,
        color: 'var(--color-text-muted)',
        margin: 0,
      }}>
        Dashboards coming in M4 Phase 2
      </p>
    </div>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
            <Route path="/operations" element={<OperationsPage />} />
            <Route path="/operations/:id" element={<OperationDetailPage />}>
              <Route index element={<OverviewTab />} />
              <Route path="networks" element={<NetworksTab />} />
              <Route path="c2" element={<C2Tab />} />
              <Route path="findings" element={<FindingsTab />} />
              <Route path="audit" element={<AuditTab />} />
            </Route>
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/c2" element={<C2Page />} />
            <Route path="/dashboards" element={<DashboardsPlaceholder />} />
            <Route path="/admin/display-schemas" element={<DisplaySchemaEditor />} />
            <Route path="/" element={<Navigate to="/operations" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/operations" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
