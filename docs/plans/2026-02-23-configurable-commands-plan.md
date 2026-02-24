# Configurable Command Presets — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded C2 quick-command buttons with a persistent, OS-aware command library with admin global and user personal presets.

**Architecture:** New `command_presets` table in PostgreSQL. CRUD endpoints added to the existing ticket-service (Node/Express). Frontend C2Page fetches presets by OS, renders dynamic grid with add/edit/delete. Audit events via NATS.

**Tech Stack:** PostgreSQL, Node/Express (ticket-service), React/TypeScript (frontend), NATS (audit events), Traefik (routing)

---

### Task 1: Database Migration

**Files:**
- Create: `infra/db/postgres/migrations/003_command_presets.sql`

**Step 1: Write the migration file**

```sql
-- EMS-COP PostgreSQL Schema
-- Migration 003: Command presets table + seed data
-- Depends on: 001_core_schema.sql

-- ════════════════════════════════════════════
--  COMMAND PRESETS TABLE
-- ════════════════════════════════════════════

CREATE TABLE command_presets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    command     TEXT NOT NULL,
    description TEXT DEFAULT '',
    os          VARCHAR(20) NOT NULL CHECK (os IN ('linux', 'windows', 'macos')),
    scope       VARCHAR(10) NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'user')),
    created_by  UUID REFERENCES users(id),
    sort_order  INT DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_command_presets_os_scope ON command_presets(os, scope);
CREATE INDEX idx_command_presets_created_by ON command_presets(created_by);

-- Apply the updated_at trigger (already defined in 001 as set_updated_at)
CREATE TRIGGER trg_command_presets_updated
    BEFORE UPDATE ON command_presets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ════════════════════════════════════════════
--  SEED DATA — Linux (12 commands)
-- ════════════════════════════════════════════

INSERT INTO command_presets (name, command, description, os, scope, sort_order) VALUES
('List Files',    'ls',               'List directory contents',            'linux', 'global', 10),
('Processes',     'ps aux',           'Running processes with details',     'linux', 'global', 20),
('Current User',  'whoami',           'Current username',                   'linux', 'global', 30),
('Working Dir',   'pwd',              'Print working directory',            'linux', 'global', 40),
('User/Groups',   'id',              'User and group IDs',                  'linux', 'global', 50),
('Interfaces',    'ifconfig',         'Network interface config',           'linux', 'global', 60),
('Open Ports',    'ss -tlnp',         'Listening TCP ports with process',   'linux', 'global', 70),
('System Info',   'uname -a',         'Kernel and system info',             'linux', 'global', 80),
('Users',         'cat /etc/passwd',  'Local user accounts',                'linux', 'global', 90),
('OS Info',       'cat /etc/os-release', 'OS release details',              'linux', 'global', 100),
('Disk Usage',    'df -h',            'Filesystem disk usage',              'linux', 'global', 110),
('Environment',   'env',              'Environment variables',              'linux', 'global', 120);

-- ════════════════════════════════════════════
--  SEED DATA — Windows (12 commands)
-- ════════════════════════════════════════════

INSERT INTO command_presets (name, command, description, os, scope, sort_order) VALUES
('List Files',    'dir',                           'List directory contents',        'windows', 'global', 10),
('Current User',  'whoami',                        'Current username',               'windows', 'global', 20),
('Privileges',    'whoami /priv',                  'Current user privileges',        'windows', 'global', 30),
('Interfaces',    'ipconfig',                      'Network interface config',       'windows', 'global', 40),
('Open Ports',    'Get-NetTCPConnection',          'Active TCP connections',         'windows', 'global', 50),
('System Info',   'systeminfo',                    'Detailed system information',    'windows', 'global', 60),
('Processes',     'tasklist',                      'Running processes',              'windows', 'global', 70),
('Local Users',   'net user',                      'Local user accounts',            'windows', 'global', 80),
('Local Admins',  'net localgroup administrators', 'Local admin group members',      'windows', 'global', 90),
('Processes PS',  'Get-Process',                   'PowerShell process list',        'windows', 'global', 100),
('Hostname',      'hostname',                      'Computer name',                  'windows', 'global', 110),
('Environment',   'set',                           'Environment variables',          'windows', 'global', 120);

-- ════════════════════════════════════════════
--  SEED DATA — macOS (12 commands)
-- ════════════════════════════════════════════

INSERT INTO command_presets (name, command, description, os, scope, sort_order) VALUES
('List Files',     'ls',                  'List directory contents',          'macos', 'global', 10),
('Processes',      'ps aux',              'Running processes with details',   'macos', 'global', 20),
('Current User',   'whoami',              'Current username',                 'macos', 'global', 30),
('Working Dir',    'pwd',                 'Print working directory',          'macos', 'global', 40),
('User/Groups',    'id',                  'User and group IDs',              'macos', 'global', 50),
('Interfaces',     'ifconfig',            'Network interface config',         'macos', 'global', 60),
('Open Ports',     'netstat -an',         'Network connections and ports',    'macos', 'global', 70),
('System Info',    'uname -a',            'Kernel and system info',           'macos', 'global', 80),
('macOS Version',  'sw_vers',             'macOS version details',            'macos', 'global', 90),
('Users',          'dscl . list /Users',  'Local user accounts',              'macos', 'global', 100),
('Disk Usage',     'df -h',               'Filesystem disk usage',            'macos', 'global', 110),
('Environment',    'env',                 'Environment variables',            'macos', 'global', 120);
```

**Step 2: Apply the migration**

Run: `docker compose exec postgres psql -U ems -d ems_cop -f /docker-entrypoint-initdb.d/003_command_presets.sql`

But first, the migration file must be volume-mounted. Check `docker-compose.yml` for the postgres volume mount pattern. The migrations are likely mounted at `/docker-entrypoint-initdb.d/`. If so, the migration runs on fresh init only. For an existing DB, run it manually:

```bash
docker compose cp infra/db/postgres/migrations/003_command_presets.sql postgres:/tmp/003.sql
docker compose exec postgres psql -U ems -d ems_cop -f /tmp/003.sql
```

Expected: `CREATE TABLE`, `CREATE INDEX` x2, `CREATE TRIGGER`, `INSERT 0 12` x3

**Step 3: Verify**

```bash
docker compose exec postgres psql -U ems -d ems_cop -c "SELECT os, COUNT(*) FROM command_presets GROUP BY os ORDER BY os;"
```

Expected:
```
   os    | count
---------+-------
 linux   |    12
 macos   |    12
 windows |    12
```

**Step 4: Commit**

```bash
git add infra/db/postgres/migrations/003_command_presets.sql
git commit -m "feat: add command_presets table and seed data (36 OS-specific defaults)"
```

---

### Task 2: Traefik Route for Commands API

**Files:**
- Modify: `infra/traefik/dynamic.yml`

**Step 1: Add the commands router**

In the `ROUTERS — PROTECTED` section (after the `ticket` router at line ~76), add:

```yaml
    commands:
      rule: "PathPrefix(`/api/v1/commands`)"
      entryPoints: [web]
      service: ticket
      middlewares: [auth-verify, cors-headers]
      priority: 50
```

This routes `/api/v1/commands/*` to the ticket-service (same backend, port 3003). No new service needed.

**Step 2: Verify Traefik picks up the route**

```bash
curl -s http://localhost:18080/api/v1/commands/presets 2>&1 | head -5
```

Expected: 401 Unauthorized (no auth token) — confirms the route exists and ForwardAuth is active. If you get a 404, Traefik hasn't reloaded — restart it:

```bash
docker compose restart traefik
```

**Step 3: Commit**

```bash
git add infra/traefik/dynamic.yml
git commit -m "feat: add Traefik route for /api/v1/commands to ticket-service"
```

---

### Task 3: Command Presets API in Ticket Service

**Files:**
- Modify: `services/ticket/src/index.js`

**Step 1: Add the four endpoints**

Insert the following routes after the `LIST COMMENTS` route (after line 333) and before the `--- Start ---` section. The existing `getUserContext`, `sendError`, `publishEvent`, and `pool` helpers are already available.

```javascript
// ════════════════════════════════════════════
//  COMMAND PRESETS
// ════════════════════════════════════════════

// LIST PRESETS (global + user's personal for given OS)
app.get('/api/v1/commands/presets', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const os = (req.query.os || 'linux').toLowerCase();
  if (!['linux', 'windows', 'macos'].includes(os)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid OS. Must be linux, windows, or macos');
  }

  try {
    const result = await pool.query(
      `SELECT * FROM command_presets
       WHERE os = $1 AND (scope = 'global' OR (scope = 'user' AND created_by = $2))
       ORDER BY sort_order ASC, name ASC`,
      [os, userId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[ticket] list presets error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list command presets');
  }
});

// CREATE PRESET
app.post('/api/v1/commands/presets', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const { name, command, description, os, scope } = req.body;
  if (!name || !command || !os) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'name, command, and os are required');
  }
  if (!['linux', 'windows', 'macos'].includes(os)) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'Invalid OS. Must be linux, windows, or macos');
  }

  const presetScope = scope || 'user';
  if (presetScope === 'global' && !roles.includes('admin')) {
    return sendError(res, 403, 'FORBIDDEN', 'Only admins can create global presets');
  }

  try {
    const result = await pool.query(
      `INSERT INTO command_presets (name, command, description, os, scope, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, command, description || '', os, presetScope, presetScope === 'global' ? null : userId]
    );
    const preset = result.rows[0];
    publishEvent('command_preset.created', userId, null, preset.id, { name, os, scope: presetScope });
    res.status(201).json({ data: preset });
  } catch (err) {
    console.error('[ticket] create preset error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create command preset');
  }
});

// UPDATE PRESET
app.patch('/api/v1/commands/presets/:id', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  try {
    const existing = await pool.query('SELECT * FROM command_presets WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Preset not found');
    }

    const preset = existing.rows[0];
    if (preset.scope === 'global' && !roles.includes('admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Only admins can edit global presets');
    }
    if (preset.scope === 'user' && preset.created_by !== userId) {
      return sendError(res, 403, 'FORBIDDEN', 'Cannot edit another user\'s preset');
    }

    const allowed = ['name', 'command', 'description', 'sort_order'];
    const sets = [];
    const params = [];
    let paramIdx = 1;

    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = $${paramIdx++}`);
        params.push(req.body[field]);
      }
    }
    if (sets.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    }

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE command_presets SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    publishEvent('command_preset.updated', userId, null, req.params.id, { fields: Object.keys(req.body) });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[ticket] update preset error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update command preset');
  }
});

// DELETE PRESET
app.delete('/api/v1/commands/presets/:id', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  try {
    const existing = await pool.query('SELECT * FROM command_presets WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Preset not found');
    }

    const preset = existing.rows[0];
    if (preset.scope === 'global' && !roles.includes('admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Only admins can delete global presets');
    }
    if (preset.scope === 'user' && preset.created_by !== userId) {
      return sendError(res, 403, 'FORBIDDEN', 'Cannot delete another user\'s preset');
    }

    await pool.query('DELETE FROM command_presets WHERE id = $1', [req.params.id]);
    publishEvent('command_preset.deleted', userId, null, req.params.id, { name: preset.name, os: preset.os });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error('[ticket] delete preset error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete command preset');
  }
});
```

Also update the `publishEvent` function to handle `command_preset` resource type. Change line 54 from:

```javascript
    resource_type: 'ticket',
```

to:

```javascript
    resource_type: eventType.startsWith('command_preset') ? 'command_preset' : 'ticket',
```

**Step 2: Rebuild ticket-service**

```bash
docker compose up -d --build ticket-service
```

**Step 3: Verify the endpoints**

First get a JWT token:
```bash
TOKEN=$(curl -s http://localhost:18080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme"}' | jq -r '.access_token')
```

List Linux presets:
```bash
curl -s http://localhost:18080/api/v1/commands/presets?os=linux \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'
```
Expected: `12`

Create a personal preset:
```bash
curl -s http://localhost:18080/api/v1/commands/presets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test CMD","command":"echo hello","os":"linux","scope":"user"}' | jq '.data.name'
```
Expected: `"Test CMD"`

List again (should now be 13):
```bash
curl -s http://localhost:18080/api/v1/commands/presets?os=linux \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'
```
Expected: `13`

Delete the test preset (use the ID from the create response):
```bash
PRESET_ID=$(curl -s http://localhost:18080/api/v1/commands/presets?os=linux \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data[-1].id')
curl -s -X DELETE http://localhost:18080/api/v1/commands/presets/$PRESET_ID \
  -H "Authorization: Bearer $TOKEN" | jq
```
Expected: `{ "data": { "deleted": true } }`

**Step 4: Commit**

```bash
git add services/ticket/src/index.js
git commit -m "feat: add command presets CRUD endpoints to ticket-service"
```

---

### Task 4: Audit Service — Subscribe to command_preset Events

**Files:**
- Modify: `services/audit/main.go:117`

**Step 1: Add subscription**

On line 117, the `subjects` slice lists NATS subscriptions. Add `"command_preset.>"`:

Change:
```go
subjects := []string{"auth.>", "ticket.>", "workflow.>", "operation.>", "c2.>", "endpoint.>"}
```

To:
```go
subjects := []string{"auth.>", "ticket.>", "workflow.>", "operation.>", "c2.>", "endpoint.>", "command_preset.>"}
```

**Step 2: Rebuild audit-service**

```bash
docker compose up -d --build audit-service
```

**Step 3: Verify**

Check audit-service logs show the new subscription:
```bash
docker compose logs audit-service --tail 20 2>&1 | grep command_preset
```

Expected: log line containing `"subject":"command_preset.>"`

**Step 4: Commit**

```bash
git add services/audit/main.go
git commit -m "feat: subscribe audit-service to command_preset events"
```

---

### Task 5: Frontend — Dynamic Command Grid

**Files:**
- Modify: `frontend/src/pages/C2Page.tsx`

This is the largest task. It replaces the hardcoded `QUICK_COMMANDS` array with a dynamic grid fetched from the API, and adds add/edit/delete UI.

**Step 1: Update the C2Page component**

Replace the entire `C2Page.tsx` with the updated version. Key changes:

1. Remove the `QUICK_COMMANDS` constant (line 28)
2. Add a `CommandPreset` interface
3. Add state for presets, add/edit modal
4. Add `fetchPresets` function that calls `GET /api/v1/commands/presets?os={detected_os}`
5. Add OS detection helper: `detectOS(session.os)` → `'linux' | 'windows' | 'macos'`
6. Fetch presets when `selectedSession` changes (and OS is known)
7. Replace the hardcoded button grid with preset-based buttons
8. Add `+` button to open an add modal
9. Add right-click context menu for edit/delete
10. Fallback to basic commands if API fails

Here is the full updated component:

```tsx
import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { apiFetch } from '../lib/api'
import {
  Shield, Ticket, LogOut, Terminal, RefreshCw, Wifi, WifiOff,
  Plus, Lock, Pencil, Trash2, X,
} from 'lucide-react'
import { APP_VERSION } from '../version'
import TerminalPanel from '../components/TerminalPanel'

interface C2Session {
  id: string
  implant_id: string
  hostname: string
  os: string
  arch: string
  remote_addr: string
  transport: string
  is_alive: boolean
  last_message: string
}

interface CommandResult {
  output: string
  error: string
}

interface CommandPreset {
  id: string
  name: string
  command: string
  description: string
  os: string
  scope: string
  created_by: string | null
  sort_order: number
}

const FALLBACK_COMMANDS: CommandPreset[] = [
  { id: 'f1', name: 'ls', command: 'ls', description: 'List files', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f2', name: 'ps', command: 'ps', description: 'Processes', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f3', name: 'whoami', command: 'whoami', description: 'Current user', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f4', name: 'pwd', command: 'pwd', description: 'Working directory', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f5', name: 'ifconfig', command: 'ifconfig', description: 'Interfaces', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
  { id: 'f6', name: 'netstat', command: 'netstat', description: 'Network stats', os: 'linux', scope: 'global', created_by: null, sort_order: 0 },
]

function detectOS(os: string): 'linux' | 'windows' | 'macos' {
  const lower = os.toLowerCase()
  if (lower.includes('windows')) return 'windows'
  if (lower.includes('darwin') || lower.includes('macos') || lower.includes('mac')) return 'macos'
  return 'linux'
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = Math.max(0, now - then)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function osLabel(os: string): string {
  const lower = os.toLowerCase()
  if (lower.includes('linux')) return 'Linux'
  if (lower.includes('windows')) return 'Windows'
  if (lower.includes('darwin') || lower.includes('macos') || lower.includes('mac')) return 'macOS'
  return os || 'Unknown'
}

export default function C2Page() {
  const { user, roles, logout } = useAuth()
  const [sessions, setSessions] = useState<C2Session[]>([])
  const [selectedSession, setSelectedSession] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'terminal' | 'commands'>('terminal')
  const [commandOutput, setCommandOutput] = useState<string>('')
  const [commandLoading, setCommandLoading] = useState(false)
  const [loading, setLoading] = useState(true)

  // Command presets
  const [presets, setPresets] = useState<CommandPreset[]>([])
  const [showPresetModal, setShowPresetModal] = useState(false)
  const [editingPreset, setEditingPreset] = useState<CommandPreset | null>(null)
  const [presetForm, setPresetForm] = useState({ name: '', command: '', description: '', scope: 'user' })

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; preset: CommandPreset } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const isAdmin = roles.includes('admin')

  const fetchSessions = useCallback(async () => {
    try {
      const data = await apiFetch<C2Session[]>('/c2/sessions')
      setSessions(Array.isArray(data) ? data : [])
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  const selectedSessionData = sessions.find((s) => s.id === selectedSession)
  const sessionOS = selectedSessionData ? detectOS(selectedSessionData.os) : 'linux'

  const fetchPresets = useCallback(async () => {
    try {
      const data = await apiFetch<{ data: CommandPreset[] }>(`/commands/presets?os=${sessionOS}`)
      setPresets(data.data && data.data.length > 0 ? data.data : FALLBACK_COMMANDS)
    } catch {
      setPresets(FALLBACK_COMMANDS)
    }
  }, [sessionOS])

  // Initial fetch and polling for sessions
  useEffect(() => {
    fetchSessions()
    const interval = setInterval(fetchSessions, 10000)
    return () => clearInterval(interval)
  }, [fetchSessions])

  // Fetch presets when session changes
  useEffect(() => {
    if (selectedSession) {
      fetchPresets()
    }
  }, [selectedSession, fetchPresets])

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => setContextMenu(null)
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

  const executeCommand = async (command: string) => {
    if (!selectedSession) return
    setCommandLoading(true)
    setCommandOutput((prev) => prev + `\n$ ${command}\n`)
    try {
      const result = await apiFetch<CommandResult>(
        `/c2/sessions/${selectedSession}/execute`,
        {
          method: 'POST',
          body: JSON.stringify({ command }),
        }
      )
      if (result.error) {
        setCommandOutput((prev) => prev + `[ERROR] ${result.error}\n`)
      } else {
        setCommandOutput((prev) => prev + (result.output || '(no output)\n'))
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Command failed'
      setCommandOutput((prev) => prev + `[ERROR] ${msg}\n`)
    } finally {
      setCommandLoading(false)
    }
  }

  const handlePresetSubmit = async () => {
    if (!presetForm.name || !presetForm.command) return

    try {
      if (editingPreset) {
        await apiFetch(`/commands/presets/${editingPreset.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: presetForm.name,
            command: presetForm.command,
            description: presetForm.description,
          }),
        })
      } else {
        await apiFetch('/commands/presets', {
          method: 'POST',
          body: JSON.stringify({
            name: presetForm.name,
            command: presetForm.command,
            description: presetForm.description,
            os: sessionOS,
            scope: presetForm.scope,
          }),
        })
      }
      setShowPresetModal(false)
      setEditingPreset(null)
      setPresetForm({ name: '', command: '', description: '', scope: 'user' })
      fetchPresets()
    } catch (err) {
      console.error('Failed to save preset:', err)
    }
  }

  const handleDeletePreset = async (preset: CommandPreset) => {
    if (!confirm(`Delete "${preset.name}"?`)) return
    try {
      await apiFetch(`/commands/presets/${preset.id}`, { method: 'DELETE' })
      fetchPresets()
    } catch (err) {
      console.error('Failed to delete preset:', err)
    }
  }

  const openEditModal = (preset: CommandPreset) => {
    setEditingPreset(preset)
    setPresetForm({
      name: preset.name,
      command: preset.command,
      description: preset.description,
      scope: preset.scope,
    })
    setShowPresetModal(true)
    setContextMenu(null)
  }

  const openAddModal = () => {
    setEditingPreset(null)
    setPresetForm({ name: '', command: '', description: '', scope: 'user' })
    setShowPresetModal(true)
  }

  const canEditPreset = (preset: CommandPreset) => {
    if (preset.scope === 'global') return isAdmin
    return preset.created_by === user?.id
  }

  const aliveSessions = sessions.filter((s) => s.is_alive).length

  return (
    <div className="app-shell">
      {/* Navbar */}
      <nav className="navbar">
        <div className="navbar-left">
          <Shield size={20} strokeWidth={1.5} className="navbar-icon" />
          <Link to="/" className="navbar-brand">EMS-COP</Link>
          <span className="navbar-version">{APP_VERSION}</span>
          <span className="navbar-sep">|</span>
          <Link to="/tickets" className="navbar-link">
            <Ticket size={14} />
            TICKETS
          </Link>
          <Link to="/c2" className="navbar-link active">
            <Terminal size={14} />
            C2
          </Link>
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

      {/* C2 Layout */}
      <div className="c2-layout">
        {/* Left Sidebar — Sessions */}
        <aside className="c2-sidebar">
          <div className="c2-sidebar-header">
            <h2 className="c2-sidebar-title">SESSIONS</h2>
            <div className="c2-sidebar-meta">
              <span className="c2-session-count">
                {aliveSessions} / {sessions.length} alive
              </span>
              <button
                onClick={fetchSessions}
                className="c2-refresh-btn"
                title="Refresh sessions"
              >
                <RefreshCw size={12} />
              </button>
            </div>
          </div>

          <div className="c2-session-list">
            {loading ? (
              <div className="c2-session-empty">Loading sessions...</div>
            ) : sessions.length === 0 ? (
              <div className="c2-session-empty">No sessions found</div>
            ) : (
              sessions.map((session) => (
                <button
                  key={session.id}
                  className={`session-item ${selectedSession === session.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedSession(session.id)
                    setCommandOutput('')
                  }}
                >
                  <div className="session-item-top">
                    <span
                      className="session-status"
                      style={{
                        backgroundColor: session.is_alive
                          ? 'var(--color-success)'
                          : 'var(--color-danger)',
                      }}
                    />
                    <span className="session-hostname">{session.hostname || session.implant_id || session.id.slice(0, 8)}</span>
                    {session.is_alive ? (
                      <Wifi size={10} className="session-alive-icon" />
                    ) : (
                      <WifiOff size={10} className="session-dead-icon" />
                    )}
                  </div>
                  <div className="session-info">
                    <span className="session-os">{osLabel(session.os)}</span>
                    <span className="session-sep">&middot;</span>
                    <span className="session-addr">{session.remote_addr || '—'}</span>
                  </div>
                  <div className="session-info">
                    <span className="session-last-seen">{timeAgo(session.last_message)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        {/* Right Panel */}
        <div className="c2-main">
          {/* Session header */}
          {selectedSessionData && (
            <div className="c2-session-banner">
              <span
                className="session-status"
                style={{
                  backgroundColor: selectedSessionData.is_alive
                    ? 'var(--color-success)'
                    : 'var(--color-danger)',
                }}
              />
              <span className="c2-banner-host">{selectedSessionData.hostname}</span>
              <span className="c2-banner-detail">
                {osLabel(selectedSessionData.os)} &middot; {selectedSessionData.arch} &middot; {selectedSessionData.transport} &middot; {selectedSessionData.remote_addr}
              </span>
            </div>
          )}

          {/* Tabs */}
          <div className="c2-tabs">
            <button
              className={`c2-tab ${activeTab === 'terminal' ? 'active' : ''}`}
              onClick={() => setActiveTab('terminal')}
            >
              <Terminal size={12} />
              TERMINAL
            </button>
            <button
              className={`c2-tab ${activeTab === 'commands' ? 'active' : ''}`}
              onClick={() => setActiveTab('commands')}
            >
              COMMANDS
            </button>
          </div>

          {/* Tab Content */}
          <div className="c2-tab-content">
            {activeTab === 'terminal' ? (
              <TerminalPanel sessionId={selectedSession} />
            ) : (
              <div className="c2-commands-panel">
                {!selectedSession ? (
                  <div className="terminal-placeholder">
                    <div className="terminal-placeholder-content">
                      <p className="terminal-placeholder-text">Select a session to execute commands</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="cmd-grid">
                      {presets.map((preset) => (
                        <button
                          key={preset.id}
                          className="cmd-btn"
                          onClick={() => executeCommand(preset.command)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            if (canEditPreset(preset)) {
                              setContextMenu({ x: e.clientX, y: e.clientY, preset })
                            }
                          }}
                          disabled={commandLoading}
                          title={`${preset.description}\n\n$ ${preset.command}`}
                        >
                          {preset.scope === 'global' && <Lock size={8} className="cmd-scope-icon" />}
                          {preset.name}
                        </button>
                      ))}
                      <button
                        className="cmd-btn cmd-add-btn"
                        onClick={openAddModal}
                        title="Add custom command"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    <div className="cmd-output-wrap">
                      <div className="cmd-output-header">
                        <span>OUTPUT</span>
                        {commandLoading && <span className="cmd-loading">Executing...</span>}
                      </div>
                      <pre className="cmd-output">
                        {commandOutput || 'Click a command button to execute...'}
                      </pre>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="cmd-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className="cmd-context-item"
            onClick={() => openEditModal(contextMenu.preset)}
          >
            <Pencil size={12} /> Edit
          </button>
          <button
            className="cmd-context-item cmd-context-danger"
            onClick={() => {
              handleDeletePreset(contextMenu.preset)
              setContextMenu(null)
            }}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}

      {/* Add/Edit Preset Modal */}
      {showPresetModal && (
        <div className="modal-overlay" onClick={() => setShowPresetModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{editingPreset ? 'EDIT COMMAND' : 'ADD COMMAND'}</h3>
              <button className="modal-close" onClick={() => setShowPresetModal(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label">NAME</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. Open Ports"
                  value={presetForm.name}
                  onChange={(e) => setPresetForm({ ...presetForm, name: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label className="form-label">COMMAND</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="e.g. ss -tlnp"
                  value={presetForm.command}
                  onChange={(e) => setPresetForm({ ...presetForm, command: e.target.value })}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="form-group">
                <label className="form-label">DESCRIPTION</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Short description for tooltip"
                  value={presetForm.description}
                  onChange={(e) => setPresetForm({ ...presetForm, description: e.target.value })}
                />
              </div>
              {!editingPreset && isAdmin && (
                <div className="form-group">
                  <label className="form-label">SCOPE</label>
                  <select
                    className="form-input"
                    value={presetForm.scope}
                    onChange={(e) => setPresetForm({ ...presetForm, scope: e.target.value })}
                  >
                    <option value="user">Personal (only you)</option>
                    <option value="global">Global (all operators)</option>
                  </select>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="submit-btn" onClick={handlePresetSubmit}>
                {editingPreset ? 'SAVE' : 'ADD COMMAND'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

**Step 2: Rebuild frontend**

```bash
docker compose up -d --build frontend
```

**Step 3: Verify in browser**

Navigate to `http://localhost:18080/c2`. Log in if needed. Select a session. The COMMANDS tab should show 12 buttons (for the session's OS) plus a `+` button. Click a button — command executes. Click `+` — modal opens. Right-click a personal preset — context menu with edit/delete.

**Step 4: Commit**

```bash
git add frontend/src/pages/C2Page.tsx
git commit -m "feat: dynamic command grid with OS-aware presets and add/edit/delete UI"
```

---

### Task 6: Frontend — CSS for New Components

**Files:**
- Modify: `frontend/src/index.css`

**Step 1: Add styles for the new UI components**

Append after the existing `.cmd-output` styles (around line 1420):

```css
/* Command preset scope icon */
.cmd-scope-icon {
  opacity: 0.4;
  margin-right: 4px;
  vertical-align: -1px;
}

/* Add command button */
.cmd-add-btn {
  border-style: dashed;
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
}

.cmd-add-btn:hover:not(:disabled) {
  color: var(--color-accent);
  border-color: var(--color-accent);
  background: rgba(77, 171, 247, 0.05);
}

/* Context menu */
.cmd-context-menu {
  position: fixed;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  padding: 4px;
  z-index: 1000;
  min-width: 120px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.cmd-context-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  color: var(--color-text);
  font-size: 11px;
  font-family: var(--font-mono);
  cursor: pointer;
  border-radius: 3px;
  text-align: left;
}

.cmd-context-item:hover {
  background: var(--color-bg-hover);
}

.cmd-context-danger {
  color: var(--color-danger);
}

.cmd-context-danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius);
  width: 400px;
  max-width: 90vw;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.modal-title {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--color-text);
}

.modal-close {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px;
}

.modal-close:hover {
  color: var(--color-text);
}

.modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-footer {
  padding: 12px 20px 20px;
}
```

**Step 2: Rebuild frontend**

```bash
docker compose up -d --build frontend
```

**Step 3: Verify**

Navigate to `http://localhost:18080/c2`, select a session, go to COMMANDS tab. Verify:
- Buttons render in the grid with the lock icon on global presets
- `+` button has dashed border
- Right-click shows a styled context menu
- Add modal opens, is styled correctly

**Step 4: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat: add CSS for command preset context menu, modal, and add button"
```

---

### Task 7: Final Verification and Version Bump

**Step 1: End-to-end test**

1. Log in as admin
2. Go to C2 → COMMANDS tab
3. Select a session (should see 12 Linux commands)
4. Click "List Files" → executes `ls`
5. Click `+` → add a personal command "My Test" / `echo hello` / "Test command"
6. Verify it appears in the grid (without lock icon)
7. Right-click it → Edit → change name to "My Test 2" → Save
8. Right-click it → Delete → confirm
9. Verify it's gone
10. If admin: click `+` → set scope to Global → verify lock icon appears

**Step 2: Verify audit events**

```bash
TOKEN=$(curl -s http://localhost:18080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme"}' | jq -r '.access_token')

curl -s "http://localhost:18080/api/v1/audit/events?event_type=command_preset.created" \
  -H "Authorization: Bearer $TOKEN" | jq '.data | length'
```

Expected: at least 1 (from the test preset created above)

**Step 3: Bump version**

Update `frontend/src/version.ts`:
```typescript
export const APP_VERSION = 'v0.3.1'
```

**Step 4: Final commit and tag**

```bash
git add frontend/src/version.ts
git commit -m "chore: bump version to v0.3.1"
git tag -a v0.3.1 -m "v0.3.1 — Configurable command presets

- OS-aware command library (Linux, Windows, macOS)
- Admin global presets + user personal presets
- Add/edit/delete via UI with right-click context menu
- 36 default commands seeded (12 per OS)
- Audit trail for preset changes"
git push && git push origin v0.3.1
```
