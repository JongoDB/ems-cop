import { describe, it, expect, afterEach } from 'vitest';
import {
  widgetRegistry,
  getWidgetDef,
  getWidgetsByCategory,
  registerWidget,
  type WidgetDefinition,
  type WidgetProps,
} from '../WidgetRegistry';

// Keep track of widgets we add so we can clean up
const addedWidgetTypes: string[] = [];

afterEach(() => {
  // Clean up any widgets we registered during tests
  for (const type of addedWidgetTypes) {
    widgetRegistry.delete(type);
  }
  addedWidgetTypes.length = 0;
});

describe('WidgetRegistry', () => {
  describe('widget registration', () => {
    it('has all 14 default widgets registered', () => {
      expect(widgetRegistry.size).toBe(14);
    });

    it('contains expected widget types', () => {
      const expectedTypes = [
        'network_topology',
        'terminal',
        'remote_desktop',
        'notes',
        'ticket_queue',
        'operation_timeline',
        'sliver_c2_panel',
        'audit_log',
        'plugin_iframe',
        'metrics_chart',
        'endpoint_table',
        'command_palette',
        'cti_health',
        'consolidated_audit',
      ];

      for (const type of expectedTypes) {
        expect(widgetRegistry.has(type), `Missing widget type: ${type}`).toBe(true);
      }
    });

    it('each widget has required fields', () => {
      for (const [type, def] of widgetRegistry) {
        expect(def.type).toBe(type);
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.icon).toBeTruthy();
        expect(def.category).toBeTruthy();
        expect(def.defaultSize).toBeDefined();
        expect(def.defaultSize.w).toBeGreaterThan(0);
        expect(def.defaultSize.h).toBeGreaterThan(0);
        expect(def.minSize).toBeDefined();
        expect(def.minSize.w).toBeGreaterThan(0);
        expect(def.minSize.h).toBeGreaterThan(0);
        expect(def.component).toBeDefined();
      }
    });

    it('minSize is always <= defaultSize for all widgets', () => {
      for (const [type, def] of widgetRegistry) {
        expect(
          def.minSize.w <= def.defaultSize.w,
          `${type}: minSize.w (${def.minSize.w}) > defaultSize.w (${def.defaultSize.w})`
        ).toBe(true);
        expect(
          def.minSize.h <= def.defaultSize.h,
          `${type}: minSize.h (${def.minSize.h}) > defaultSize.h (${def.defaultSize.h})`
        ).toBe(true);
      }
    });
  });

  describe('getWidgetDef', () => {
    it('returns correct definition for a known type', () => {
      const def = getWidgetDef('terminal');

      expect(def).toBeDefined();
      expect(def!.type).toBe('terminal');
      expect(def!.name).toBe('Terminal Session');
      expect(def!.category).toBe('c2');
    });

    it('returns correct definition for network_topology', () => {
      const def = getWidgetDef('network_topology');

      expect(def).toBeDefined();
      expect(def!.name).toBe('Network Topology');
      expect(def!.category).toBe('monitoring');
    });

    it('returns undefined for unknown widget type', () => {
      const def = getWidgetDef('nonexistent_widget');

      expect(def).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(getWidgetDef('')).toBeUndefined();
    });
  });

  describe('getWidgetsByCategory', () => {
    it('returns c2 widgets', () => {
      const c2Widgets = getWidgetsByCategory('c2');

      expect(c2Widgets.length).toBeGreaterThan(0);
      expect(c2Widgets.every((w) => w.category === 'c2')).toBe(true);

      const types = c2Widgets.map((w) => w.type);
      expect(types).toContain('terminal');
      expect(types).toContain('sliver_c2_panel');
      expect(types).toContain('command_palette');
      expect(types).toContain('remote_desktop');
    });

    it('returns monitoring widgets', () => {
      const monitoringWidgets = getWidgetsByCategory('monitoring');

      expect(monitoringWidgets.length).toBeGreaterThan(0);
      expect(monitoringWidgets.every((w) => w.category === 'monitoring')).toBe(true);

      const types = monitoringWidgets.map((w) => w.type);
      expect(types).toContain('network_topology');
      expect(types).toContain('endpoint_table');
    });

    it('returns management widgets', () => {
      const mgmtWidgets = getWidgetsByCategory('management');

      const types = mgmtWidgets.map((w) => w.type);
      expect(types).toContain('ticket_queue');
      expect(types).toContain('operation_timeline');
    });

    it('returns analytics widgets', () => {
      const analyticsWidgets = getWidgetsByCategory('analytics');

      const types = analyticsWidgets.map((w) => w.type);
      expect(types).toContain('metrics_chart');
      expect(types).toContain('audit_log');
    });

    it('returns collaboration widgets', () => {
      const collabWidgets = getWidgetsByCategory('collaboration');

      const types = collabWidgets.map((w) => w.type);
      expect(types).toContain('notes');
    });

    it('returns integration widgets', () => {
      const integrationWidgets = getWidgetsByCategory('integration');

      const types = integrationWidgets.map((w) => w.type);
      expect(types).toContain('plugin_iframe');
    });

    it('returns empty array for unknown category', () => {
      const widgets = getWidgetsByCategory('nonexistent');

      expect(widgets).toEqual([]);
    });

    it('does not return widgets from other categories', () => {
      const c2Widgets = getWidgetsByCategory('c2');

      for (const widget of c2Widgets) {
        expect(widget.category).toBe('c2');
        expect(widget.category).not.toBe('monitoring');
        expect(widget.category).not.toBe('analytics');
      }
    });
  });

  describe('registerWidget', () => {
    it('adds a new widget to the registry', () => {
      const customWidget: WidgetDefinition = {
        type: 'custom_test_widget',
        name: 'Custom Test Widget',
        description: 'A test widget',
        icon: 'Zap',
        category: 'integration',
        defaultSize: { w: 4, h: 3 },
        minSize: { w: 2, h: 1 },
        component: (() => null) as unknown as React.ComponentType<WidgetProps>,
      };

      addedWidgetTypes.push('custom_test_widget');
      registerWidget(customWidget);

      expect(widgetRegistry.has('custom_test_widget')).toBe(true);
      expect(getWidgetDef('custom_test_widget')).toEqual(customWidget);
    });

    it('new widget appears in category queries after registration', () => {
      const customWidget: WidgetDefinition = {
        type: 'custom_analytics_widget',
        name: 'Custom Analytics',
        description: 'Analytics widget for testing',
        icon: 'Chart',
        category: 'analytics',
        defaultSize: { w: 6, h: 4 },
        minSize: { w: 3, h: 2 },
        component: (() => null) as unknown as React.ComponentType<WidgetProps>,
      };

      addedWidgetTypes.push('custom_analytics_widget');
      registerWidget(customWidget);

      const analyticsWidgets = getWidgetsByCategory('analytics');
      const types = analyticsWidgets.map((w) => w.type);
      expect(types).toContain('custom_analytics_widget');
    });

    it('can override an existing widget', () => {
      const override: WidgetDefinition = {
        type: 'override_test_widget',
        name: 'Original',
        description: 'Original widget',
        icon: 'Star',
        category: 'c2',
        defaultSize: { w: 4, h: 3 },
        minSize: { w: 2, h: 1 },
        component: (() => null) as unknown as React.ComponentType<WidgetProps>,
      };

      addedWidgetTypes.push('override_test_widget');
      registerWidget(override);

      const updated: WidgetDefinition = {
        ...override,
        name: 'Updated',
        description: 'Updated widget',
      };

      registerWidget(updated);

      expect(getWidgetDef('override_test_widget')!.name).toBe('Updated');
    });
  });
});
