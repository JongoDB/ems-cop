# M4c Dashboards Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Drag-and-drop dashboard system with 12 functional widgets, real-time WebSocket data, echelon templates.

**Architecture:** Three layers — ws-relay (NATS→Socket.IO), dashboard-service (CRUD API), frontend framework (react-grid-layout + lazy widgets). C2-centric build order.

**Tech Stack:** Socket.IO, react-grid-layout, xterm.js, Cytoscape.js, TipTap, Recharts, Express, pg, nats

**Design doc:** `docs/plans/2026-02-24-m4c-dashboards-design.md`

---

### Task 1: WS-Relay Service — Socket.IO + NATS Bridge

**Files:**
- Rewrite: `services/ws-relay/src/index.js`
- Modify: `services/ws-relay/package.json` (add socket.io, nats, ioredis dependencies)

**Implementation:**

Rewrite `services/ws-relay/src/index.js` with:
- Express server + Socket.IO server on port 3009
- NATS JetStream connection (from `NATS_URL` env)
- Socket.IO auth middleware: extract Bearer token from handshake, validate via HTTP call to `http://auth-service:3001/api/v1/auth/verify`
- On client `subscribe` event: join Socket.IO room for that topic, create NATS subscription if not exists for that topic pattern
- On NATS message: broadcast to all clients in matching room
- On client disconnect: leave rooms, clean up NATS subs with no listeners
- `GET /health` returns `{status: "ok", nats: connected/disconnected, clients: count}`

Install deps: `cd services/ws-relay && npm install socket.io nats ioredis`

**Verify:**
- `docker compose up -d --build ws-relay`
- Container starts and stays healthy
- Health endpoint returns connected status

---

### Task 2: WS-Relay — Terminal Proxy

**Files:**
- Modify: `services/ws-relay/src/index.js`

**Implementation:**

Add terminal proxy handlers to ws-relay:
- On `terminal.open` event with `{session_id}`: open WebSocket connection to `http://c2-gateway:3005/api/v1/c2/sessions/{session_id}/shell`
- Forward client stdin to C2 Gateway WS
- Forward C2 Gateway WS stdout back to client as `terminal.data` events
- On `terminal.close` or client disconnect: close C2 Gateway WS connection
- Track active terminal sessions per client in a Map
- Max 3 concurrent terminal sessions per client

**Verify:**
- ws-relay container rebuilds and stays healthy
- Terminal proxy code exists and handles open/close lifecycle

---

### Task 3: Dashboard Service — CRUD API

**Files:**
- Rewrite: `services/dashboard/src/index.js`
- Modify: `services/dashboard/package.json` (add pg, nats dependencies)

**Implementation:**

Rewrite `services/dashboard/src/index.js` with Express app:
- PostgreSQL pool from `POSTGRES_*` env vars
- NATS connection for event publishing
- Extract user context from `X-User-ID` and `X-User-Roles` headers (set by ForwardAuth)

Endpoints:
- `GET /api/v1/dashboards` — `SELECT * FROM dashboards WHERE owner_id = $1 OR shared_with @> $2 ORDER BY updated_at DESC`. Return `{data: [...]}`.
- `POST /api/v1/dashboards` — Insert into `dashboards` with owner_id from header. If `template` field provided, clone tabs+widgets from template dashboard. Publish `dashboard.created` to NATS.
- `GET /api/v1/dashboards/:id` — Join dashboards + dashboard_tabs + dashboard_widgets. Return nested structure: `{...dashboard, tabs: [{...tab, widgets: [...]}]}`.
- `PATCH /api/v1/dashboards/:id` — Update name, description, shared_with. Owner check.
- `DELETE /api/v1/dashboards/:id` — Cascade delete (tabs and widgets via FK). Owner check.
- `POST /api/v1/dashboards/:id/tabs` — Insert tab with next tab_order.
- `PATCH /api/v1/dashboards/:id/tabs/:tabId` — Update name, tab_order.
- `DELETE /api/v1/dashboards/:id/tabs/:tabId` — Delete tab (widgets cascade).
- `POST /api/v1/dashboards/:id/tabs/:tabId/widgets` — Insert widget with type, config, position, size.
- `PATCH /api/v1/dashboards/:id/tabs/:tabId/widgets/:wId` — Update config, position, size.
- `DELETE /api/v1/dashboards/:id/tabs/:tabId/widgets/:wId` — Delete widget.
- `PUT /api/v1/dashboards/:id/tabs/:tabId/layout` — Batch update: loop array of `{widget_id, position_x, position_y, width, height}`, update each.
- `GET /api/v1/dashboards/templates` — `SELECT * FROM dashboards WHERE is_template = true`.
- `GET /health` — health check.

Install deps: `cd services/dashboard && npm install pg nats`

**Verify:**
- `docker compose up -d --build dashboard-service`
- `curl http://localhost:18080/api/v1/dashboards` returns `{data: []}` or list
- `curl -X POST .../dashboards` creates a dashboard
- `GET .../dashboards/:id` returns nested tabs+widgets

---

### Task 4: Dashboard Service — Template Seeding

**Files:**
- Modify: `services/dashboard/src/index.js`

**Implementation:**

Add template seeding logic:
- On startup, check if template dashboards exist: `SELECT count(*) FROM dashboards WHERE is_template = true`
- If 0, seed the 5 echelon templates from the design doc:
  - **Operator template**: Terminal (L), C2 Panel (M), Command Palette (M), Network Topology (L)
  - **Tactical/E3 template**: Network Topology (L), Endpoint Table (M), Terminal (M), Ticket Queue (M)
  - **Operational/E2 template**: Ticket Queue (M), Endpoint Table (M), Metrics Chart (M), Audit Log (M)
  - **Strategic/E1 template**: Metrics Chart (L), Operation Timeline (M), Audit Log (M)
  - **Planner template**: Ticket Queue (M), Operation Timeline (M), Notes (S), Metrics Chart (M)
- Each template: insert dashboard (is_template=true, echelon_default=echelon_name), one tab "Main", widgets with positions

Add auto-seed endpoint:
- `POST /api/v1/dashboards/seed` — Called on first login to create user's default dashboard from their echelon template. Check if user has any dashboards, if not, clone from matching template.

**Verify:**
- Rebuild dashboard-service
- `GET /api/v1/dashboards/templates` returns 5 templates
- `POST /api/v1/dashboards/seed` with operator role creates dashboard with Terminal, C2 Panel, Command Palette, Network Topology widgets

---

### Task 5: Frontend — Socket.IO Store and Hook

**Files:**
- Create: `frontend/src/stores/socketStore.ts`
- Create: `frontend/src/hooks/useSocket.ts`
- Modify: `frontend/src/lib/api.ts` (add Socket.IO connection setup)

**Implementation:**

`socketStore.ts` (Zustand):
- State: `socket: Socket | null`, `connected: boolean`, `rooms: Set<string>`
- Actions: `connect(token)`, `disconnect()`, `subscribe(topic)`, `unsubscribe(topic)`
- Connect to ws-relay at `window.location.origin` with path `/ws` and auth token
- Auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)

`useSocket.ts` hook:
- Takes `topic: string` param
- On mount: subscribe to room via socketStore
- On unmount: unsubscribe
- Returns `{events: SocketEvent[], connected: boolean}`
- Keeps a buffer of last 100 events per topic

Initialize socket connection after login (in auth flow or App.tsx).

**Verify:**
- Frontend builds without errors
- Socket store exports connect/disconnect/subscribe

---

### Task 6: Frontend — Dashboard Store

**Files:**
- Create: `frontend/src/stores/dashboardStore.ts`

**Implementation:**

Zustand store with:
- State: `dashboards: Dashboard[]`, `currentDashboard: Dashboard | null`, `currentTabId: string | null`, `loading: boolean`, `layoutDirty: boolean`
- Types: `Dashboard`, `DashboardTab`, `DashboardWidget` matching API response shape
- Actions:
  - `fetchDashboards()` — GET /api/v1/dashboards
  - `fetchDashboard(id)` — GET /api/v1/dashboards/:id (with nested tabs+widgets)
  - `createDashboard(name, template?)` — POST /api/v1/dashboards
  - `updateDashboard(id, updates)` — PATCH
  - `deleteDashboard(id)` — DELETE
  - `addTab(dashboardId, name)` — POST .../tabs
  - `removeTab(dashboardId, tabId)` — DELETE
  - `addWidget(dashboardId, tabId, widget)` — POST .../widgets
  - `updateWidget(dashboardId, tabId, widgetId, updates)` — PATCH
  - `removeWidget(dashboardId, tabId, widgetId)` — DELETE
  - `updateLayout(dashboardId, tabId, layouts)` — PUT .../layout (debounced 300ms)
  - `setCurrentTab(tabId)`
  - `seedDashboard()` — POST /api/v1/dashboards/seed

**Verify:**
- Frontend builds
- Store exports all actions

---

### Task 7: Frontend — Widget Event Bus

**Files:**
- Create: `frontend/src/stores/widgetEventBus.ts`

**Implementation:**

Simple Zustand-based event bus for cross-widget communication:
- `selectSession(sessionId: string)` — C2 Panel → Terminal
- `executeCommand(command: string)` — Command Palette → Terminal
- `navigateToTicket(ticketId: string)` — Ticket Queue → router
- `navigateToEndpoint(endpointId: string)` — Endpoint Table → router
- State: `selectedSessionId`, `pendingCommand`, listeners map
- Widgets read from the store reactively

**Verify:**
- Frontend builds
- Event bus exports select/execute actions

---

### Task 8: Frontend — DashboardsPage Shell

**Files:**
- Create: `frontend/src/pages/DashboardsPage.tsx`
- Create: `frontend/src/components/dashboard/DashboardSidebar.tsx`
- Create: `frontend/src/components/dashboard/DashboardView.tsx`
- Create: `frontend/src/components/dashboard/DashboardHeader.tsx`
- Create: `frontend/src/components/dashboard/TabBar.tsx`
- Modify: `frontend/src/App.tsx` (replace DashboardsPlaceholder with DashboardsPage, add /dashboards/:id route)

**Implementation:**

`DashboardsPage.tsx`:
- Flex layout: sidebar (240px) + main area
- On mount: fetch dashboards, if none exist call seedDashboard(), select first
- Route: `/dashboards` shows first dashboard, `/dashboards/:id` shows specific

`DashboardSidebar.tsx`:
- List of dashboard names with active highlight
- "+ New Dashboard" button → create with default name
- Each item: click to select, right-click or ... button for rename/delete

`DashboardView.tsx`:
- Renders DashboardHeader + TabBar + WidgetGrid for current dashboard
- Loading state while fetching

`DashboardHeader.tsx`:
- Dashboard name (editable on double-click), share button, delete button

`TabBar.tsx`:
- Horizontal tabs from dashboard.tabs, click to switch
- "+ Add Tab" button
- Tab context menu: rename, delete

Update `App.tsx`: replace `DashboardsPlaceholder` with `DashboardsPage`, add `/dashboards/:id` route.

**Verify:**
- Frontend builds
- Navigate to `/dashboards` — shows sidebar and empty grid
- Can create/switch dashboards and tabs

---

### Task 9: Frontend — WidgetGrid and WidgetWrapper

**Files:**
- Create: `frontend/src/components/dashboard/WidgetGrid.tsx`
- Create: `frontend/src/components/dashboard/WidgetWrapper.tsx`
- Create: `frontend/src/components/dashboard/AddWidgetModal.tsx`

**Implementation:**

`WidgetGrid.tsx`:
- Uses `react-grid-layout` `<ResponsiveGridLayout>`
- 12 columns, rowHeight 80px, no free resize (only preset sizes via WidgetWrapper)
- Renders WidgetWrapper for each widget in current tab
- On layout change: call `dashboardStore.updateLayout()` with new positions
- "+" button in empty space opens AddWidgetModal

`WidgetWrapper.tsx`:
- Container with drag handle (top bar), widget name, size toggle (S/M/L buttons), fullscreen button, remove button
- Size toggle changes grid item dimensions: S=4x3, M=6x4, L=8x6
- Fullscreen toggles widget to fill viewport (CSS overlay)
- Lazy loads actual widget component from registry
- Error boundary wrapping the lazy widget

`AddWidgetModal.tsx`:
- Modal with grid of available widgets from WidgetRegistry
- Grouped by category (C2, Operations, Analytics)
- Each card: icon, name, description, default size
- Click → adds widget to current tab at next available position
- Calculates position: find first gap in grid, or append at bottom

Size presets as constants:
```typescript
const WIDGET_SIZES = {
  S: { w: 4, h: 3 },
  M: { w: 6, h: 4 },
  L: { w: 8, h: 6 },
}
```

**Verify:**
- Frontend builds
- Can add widgets from modal
- Widgets render in grid with drag handles
- Size toggle changes widget dimensions
- Layout persists via API on drag end

---

### Task 10: Terminal Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/TerminalWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts` (update terminal entry)

**Implementation:**

`TerminalWidget.tsx`:
- xterm.js `Terminal` instance with `FitAddon` and `SearchAddon`
- Session selector dropdown at top (fetches from `/api/v1/c2/sessions`)
- On session select: emit `terminal.open` via Socket.IO with `{session_id}`
- Listen for `terminal.data` events → write to xterm
- On keypress → emit `terminal.input` via Socket.IO
- Fit addon auto-resizes on container resize (ResizeObserver)
- 1000-line scrollback buffer
- Listens to `widgetEventBus.selectedSessionId` — auto-selects session when C2 Panel clicks one
- Listens to `widgetEventBus.pendingCommand` — writes command to terminal
- Dark theme matching app palette
- Handle disconnect: show "Session disconnected" overlay with reconnect button

Update WidgetRegistry: point terminal entry to new component, set minSize to 'M'.

**Verify:**
- Frontend builds
- Terminal widget renders xterm.js in the grid
- Session dropdown populates from API
- Selecting a session attempts Socket.IO connection

---

### Task 11: Sliver C2 Panel Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/SliverC2PanelWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`SliverC2PanelWidget.tsx`:
- Fetches sessions from `/api/v1/c2/sessions` on mount
- Subscribes to Socket.IO `c2.session.*` for live updates
- Renders session list table: hostname, OS icon, transport, last checkin (relative time), status badge
- Status colors: active=green, dormant=yellow, dead=red
- Click session → `widgetEventBus.selectSession(id)`
- Auto-refresh interval as fallback (30s)
- Empty state: "No active sessions" message
- Session count badge in widget header

**Verify:**
- Frontend builds
- C2 Panel renders in grid
- Shows sessions from API (or empty state)
- Clicking session updates widgetEventBus

---

### Task 12: Command Palette Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/CommandPaletteWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`CommandPaletteWidget.tsx`:
- Fetches commands from `/api/v1/c2/commands` on mount
- Search input at top with filter
- Commands grouped by category (accordion sections): recon, lateral_movement, persistence, exfiltration, general
- Each command row: name, description, risk level badge (1=green, 2=blue, 3=yellow, 4=orange, 5=red)
- Click command → `widgetEventBus.executeCommand(command.syntax)`
- Keyboard shortcut: `/` focuses search
- If no commands from API, show built-in defaults from C2 Gateway's command list

**Verify:**
- Frontend builds
- Command Palette renders in grid with searchable command list
- Click command updates widgetEventBus

---

### Task 13: Remote Desktop Widget (Shell)

**Files:**
- Rewrite: `frontend/src/components/widgets/RemoteDesktopWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`RemoteDesktopWidget.tsx`:
- Settings form: host, port (default 5900), password fields
- Settings saved to widget config via dashboardStore.updateWidget
- Main area: "Remote Desktop — Coming in M6" message with monitor icon
- Below message: connection details summary if configured
- "Test Connection" button (disabled, shows "Available in M6")
- Styled to match app theme

**Verify:**
- Frontend builds
- Remote Desktop widget renders settings form and placeholder
- Config saves to widget store

---

### Task 14: Network Topology Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/NetworkTopologyWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`NetworkTopologyWidget.tsx`:
- Embeds the existing Cytoscape.js `NetworkMap` component from `components/network-map/`
- Widget config: `operation_id` selector (dropdown of operations)
- Fetches topology from `/api/v1/networks/{networkId}/topology` for the operation's networks
- Subscribes to Socket.IO `endpoint.*` for live node status updates
- On new endpoint event: add/update node in Cytoscape graph
- Toolbar: zoom in/out, fit, layout toggle (cola/grid/circle)
- Falls back to "Select an operation" if no operation_id configured

**Verify:**
- Frontend builds
- Network Topology widget renders Cytoscape map in grid
- Operation selector works

---

### Task 15: Ticket Queue Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/TicketQueueWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`TicketQueueWidget.tsx`:
- TanStack Table with columns: title, status, priority, assignee, updated_at
- Widget config: filter presets (status, priority, assignee_id)
- Fetches from `/api/v1/tickets` with config filters as query params
- Subscribes to Socket.IO `ticket.*` — on ticket event, refetch or optimistically update
- Status badges with color coding (draft=gray, submitted=blue, in_review=yellow, approved=green, etc.)
- Click row → navigate to `/tickets/:id` (or open in panel if available)
- Compact mode: fewer columns when widget is size S
- Pagination: simple prev/next at bottom

**Verify:**
- Frontend builds
- Ticket Queue renders table with data from API
- Real-time updates via Socket.IO

---

### Task 16: Audit Log Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/AuditLogWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`AuditLogWidget.tsx`:
- Streaming log display with auto-scroll (sticks to bottom)
- Subscribes to Socket.IO `audit.events`
- Each row: timestamp (HH:mm:ss), event type badge, actor name, event summary
- Widget config: event type filter, actor filter
- Buffer: keep last 500 events in memory
- Alternating row backgrounds for readability
- Pause button to stop auto-scroll (resume on click)
- Initial load: fetch last 50 events from `/api/v1/audit/events?limit=50`

**Verify:**
- Frontend builds
- Audit Log renders event list
- New events appear in real-time via Socket.IO

---

### Task 17: Endpoint Table Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/EndpointTableWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`EndpointTableWidget.tsx`:
- Table: hostname, IP, OS, health status, last checkin, group
- Fetches from `/api/v1/endpoints` (existing endpoint-service API)
- Subscribes to Socket.IO `endpoint.*` for health updates
- Health badges: healthy=green, degraded=yellow, unreachable=red, unknown=gray
- Sortable columns (client-side sort)
- Click row → navigate to endpoint detail (future) or show tooltip
- Compact mode for size S

**Verify:**
- Frontend builds
- Endpoint Table renders with data from API
- Status badges display correctly

---

### Task 18: Metrics Chart Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/MetricsChartWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`MetricsChartWidget.tsx`:
- Recharts `ResponsiveContainer` with `LineChart` / `BarChart` / `AreaChart`
- Widget config: `chartType` (line/bar/area), `dataSource` (tickets_by_status, sessions_over_time, endpoint_health)
- Config panel: chart type selector, data source selector, time range
- Fetches aggregated data from dashboard-service (add aggregation endpoints):
  - `GET /api/v1/dashboards/metrics/tickets` — ticket counts by status
  - `GET /api/v1/dashboards/metrics/sessions` — C2 session counts over time
  - `GET /api/v1/dashboards/metrics/endpoints` — endpoint health summary
- Polls every 30s (TanStack Query refetchInterval)
- Styled with app theme colors

Add aggregation endpoints to dashboard-service.

**Verify:**
- Frontend builds
- Metrics Chart renders Recharts visualization
- Data source selector works

---

### Task 19: Operation Timeline Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/OperationTimelineWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`OperationTimelineWidget.tsx`:
- Vertical timeline with event dots and connecting line
- Widget config: `operation_id` selector
- Fetches operation data from `/api/v1/operations/:id` and audit events filtered by operation
- Timeline entries: operation created, status changes, phase transitions, approvals
- Current phase highlighted with accent color
- Each entry: timestamp, event type icon, description
- Scrollable if many events
- Empty state: "Select an operation" if no operation_id

**Verify:**
- Frontend builds
- Timeline renders for selected operation
- Phase highlighting works

---

### Task 20: Notes Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/NotesWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`NotesWidget.tsx`:
- TipTap editor with StarterKit extensions (headings, bold, italic, lists, code blocks)
- Toolbar: bold, italic, heading, bullet list, code block
- Content stored in widget config JSONB as TipTap JSON
- Auto-save: debounced (1s) PATCH to widget config on content change
- Styled to match app theme (dark editor background)
- Placeholder text: "Add notes..."

Install TipTap: `cd frontend && npm install @tiptap/react @tiptap/starter-kit @tiptap/extension-placeholder`

**Verify:**
- Frontend builds
- Notes widget renders TipTap editor
- Content persists via widget config

---

### Task 21: Plugin IFrame Widget

**Files:**
- Rewrite: `frontend/src/components/widgets/PluginIFrameWidget.tsx`
- Modify: `frontend/src/components/widgets/WidgetRegistry.ts`

**Implementation:**

`PluginIFrameWidget.tsx`:
- Widget config: `url` field
- If URL configured: render sandboxed iframe (`sandbox="allow-scripts allow-same-origin"`)
- If no URL: show config form with URL input and "Load" button
- iframe fills widget container
- Error state: if iframe fails to load, show error message
- Edit button in widget header to change URL

**Verify:**
- Frontend builds
- Plugin IFrame renders iframe or config form
- Sandbox attributes present

---

### Task 22: Echelon Template Auto-Seed

**Files:**
- Modify: `frontend/src/pages/DashboardsPage.tsx`
- Modify: `frontend/src/stores/dashboardStore.ts`

**Implementation:**

Update DashboardsPage mount logic:
1. Fetch dashboards
2. If empty array: call `POST /api/v1/dashboards/seed` with user's role from auth
3. Re-fetch dashboards
4. Select the first dashboard

Update dashboardStore: add `seedDashboard()` action that calls the seed endpoint.

**Verify:**
- New user with no dashboards gets auto-seeded dashboard on first visit
- Dashboard contains widgets matching their echelon template

---

### Task 23: Traefik Route for WS-Relay WebSocket

**Files:**
- Modify: `infra/traefik/dynamic.yml`

**Implementation:**

Add WebSocket route for ws-relay:
- Router: `ws-relay` matching `PathPrefix('/ws')`
- Service: `ws-relay` at `http://ws-relay:3009`
- Headers middleware: WebSocket upgrade headers

Ensure Socket.IO transport works through Traefik (may need to allow `polling` and `websocket` transports).

**Verify:**
- `docker compose restart traefik`
- Socket.IO client can connect through `localhost:18080/ws`

---

### Task 24: Integration Testing and Version Bump

**Files:**
- Modify: `frontend/src/version.ts` — bump to v0.7.0
- Modify: `CLAUDE.md` — update Current Progress section

**Implementation:**

Full integration test:
1. All containers healthy
2. Dashboard-service: CRUD works, templates seeded
3. WS-Relay: Socket.IO connects, NATS subscription works
4. Frontend: dashboard loads, widgets render, drag/drop works
5. Terminal widget: connects to C2 Gateway (if Sliver sessions available)
6. All 12 widgets render without errors
7. Layout persists across page reloads
8. Echelon auto-seed works for new user

Update CLAUDE.md Current Progress:
- M4c complete: dashboard system, 12 widgets, ws-relay, template seeding
- Version: v0.7.0

**Verify:**
- Full docker compose up
- All services healthy
- Dashboard end-to-end flow works
