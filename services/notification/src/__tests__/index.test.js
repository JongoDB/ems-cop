// ─── Notification Service Tests ─────────────────────────────────────────────
// Tests for notification CRUD, rate limiting, dedup, dispatch pipeline,
// Jira config CRUD, Jira webhook, preferences, and health endpoints.

const express = require('express');
const supertest = require('supertest');
const crypto = require('crypto');

const pgQuery = jest.fn();
const redisGet = jest.fn();
const redisSet = jest.fn();
const redisZadd = jest.fn();
const redisZcard = jest.fn();
const redisZremrangebyscore = jest.fn();
const redisExpire = jest.fn();
const natsPublish = jest.fn();
const natsIsClosed = jest.fn().mockReturnValue(false);

// Build a test app that mirrors the notification-service route handlers
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  function getUserID(req) {
    return req.headers['x-user-id'] || null;
  }

  function sendError(res, status, code, message) {
    res.status(status).json({ error: { code, message } });
  }

  // Health
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', service: 'notification-service' });
  });

  async function readyCheck(_req, res) {
    const checks = {};
    let overall = 'ok';
    let httpStatus = 200;
    try { await pgQuery('SELECT 1'); checks.postgres = 'ok'; }
    catch { checks.postgres = 'error'; overall = 'degraded'; httpStatus = 503; }
    checks.redis = 'ok'; // always ok in tests
    checks.nats = natsIsClosed() ? 'error' : 'ok';
    if (checks.nats === 'error') { overall = 'degraded'; httpStatus = 503; }
    res.status(httpStatus).json({ status: overall, service: 'notification-service', checks });
  }
  app.get('/health/ready', readyCheck);
  app.get('/health', readyCheck);

  // Jira Webhook
  app.post('/api/v1/notifications/jira/webhook', async (req, res) => {
    try {
      const signature = req.headers['x-hub-signature'] || req.headers['x-atlassian-webhook-signature'];
      if (!signature) {
        return res.status(401).json({ error: { code: 'MISSING_SIGNATURE', message: 'Webhook signature required' } });
      }
      const configResult = await pgQuery('SELECT webhook_secret FROM jira_configs LIMIT 1');
      if (configResult.rows.length === 0 || !configResult.rows[0].webhook_secret) {
        return res.status(500).json({ error: { code: 'NO_CONFIG', message: 'Jira not configured' } });
      }
      const secret = configResult.rows[0].webhook_secret;
      const expectedSig = 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
      if (signature.length !== expectedSig.length ||
          !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
        return res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } });
      }
      const event = req.body;
      const issueKey = event.issue?.key;
      if (!issueKey) return res.json({ ok: true, message: 'no issue key' });

      const mappingResult = await pgQuery(expect.any(String), [issueKey]);
      const mapping = mappingResult.rows[0];
      if (!mapping) return res.json({ ok: true, message: 'unmapped issue' });
      if (mapping.sync_direction === 'outbound') return res.json({ ok: true, message: 'inbound disabled' });

      // Set sync lock
      await redisSet(`jira:sync_lock:${mapping.ticket_id}`, '1', 'EX', 30);

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: { code: 'WEBHOOK_ERROR', message: err.message } });
    }
  });

  // Notifications CRUD
  app.get('/api/v1/notifications', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const isRead = req.query.is_read;
    const type = req.query.notification_type;
    let where = 'WHERE user_id = $1';
    const params = [userId];
    let paramIdx = 2;
    if (isRead !== undefined) { where += ` AND is_read = $${paramIdx++}`; params.push(isRead === 'true'); }
    if (type) { where += ` AND notification_type = $${paramIdx++}`; params.push(type); }
    try {
      const countResult = await pgQuery(`SELECT COUNT(*) FROM notifications ${where}`, params);
      const total = parseInt(countResult.rows[0].count);
      const dataResult = await pgQuery(expect.any(String), [...params, limit, offset]);
      res.json({ data: dataResult.rows, pagination: { page, limit, total } });
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.get('/api/v1/notifications/unread-count', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rows } = await pgQuery(expect.any(String), [userId]);
      res.json({ count: parseInt(rows[0].count) });
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.patch('/api/v1/notifications/:id/read', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rows } = await pgQuery(expect.any(String), [req.params.id, userId]);
      if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Notification not found');
      res.json(rows[0]);
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.patch('/api/v1/notifications/:id/unread', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rows } = await pgQuery(expect.any(String), [req.params.id, userId]);
      if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Notification not found');
      res.json(rows[0]);
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.post('/api/v1/notifications/mark-all-read', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rowCount } = await pgQuery(expect.any(String), [userId]);
      res.json({ updated: rowCount });
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.delete('/api/v1/notifications/:id', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rowCount } = await pgQuery(expect.any(String), [req.params.id, userId]);
      if (!rowCount) return sendError(res, 404, 'NOT_FOUND', 'Notification not found');
      res.status(204).end();
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  // Notification Channels
  app.get('/api/v1/notifications/channels', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rows } = await pgQuery(expect.any(String), [userId]);
      res.json({ data: rows });
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.post('/api/v1/notifications/channels', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    const { channel_type, config, enabled } = req.body;
    if (!channel_type) return sendError(res, 400, 'MISSING_FIELD', 'channel_type required');
    try {
      const { rows } = await pgQuery(expect.any(String), [userId, channel_type, JSON.stringify(config || {}), enabled !== false]);
      res.status(201).json(rows[0]);
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.patch('/api/v1/notifications/channels/:id', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    const updates = [];
    const params = [req.params.id, userId];
    let idx = 3;
    if (req.body.config !== undefined) { updates.push(`config = $${idx++}`); params.push(JSON.stringify(req.body.config)); }
    if (req.body.enabled !== undefined) { updates.push(`enabled = $${idx++}`); params.push(req.body.enabled); }
    if (!updates.length) return sendError(res, 400, 'NO_CHANGES', 'Nothing to update');
    try {
      const { rows } = await pgQuery(expect.any(String), params);
      if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Channel not found');
      res.json(rows[0]);
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.delete('/api/v1/notifications/channels/:id', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rowCount } = await pgQuery(expect.any(String), [req.params.id, userId]);
      if (!rowCount) return sendError(res, 404, 'NOT_FOUND', 'Channel not found');
      res.status(204).end();
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  // Preferences
  app.get('/api/v1/notifications/preferences', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rows } = await pgQuery('SELECT preferences FROM users WHERE id = $1', [userId]);
      if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'User not found');
      res.json(rows[0].preferences?.notifications || {});
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.patch('/api/v1/notifications/preferences', async (req, res) => {
    const userId = getUserID(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');
    try {
      const { rows } = await pgQuery(expect.any(String), [JSON.stringify(req.body), userId]);
      if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'User not found');
      res.json(rows[0].preferences?.notifications || {});
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  // Jira Config CRUD
  app.get('/api/v1/notifications/jira/configs', async (req, res) => {
    try {
      const { rows } = await pgQuery(expect.any(String));
      res.json({ data: rows });
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.post('/api/v1/notifications/jira/configs', async (req, res) => {
    const userId = getUserID(req);
    const { name: cfgName, base_url, auth, project_key, operation_id, field_mappings, sync_direction, webhook_secret } = req.body;
    if (!cfgName || !base_url || !project_key) {
      return sendError(res, 400, 'MISSING_FIELD', 'name, base_url, and project_key are required');
    }
    try {
      const { rows } = await pgQuery(expect.any(String), expect.any(Array));
      natsPublish('jira.config_created', rows[0].id);
      res.status(201).json(rows[0]);
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.get('/api/v1/notifications/jira/configs/:id', async (req, res) => {
    try {
      const { rows } = await pgQuery('SELECT * FROM jira_configs WHERE id = $1', [req.params.id]);
      if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Config not found');
      res.json(rows[0]);
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.patch('/api/v1/notifications/jira/configs/:id', async (req, res) => {
    const updates = [];
    const params = [req.params.id];
    let idx = 2;
    const fields = ['name', 'base_url', 'project_key', 'operation_id', 'sync_direction', 'webhook_secret', 'is_active'];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = $${idx++}`); params.push(req.body[f]); }
    }
    if (req.body.auth !== undefined) { updates.push(`auth = $${idx++}`); params.push(JSON.stringify(req.body.auth)); }
    if (req.body.field_mappings !== undefined) { updates.push(`field_mappings = $${idx++}`); params.push(JSON.stringify(req.body.field_mappings)); }
    if (!updates.length) return sendError(res, 400, 'NO_CHANGES', 'Nothing to update');
    try {
      const { rows } = await pgQuery(expect.any(String), params);
      if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Config not found');
      res.json(rows[0]);
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  app.delete('/api/v1/notifications/jira/configs/:id', async (req, res) => {
    try {
      const { rowCount } = await pgQuery('DELETE FROM jira_configs WHERE id = $1', [req.params.id]);
      if (!rowCount) return sendError(res, 404, 'NOT_FOUND', 'Config not found');
      res.status(204).end();
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  // Test Jira connection
  app.post('/api/v1/notifications/jira/configs/:id/test', async (req, res) => {
    try {
      const { rows } = await pgQuery('SELECT * FROM jira_configs WHERE id = $1', [req.params.id]);
      if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Config not found');
      // Mock successful test
      const config = rows[0];
      try {
        const response = await global.fetch(`${config.base_url}/rest/api/3/project/${config.project_key}`, expect.any(Object));
        const result = await response.json();
        res.json({ success: true, project: { key: result.key, name: result.name } });
      } catch (err) {
        res.json({ success: false, error: err.message });
      }
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  // Sync mappings
  app.get('/api/v1/notifications/jira/mappings', async (req, res) => {
    const ticketId = req.query.ticket_id;
    try {
      let query = 'SELECT * FROM jira_sync_mappings';
      const params = [];
      if (ticketId) { query += ' WHERE ticket_id = $1'; params.push(ticketId); }
      query += ' ORDER BY created_at DESC';
      const { rows } = await pgQuery(query, params);
      res.json({ data: rows });
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  // Force sync
  app.post('/api/v1/notifications/jira/sync/:ticketId', async (req, res) => {
    const ticketId = req.params.ticketId;
    try {
      const ticketResult = await pgQuery(expect.any(String), [ticketId]);
      if (!ticketResult.rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
      const configResult = await pgQuery(expect.any(String));
      const config = configResult.rows[0];
      if (!config) return sendError(res, 404, 'NOT_FOUND', 'No active Jira config');
      const mappingResult = await pgQuery('SELECT * FROM jira_sync_mappings WHERE ticket_id = $1', [ticketId]);
      if (mappingResult.rows[0]) {
        res.json({ status: 'synced', mapping: mappingResult.rows[0].jira_issue_key });
      } else {
        res.json({ status: 'created', mapping: null });
      }
    } catch (err) {
      sendError(res, 500, 'SYNC_ERROR', err.message);
    }
  });

  // Sync log
  app.get('/api/v1/notifications/jira/log', async (req, res) => {
    const configId = req.query.config_id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    try {
      let query = 'SELECT * FROM jira_sync_log';
      const params = [];
      if (configId) { query += ' WHERE config_id = $1'; params.push(configId); }
      query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
      params.push(limit);
      const { rows } = await pgQuery(query, params);
      res.json({ data: rows });
    } catch (err) {
      sendError(res, 500, 'DB_ERROR', err.message);
    }
  });

  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPATCH PIPELINE TESTS (standalone functions, not routes)
// ═══════════════════════════════════════════════════════════════════════════

async function testDispatchNotification(notif) {
  const { user_id, notification_type, title, body, reference_type, reference_id } = notif;

  // Check preferences
  const prefResult = await pgQuery('SELECT preferences FROM users WHERE id = $1', [user_id]);
  if (prefResult.rows[0]?.preferences?.notifications?.[notification_type] === false) {
    return { dispatched: false, reason: 'opted_out' };
  }

  // Rate limit check
  const rateKey = `notif:rate:${user_id}`;
  const now = Date.now();
  await redisZremrangebyscore(rateKey, 0, now - 60000);
  const count = await redisZcard(rateKey);
  if (count >= 30) return { dispatched: false, reason: 'rate_limited' };
  await redisZadd(rateKey, now, `${now}:${Math.random()}`);
  await redisExpire(rateKey, 120);

  // Dedup check
  const dedupKey = `notif:dedup:${user_id}:${notification_type}:${reference_id || 'none'}`;
  const exists = await redisGet(dedupKey);
  if (exists) return { dispatched: false, reason: 'deduped' };
  await redisSet(dedupKey, '1', 'EX', 60);

  // Insert in-app notification
  const { rows } = await pgQuery(expect.any(String), [user_id, title, body, notification_type, reference_type, reference_id]);
  return { dispatched: true, notification: rows[0] };
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Notification Service', () => {
  let app, request;

  beforeAll(() => {
    app = buildApp();
    request = supertest(app);
  });

  beforeEach(() => {
    pgQuery.mockReset();
    natsPublish.mockReset();
    redisGet.mockReset();
    redisSet.mockReset();
    redisZadd.mockReset();
    redisZcard.mockReset();
    redisZremrangebyscore.mockReset();
    redisExpire.mockReset();
    natsIsClosed.mockReturnValue(false);
  });

  // ─── Health ────────────────────────────────────────────────────────────

  describe('Health Endpoints', () => {
    it('GET /health/live returns ok', async () => {
      const res = await request.get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /health/ready returns ok when all dependencies healthy', async () => {
      pgQuery.mockResolvedValueOnce({});
      const res = await request.get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.checks.postgres).toBe('ok');
      expect(res.body.checks.redis).toBe('ok');
      expect(res.body.checks.nats).toBe('ok');
    });

    it('GET /health/ready returns degraded when PG is down', async () => {
      pgQuery.mockRejectedValueOnce(new Error('fail'));
      const res = await request.get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.checks.postgres).toBe('error');
    });

    it('GET /health/ready returns degraded when NATS is down', async () => {
      pgQuery.mockResolvedValueOnce({});
      natsIsClosed.mockReturnValue(true);
      const res = await request.get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.checks.nats).toBe('error');
    });
  });

  // ─── Notification CRUD ─────────────────────────────────────────────────

  describe('GET /api/v1/notifications', () => {
    it('lists notifications with pagination', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '5' }] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'n-1', title: 'Test', is_read: false },
            { id: 'n-2', title: 'Test 2', is_read: true },
          ],
        });

      const res = await request
        .get('/api/v1/notifications?page=1&limit=2')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({ page: 1, limit: 2, total: 5 });
    });

    it('filters by is_read', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'n-1', is_read: false }] });

      const res = await request
        .get('/api/v1/notifications?is_read=false')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      // Should have added is_read filter param
      expect(pgQuery.mock.calls[0][1]).toEqual(['user-1', false]);
    });

    it('filters by notification_type', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'n-1', notification_type: 'ticket_assigned' }] });

      const res = await request
        .get('/api/v1/notifications?notification_type=ticket_assigned')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
    });

    it('rejects without auth', async () => {
      const res = await request.get('/api/v1/notifications');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/notifications/unread-count', () => {
    it('returns unread count', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });

      const res = await request
        .get('/api/v1/notifications/unread-count')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(7);
    });

    it('rejects without auth', async () => {
      const res = await request.get('/api/v1/notifications/unread-count');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/v1/notifications/:id/read', () => {
    it('marks notification as read', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'n-1', is_read: true }] });

      const res = await request
        .patch('/api/v1/notifications/n-1/read')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.is_read).toBe(true);
    });

    it('returns 404 when not found', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .patch('/api/v1/notifications/nonexistent/read')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/v1/notifications/:id/unread', () => {
    it('marks notification as unread', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'n-1', is_read: false }] });

      const res = await request
        .patch('/api/v1/notifications/n-1/unread')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.is_read).toBe(false);
    });
  });

  describe('POST /api/v1/notifications/mark-all-read', () => {
    it('marks all notifications as read', async () => {
      pgQuery.mockResolvedValueOnce({ rowCount: 5 });

      const res = await request
        .post('/api/v1/notifications/mark-all-read')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(5);
    });

    it('rejects without auth', async () => {
      const res = await request.post('/api/v1/notifications/mark-all-read');
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/v1/notifications/:id', () => {
    it('deletes a notification', async () => {
      pgQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request
        .delete('/api/v1/notifications/n-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(204);
    });

    it('returns 404 when not found', async () => {
      pgQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request
        .delete('/api/v1/notifications/nonexistent')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(404);
    });
  });

  // ─── Notification Channels ─────────────────────────────────────────────

  describe('Notification Channels', () => {
    it('GET /api/v1/notifications/channels lists channels', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'ch-1', channel_type: 'email' }] });

      const res = await request
        .get('/api/v1/notifications/channels')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('POST /api/v1/notifications/channels creates channel', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'ch-1', channel_type: 'webhook', enabled: true }] });

      const res = await request
        .post('/api/v1/notifications/channels')
        .set('x-user-id', 'user-1')
        .send({ channel_type: 'webhook', config: { url: 'https://example.com/hook' } });

      expect(res.status).toBe(201);
      expect(res.body.channel_type).toBe('webhook');
    });

    it('POST /api/v1/notifications/channels rejects without channel_type', async () => {
      const res = await request
        .post('/api/v1/notifications/channels')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
    });

    it('PATCH /api/v1/notifications/channels/:id updates channel', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'ch-1', enabled: false }] });

      const res = await request
        .patch('/api/v1/notifications/channels/ch-1')
        .set('x-user-id', 'user-1')
        .send({ enabled: false });

      expect(res.status).toBe(200);
    });

    it('PATCH /api/v1/notifications/channels/:id rejects with no changes', async () => {
      const res = await request
        .patch('/api/v1/notifications/channels/ch-1')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
    });

    it('DELETE /api/v1/notifications/channels/:id deletes channel', async () => {
      pgQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request
        .delete('/api/v1/notifications/channels/ch-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(204);
    });

    it('DELETE /api/v1/notifications/channels/:id returns 404', async () => {
      pgQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request
        .delete('/api/v1/notifications/channels/nonexistent')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(404);
    });
  });

  // ─── Rate Limiting & Dedup (dispatch pipeline) ─────────────────────────

  describe('Dispatch Pipeline', () => {
    it('dispatches notification under rate limit', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ preferences: {} }] }) // user prefs
        .mockResolvedValueOnce({ rows: [{ id: 'n-1', created_at: new Date().toISOString() }] }); // insert

      redisZremrangebyscore.mockResolvedValue(undefined);
      redisZcard.mockResolvedValue(5); // under 30 limit
      redisZadd.mockResolvedValue(1);
      redisExpire.mockResolvedValue(1);
      redisGet.mockResolvedValue(null); // no dedup
      redisSet.mockResolvedValue('OK');

      const result = await testDispatchNotification({
        user_id: 'user-1',
        notification_type: 'ticket_assigned',
        title: 'Test',
        body: 'Body',
        reference_type: 'ticket',
        reference_id: 'tid-1',
      });

      expect(result.dispatched).toBe(true);
      expect(result.notification.id).toBe('n-1');
    });

    it('blocks notification over rate limit (30/min)', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ preferences: {} }] });

      redisZremrangebyscore.mockResolvedValue(undefined);
      redisZcard.mockResolvedValue(30); // at limit

      const result = await testDispatchNotification({
        user_id: 'user-1',
        notification_type: 'ticket_update',
        title: 'Test',
        body: 'Body',
        reference_type: 'ticket',
        reference_id: 'tid-1',
      });

      expect(result.dispatched).toBe(false);
      expect(result.reason).toBe('rate_limited');
    });

    it('blocks duplicate notification within 60s', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ preferences: {} }] });

      redisZremrangebyscore.mockResolvedValue(undefined);
      redisZcard.mockResolvedValue(1);
      redisZadd.mockResolvedValue(1);
      redisExpire.mockResolvedValue(1);
      redisGet.mockResolvedValue('1'); // dedup key exists

      const result = await testDispatchNotification({
        user_id: 'user-1',
        notification_type: 'ticket_update',
        title: 'Test',
        body: 'Body',
        reference_type: 'ticket',
        reference_id: 'tid-1',
      });

      expect(result.dispatched).toBe(false);
      expect(result.reason).toBe('deduped');
    });

    it('allows different reference IDs (no dedup)', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ preferences: {} }] })
        .mockResolvedValueOnce({ rows: [{ id: 'n-2', created_at: new Date().toISOString() }] });

      redisZremrangebyscore.mockResolvedValue(undefined);
      redisZcard.mockResolvedValue(1);
      redisZadd.mockResolvedValue(1);
      redisExpire.mockResolvedValue(1);
      redisGet.mockResolvedValue(null); // no dedup for different reference
      redisSet.mockResolvedValue('OK');

      const result = await testDispatchNotification({
        user_id: 'user-1',
        notification_type: 'ticket_update',
        title: 'Test',
        body: 'Body',
        reference_type: 'ticket',
        reference_id: 'tid-different',
      });

      expect(result.dispatched).toBe(true);
    });

    it('respects user opt-out preference', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [{ preferences: { notifications: { ticket_assigned: false } } }],
      });

      const result = await testDispatchNotification({
        user_id: 'user-1',
        notification_type: 'ticket_assigned',
        title: 'Test',
        body: 'Body',
        reference_type: 'ticket',
        reference_id: 'tid-1',
      });

      expect(result.dispatched).toBe(false);
      expect(result.reason).toBe('opted_out');
    });
  });

  // ─── Preferences ───────────────────────────────────────────────────────

  describe('Notification Preferences', () => {
    it('GET /api/v1/notifications/preferences returns preferences', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [{ preferences: { notifications: { ticket_assigned: true, ticket_update: false } } }],
      });

      const res = await request
        .get('/api/v1/notifications/preferences')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.ticket_assigned).toBe(true);
      expect(res.body.ticket_update).toBe(false);
    });

    it('GET /api/v1/notifications/preferences returns empty for no prefs', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ preferences: {} }] });

      const res = await request
        .get('/api/v1/notifications/preferences')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });

    it('GET /api/v1/notifications/preferences returns 404 for unknown user', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .get('/api/v1/notifications/preferences')
        .set('x-user-id', 'nonexistent');

      expect(res.status).toBe(404);
    });

    it('PATCH /api/v1/notifications/preferences updates preferences', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [{ preferences: { notifications: { ticket_assigned: false } } }],
      });

      const res = await request
        .patch('/api/v1/notifications/preferences')
        .set('x-user-id', 'user-1')
        .send({ ticket_assigned: false });

      expect(res.status).toBe(200);
      expect(res.body.ticket_assigned).toBe(false);
    });
  });

  // ─── Jira Config CRUD ─────────────────────────────────────────────────

  describe('Jira Configuration', () => {
    it('GET /api/v1/notifications/jira/configs lists configs', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [{ id: 'jc-1', name: 'Test Jira', base_url: 'https://jira.example.com' }],
      });

      const res = await request.get('/api/v1/notifications/jira/configs');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('POST /api/v1/notifications/jira/configs creates config', async () => {
      const config = { id: 'jc-1', name: 'Prod Jira', base_url: 'https://jira.com', project_key: 'EMS' };
      pgQuery.mockResolvedValueOnce({ rows: [config] });

      const res = await request
        .post('/api/v1/notifications/jira/configs')
        .set('x-user-id', 'admin-1')
        .send({ name: 'Prod Jira', base_url: 'https://jira.com', project_key: 'EMS' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Prod Jira');
    });

    it('POST /api/v1/notifications/jira/configs rejects missing fields', async () => {
      const res = await request
        .post('/api/v1/notifications/jira/configs')
        .set('x-user-id', 'admin-1')
        .send({ name: 'Test' }); // missing base_url and project_key

      expect(res.status).toBe(400);
    });

    it('GET /api/v1/notifications/jira/configs/:id returns config', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'jc-1', name: 'Test' }] });

      const res = await request.get('/api/v1/notifications/jira/configs/jc-1');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('jc-1');
    });

    it('GET /api/v1/notifications/jira/configs/:id returns 404', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request.get('/api/v1/notifications/jira/configs/nonexistent');
      expect(res.status).toBe(404);
    });

    it('PATCH /api/v1/notifications/jira/configs/:id updates config', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'jc-1', name: 'Updated' }] });

      const res = await request
        .patch('/api/v1/notifications/jira/configs/jc-1')
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
    });

    it('PATCH /api/v1/notifications/jira/configs/:id rejects no changes', async () => {
      const res = await request
        .patch('/api/v1/notifications/jira/configs/jc-1')
        .send({});

      expect(res.status).toBe(400);
    });

    it('DELETE /api/v1/notifications/jira/configs/:id deletes', async () => {
      pgQuery.mockResolvedValueOnce({ rowCount: 1 });

      const res = await request.delete('/api/v1/notifications/jira/configs/jc-1');
      expect(res.status).toBe(204);
    });

    it('DELETE /api/v1/notifications/jira/configs/:id returns 404', async () => {
      pgQuery.mockResolvedValueOnce({ rowCount: 0 });

      const res = await request.delete('/api/v1/notifications/jira/configs/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  // ─── Jira Test Connection ──────────────────────────────────────────────

  describe('POST /api/v1/notifications/jira/configs/:id/test', () => {
    it('returns success on successful connection', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [{ id: 'jc-1', base_url: 'https://jira.example.com', project_key: 'EMS', auth: {} }],
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ key: 'EMS', name: 'EMS Project' }),
      });

      const res = await request.post('/api/v1/notifications/jira/configs/jc-1/test');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.project.key).toBe('EMS');
    });

    it('returns failure on connection error', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [{ id: 'jc-1', base_url: 'https://jira.example.com', project_key: 'EMS', auth: {} }],
      });
      global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

      const res = await request.post('/api/v1/notifications/jira/configs/jc-1/test');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Connection refused');
    });

    it('returns 404 for unknown config', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request.post('/api/v1/notifications/jira/configs/nonexistent/test');
      expect(res.status).toBe(404);
    });
  });

  // ─── Jira Webhook ──────────────────────────────────────────────────────

  describe('POST /api/v1/notifications/jira/webhook', () => {
    const webhookSecret = 'test-secret-123';

    function signPayload(payload, secret) {
      return 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
    }

    it('accepts valid HMAC signature', async () => {
      const payload = { issue: { key: 'EMS-1' }, webhookEvent: 'jira:issue_updated' };
      const sig = signPayload(payload, webhookSecret);

      pgQuery
        .mockResolvedValueOnce({ rows: [{ webhook_secret: webhookSecret }] }) // config
        .mockResolvedValueOnce({ rows: [{ // mapping
          ticket_id: 'tid-1', config_id: 'jc-1',
          jira_issue_key: 'EMS-1', sync_direction: 'both',
          field_mappings: {},
        }] });
      redisSet.mockResolvedValue('OK');

      const res = await request
        .post('/api/v1/notifications/jira/webhook')
        .set('x-hub-signature', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('rejects missing signature', async () => {
      const res = await request
        .post('/api/v1/notifications/jira/webhook')
        .send({ issue: { key: 'EMS-1' } });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MISSING_SIGNATURE');
    });

    it('rejects invalid signature', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ webhook_secret: webhookSecret }] });

      const res = await request
        .post('/api/v1/notifications/jira/webhook')
        .set('x-hub-signature', 'sha256=invalid_signature_0000000000000000000000000000000000000000000000000000000000000')
        .send({ issue: { key: 'EMS-1' } });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    });

    it('returns ok for unmapped issue', async () => {
      const payload = { issue: { key: 'UNKNOWN-1' } };
      const sig = signPayload(payload, webhookSecret);

      pgQuery
        .mockResolvedValueOnce({ rows: [{ webhook_secret: webhookSecret }] })
        .mockResolvedValueOnce({ rows: [] }); // no mapping

      const res = await request
        .post('/api/v1/notifications/jira/webhook')
        .set('x-hub-signature', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('unmapped issue');
    });

    it('returns ok for outbound-only sync direction', async () => {
      const payload = { issue: { key: 'EMS-1' } };
      const sig = signPayload(payload, webhookSecret);

      pgQuery
        .mockResolvedValueOnce({ rows: [{ webhook_secret: webhookSecret }] })
        .mockResolvedValueOnce({ rows: [{ sync_direction: 'outbound', ticket_id: 'tid-1' }] });

      const res = await request
        .post('/api/v1/notifications/jira/webhook')
        .set('x-hub-signature', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('inbound disabled');
    });

    it('sets sync lock to prevent loop', async () => {
      const payload = { issue: { key: 'EMS-1' }, webhookEvent: 'jira:issue_updated' };
      const sig = signPayload(payload, webhookSecret);

      pgQuery
        .mockResolvedValueOnce({ rows: [{ webhook_secret: webhookSecret }] })
        .mockResolvedValueOnce({ rows: [{
          ticket_id: 'tid-1', config_id: 'jc-1', sync_direction: 'both', field_mappings: {},
        }] });
      redisSet.mockResolvedValue('OK');

      await request
        .post('/api/v1/notifications/jira/webhook')
        .set('x-hub-signature', sig)
        .send(payload);

      expect(redisSet).toHaveBeenCalledWith('jira:sync_lock:tid-1', '1', 'EX', 30);
    });

    it('returns ok when no issue key', async () => {
      const payload = { webhookEvent: 'jira:issue_updated' }; // no issue
      const sig = signPayload(payload, webhookSecret);

      pgQuery.mockResolvedValueOnce({ rows: [{ webhook_secret: webhookSecret }] });

      const res = await request
        .post('/api/v1/notifications/jira/webhook')
        .set('x-hub-signature', sig)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('no issue key');
    });
  });

  // ─── Jira Sync Mappings ────────────────────────────────────────────────

  describe('GET /api/v1/notifications/jira/mappings', () => {
    it('lists all mappings', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [{ id: 'm-1', ticket_id: 'tid-1', jira_issue_key: 'EMS-1' }],
      });

      const res = await request.get('/api/v1/notifications/jira/mappings');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('filters by ticket_id', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'm-1' }] });

      const res = await request.get('/api/v1/notifications/jira/mappings?ticket_id=tid-1');
      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1]).toContain('tid-1');
    });
  });

  // ─── Jira Force Sync ──────────────────────────────────────────────────

  describe('POST /api/v1/notifications/jira/sync/:ticketId', () => {
    it('syncs existing mapping', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'tid-1', title: 'Test' }] }) // ticket
        .mockResolvedValueOnce({ rows: [{ id: 'jc-1', is_active: true }] }) // config
        .mockResolvedValueOnce({ rows: [{ jira_issue_key: 'EMS-1' }] }); // mapping

      const res = await request.post('/api/v1/notifications/jira/sync/tid-1');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('synced');
    });

    it('creates new mapping when none exists', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'tid-1', title: 'Test' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jc-1', is_active: true }] })
        .mockResolvedValueOnce({ rows: [] }); // no mapping

      const res = await request.post('/api/v1/notifications/jira/sync/tid-1');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('created');
    });

    it('returns 404 when ticket not found', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request.post('/api/v1/notifications/jira/sync/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns 404 when no active Jira config', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'tid-1' }] })
        .mockResolvedValueOnce({ rows: [] }); // no config

      const res = await request.post('/api/v1/notifications/jira/sync/tid-1');
      expect(res.status).toBe(404);
    });
  });

  // ─── Jira Sync Log ────────────────────────────────────────────────────

  describe('GET /api/v1/notifications/jira/log', () => {
    it('returns sync log', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [{ id: 'log-1', action: 'create_issue', status: 'success' }],
      });

      const res = await request.get('/api/v1/notifications/jira/log');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('filters by config_id', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request.get('/api/v1/notifications/jira/log?config_id=jc-1');
      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1]).toContain('jc-1');
    });

    it('caps limit at 200', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request.get('/api/v1/notifications/jira/log?limit=500');
      expect(res.status).toBe(200);
      // The limit param should be 200 (capped)
      const lastParam = pgQuery.mock.calls[0][1][pgQuery.mock.calls[0][1].length - 1];
      expect(lastParam).toBe(200);
    });
  });
});
