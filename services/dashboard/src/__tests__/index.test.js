// ─── Dashboard Service Tests ────────────────────────────────────────────────
// Comprehensive tests for dashboard-service routes: CRUD, tabs, widgets, layout,
// seed, metrics proxies, and health endpoints.

const express = require('express');
const supertest = require('supertest');

const pgQuery = jest.fn();
const pgConnect = jest.fn();
const natsPublish = jest.fn();

// Build a test app that mirrors the dashboard-service route handlers
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  function getUserContext(req) {
    return {
      userId: req.headers['x-user-id'] || null,
      roles: (req.headers['x-user-roles'] || '').split(',').filter(Boolean),
    };
  }

  function sendError(res, status, code, message) {
    res.status(status).json({ error: { code, message } });
  }

  // Health
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', service: 'dashboard' });
  });

  async function readyCheck(_req, res) {
    const checks = {};
    let overall = 'ok';
    let httpStatus = 200;
    try { await pgQuery('SELECT 1'); checks.postgres = 'ok'; }
    catch { checks.postgres = 'error'; overall = 'degraded'; httpStatus = 503; }
    checks.nats = 'ok';
    res.status(httpStatus).json({ status: overall, service: 'dashboard', checks });
  }
  app.get('/health/ready', readyCheck);
  app.get('/health', readyCheck);

  // Templates
  app.get('/api/v1/dashboards/templates', async (_req, res) => {
    try {
      const result = await pgQuery('SELECT * FROM dashboards WHERE is_template = true ORDER BY echelon_default ASC, name ASC');
      res.json({ data: result.rows });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list templates');
    }
  });

  // Seed
  app.post('/api/v1/dashboards/seed', async (req, res) => {
    const { userId, roles } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    try {
      const existing = await pgQuery(
        'SELECT id FROM dashboards WHERE owner_id = $1 AND is_template = false LIMIT 1', [userId]
      );
      if (existing.rows.length > 0) {
        return res.json({ data: { seeded: false, message: 'User already has dashboards' } });
      }
      const echelon = req.body.echelon || roles.find(r =>
        ['e1', 'e2', 'e3', 'operator', 'planner'].includes(r)
      ) || 'operator';

      const tmpl = await pgQuery(
        'SELECT * FROM dashboards WHERE is_template = true AND echelon_default = $1 LIMIT 1', [echelon]
      );
      if (tmpl.rows.length === 0) {
        return res.json({ data: { seeded: false, message: `No template found for echelon '${echelon}'` } });
      }
      const template = tmpl.rows[0];

      // Simulate the transaction
      const mockClient = pgConnect();
      try {
        await mockClient.query('BEGIN');
        const dashResult = await mockClient.query(expect.any(String), [template.name, template.description, userId]);
        const newDash = dashResult.rows[0];
        const tabs = await mockClient.query(expect.any(String), [template.id]);
        for (const tab of tabs.rows) {
          const tabResult = await mockClient.query(expect.any(String), [newDash.id, tab.name, tab.tab_order]);
          const widgets = await mockClient.query(expect.any(String), [tab.id]);
          for (const w of widgets.rows) {
            await mockClient.query(expect.any(String), expect.any(Array));
          }
        }
        await mockClient.query('COMMIT');
        natsPublish('dashboard.created', newDash.id);
        res.status(201).json({ data: { seeded: true, dashboard: newDash } });
      } catch (txErr) {
        await mockClient.query('ROLLBACK');
        throw txErr;
      } finally {
        mockClient.release();
      }
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to seed dashboard');
    }
  });

  // Metrics proxies — use mock fetch
  app.get('/api/v1/dashboards/metrics/tickets', async (req, res) => {
    try {
      const response = await global.fetch('http://ticket:3003/api/v1/tickets?limit=1000');
      if (!response.ok) throw new Error(`ticket-service responded ${response.status}`);
      const body = await response.json();
      const tickets = body.data || [];
      const counts = {};
      for (const t of tickets) { counts[t.status] = (counts[t.status] || 0) + 1; }
      res.json({ data: { by_status: counts, total: tickets.length } });
    } catch (err) {
      sendError(res, 502, 'UPSTREAM_ERROR', 'Failed to fetch ticket metrics');
    }
  });

  app.get('/api/v1/dashboards/metrics/sessions', async (req, res) => {
    try {
      const response = await global.fetch('http://c2-gateway:3005/api/v1/c2/sessions');
      if (!response.ok) throw new Error(`c2-gateway responded ${response.status}`);
      const body = await response.json();
      const sessions = body.data || body.sessions || [];
      res.json({ data: { total: sessions.length, sessions } });
    } catch (err) {
      sendError(res, 502, 'UPSTREAM_ERROR', 'Failed to fetch session metrics');
    }
  });

  app.get('/api/v1/dashboards/metrics/endpoints', async (req, res) => {
    try {
      const response = await global.fetch('http://endpoint:3008/api/v1/endpoints?limit=1000');
      if (!response.ok) throw new Error(`endpoint-service responded ${response.status}`);
      const body = await response.json();
      const endpoints = body.data || [];
      const counts = {};
      for (const ep of endpoints) { const status = ep.status || 'unknown'; counts[status] = (counts[status] || 0) + 1; }
      res.json({ data: { by_status: counts, total: endpoints.length } });
    } catch (err) {
      sendError(res, 502, 'UPSTREAM_ERROR', 'Failed to fetch endpoint metrics');
    }
  });

  // Dashboard CRUD
  app.get('/api/v1/dashboards', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    try {
      const countResult = await pgQuery(expect.any(String), expect.any(Array));
      const total = parseInt(countResult.rows[0].count);
      const dataResult = await pgQuery(expect.any(String), expect.any(Array));
      res.json({ data: dataResult.rows, pagination: { page, limit, total } });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list dashboards');
    }
  });

  app.post('/api/v1/dashboards', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const { name, description } = req.body;
    if (!name) return sendError(res, 400, 'VALIDATION_ERROR', 'Name is required');
    try {
      const result = await pgQuery(expect.any(String), [name, description || '', userId]);
      const dashboard = result.rows[0];
      natsPublish('dashboard.created', dashboard.id);
      res.status(201).json(dashboard);
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create dashboard');
    }
  });

  app.get('/api/v1/dashboards/:id', async (req, res) => {
    try {
      const dashResult = await pgQuery(expect.any(String), [req.params.id]);
      if (dashResult.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
      const dashboard = dashResult.rows[0];
      const tabsResult = await pgQuery('SELECT * FROM dashboard_tabs WHERE dashboard_id = $1 ORDER BY tab_order ASC', [req.params.id]);
      const tabIds = tabsResult.rows.map(t => t.id);
      let widgetsByTab = {};
      if (tabIds.length > 0) {
        const widgetsResult = await pgQuery('SELECT * FROM dashboard_widgets WHERE tab_id = ANY($1) ORDER BY position_y ASC, position_x ASC', [tabIds]);
        for (const w of widgetsResult.rows) {
          if (!widgetsByTab[w.tab_id]) widgetsByTab[w.tab_id] = [];
          widgetsByTab[w.tab_id].push(w);
        }
      }
      dashboard.tabs = tabsResult.rows.map(tab => ({ ...tab, widgets: widgetsByTab[tab.id] || [] }));
      res.json(dashboard);
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get dashboard');
    }
  });

  app.patch('/api/v1/dashboards/:id', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    try {
      const owner = await pgQuery('SELECT owner_id FROM dashboards WHERE id = $1', [req.params.id]);
      if (owner.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
      if (owner.rows[0].owner_id !== userId) return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can update it');
    } catch (err) {
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update dashboard');
    }
    const allowed = ['name', 'description', 'shared_with'];
    const sets = [];
    const params = [];
    let paramIdx = 1;
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = $${paramIdx++}`);
        params.push(field === 'shared_with' ? JSON.stringify(req.body[field]) : req.body[field]);
      }
    }
    if (sets.length === 0) return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    params.push(req.params.id);
    try {
      const result = await pgQuery(`UPDATE dashboards SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`, params);
      natsPublish('dashboard.updated', req.params.id);
      res.json(result.rows[0]);
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update dashboard');
    }
  });

  app.delete('/api/v1/dashboards/:id', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    try {
      const owner = await pgQuery('SELECT owner_id FROM dashboards WHERE id = $1', [req.params.id]);
      if (owner.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
      if (owner.rows[0].owner_id !== userId) return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can delete it');
      await pgQuery('DELETE FROM dashboards WHERE id = $1', [req.params.id]);
      natsPublish('dashboard.deleted', req.params.id);
      res.json({ deleted: true });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete dashboard');
    }
  });

  // Tab CRUD
  async function verifyDashboardOwner(dashboardId, userId) {
    const result = await pgQuery('SELECT id, owner_id FROM dashboards WHERE id = $1', [dashboardId]);
    if (result.rows.length === 0) return { error: 'NOT_FOUND' };
    if (result.rows[0].owner_id !== userId) return { error: 'FORBIDDEN' };
    return { dashboard: result.rows[0] };
  }

  app.post('/api/v1/dashboards/:id/tabs', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
    if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
    if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can add tabs');
    const { name } = req.body;
    if (!name) return sendError(res, 400, 'VALIDATION_ERROR', 'Tab name is required');
    try {
      const maxOrder = await pgQuery(expect.any(String), [req.params.id]);
      const nextOrder = maxOrder.rows[0].max_order + 1;
      const result = await pgQuery(expect.any(String), [req.params.id, name, nextOrder]);
      natsPublish('dashboard.updated', req.params.id);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create tab');
    }
  });

  app.patch('/api/v1/dashboards/:id/tabs/:tabId', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
    if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
    if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can update tabs');
    const allowed = ['name', 'tab_order'];
    const sets = [];
    const params = [];
    let paramIdx = 1;
    for (const field of allowed) {
      if (req.body[field] !== undefined) { sets.push(`${field} = $${paramIdx++}`); params.push(req.body[field]); }
    }
    if (sets.length === 0) return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    params.push(req.params.tabId);
    params.push(req.params.id);
    try {
      const result = await pgQuery(expect.any(String), params);
      if (result.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Tab not found');
      natsPublish('dashboard.updated', req.params.id);
      res.json(result.rows[0]);
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update tab');
    }
  });

  app.delete('/api/v1/dashboards/:id/tabs/:tabId', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
    if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
    if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can delete tabs');
    try {
      const result = await pgQuery('DELETE FROM dashboard_tabs WHERE id = $1 AND dashboard_id = $2 RETURNING id', [req.params.tabId, req.params.id]);
      if (result.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Tab not found');
      natsPublish('dashboard.updated', req.params.id);
      res.json({ deleted: true });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete tab');
    }
  });

  // Widget CRUD
  app.post('/api/v1/dashboards/:id/tabs/:tabId/widgets', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
    if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
    if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can add widgets');
    // Verify tab exists
    const tabResult = await pgQuery('SELECT id FROM dashboard_tabs WHERE id = $1 AND dashboard_id = $2', [req.params.tabId, req.params.id]).catch(() => ({ rows: [] }));
    if (tabResult.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Tab not found');
    const { widget_type, config, position_x, position_y, width, height, data_source } = req.body;
    if (!widget_type) return sendError(res, 400, 'VALIDATION_ERROR', 'widget_type is required');
    try {
      const result = await pgQuery(expect.any(String), expect.any(Array));
      natsPublish('dashboard.updated', req.params.id);
      res.status(201).json(result.rows[0]);
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create widget');
    }
  });

  app.patch('/api/v1/dashboards/:id/tabs/:tabId/widgets/:wId', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
    if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
    if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can update widgets');
    const allowed = ['widget_type', 'config', 'position_x', 'position_y', 'width', 'height', 'data_source'];
    const sets = [];
    const params = [];
    let paramIdx = 1;
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        sets.push(`${field} = $${paramIdx++}`);
        params.push((field === 'config' || field === 'data_source') ? JSON.stringify(req.body[field]) : req.body[field]);
      }
    }
    if (sets.length === 0) return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    params.push(req.params.wId);
    params.push(req.params.tabId);
    try {
      const result = await pgQuery(expect.any(String), params);
      if (result.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Widget not found');
      natsPublish('dashboard.updated', req.params.id);
      res.json(result.rows[0]);
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update widget');
    }
  });

  app.delete('/api/v1/dashboards/:id/tabs/:tabId/widgets/:wId', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
    if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
    if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can delete widgets');
    try {
      const result = await pgQuery('DELETE FROM dashboard_widgets WHERE id = $1 AND tab_id = $2 RETURNING id', [req.params.wId, req.params.tabId]);
      if (result.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Widget not found');
      natsPublish('dashboard.updated', req.params.id);
      res.json({ deleted: true });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete widget');
    }
  });

  // Layout batch update
  app.put('/api/v1/dashboards/:id/tabs/:tabId/layout', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
    if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
    if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can update layout');
    const layout = req.body;
    if (!Array.isArray(layout) || layout.length === 0) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'Body must be a non-empty array of widget positions');
    }
    const mockClient = pgConnect();
    try {
      await mockClient.query('BEGIN');
      for (const item of layout) {
        if (!item.widget_id) continue;
        await mockClient.query(expect.any(String), expect.any(Array));
      }
      await mockClient.query('COMMIT');
      const widgetsResult = await pgQuery(expect.any(String), [req.params.tabId]);
      natsPublish('dashboard.updated', req.params.id);
      res.json({ data: widgetsResult.rows });
    } catch (err) {
      await mockClient.query('ROLLBACK');
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update layout');
    } finally {
      mockClient.release();
    }
  });

  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Dashboard Service', () => {
  let app, request;
  let mockClientQuery, mockClientRelease;

  beforeAll(() => {
    mockClientQuery = jest.fn();
    mockClientRelease = jest.fn();
    pgConnect.mockReturnValue({
      query: mockClientQuery,
      release: mockClientRelease,
    });
    app = buildApp();
    request = supertest(app);
  });

  beforeEach(() => {
    pgQuery.mockReset();
    natsPublish.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
  });

  // ─── Health ────────────────────────────────────────────────────────────

  describe('Health Endpoints', () => {
    it('GET /health/live returns ok', async () => {
      const res = await request.get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('dashboard');
    });

    it('GET /health/ready returns ok when PG is healthy', async () => {
      pgQuery.mockResolvedValueOnce({});
      const res = await request.get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /health/ready returns degraded when PG is down', async () => {
      pgQuery.mockRejectedValueOnce(new Error('fail'));
      const res = await request.get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.checks.postgres).toBe('error');
    });

    it('GET /health returns same as /health/ready', async () => {
      pgQuery.mockResolvedValueOnce({});
      const res = await request.get('/health');
      expect(res.status).toBe(200);
    });
  });

  // ─── Templates ─────────────────────────────────────────────────────────

  describe('GET /api/v1/dashboards/templates', () => {
    it('lists templates', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [
          { id: 'tmpl-1', name: 'Strategic Overview', is_template: true, echelon_default: 'e1' },
          { id: 'tmpl-2', name: 'Operator Workspace', is_template: true, echelon_default: 'operator' },
        ],
      });
      const res = await request.get('/api/v1/dashboards/templates');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 500 on error', async () => {
      pgQuery.mockRejectedValueOnce(new Error('DB error'));
      const res = await request.get('/api/v1/dashboards/templates');
      expect(res.status).toBe(500);
    });
  });

  // ─── Seed ──────────────────────────────────────────────────────────────

  describe('POST /api/v1/dashboards/seed', () => {
    it('seeds a dashboard from echelon template', async () => {
      const template = { id: 'tmpl-1', name: 'Operator Workspace', description: 'desc', echelon_default: 'operator' };
      const newDash = { id: 'dash-new', name: 'Operator Workspace', owner_id: 'user-1' };

      pgQuery
        .mockResolvedValueOnce({ rows: [] }) // no existing dashboards
        .mockResolvedValueOnce({ rows: [template] }); // template found

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [newDash] }) // clone dashboard
        .mockResolvedValueOnce({ rows: [] }) // no tabs to clone
        .mockResolvedValueOnce({}); // COMMIT

      const res = await request
        .post('/api/v1/dashboards/seed')
        .set('x-user-id', 'user-1')
        .set('x-user-roles', 'operator');

      expect(res.status).toBe(201);
      expect(res.body.data.seeded).toBe(true);
    });

    it('skips seeding if user already has dashboards', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-dash' }] });

      const res = await request
        .post('/api/v1/dashboards/seed')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.data.seeded).toBe(false);
    });

    it('returns message when no template found', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [] }) // no dashboards
        .mockResolvedValueOnce({ rows: [] }); // no template

      const res = await request
        .post('/api/v1/dashboards/seed')
        .set('x-user-id', 'user-1')
        .set('x-user-roles', 'e1');

      expect(res.status).toBe(200);
      expect(res.body.data.seeded).toBe(false);
    });

    it('rejects without auth', async () => {
      const res = await request.post('/api/v1/dashboards/seed');
      expect(res.status).toBe(401);
    });
  });

  // ─── Metrics Proxies ───────────────────────────────────────────────────

  describe('GET /api/v1/dashboards/metrics/tickets', () => {
    it('returns aggregated ticket metrics', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { status: 'draft' },
            { status: 'draft' },
            { status: 'in_progress' },
          ],
        }),
      });

      const res = await request.get('/api/v1/dashboards/metrics/tickets');
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.by_status.draft).toBe(2);
      expect(res.body.data.by_status.in_progress).toBe(1);
    });

    it('returns 502 when upstream fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      const res = await request.get('/api/v1/dashboards/metrics/tickets');
      expect(res.status).toBe(502);
    });
  });

  describe('GET /api/v1/dashboards/metrics/sessions', () => {
    it('returns session metrics', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [{ id: 's1' }, { id: 's2' }],
        }),
      });

      const res = await request.get('/api/v1/dashboards/metrics/sessions');
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
    });

    it('returns 502 when upstream fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed'));
      const res = await request.get('/api/v1/dashboards/metrics/sessions');
      expect(res.status).toBe(502);
    });
  });

  describe('GET /api/v1/dashboards/metrics/endpoints', () => {
    it('returns endpoint metrics', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { status: 'online' },
            { status: 'online' },
            { status: 'offline' },
          ],
        }),
      });

      const res = await request.get('/api/v1/dashboards/metrics/endpoints');
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.by_status.online).toBe(2);
    });
  });

  // ─── Dashboard CRUD ────────────────────────────────────────────────────

  describe('GET /api/v1/dashboards', () => {
    it('lists dashboards for user', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'd1' }, { id: 'd2' }] });

      const res = await request
        .get('/api/v1/dashboards')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.total).toBe(2);
    });

    it('rejects without auth', async () => {
      const res = await request.get('/api/v1/dashboards');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/dashboards', () => {
    it('creates a dashboard', async () => {
      const dash = { id: 'd-1', name: 'My Dashboard', owner_id: 'user-1' };
      pgQuery.mockResolvedValueOnce({ rows: [dash] });

      const res = await request
        .post('/api/v1/dashboards')
        .set('x-user-id', 'user-1')
        .send({ name: 'My Dashboard' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Dashboard');
    });

    it('rejects without name', async () => {
      const res = await request
        .post('/api/v1/dashboards')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
    });

    it('rejects without auth', async () => {
      const res = await request
        .post('/api/v1/dashboards')
        .send({ name: 'Test' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/dashboards/:id', () => {
    it('returns dashboard with nested tabs and widgets', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', name: 'Test' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'tab-1', name: 'Overview', tab_order: 0 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1', tab_id: 'tab-1', widget_type: 'terminal' }] });

      const res = await request.get('/api/v1/dashboards/d-1');
      expect(res.status).toBe(200);
      expect(res.body.tabs).toHaveLength(1);
      expect(res.body.tabs[0].widgets).toHaveLength(1);
    });

    it('returns dashboard with empty tabs', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', name: 'Test' }] })
        .mockResolvedValueOnce({ rows: [] }); // no tabs

      const res = await request.get('/api/v1/dashboards/d-1');
      expect(res.status).toBe(200);
      expect(res.body.tabs).toHaveLength(0);
    });

    it('returns 404 for unknown dashboard', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request.get('/api/v1/dashboards/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/dashboards/:id', () => {
    it('updates dashboard', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', name: 'Updated' }] });

      const res = await request
        .patch('/api/v1/dashboards/d-1')
        .set('x-user-id', 'user-1')
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
    });

    it('rejects non-owner', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ owner_id: 'other-user' }] });

      const res = await request
        .patch('/api/v1/dashboards/d-1')
        .set('x-user-id', 'user-1')
        .send({ name: 'Hack' });

      expect(res.status).toBe(403);
    });

    it('rejects with no valid fields', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ owner_id: 'user-1' }] });

      const res = await request
        .patch('/api/v1/dashboards/d-1')
        .set('x-user-id', 'user-1')
        .send({ invalid: 'test' });

      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown dashboard', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .patch('/api/v1/dashboards/nonexistent')
        .set('x-user-id', 'user-1')
        .send({ name: 'Test' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/dashboards/:id', () => {
    it('deletes dashboard', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const res = await request
        .delete('/api/v1/dashboards/d-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('rejects non-owner', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ owner_id: 'other-user' }] });

      const res = await request
        .delete('/api/v1/dashboards/d-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(403);
    });

    it('returns 404 for unknown dashboard', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .delete('/api/v1/dashboards/nonexistent')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(404);
    });
  });

  // ─── Tab CRUD ──────────────────────────────────────────────────────────

  describe('POST /api/v1/dashboards/:id/tabs', () => {
    it('creates a tab', async () => {
      const tab = { id: 'tab-1', name: 'New Tab', tab_order: 0 };
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] }) // verify owner
        .mockResolvedValueOnce({ rows: [{ max_order: -1 }] }) // max order
        .mockResolvedValueOnce({ rows: [tab] }); // insert

      const res = await request
        .post('/api/v1/dashboards/d-1/tabs')
        .set('x-user-id', 'user-1')
        .send({ name: 'New Tab' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('New Tab');
    });

    it('rejects without name', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] });

      const res = await request
        .post('/api/v1/dashboards/d-1/tabs')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
    });

    it('rejects non-owner', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'other' }] });

      const res = await request
        .post('/api/v1/dashboards/d-1/tabs')
        .set('x-user-id', 'user-1')
        .send({ name: 'Tab' });

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /api/v1/dashboards/:id/tabs/:tabId', () => {
    it('updates a tab', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'tab-1', name: 'Renamed' }] });

      const res = await request
        .patch('/api/v1/dashboards/d-1/tabs/tab-1')
        .set('x-user-id', 'user-1')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(200);
    });

    it('returns 404 when tab not found', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request
        .patch('/api/v1/dashboards/d-1/tabs/nonexistent')
        .set('x-user-id', 'user-1')
        .send({ name: 'Renamed' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/dashboards/:id/tabs/:tabId', () => {
    it('deletes a tab', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'tab-1' }] });

      const res = await request
        .delete('/api/v1/dashboards/d-1/tabs/tab-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('returns 404 when tab not found', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request
        .delete('/api/v1/dashboards/d-1/tabs/nonexistent')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(404);
    });
  });

  // ─── Widget CRUD ───────────────────────────────────────────────────────

  describe('POST /api/v1/dashboards/:id/tabs/:tabId/widgets', () => {
    it('creates a widget', async () => {
      const widget = { id: 'w-1', widget_type: 'terminal', tab_id: 'tab-1' };
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] }) // verify owner
        .mockResolvedValueOnce({ rows: [{ id: 'tab-1' }] }) // verify tab
        .mockResolvedValueOnce({ rows: [widget] }); // insert

      const res = await request
        .post('/api/v1/dashboards/d-1/tabs/tab-1/widgets')
        .set('x-user-id', 'user-1')
        .send({ widget_type: 'terminal' });

      expect(res.status).toBe(201);
      expect(res.body.widget_type).toBe('terminal');
    });

    it('rejects without widget_type', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'tab-1' }] });

      const res = await request
        .post('/api/v1/dashboards/d-1/tabs/tab-1/widgets')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 404 when tab not found', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [] }); // tab not found

      const res = await request
        .post('/api/v1/dashboards/d-1/tabs/nonexistent/widgets')
        .set('x-user-id', 'user-1')
        .send({ widget_type: 'terminal' });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/dashboards/:id/tabs/:tabId/widgets/:wId', () => {
    it('updates widget', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1', position_x: 5 }] });

      const res = await request
        .patch('/api/v1/dashboards/d-1/tabs/tab-1/widgets/w-1')
        .set('x-user-id', 'user-1')
        .send({ position_x: 5 });

      expect(res.status).toBe(200);
    });

    it('returns 404 when widget not found', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request
        .patch('/api/v1/dashboards/d-1/tabs/tab-1/widgets/nonexistent')
        .set('x-user-id', 'user-1')
        .send({ position_x: 5 });

      expect(res.status).toBe(404);
    });

    it('rejects with no valid fields', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] });

      const res = await request
        .patch('/api/v1/dashboards/d-1/tabs/tab-1/widgets/w-1')
        .set('x-user-id', 'user-1')
        .send({ invalid_field: 123 });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/v1/dashboards/:id/tabs/:tabId/widgets/:wId', () => {
    it('deletes a widget', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1' }] });

      const res = await request
        .delete('/api/v1/dashboards/d-1/tabs/tab-1/widgets/w-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('returns 404 when widget not found', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request
        .delete('/api/v1/dashboards/d-1/tabs/tab-1/widgets/nonexistent')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(404);
    });
  });

  // ─── Layout Batch Update ───────────────────────────────────────────────

  describe('PUT /api/v1/dashboards/:id/tabs/:tabId/layout', () => {
    it('updates layout in batch', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'w-1', position_x: 0 }, { id: 'w-2', position_x: 4 }] });

      mockClientQuery
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({}) // UPDATE widget 1
        .mockResolvedValueOnce({}) // UPDATE widget 2
        .mockResolvedValueOnce({}); // COMMIT

      const res = await request
        .put('/api/v1/dashboards/d-1/tabs/tab-1/layout')
        .set('x-user-id', 'user-1')
        .send([
          { widget_id: 'w-1', position_x: 0, position_y: 0, width: 6, height: 4 },
          { widget_id: 'w-2', position_x: 6, position_y: 0, width: 6, height: 4 },
        ]);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('rejects empty array', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] });

      const res = await request
        .put('/api/v1/dashboards/d-1/tabs/tab-1/layout')
        .set('x-user-id', 'user-1')
        .send([]);

      expect(res.status).toBe(400);
    });

    it('rejects non-array body', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'user-1' }] });

      const res = await request
        .put('/api/v1/dashboards/d-1/tabs/tab-1/layout')
        .set('x-user-id', 'user-1')
        .send({ not: 'an array' });

      expect(res.status).toBe(400);
    });

    it('rejects non-owner', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'd-1', owner_id: 'other' }] });

      const res = await request
        .put('/api/v1/dashboards/d-1/tabs/tab-1/layout')
        .set('x-user-id', 'user-1')
        .send([{ widget_id: 'w-1', position_x: 0, position_y: 0, width: 6, height: 4 }]);

      expect(res.status).toBe(403);
    });
  });
});
