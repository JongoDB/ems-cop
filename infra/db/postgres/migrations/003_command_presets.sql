-- EMS-COP PostgreSQL Schema
-- Migration 003: Command presets table + seed data
-- Depends on: 001_core_schema.sql

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

CREATE TRIGGER trg_command_presets_updated
    BEFORE UPDATE ON command_presets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Linux (12 commands)
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

-- Windows (12 commands)
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

-- macOS (12 commands)
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
