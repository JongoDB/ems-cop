const express = require('express');
const { Pool } = require('pg');
const { connect, StringCodec } = require('nats');
const pino = require('pino');
const logger = pino({ name: 'dashboard-service' });

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = process.env.SERVICE_PORT || 3004;
const sc = StringCodec();

// --- Database ---
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'ems_cop',
  user: process.env.POSTGRES_USER || 'ems',
  password: process.env.POSTGRES_PASSWORD || 'ems_dev_password',
  max: parseInt(process.env.PG_MAX_CONNS || '10'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// --- NATS ---
let nc = null;
let natsRetryCount = 0;

async function connectNats() {
  try {
    nc = await connect({
      servers: process.env.NATS_URL || 'nats://localhost:4222',
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
    });
    natsRetryCount = 0;
    logger.info('connected to nats');
  } catch (err) {
    natsRetryCount++;
    const baseDelay = Math.min(1000 * Math.pow(2, natsRetryCount), 30000);
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;
    logger.warn({ err: err.message, retryMs: Math.round(delay) }, 'NATS connection failed, retrying');
    setTimeout(connectNats, delay);
  }
}

function publishEvent(eventType, userId, dashboardId, details) {
  if (!nc) return;
  const event = {
    event_type: eventType,
    actor_id: userId || '',
    actor_username: '',
    actor_ip: '',
    session_id: '',
    resource_type: 'dashboard',
    resource_id: dashboardId || '',
    action: eventType.split('.')[1] || eventType,
    details: JSON.stringify(details || {}),
    timestamp: new Date().toISOString(),
  };
  nc.publish(eventType, sc.encode(JSON.stringify(event)));
}

// --- Helpers ---
function getUserContext(req) {
  return {
    userId: req.headers['x-user-id'] || null,
    roles: (req.headers['x-user-roles'] || '').split(',').filter(Boolean),
  };
}

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

// --- Health ---
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', service: 'dashboard' });
});

async function readyCheck(_req, res) {
  const checks = {};
  let overall = 'ok';
  let httpStatus = 200;

  try { await pool.query('SELECT 1'); checks.postgres = 'ok'; }
  catch { checks.postgres = 'error'; overall = 'degraded'; httpStatus = 503; }

  checks.nats = (nc && !nc.isClosed()) ? 'ok' : 'error';
  if (checks.nats === 'error') { overall = 'degraded'; httpStatus = 503; }

  res.status(httpStatus).json({ status: overall, service: 'dashboard', checks });
}

app.get('/health/ready', readyCheck);
app.get('/health', readyCheck);

// ============================================================
// Templates - must be registered BEFORE /:id routes
// ============================================================

app.get('/api/v1/dashboards/templates', async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM dashboards WHERE is_template = true ORDER BY echelon_default ASC, name ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    logger.error({ err: err.message }, 'list templates error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list templates');
  }
});

// ============================================================
// Seed - clone echelon template for first-time user
// ============================================================

app.post('/api/v1/dashboards/seed', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  try {
    // Check if user already has dashboards
    const existing = await pool.query(
      'SELECT id FROM dashboards WHERE owner_id = $1 AND is_template = false LIMIT 1',
      [userId]
    );
    if (existing.rows.length > 0) {
      return res.json({ data: { seeded: false, message: 'User already has dashboards' } });
    }

    // Determine echelon: body override > first matching role > admin defaults to operator > fallback to operator
    const echelon = req.body.echelon || roles.find(r =>
      ['e1', 'e2', 'e3', 'operator', 'planner'].includes(r)
    ) || (roles.includes('admin') ? 'operator' : 'operator');

    // Find matching template
    const tmpl = await pool.query(
      'SELECT * FROM dashboards WHERE is_template = true AND echelon_default = $1 LIMIT 1',
      [echelon]
    );
    if (tmpl.rows.length === 0) {
      return res.json({ data: { seeded: false, message: `No template found for echelon '${echelon}'` } });
    }

    const template = tmpl.rows[0];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Clone dashboard
      const dashResult = await client.query(
        `INSERT INTO dashboards (name, description, owner_id, is_template, shared_with)
         VALUES ($1, $2, $3, false, '[]')
         RETURNING *`,
        [template.name, template.description, userId]
      );
      const newDash = dashResult.rows[0];

      // Clone tabs
      const tabs = await client.query(
        'SELECT * FROM dashboard_tabs WHERE dashboard_id = $1 ORDER BY tab_order ASC',
        [template.id]
      );

      for (const tab of tabs.rows) {
        const tabResult = await client.query(
          `INSERT INTO dashboard_tabs (dashboard_id, name, tab_order)
           VALUES ($1, $2, $3) RETURNING id`,
          [newDash.id, tab.name, tab.tab_order]
        );
        const newTabId = tabResult.rows[0].id;

        // Clone widgets for this tab
        const widgets = await client.query(
          'SELECT * FROM dashboard_widgets WHERE tab_id = $1',
          [tab.id]
        );
        for (const w of widgets.rows) {
          await client.query(
            `INSERT INTO dashboard_widgets (tab_id, widget_type, config, position_x, position_y, width, height, data_source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [newTabId, w.widget_type, w.config, w.position_x, w.position_y, w.width, w.height, w.data_source]
          );
        }
      }

      await client.query('COMMIT');
      publishEvent('dashboard.created', userId, newDash.id, { seeded_from: template.id, echelon });
      res.status(201).json({ data: { seeded: true, dashboard: newDash } });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err: err.message }, 'seed error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to seed dashboard');
  }
});

// ============================================================
// Metrics proxies
// ============================================================

app.get('/api/v1/dashboards/metrics/tickets', async (req, res) => {
  try {
    const baseUrl = process.env.TICKET_SERVICE_URL || 'http://ticket:3003';
    const response = await fetch(`${baseUrl}/api/v1/tickets?limit=1000`);
    if (!response.ok) throw new Error(`ticket-service responded ${response.status}`);
    const body = await response.json();
    const tickets = body.data || [];

    const counts = {};
    for (const t of tickets) {
      counts[t.status] = (counts[t.status] || 0) + 1;
    }
    res.json({ data: { by_status: counts, total: tickets.length } });
  } catch (err) {
    logger.error({ err: err.message }, 'metrics/tickets error');
    sendError(res, 502, 'UPSTREAM_ERROR', 'Failed to fetch ticket metrics');
  }
});

app.get('/api/v1/dashboards/metrics/sessions', async (req, res) => {
  try {
    const baseUrl = process.env.C2_GATEWAY_URL || 'http://c2-gateway:3005';
    const response = await fetch(`${baseUrl}/api/v1/c2/sessions`);
    if (!response.ok) throw new Error(`c2-gateway responded ${response.status}`);
    const body = await response.json();
    const sessions = body.data || body.sessions || [];
    res.json({ data: { total: sessions.length, sessions } });
  } catch (err) {
    logger.error({ err: err.message }, 'metrics/sessions error');
    sendError(res, 502, 'UPSTREAM_ERROR', 'Failed to fetch session metrics');
  }
});

app.get('/api/v1/dashboards/metrics/endpoints', async (req, res) => {
  try {
    const baseUrl = process.env.ENDPOINT_SERVICE_URL || 'http://endpoint:3008';
    const response = await fetch(`${baseUrl}/api/v1/endpoints?limit=1000`);
    if (!response.ok) throw new Error(`endpoint-service responded ${response.status}`);
    const body = await response.json();
    const endpoints = body.data || [];

    const counts = {};
    for (const ep of endpoints) {
      const status = ep.status || 'unknown';
      counts[status] = (counts[status] || 0) + 1;
    }
    res.json({ data: { by_status: counts, total: endpoints.length } });
  } catch (err) {
    logger.error({ err: err.message }, 'metrics/endpoints error');
    sendError(res, 502, 'UPSTREAM_ERROR', 'Failed to fetch endpoint metrics');
  }
});

// ============================================================
// Dashboard CRUD
// ============================================================

// LIST DASHBOARDS
app.get('/api/v1/dashboards', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  try {
    // Build the shared_with check: user's roles as a JSONB array for @> containment
    // shared_with is an array of objects like [{"entity_type":"role","entity_id":"operator",...}]
    // We check owner OR any role match in shared_with
    const rolesJson = JSON.stringify(roles.map(r => ({ entity_type: 'role', entity_id: r })));

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM dashboards
       WHERE is_template = false
         AND (owner_id = $1
              OR shared_with @> ANY(SELECT jsonb_build_array(value) FROM jsonb_array_elements($2::jsonb) AS value))`,
      [userId, rolesJson]
    );
    const total = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT d.*, u.display_name AS owner_name
       FROM dashboards d
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.is_template = false
         AND (d.owner_id = $1
              OR d.shared_with @> ANY(SELECT jsonb_build_array(value) FROM jsonb_array_elements($2::jsonb) AS value))
       ORDER BY d.updated_at DESC
       LIMIT $3 OFFSET $4`,
      [userId, rolesJson, limit, offset]
    );

    res.json({
      data: dataResult.rows,
      pagination: { page, limit, total },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'list error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list dashboards');
  }
});

// CREATE DASHBOARD
app.post('/api/v1/dashboards', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const { name, description } = req.body;
  if (!name) return sendError(res, 400, 'VALIDATION_ERROR', 'Name is required');

  try {
    const result = await pool.query(
      `INSERT INTO dashboards (name, description, owner_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, description || '', userId]
    );
    const dashboard = result.rows[0];
    publishEvent('dashboard.created', userId, dashboard.id, { name });
    res.status(201).json(dashboard);
  } catch (err) {
    logger.error({ err: err.message }, 'create error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create dashboard');
  }
});

// GET DASHBOARD (with nested tabs + widgets)
app.get('/api/v1/dashboards/:id', async (req, res) => {
  try {
    const dashResult = await pool.query(
      `SELECT d.*, u.display_name AS owner_name
       FROM dashboards d
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    if (dashResult.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    }

    const dashboard = dashResult.rows[0];

    // Fetch tabs
    const tabsResult = await pool.query(
      'SELECT * FROM dashboard_tabs WHERE dashboard_id = $1 ORDER BY tab_order ASC',
      [req.params.id]
    );

    // Fetch all widgets for all tabs in one query
    const tabIds = tabsResult.rows.map(t => t.id);
    let widgetsByTab = {};

    if (tabIds.length > 0) {
      const widgetsResult = await pool.query(
        'SELECT * FROM dashboard_widgets WHERE tab_id = ANY($1) ORDER BY position_y ASC, position_x ASC',
        [tabIds]
      );
      for (const w of widgetsResult.rows) {
        if (!widgetsByTab[w.tab_id]) widgetsByTab[w.tab_id] = [];
        widgetsByTab[w.tab_id].push(w);
      }
    }

    // Assemble nested response
    dashboard.tabs = tabsResult.rows.map(tab => ({
      ...tab,
      widgets: widgetsByTab[tab.id] || [],
    }));

    res.json(dashboard);
  } catch (err) {
    logger.error({ err: err.message }, 'get error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get dashboard');
  }
});

// UPDATE DASHBOARD
app.patch('/api/v1/dashboards/:id', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  // Owner check
  try {
    const owner = await pool.query('SELECT owner_id FROM dashboards WHERE id = $1', [req.params.id]);
    if (owner.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    }
    if (owner.rows[0].owner_id !== userId) {
      return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can update it');
    }
  } catch (err) {
    logger.error({ err: err.message }, 'update owner check error');
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
  if (sets.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  params.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE dashboards SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );
    publishEvent('dashboard.updated', userId, req.params.id, { fields: Object.keys(req.body) });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err: err.message }, 'update error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update dashboard');
  }
});

// DELETE DASHBOARD
app.delete('/api/v1/dashboards/:id', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  try {
    const owner = await pool.query('SELECT owner_id FROM dashboards WHERE id = $1', [req.params.id]);
    if (owner.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
    }
    if (owner.rows[0].owner_id !== userId) {
      return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can delete it');
    }

    await pool.query('DELETE FROM dashboards WHERE id = $1', [req.params.id]);
    publishEvent('dashboard.deleted', userId, req.params.id, {});
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err: err.message }, 'delete error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete dashboard');
  }
});

// ============================================================
// Tab CRUD
// ============================================================

// Helper: verify dashboard ownership and return dashboard
async function verifyDashboardOwner(dashboardId, userId) {
  const result = await pool.query(
    'SELECT id, owner_id FROM dashboards WHERE id = $1',
    [dashboardId]
  );
  if (result.rows.length === 0) return { error: 'NOT_FOUND' };
  if (result.rows[0].owner_id !== userId) return { error: 'FORBIDDEN' };
  return { dashboard: result.rows[0] };
}

// CREATE TAB
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
    // Get next tab_order
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(tab_order), -1) AS max_order FROM dashboard_tabs WHERE dashboard_id = $1',
      [req.params.id]
    );
    const nextOrder = maxOrder.rows[0].max_order + 1;

    const result = await pool.query(
      `INSERT INTO dashboard_tabs (dashboard_id, name, tab_order)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, name, nextOrder]
    );

    publishEvent('dashboard.updated', userId, req.params.id, { action: 'tab_added', tab_id: result.rows[0].id });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error({ err: err.message }, 'create tab error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create tab');
  }
});

// UPDATE TAB
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
    if (req.body[field] !== undefined) {
      sets.push(`${field} = $${paramIdx++}`);
      params.push(req.body[field]);
    }
  }
  if (sets.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  params.push(req.params.tabId);
  params.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE dashboard_tabs SET ${sets.join(', ')}
       WHERE id = $${paramIdx} AND dashboard_id = $${paramIdx + 1}
       RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Tab not found');
    }
    publishEvent('dashboard.updated', userId, req.params.id, { action: 'tab_updated', tab_id: req.params.tabId });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err: err.message }, 'update tab error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update tab');
  }
});

// DELETE TAB
app.delete('/api/v1/dashboards/:id/tabs/:tabId', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
  if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
  if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
  if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can delete tabs');

  try {
    const result = await pool.query(
      'DELETE FROM dashboard_tabs WHERE id = $1 AND dashboard_id = $2 RETURNING id',
      [req.params.tabId, req.params.id]
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Tab not found');
    }
    publishEvent('dashboard.updated', userId, req.params.id, { action: 'tab_deleted', tab_id: req.params.tabId });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err: err.message }, 'delete tab error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete tab');
  }
});

// ============================================================
// Widget CRUD
// ============================================================

// Helper: verify tab belongs to dashboard
async function verifyTab(dashboardId, tabId) {
  const result = await pool.query(
    'SELECT id FROM dashboard_tabs WHERE id = $1 AND dashboard_id = $2',
    [tabId, dashboardId]
  );
  return result.rows.length > 0;
}

// CREATE WIDGET
app.post('/api/v1/dashboards/:id/tabs/:tabId/widgets', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
  if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
  if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
  if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can add widgets');

  const tabExists = await verifyTab(req.params.id, req.params.tabId).catch(() => false);
  if (!tabExists) return sendError(res, 404, 'NOT_FOUND', 'Tab not found');

  const { widget_type, config, position_x, position_y, width, height, data_source } = req.body;
  if (!widget_type) return sendError(res, 400, 'VALIDATION_ERROR', 'widget_type is required');

  try {
    const result = await pool.query(
      `INSERT INTO dashboard_widgets (tab_id, widget_type, config, position_x, position_y, width, height, data_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        req.params.tabId,
        widget_type,
        JSON.stringify(config || {}),
        position_x ?? 0,
        position_y ?? 0,
        width ?? 4,
        height ?? 4,
        data_source ? JSON.stringify(data_source) : null,
      ]
    );
    publishEvent('dashboard.updated', userId, req.params.id, { action: 'widget_added', widget_id: result.rows[0].id });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error({ err: err.message }, 'create widget error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create widget');
  }
});

// UPDATE WIDGET
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
      // JSONB fields need to be stringified
      if (field === 'config' || field === 'data_source') {
        params.push(JSON.stringify(req.body[field]));
      } else {
        params.push(req.body[field]);
      }
    }
  }
  if (sets.length === 0) {
    return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  params.push(req.params.wId);
  params.push(req.params.tabId);
  try {
    const result = await pool.query(
      `UPDATE dashboard_widgets SET ${sets.join(', ')}
       WHERE id = $${paramIdx} AND tab_id = $${paramIdx + 1}
       RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Widget not found');
    }
    publishEvent('dashboard.updated', userId, req.params.id, { action: 'widget_updated', widget_id: req.params.wId });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err: err.message }, 'update widget error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update widget');
  }
});

// DELETE WIDGET
app.delete('/api/v1/dashboards/:id/tabs/:tabId/widgets/:wId', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const check = await verifyDashboardOwner(req.params.id, userId).catch(() => null);
  if (!check) return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to verify ownership');
  if (check.error === 'NOT_FOUND') return sendError(res, 404, 'NOT_FOUND', 'Dashboard not found');
  if (check.error === 'FORBIDDEN') return sendError(res, 403, 'FORBIDDEN', 'Only the dashboard owner can delete widgets');

  try {
    const result = await pool.query(
      'DELETE FROM dashboard_widgets WHERE id = $1 AND tab_id = $2 RETURNING id',
      [req.params.wId, req.params.tabId]
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Widget not found');
    }
    publishEvent('dashboard.updated', userId, req.params.id, { action: 'widget_deleted', widget_id: req.params.wId });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err: err.message }, 'delete widget error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete widget');
  }
});

// ============================================================
// Layout batch update
// ============================================================

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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const item of layout) {
      if (!item.widget_id) continue;
      await client.query(
        `UPDATE dashboard_widgets
         SET position_x = $1, position_y = $2, width = $3, height = $4
         WHERE id = $5 AND tab_id = $6`,
        [
          item.position_x ?? 0,
          item.position_y ?? 0,
          item.width ?? 4,
          item.height ?? 4,
          item.widget_id,
          req.params.tabId,
        ]
      );
    }

    await client.query('COMMIT');

    // Return updated widgets
    const widgetsResult = await pool.query(
      'SELECT * FROM dashboard_widgets WHERE tab_id = $1 ORDER BY position_y ASC, position_x ASC',
      [req.params.tabId]
    );

    publishEvent('dashboard.updated', userId, req.params.id, { action: 'layout_updated', tab_id: req.params.tabId });
    res.json({ data: widgetsResult.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message }, 'layout update error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update layout');
  } finally {
    client.release();
  }
});

// ============================================================
// Template Seeding — insert echelon templates if missing
// ============================================================

const ECHELON_TEMPLATES = [
  {
    name: 'Strategic Overview', echelon: 'e1',
    description: 'High-level metrics, ticket queue, and operation timeline',
    tabs: [{ name: 'Overview', widgets: [
      { type: 'metrics_chart', x: 0, y: 0, w: 4, h: 3, config: { chartType: 'kpi', metric: 'active_operations' } },
      { type: 'metrics_chart', x: 4, y: 0, w: 4, h: 3, config: { chartType: 'kpi', metric: 'compliance_posture' } },
      { type: 'metrics_chart', x: 8, y: 0, w: 4, h: 3, config: { chartType: 'kpi', metric: 'critical_findings' } },
      { type: 'ticket_queue', x: 0, y: 3, w: 6, h: 4, config: { filter: { priority: 'critical', status: 'in_review' } } },
      { type: 'operation_timeline', x: 6, y: 3, w: 6, h: 4, config: {} },
    ]}],
  },
  {
    name: 'Operational Summary', echelon: 'e2',
    description: 'Ticket queue, network topology, metrics, and audit log',
    tabs: [{ name: 'Operations', widgets: [
      { type: 'ticket_queue', x: 0, y: 0, w: 6, h: 4, config: { filter: { status: 'in_review' } } },
      { type: 'network_topology', x: 6, y: 0, w: 6, h: 4, config: {} },
      { type: 'metrics_chart', x: 0, y: 4, w: 6, h: 3, config: { chartType: 'bar', metric: 'operations_by_status' } },
      { type: 'audit_log', x: 6, y: 4, w: 6, h: 3, config: {} },
    ]}],
  },
  {
    name: 'Tactical Workspace', echelon: 'e3',
    description: 'Network topology, C2 panel, ticket queue, and audit log',
    tabs: [{ name: 'Mission', widgets: [
      { type: 'network_topology', x: 0, y: 0, w: 6, h: 5, config: {} },
      { type: 'ticket_queue', x: 6, y: 0, w: 6, h: 3, config: {} },
      { type: 'sliver_c2_panel', x: 6, y: 3, w: 6, h: 4, config: {} },
      { type: 'audit_log', x: 0, y: 5, w: 12, h: 3, config: {} },
    ]}],
  },
  {
    name: 'Operator Workspace', echelon: 'operator',
    description: 'Terminal, C2 panel, network topology, notes, and endpoint table',
    tabs: [
      { name: 'Execute', widgets: [
        { type: 'terminal', x: 0, y: 0, w: 6, h: 5, config: {} },
        { type: 'network_topology', x: 6, y: 0, w: 6, h: 3, config: {} },
        { type: 'sliver_c2_panel', x: 6, y: 3, w: 6, h: 4, config: {} },
        { type: 'notes', x: 0, y: 5, w: 4, h: 3, config: {} },
        { type: 'endpoint_table', x: 4, y: 5, w: 8, h: 3, config: {} },
      ]},
      { name: 'Tasks', widgets: [
        { type: 'ticket_queue', x: 0, y: 0, w: 12, h: 4, config: { filter: { assigned_to: 'self' } } },
        { type: 'operation_timeline', x: 0, y: 4, w: 12, h: 3, config: {} },
      ]},
    ],
  },
  {
    name: 'Planner Workspace', echelon: 'planner',
    description: 'Network topology, notes, endpoint table, and ticket queue',
    tabs: [{ name: 'Plan', widgets: [
      { type: 'network_topology', x: 0, y: 0, w: 6, h: 4, config: {} },
      { type: 'notes', x: 6, y: 0, w: 6, h: 4, config: {} },
      { type: 'endpoint_table', x: 0, y: 4, w: 8, h: 4, config: {} },
      { type: 'ticket_queue', x: 8, y: 4, w: 4, h: 4, config: { filter: { created_by: 'self' } } },
    ]}],
  },
];

async function seedTemplates() {
  const existing = await pool.query('SELECT COUNT(*) FROM dashboards WHERE is_template = true');
  if (parseInt(existing.rows[0].count) > 0) {
    logger.info('templates already exist, skipping seed');
    return;
  }

  logger.info('seeding echelon templates');

  // Find admin user to own templates
  const adminResult = await pool.query(
    "SELECT id FROM users WHERE username = 'admin' LIMIT 1"
  );
  const adminId = adminResult.rows[0]?.id;
  if (!adminId) {
    logger.error('admin user not found, cannot seed templates');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const tmpl of ECHELON_TEMPLATES) {
      const dashResult = await client.query(
        `INSERT INTO dashboards (name, description, owner_id, is_template, echelon_default, shared_with)
         VALUES ($1, $2, $3, true, $4, '[]')
         RETURNING id`,
        [tmpl.name, tmpl.description, adminId, tmpl.echelon]
      );
      const dashId = dashResult.rows[0].id;

      for (let ti = 0; ti < tmpl.tabs.length; ti++) {
        const tab = tmpl.tabs[ti];
        const tabResult = await client.query(
          `INSERT INTO dashboard_tabs (dashboard_id, name, tab_order)
           VALUES ($1, $2, $3) RETURNING id`,
          [dashId, tab.name, ti]
        );
        const tabId = tabResult.rows[0].id;

        for (const w of tab.widgets) {
          await client.query(
            `INSERT INTO dashboard_widgets (tab_id, widget_type, config, position_x, position_y, width, height)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [tabId, w.type, JSON.stringify(w.config || {}), w.x, w.y, w.w, w.h]
          );
        }
      }
    }

    await client.query('COMMIT');
    logger.info({ count: ECHELON_TEMPLATES.length }, 'seeded echelon templates');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message }, 'template seed failed');
  } finally {
    client.release();
  }
}

// ============================================================
// Start
// ============================================================

let server;

async function start() {
  await connectNats();
  await seedTemplates();
  server = app.listen(port, () => logger.info({ port }, 'listening'));
}

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  if (server) {
    server.close(() => logger.info('HTTP server closed'));
  }
  if (nc) {
    try { await nc.drain(); logger.info('NATS drained'); } catch (e) { /* ignore */ }
  }
  await pool.end();
  logger.info('DB pool closed');
  setTimeout(() => { logger.error('forced shutdown after timeout'); process.exit(1); }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => {
  logger.error({ err }, 'startup failed');
  process.exit(1);
});
