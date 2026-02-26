import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LoginPage from './pages/LoginPage'
import TicketsPage from './pages/TicketsPage'
import C2Page from './pages/C2Page'
import OperationsPage from './pages/OperationsPage'
import OperationDetailPage from './pages/OperationDetailPage'
import DashboardsPage from './pages/DashboardsPage'
import OverviewTab from './pages/operation-tabs/OverviewTab'
import NetworksTab from './pages/operation-tabs/NetworksTab'
import C2Tab from './pages/operation-tabs/C2Tab'
import FindingsTab from './pages/operation-tabs/FindingsTab'
import AuditTab from './pages/operation-tabs/AuditTab'
import WorkflowTab from './pages/operation-tabs/WorkflowTab'
import DisplaySchemaEditor from './pages/admin/DisplaySchemaEditor'
import ParserWorkbench from './pages/admin/ParserWorkbench'
import WorkflowListPage from './pages/admin/WorkflowListPage'
import WorkflowEditorPage from './pages/admin/WorkflowEditorPage'
import JiraConfigPage from './pages/admin/JiraConfigPage'
import ProtectedRoute from './components/ProtectedRoute'
import AppLayout from './components/AppLayout'
import AdminLayout from './components/AdminLayout'

const queryClient = new QueryClient()

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
              <Route path="workflow" element={<WorkflowTab />} />
            </Route>
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/c2" element={<C2Page />} />
            <Route path="/dashboards" element={<DashboardsPage />} />
            <Route path="/dashboards/:id" element={<DashboardsPage />} />
            <Route path="/admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="display-schemas" replace />} />
              <Route path="display-schemas" element={<DisplaySchemaEditor />} />
              <Route path="import-parsers" element={<ParserWorkbench />} />
              <Route path="workflows" element={<WorkflowListPage />} />
              <Route path="workflows/:id" element={<WorkflowEditorPage />} />
              <Route path="jira" element={<JiraConfigPage />} />
            </Route>
            <Route path="/" element={<Navigate to="/operations" replace />} />
          </Route>
          <Route path="*" element={<Navigate to="/operations" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
