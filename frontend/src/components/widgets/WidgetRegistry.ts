// Widget Registry — extensible catalog of dashboard components
// New widgets are registered here and automatically available in the dashboard builder

import { lazy, ComponentType } from 'react';

export interface WidgetDefinition {
  type: string;
  name: string;
  description: string;
  icon: string;               // lucide-react icon name
  category: 'c2' | 'monitoring' | 'management' | 'collaboration' | 'analytics' | 'integration';
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  maxSize?: { w: number; h: number };
  configSchema?: Record<string, unknown>;  // JSON schema for widget-specific config
  component: ComponentType<WidgetProps>;
}

export interface WidgetProps {
  id: string;
  config: Record<string, unknown>;
  dataSource?: DataSourceConfig;
  isFullscreen?: boolean;
  operationId?: string;        // current operation context
  onConfigChange?: (config: Record<string, unknown>) => void;
}

export interface DataSourceConfig {
  type: 'api' | 'websocket' | 'static';
  endpoint?: string;
  filters?: Record<string, unknown>;
  refreshIntervalSeconds?: number;
}

// ════════════════════════════════════════════
//  LAZY-LOADED WIDGET COMPONENTS
// ════════════════════════════════════════════

const NetworkTopology = lazy(() => import('./NetworkTopologyWidget'));
const Terminal = lazy(() => import('./TerminalWidget'));
const RemoteDesktop = lazy(() => import('./RemoteDesktopWidget'));
const InlineNotes = lazy(() => import('./InlineNotesWidget'));
const TicketQueue = lazy(() => import('./TicketQueueWidget'));
const OperationTimeline = lazy(() => import('./OperationTimelineWidget'));
const SliverC2Panel = lazy(() => import('./SliverC2PanelWidget'));
const AuditLogViewer = lazy(() => import('./AuditLogViewerWidget'));
const PluginIframe = lazy(() => import('./PluginIframeWidget'));
const MetricsChart = lazy(() => import('./MetricsChartWidget'));
const EndpointTable = lazy(() => import('./EndpointTableWidget'));
const CommandPalette = lazy(() => import('./CommandPaletteWidget'));

// ════════════════════════════════════════════
//  WIDGET REGISTRY
// ════════════════════════════════════════════

export const widgetRegistry: Map<string, WidgetDefinition> = new Map([
  ['network_topology', {
    type: 'network_topology',
    name: 'Network Topology',
    description: 'Interactive graph showing endpoints, implants, network segments, and C2 channels',
    icon: 'Network',
    category: 'monitoring',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 3 },
    component: NetworkTopology as ComponentType<WidgetProps>,
  }],

  ['terminal', {
    type: 'terminal',
    name: 'Terminal Session',
    description: 'Interactive terminal connected to C2 shell sessions or SSH',
    icon: 'Terminal',
    category: 'c2',
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    component: Terminal as ComponentType<WidgetProps>,
  }],

  ['remote_desktop', {
    type: 'remote_desktop',
    name: 'Remote Desktop',
    description: 'VNC-based graphical session to endpoints (via noVNC)',
    icon: 'Monitor',
    category: 'c2',
    defaultSize: { w: 8, h: 6 },
    minSize: { w: 4, h: 3 },
    component: RemoteDesktop as ComponentType<WidgetProps>,
  }],

  ['notes', {
    type: 'notes',
    name: 'Inline Notes',
    description: 'Rich-text collaborative notepad with Markdown, import/export',
    icon: 'StickyNote',
    category: 'collaboration',
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 2, h: 2 },
    component: InlineNotes as ComponentType<WidgetProps>,
  }],

  ['ticket_queue', {
    type: 'ticket_queue',
    name: 'Ticket Queue',
    description: 'Filterable view of tickets relevant to current user/operation',
    icon: 'ListTodo',
    category: 'management',
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 3, h: 2 },
    component: TicketQueue as ComponentType<WidgetProps>,
  }],

  ['operation_timeline', {
    type: 'operation_timeline',
    name: 'Operation Timeline',
    description: 'Gantt-style view of operation phases, tasks, and milestones',
    icon: 'GanttChart',
    category: 'management',
    defaultSize: { w: 12, h: 3 },
    minSize: { w: 6, h: 2 },
    component: OperationTimeline as ComponentType<WidgetProps>,
  }],

  ['sliver_c2_panel', {
    type: 'sliver_c2_panel',
    name: 'Sliver C2 Panel',
    description: 'Implant list, session management, task history, listeners',
    icon: 'Skull',
    category: 'c2',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 4, h: 3 },
    component: SliverC2Panel as ComponentType<WidgetProps>,
  }],

  ['audit_log', {
    type: 'audit_log',
    name: 'Audit Log Viewer',
    description: 'Real-time filterable log stream of all system and user activity',
    icon: 'ScrollText',
    category: 'analytics',
    defaultSize: { w: 12, h: 4 },
    minSize: { w: 4, h: 2 },
    component: AuditLogViewer as ComponentType<WidgetProps>,
  }],

  ['plugin_iframe', {
    type: 'plugin_iframe',
    name: 'Plugin (IFrame)',
    description: 'Sandboxed iframe for embedding arbitrary third-party web UIs',
    icon: 'Puzzle',
    category: 'integration',
    defaultSize: { w: 6, h: 5 },
    minSize: { w: 3, h: 2 },
    component: PluginIframe as ComponentType<WidgetProps>,
  }],

  ['metrics_chart', {
    type: 'metrics_chart',
    name: 'Metrics / Charts',
    description: 'Configurable charts driven by system telemetry or operation data',
    icon: 'BarChart3',
    category: 'analytics',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    component: MetricsChart as ComponentType<WidgetProps>,
  }],

  ['endpoint_table', {
    type: 'endpoint_table',
    name: 'Endpoint Inventory',
    description: 'Sortable/filterable table of all managed endpoints with status',
    icon: 'Server',
    category: 'monitoring',
    defaultSize: { w: 12, h: 4 },
    minSize: { w: 6, h: 2 },
    component: EndpointTable as ComponentType<WidgetProps>,
  }],

  ['command_palette', {
    type: 'command_palette',
    name: 'Command Palette',
    description: 'Keyboard-driven command palette for rapid task execution',
    icon: 'Command',
    category: 'c2',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    component: CommandPalette as ComponentType<WidgetProps>,
  }],
]);

// ════════════════════════════════════════════
//  ECHELON DEFAULT TEMPLATES
// ════════════════════════════════════════════

export interface DashboardTemplate {
  name: string;
  echelon: string;
  tabs: Array<{
    name: string;
    widgets: Array<{
      type: string;
      position: { x: number; y: number; w: number; h: number };
      config?: Record<string, unknown>;
    }>;
  }>;
}

export const echelonTemplates: DashboardTemplate[] = [
  {
    name: 'Strategic Overview',
    echelon: 'e1',
    tabs: [
      {
        name: 'Overview',
        widgets: [
          { type: 'metrics_chart', position: { x: 0, y: 0, w: 4, h: 3 }, config: { chartType: 'kpi', metric: 'active_operations' } },
          { type: 'metrics_chart', position: { x: 4, y: 0, w: 4, h: 3 }, config: { chartType: 'kpi', metric: 'compliance_posture' } },
          { type: 'metrics_chart', position: { x: 8, y: 0, w: 4, h: 3 }, config: { chartType: 'kpi', metric: 'critical_findings' } },
          { type: 'ticket_queue', position: { x: 0, y: 3, w: 6, h: 4 }, config: { filter: { priority: 'critical', status: 'in_review' } } },
          { type: 'operation_timeline', position: { x: 6, y: 3, w: 6, h: 4 } },
        ],
      },
    ],
  },
  {
    name: 'Operational Summary',
    echelon: 'e2',
    tabs: [
      {
        name: 'Operations',
        widgets: [
          { type: 'ticket_queue', position: { x: 0, y: 0, w: 6, h: 4 }, config: { filter: { status: 'in_review' } } },
          { type: 'network_topology', position: { x: 6, y: 0, w: 6, h: 4 } },
          { type: 'metrics_chart', position: { x: 0, y: 4, w: 6, h: 3 }, config: { chartType: 'bar', metric: 'operations_by_status' } },
          { type: 'audit_log', position: { x: 6, y: 4, w: 6, h: 3 } },
        ],
      },
    ],
  },
  {
    name: 'Tactical Workspace',
    echelon: 'e3',
    tabs: [
      {
        name: 'Mission',
        widgets: [
          { type: 'network_topology', position: { x: 0, y: 0, w: 6, h: 5 } },
          { type: 'ticket_queue', position: { x: 6, y: 0, w: 6, h: 3 } },
          { type: 'sliver_c2_panel', position: { x: 6, y: 3, w: 6, h: 4 } },
          { type: 'audit_log', position: { x: 0, y: 5, w: 12, h: 3 } },
        ],
      },
    ],
  },
  {
    name: 'Operator Workspace',
    echelon: 'operator',
    tabs: [
      {
        name: 'Execute',
        widgets: [
          { type: 'terminal', position: { x: 0, y: 0, w: 6, h: 5 } },
          { type: 'network_topology', position: { x: 6, y: 0, w: 6, h: 3 } },
          { type: 'sliver_c2_panel', position: { x: 6, y: 3, w: 6, h: 4 } },
          { type: 'notes', position: { x: 0, y: 5, w: 4, h: 3 } },
          { type: 'endpoint_table', position: { x: 4, y: 5, w: 8, h: 3 } },
        ],
      },
      {
        name: 'Tasks',
        widgets: [
          { type: 'ticket_queue', position: { x: 0, y: 0, w: 12, h: 4 }, config: { filter: { assigned_to: 'self' } } },
          { type: 'operation_timeline', position: { x: 0, y: 4, w: 12, h: 3 } },
        ],
      },
    ],
  },
  {
    name: 'Planner Workspace',
    echelon: 'planner',
    tabs: [
      {
        name: 'Plan',
        widgets: [
          { type: 'network_topology', position: { x: 0, y: 0, w: 6, h: 4 } },
          { type: 'notes', position: { x: 6, y: 0, w: 6, h: 4 } },
          { type: 'endpoint_table', position: { x: 0, y: 4, w: 8, h: 4 } },
          { type: 'ticket_queue', position: { x: 8, y: 4, w: 4, h: 4 }, config: { filter: { created_by: 'self' } } },
        ],
      },
    ],
  },
];

// Helper: get widget definition by type
export function getWidgetDef(type: string): WidgetDefinition | undefined {
  return widgetRegistry.get(type);
}

// Helper: get all widgets by category
export function getWidgetsByCategory(category: string): WidgetDefinition[] {
  return Array.from(widgetRegistry.values()).filter(w => w.category === category);
}

// Helper: register a custom widget (for plugins)
export function registerWidget(definition: WidgetDefinition): void {
  widgetRegistry.set(definition.type, definition);
}
