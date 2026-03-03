import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDashboardStore, type Dashboard, type DashboardTab, type DashboardWidget } from '../dashboardStore';

// Mock apiFetch
const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash-1',
    name: 'Test Dashboard',
    description: 'A test dashboard',
    owner_id: 'user-1',
    is_template: false,
    shared_with: null,
    tabs: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTab(overrides: Partial<DashboardTab> = {}): DashboardTab {
  return {
    id: 'tab-1',
    dashboard_id: 'dash-1',
    name: 'Default Tab',
    tab_order: 0,
    widgets: [],
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeWidget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id: 'widget-1',
    tab_id: 'tab-1',
    widget_type: 'metrics_chart',
    config: {},
    position_x: 0,
    position_y: 0,
    width: 4,
    height: 3,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('dashboardStore', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      dashboards: [],
      currentDashboard: null,
      currentTabId: null,
      loading: false,
      layoutDirty: false,
    });
    vi.clearAllMocks();
  });

  it('has correct initial state', () => {
    const state = useDashboardStore.getState();
    expect(state.dashboards).toEqual([]);
    expect(state.currentDashboard).toBeNull();
    expect(state.currentTabId).toBeNull();
    expect(state.loading).toBe(false);
    expect(state.layoutDirty).toBe(false);
  });

  describe('fetchDashboards', () => {
    it('populates dashboards from API response with data wrapper', async () => {
      const dashboards = [makeDashboard(), makeDashboard({ id: 'dash-2', name: 'Second' })];
      mockApiFetch.mockResolvedValueOnce({ data: dashboards });

      await useDashboardStore.getState().fetchDashboards();

      const state = useDashboardStore.getState();
      expect(state.dashboards).toEqual(dashboards);
      expect(state.loading).toBe(false);
    });

    it('populates dashboards from API response with plain array', async () => {
      const dashboards = [makeDashboard()];
      mockApiFetch.mockResolvedValueOnce(dashboards);

      await useDashboardStore.getState().fetchDashboards();

      const state = useDashboardStore.getState();
      expect(state.dashboards).toEqual(dashboards);
    });

    it('sets loading to false on error', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

      await useDashboardStore.getState().fetchDashboards();

      const state = useDashboardStore.getState();
      expect(state.loading).toBe(false);
      expect(state.dashboards).toEqual([]);
    });
  });

  describe('fetchDashboard', () => {
    it('sets currentDashboard and first tab as currentTabId', async () => {
      const tab = makeTab({ id: 'tab-abc' });
      const dashboard = makeDashboard({ tabs: [tab] });
      mockApiFetch.mockResolvedValueOnce(dashboard);

      await useDashboardStore.getState().fetchDashboard('dash-1');

      const state = useDashboardStore.getState();
      expect(state.currentDashboard).toEqual(dashboard);
      expect(state.currentTabId).toBe('tab-abc');
      expect(state.loading).toBe(false);
    });

    it('sets currentTabId to null when dashboard has no tabs', async () => {
      const dashboard = makeDashboard({ tabs: [] });
      mockApiFetch.mockResolvedValueOnce(dashboard);

      await useDashboardStore.getState().fetchDashboard('dash-1');

      expect(useDashboardStore.getState().currentTabId).toBeNull();
    });

    it('updates dashboard in the list if already present', async () => {
      const original = makeDashboard({ name: 'Original' });
      useDashboardStore.setState({ dashboards: [original] });

      const updated = makeDashboard({ name: 'Updated' });
      mockApiFetch.mockResolvedValueOnce(updated);

      await useDashboardStore.getState().fetchDashboard('dash-1');

      expect(useDashboardStore.getState().dashboards[0].name).toBe('Updated');
    });
  });

  describe('createDashboard', () => {
    it('calls API with POST and returns the created dashboard', async () => {
      const created = makeDashboard({ id: 'new-dash', name: 'New' });
      mockApiFetch.mockResolvedValueOnce(created); // createDashboard POST
      mockApiFetch.mockResolvedValueOnce({ data: [created] }); // fetchDashboards refetch

      const result = await useDashboardStore.getState().createDashboard('New');

      expect(result).toEqual(created);
      expect(mockApiFetch).toHaveBeenCalledWith('/dashboards', {
        method: 'POST',
        body: JSON.stringify({ name: 'New' }),
      });
    });

    it('returns null on error', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('fail'));

      const result = await useDashboardStore.getState().createDashboard('New');

      expect(result).toBeNull();
    });
  });

  describe('deleteDashboard', () => {
    it('removes dashboard from list', async () => {
      const d1 = makeDashboard({ id: 'dash-1' });
      const d2 = makeDashboard({ id: 'dash-2' });
      useDashboardStore.setState({ dashboards: [d1, d2] });

      mockApiFetch.mockResolvedValueOnce(undefined);

      await useDashboardStore.getState().deleteDashboard('dash-1');

      expect(useDashboardStore.getState().dashboards).toHaveLength(1);
      expect(useDashboardStore.getState().dashboards[0].id).toBe('dash-2');
    });

    it('clears currentDashboard if it was the deleted one', async () => {
      const d1 = makeDashboard({ id: 'dash-1' });
      useDashboardStore.setState({ dashboards: [d1], currentDashboard: d1 });

      mockApiFetch.mockResolvedValueOnce(undefined);

      await useDashboardStore.getState().deleteDashboard('dash-1');

      expect(useDashboardStore.getState().currentDashboard).toBeNull();
    });

    it('keeps currentDashboard if it was a different one', async () => {
      const d1 = makeDashboard({ id: 'dash-1' });
      const d2 = makeDashboard({ id: 'dash-2' });
      useDashboardStore.setState({ dashboards: [d1, d2], currentDashboard: d2 });

      mockApiFetch.mockResolvedValueOnce(undefined);

      await useDashboardStore.getState().deleteDashboard('dash-1');

      expect(useDashboardStore.getState().currentDashboard?.id).toBe('dash-2');
    });
  });

  describe('addWidget', () => {
    it('calls API and re-fetches dashboard', async () => {
      const widget = makeWidget({ id: 'new-widget' });
      const dashWithWidget = makeDashboard({
        tabs: [makeTab({ widgets: [widget] })],
      });

      mockApiFetch.mockResolvedValueOnce(widget); // POST widget
      mockApiFetch.mockResolvedValueOnce(dashWithWidget); // fetchDashboard

      const result = await useDashboardStore.getState().addWidget(
        'dash-1',
        'tab-1',
        { widget_type: 'metrics_chart', position_x: 0, position_y: 0, width: 4, height: 3 }
      );

      expect(result).toEqual(widget);
      expect(mockApiFetch).toHaveBeenCalledTimes(2);
    });

    it('returns null on error', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('fail'));

      const result = await useDashboardStore.getState().addWidget(
        'dash-1',
        'tab-1',
        { widget_type: 'terminal', position_x: 0, position_y: 0, width: 6, height: 4 }
      );

      expect(result).toBeNull();
    });
  });

  describe('removeWidget', () => {
    it('calls delete API and re-fetches dashboard', async () => {
      mockApiFetch.mockResolvedValueOnce(undefined); // DELETE
      mockApiFetch.mockResolvedValueOnce(makeDashboard()); // fetchDashboard

      await useDashboardStore.getState().removeWidget('dash-1', 'tab-1', 'widget-1');

      expect(mockApiFetch).toHaveBeenCalledWith(
        '/dashboards/dash-1/tabs/tab-1/widgets/widget-1',
        { method: 'DELETE' }
      );
    });
  });

  describe('updateLayout', () => {
    it('applies optimistic layout update', async () => {
      const widget = makeWidget({ position_x: 0, position_y: 0, width: 4, height: 3 });
      const tab = makeTab({ id: 'tab-1', widgets: [widget] });
      const dashboard = makeDashboard({ tabs: [tab] });
      useDashboardStore.setState({ currentDashboard: dashboard });

      // Don't await — the API call is debounced
      const layouts = [{ widget_id: 'widget-1', position_x: 2, position_y: 3, width: 6, height: 5 }];
      useDashboardStore.getState().updateLayout('dash-1', 'tab-1', layouts);

      const state = useDashboardStore.getState();
      const updatedWidget = state.currentDashboard!.tabs[0].widgets[0];
      expect(updatedWidget.position_x).toBe(2);
      expect(updatedWidget.position_y).toBe(3);
      expect(updatedWidget.width).toBe(6);
      expect(updatedWidget.height).toBe(5);
      expect(state.layoutDirty).toBe(true);
    });
  });

  describe('setCurrentTab', () => {
    it('sets the current tab ID', () => {
      useDashboardStore.getState().setCurrentTab('tab-42');

      expect(useDashboardStore.getState().currentTabId).toBe('tab-42');
    });

    it('can set to null', () => {
      useDashboardStore.getState().setCurrentTab('tab-42');
      useDashboardStore.getState().setCurrentTab(null);

      expect(useDashboardStore.getState().currentTabId).toBeNull();
    });
  });
});
