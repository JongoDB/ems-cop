# M4c — Dashboards Design

## Goal

Drag-and-drop dashboard system with 12 functional widgets, real-time WebSocket data via ws-relay, and echelon-based templates seeded on first login.

## Architecture

Three layers:

1. **Dashboard Service** (Node/TS, port 3004) — CRUD for dashboards, tabs, widgets. PostgreSQL persistence using existing `dashboards`/`dashboard_tabs`/`dashboard_widgets` tables. Echelon template seeding.

2. **WS-Relay** (Node/TS, port 3009) — NATS JetStream → Socket.IO fan-out. Topic-based rooms. Terminal session proxy (xterm.js ↔ ws-relay ↔ C2 Gateway ↔ Sliver shell).

3. **Frontend Dashboard Framework** — `react-grid-layout` with preset widget sizes (S/M/L). Tab bar. Lazy-loaded widgets from registry. Zustand state + Socket.IO hook for live data.

## Tech Stack

- react-grid-layout, xterm.js (fit + search addons), Cytoscape.js, TipTap, Recharts, Socket.IO client
- Socket.IO server (ws-relay), Express (dashboard-service)
- NATS JetStream subscriptions, PostgreSQL (pgx for Go, pg for Node)

---

## WS-Relay Service

### Connection Flow

1. Client connects with Bearer token in handshake auth
2. ws-relay validates token via auth-service `GET /api/v1/auth/verify`
3. Client joins rooms by topic pattern: `subscribe("c2.session.*")`, `subscribe("audit.events")`
4. ws-relay maintains one NATS subscription per unique room, fans out to all Socket.IO clients in that room

### Terminal Proxy

Interactive shell sessions flow through ws-relay as a bidirectional proxy:

```
xterm.js → Socket.IO "terminal.open" {session_id}
         → ws-relay opens WS to C2 Gateway /api/v1/c2/sessions/{id}/shell
         → C2 Gateway opens Sliver interactive shell via gRPC
         → stdout streams back: C2 Gateway → ws-relay → Socket.IO → xterm.js
         → stdin flows forward: xterm.js keystroke → ws-relay → C2 Gateway → Sliver
```

On disconnect, ws-relay closes the Sliver shell session.

### NATS Subscriptions

| Topic Pattern | Widgets Consuming |
|---------------|-------------------|
| `c2.session.*` | Sliver C2 Panel, Terminal |
| `c2.command.*` | Command Palette, Audit Log |
| `ticket.*` | Ticket Queue, Audit Log |
| `audit.events` | Audit Log |
| `endpoint.*` | Endpoint Table, Network Topology |
| `operation.*` | Operation Timeline |

### Health

`GET /health` returns connection status for NATS and Socket.IO listener.

---

## Dashboard Service

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET /api/v1/dashboards` | List user's dashboards (filtered by owner_id from auth headers) |
| `POST /api/v1/dashboards` | Create dashboard (optional `template` field to clone from echelon template) |
| `GET /api/v1/dashboards/:id` | Get dashboard with tabs and widgets (joined) |
| `PATCH /api/v1/dashboards/:id` | Update name, description, sharing |
| `DELETE /api/v1/dashboards/:id` | Delete dashboard (owner only) |
| `POST /api/v1/dashboards/:id/tabs` | Add tab |
| `PATCH /api/v1/dashboards/:id/tabs/:tabId` | Update tab (rename, reorder) |
| `DELETE /api/v1/dashboards/:id/tabs/:tabId` | Delete tab (cascade deletes widgets) |
| `POST /api/v1/dashboards/:id/tabs/:tabId/widgets` | Add widget (type, config, size preset, position) |
| `PATCH /api/v1/dashboards/:id/tabs/:tabId/widgets/:wId` | Update widget (config, position, size) |
| `DELETE /api/v1/dashboards/:id/tabs/:tabId/widgets/:wId` | Remove widget |
| `PUT /api/v1/dashboards/:id/tabs/:tabId/layout` | Batch update layout (array of `{widget_id, position_x, position_y, width, height}`) |
| `GET /api/v1/dashboards/templates` | List echelon templates |

### Template Seeding

On first login (when user has no dashboards), auto-create a default dashboard from the user's highest echelon template. Five templates from WidgetRegistry:

- **Strategic (E1)** — High-level overview: metrics, operation timeline, audit log
- **Operational (E2)** — Ticket queue, endpoint table, metrics, audit log
- **Tactical (E3)** — Network topology, endpoint table, terminal, ticket queue
- **Operator** — Terminal, C2 panel, command palette, network topology
- **Planner** — Ticket queue, operation timeline, notes, metrics

### Sharing

`shared_with` JSONB column: `{"users": ["uuid1"], "roles": ["operator"]}`. Shared dashboards appear read-only unless user has `dashboard:edit` permission.

---

## Widget Specifications

### Size Presets

| Size | Grid Units (cols x rows) |
|------|--------------------------|
| S | 4 x 3 |
| M | 6 x 4 |
| L | 8 x 6 |

Grid: 12 columns. Row height: ~80px.

### C2-Centric Widgets (Priority 1)

**1. Terminal** (`terminal`)
- xterm.js with fit addon, search addon
- Session selector dropdown (from C2 Gateway `/api/v1/c2/sessions`)
- Connects via Socket.IO `terminal.open` → bidirectional stream
- Copy/paste, 1000-line scrollback
- Min: M. Default: L.

**2. Sliver C2 Panel** (`sliver_c2_panel`)
- Live session list with status indicators (active/dormant/dead)
- Real-time via Socket.IO `c2.session.*`
- Click session → emits `selectSession(id)` on widgetEventBus → terminal opens that session
- Session details: OS, hostname, transport, last checkin, PID
- Min: M. Default: M.

**3. Command Palette** (`command_palette`)
- Searchable command catalog (C2 Gateway `/api/v1/c2/commands`)
- Grouped by category (recon, lateral, persistence, exfil)
- Click → fills terminal with command syntax via widgetEventBus
- Risk level badges (1-5) with color coding
- Min: S. Default: M.

**4. Remote Desktop** (`remote_desktop`)
- M4c: Shell only — "Connection not available" placeholder with settings UI (host, port, password)
- Settings stored in widget config JSONB
- Real noVNC integration deferred to M6
- Min: M. Default: L.

### Operational Widgets (Priority 2)

**5. Network Topology** (`network_topology`)
- Embeds existing Cytoscape.js network map component
- Scoped to operation_id from widget config
- Live updates via Socket.IO `endpoint.*`
- Min: M. Default: L.

**6. Ticket Queue** (`ticket_queue`)
- TanStack Table with configurable filters (status, assignee, priority)
- Real-time via Socket.IO `ticket.*`
- Inline status transitions, click-through to detail
- Min: S. Default: M.

**7. Audit Log** (`audit_log`)
- Streaming event log with auto-scroll
- Filters in widget config: event type, actor, date range
- Real-time via Socket.IO `audit.events`
- Alternating rows, timestamp + actor + event columns
- Min: S. Default: M.

**8. Endpoint Table** (`endpoint_table`)
- Registered endpoints with health status
- Sortable: name, IP, OS, health, last checkin
- Live health via Socket.IO `endpoint.*`
- Color-coded status badges
- Min: S. Default: M.

### Analytics Widgets (Priority 3)

**9. Metrics Chart** (`metrics_chart`)
- Recharts line/bar/area chart
- Configurable data source: endpoint health over time, tickets by status, C2 sessions
- Polls aggregation endpoint (historical data, not WebSocket)
- Min: S. Default: M.

**10. Operation Timeline** (`operation_timeline`)
- Vertical timeline of operation phases/events
- Data from workflow-engine API
- Highlights current phase, approval status per stage
- Min: S. Default: M.

**11. Notes** (`notes`)
- TipTap rich text editor (markdown-compatible)
- Content saved to widget config JSONB
- Headings, lists, code blocks
- Min: S. Default: S.

**12. Plugin IFrame** (`plugin_iframe`)
- Configurable URL iframe for external tools
- Sandboxed: `allow-scripts allow-same-origin`
- URL in widget config
- Min: S. Default: M.

---

## Frontend Dashboard Framework

### Component Tree

```
DashboardsPage
├── DashboardSidebar        (dashboard list, + New button)
├── DashboardView
│   ├── DashboardHeader     (name, edit/share/delete)
│   ├── TabBar              (tabs, + Add Tab)
│   └── WidgetGrid          (react-grid-layout)
│       ├── WidgetWrapper   (drag handle, size toggle S/M/L, remove, fullscreen)
│       │   └── <LazyWidget />
│       └── AddWidgetButton (opens catalog modal)
```

### State Management (Zustand)

- `dashboardStore`: current dashboard, tabs, widgets, layout dirty flag, CRUD actions
- `socketStore`: Socket.IO connection, room subscriptions, connection status
- `widgetEventBus`: cross-widget communication (e.g., `selectSession`, `executeCommand`)

### Socket.IO Hook

```typescript
function useSocket(topic: string): SocketEvent[] {
  // Subscribes to room on mount, unsubscribes on unmount
  // Returns latest events for that topic
  // Auto-reconnect with exponential backoff
}
```

### Layout Persistence

- Drag/drop end → debounced (300ms) `PUT .../layout` batch update
- Widget config change → `PATCH .../widgets/:wId`
- Unsaved indicator on network failure, retry on reconnect

### Routes

- `/dashboards` — Dashboard list/main view (replaces placeholder)
- `/dashboards/:id` — Specific dashboard
- `/dashboards/:id/fullscreen/:widgetId` — Widget fullscreen mode

---

## Build Order

| Phase | Scope |
|-------|-------|
| 1 | WS-Relay service (NATS → Socket.IO, terminal proxy) |
| 2 | Dashboard service (CRUD API, template seeding) |
| 3 | Frontend framework (grid, tabs, widget wrapper, sidebar, catalog) |
| 4 | C2 widgets: Terminal, C2 Panel, Command Palette, Remote Desktop shell |
| 5 | Operational widgets: Network Topology, Ticket Queue, Audit Log, Endpoint Table |
| 6 | Analytics widgets: Metrics Chart, Operation Timeline, Notes, Plugin IFrame |
| 7 | Echelon templates, auto-seed on first login |
| 8 | Integration testing, CLAUDE.md update, version bump |
