# Configurable Command Presets — Design

## Goal

Replace the hardcoded quick-command buttons on the C2 page with a persistent, OS-aware command library. Admins curate global presets per OS. Operators add personal commands visible only to them. The grid auto-filters by the selected session's operating system.

## Architecture

Commands live in PostgreSQL (`command_presets` table). The ticket-service exposes CRUD endpoints. The C2 page fetches presets filtered by OS, merges global and personal, and renders them as buttons. NATS events feed the audit trail.

No new services. No changes to existing tables.

## Data Model

```sql
CREATE TABLE command_presets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    command     TEXT NOT NULL,
    description TEXT DEFAULT '',
    os          VARCHAR(20) NOT NULL,          -- 'linux', 'windows', 'macos'
    scope       VARCHAR(10) NOT NULL DEFAULT 'global',  -- 'global' or 'user'
    created_by  UUID REFERENCES users(id),
    sort_order  INT DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_command_presets_os_scope ON command_presets(os, scope);
CREATE INDEX idx_command_presets_created_by ON command_presets(created_by);
```

**Scope rules:**
- `global` — admin-managed, visible to all operators
- `user` — personal, visible only to `created_by`

## API Endpoints

All under `/api/v1/commands/presets`, routed to the ticket-service via Traefik.

### GET /api/v1/commands/presets?os=linux

Returns global presets plus the current user's personal presets for the given OS. Sorted by `sort_order`, then `name`.

Response: `{ data: [...], pagination: { total } }`

### POST /api/v1/commands/presets

Creates a preset. Body: `{ name, command, description, os, scope }`.

- `scope='global'` requires admin role (checked via `X-User-Roles` header).
- `scope='user'` sets `created_by` from `X-User-ID` header.

Publishes `command_preset.created` to NATS.

### PATCH /api/v1/commands/presets/:id

Updates `name`, `command`, `description`, or `sort_order`.

- Admins edit any global preset.
- Users edit only their own personal presets.
- Returns 403 otherwise.

Publishes `command_preset.updated` to NATS.

### DELETE /api/v1/commands/presets/:id

- Admins delete global presets.
- Users delete their own personal presets.
- Returns 403 otherwise.

Publishes `command_preset.deleted` to NATS.

## Authorization

| Action | Global Preset | Personal Preset |
|--------|--------------|-----------------|
| View   | All users    | Owner only      |
| Create | Admin        | Any user        |
| Edit   | Admin        | Owner only      |
| Delete | Admin        | Owner only      |

Derived from `X-User-ID` and `X-User-Roles` headers set by ForwardAuth.

## Frontend

### Command Grid (C2Page, Commands Tab)

When a session is selected, the page reads `session.os`, maps it to `linux`/`windows`/`macos`, and fetches presets for that OS.

Each button displays the preset `name`. Hover shows `description` and the raw `command` string. Global presets show a lock icon; personal presets show no icon.

A `+` button at the end of the grid opens an inline form: name, command, description, scope toggle (global visible only to admins). Save calls `POST`, refreshes the grid.

Right-click on a button reveals edit and delete options. Non-admins cannot edit or delete global presets (options hidden). Edit opens the form pre-filled. Delete asks for confirmation.

If the API fails, the grid falls back to hardcoded defaults so the page remains functional.

### OS Detection

Map `session.os` string to preset OS value:
- Contains `linux` → `linux`
- Contains `windows` → `windows`
- Contains `darwin` or `macos` or `mac` → `macos`
- Fallback: `linux`

The existing `osLabel()` function already handles this mapping.

## Seed Data

~36 default presets (12 per OS), all `scope='global'`, `created_by=NULL`.

### Linux
| Name | Command | Description |
|------|---------|-------------|
| List Files | `ls` | List directory contents |
| Processes | `ps aux` | Running processes with details |
| Current User | `whoami` | Current username |
| Working Dir | `pwd` | Print working directory |
| User/Groups | `id` | User and group IDs |
| Interfaces | `ifconfig` | Network interface config |
| Open Ports | `ss -tlnp` | Listening TCP ports with process |
| System Info | `uname -a` | Kernel and system info |
| Users | `cat /etc/passwd` | Local user accounts |
| OS Info | `cat /etc/os-release` | OS release details |
| Disk Usage | `df -h` | Filesystem disk usage |
| Environment | `env` | Environment variables |

### Windows
| Name | Command | Description |
|------|---------|-------------|
| List Files | `dir` | List directory contents |
| Current User | `whoami` | Current username |
| Privileges | `whoami /priv` | Current user privileges |
| Interfaces | `ipconfig` | Network interface config |
| Open Ports | `Get-NetTCPConnection` | Active TCP connections |
| System Info | `systeminfo` | Detailed system information |
| Processes | `tasklist` | Running processes |
| Local Users | `net user` | Local user accounts |
| Local Admins | `net localgroup administrators` | Local admin group members |
| Processes PS | `Get-Process` | PowerShell process list |
| Hostname | `hostname` | Computer name |
| Environment | `set` | Environment variables |

### macOS
| Name | Command | Description |
|------|---------|-------------|
| List Files | `ls` | List directory contents |
| Processes | `ps aux` | Running processes with details |
| Current User | `whoami` | Current username |
| Working Dir | `pwd` | Print working directory |
| User/Groups | `id` | User and group IDs |
| Interfaces | `ifconfig` | Network interface config |
| Open Ports | `netstat -an` | Network connections and ports |
| System Info | `uname -a` | Kernel and system info |
| macOS Version | `sw_vers` | macOS version details |
| Users | `dscl . list /Users` | Local user accounts |
| Disk Usage | `df -h` | Filesystem disk usage |
| Environment | `env` | Environment variables |

## Audit

The audit-service subscribes to `command_preset.>` (add to existing NATS subscription filter). Events include actor ID, preset ID, OS, scope, and the action taken.

## Affected Components

| Component | Change |
|-----------|--------|
| PostgreSQL | Migration `003_command_presets.sql`: table + 36 seed rows |
| Ticket service | 4 new route handlers under `/api/v1/commands/presets` |
| Frontend C2Page | Dynamic command grid with add/edit/delete UI |
| Audit service | Subscribe to `command_preset.>` events |
| Traefik | Route `/api/v1/commands/*` to ticket-service |
