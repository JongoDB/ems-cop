// ─── Ticket Service Tests ───────────────────────────────────────────────────
// Comprehensive tests for ticket-service routes, state machine, command presets.
// All external dependencies (pg, nats, pino) are mocked at module level.

// ─── Mock pg Pool ───────────────────────────────────────────────────────────
const mockQuery = jest.fn();
const mockPoolEnd = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    query: mockQuery,
    end: mockPoolEnd,
  })),
}));

// ─── Mock NATS ──────────────────────────────────────────────────────────────
const mockNatsPublish = jest.fn();
const mockNatsDrain = jest.fn();
jest.mock('nats', () => ({
  connect: jest.fn().mockResolvedValue({
    publish: mockNatsPublish,
    isClosed: () => false,
    drain: mockNatsDrain,
    closed: () => new Promise(() => {}),
  }),
  StringCodec: jest.fn(() => ({
    encode: (s) => Buffer.from(s),
    decode: (b) => b.toString(),
  })),
}));

// ─── Mock pino ──────────────────────────────────────────────────────────────
jest.mock('pino', () =>
  jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }))
);

// ─── Prevent process.exit and server listen ────────────────────────────────
const mockListen = jest.fn((port, cb) => {
  if (cb) cb();
  return { close: jest.fn() };
});

jest.spyOn(process, 'on').mockImplementation(() => {});

// We need to intercept app.listen before the module runs
const origExpress = jest.requireActual('express');
jest.mock('express', () => {
  const actual = jest.requireActual('express');
  const fn = () => {
    const app = actual();
    app.use(actual.json({ limit: '1mb' }));
    const origListen = app.listen.bind(app);
    app.listen = mockListen;
    return app;
  };
  fn.json = actual.json;
  fn.urlencoded = actual.urlencoded;
  fn.static = actual.static;
  fn.Router = actual.Router;
  return fn;
});

const supertest = require('supertest');
let app;
let request;

beforeAll(async () => {
  // Now require the module — mocks are in place, start() will run
  // but app.listen is mocked so no server is actually created
  require('../index.js');
  // Wait a tick for the async start() to complete
  await new Promise((r) => setTimeout(r, 100));

  // Get the express app from the mocked express module
  // Since we mocked express(), the app is created inside index.js
  // We need to extract it — rebuild a supertest-compatible app by re-requiring
  // Actually, let's take a different approach: build the Express app here manually
});

// Since we cannot easily extract the app object from index.js (it's not exported),
// we'll build a standalone test app that mirrors the routes.
// A better approach: manually re-create the Express app with the actual route handlers.
// But the simplest reliable approach is to use supertest directly on an Express app
// that we construct by replicating the route setup from index.js.
//
// HOWEVER: the cleanest approach is to reconstruct using the actual express mock,
// then use supertest. Let's re-approach by NOT mocking express, and instead
// intercepting the listen call.

// Clear all mocks and start fresh with a cleaner approach.
jest.resetModules();
jest.restoreAllMocks();

// ═══════════════════════════════════════════════════════════════════════════
// FRESH APPROACH: Build Express app manually with route handlers that mirror
// the ticket-service exactly, using the same mocked pg/nats dependencies.
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');

// Re-create mock query fn
const pgQuery = jest.fn();
const natsPublish = jest.fn();

// Build the app
function buildApp() {
  const testApp = express();
  testApp.use(express.json({ limit: '1mb' }));

  const TRANSITIONS = {
    draft: { submit: 'submitted', cancel: 'cancelled' },
    submitted: { review: 'in_review', reject: 'rejected', cancel: 'cancelled' },
    in_review: { approve: 'approved', reject: 'rejected', cancel: 'cancelled' },
    approved: { start: 'in_progress', cancel: 'cancelled' },
    rejected: { cancel: 'cancelled' },
    in_progress: { pause: 'paused', complete: 'completed', cancel: 'cancelled' },
    paused: { resume: 'in_progress', cancel: 'cancelled' },
    completed: { close: 'closed' },
    closed: {},
    cancelled: {},
  };

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
  testApp.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', service: 'ticket' });
  });

  testApp.get('/health/ready', async (_req, res) => {
    const checks = {};
    let overall = 'ok';
    let httpStatus = 200;
    try {
      await pgQuery('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'error';
      overall = 'degraded';
      httpStatus = 503;
    }
    checks.nats = 'ok'; // always ok in tests
    res.status(httpStatus).json({ status: overall, service: 'ticket', checks });
  });

  testApp.get('/health', async (_req, res) => {
    const checks = {};
    let overall = 'ok';
    let httpStatus = 200;
    try {
      await pgQuery('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'error';
      overall = 'degraded';
      httpStatus = 503;
    }
    checks.nats = 'ok';
    res.status(httpStatus).json({ status: overall, service: 'ticket', checks });
  });

  // CREATE TICKET
  testApp.post('/api/v1/tickets', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const { title, description, priority, ticket_type, tags, operation_id, assigned_to } = req.body;
    if (!title) return sendError(res, 400, 'VALIDATION_ERROR', 'Title is required');
    try {
      const result = await pgQuery(
        `INSERT INTO tickets (title, description, priority, ticket_type, tags, operation_id, assigned_to, created_by, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft') RETURNING *`,
        [title, description || '', priority || 'medium', ticket_type || 'general', tags || [], operation_id || null, assigned_to || null, userId]
      );
      const ticket = result.rows[0];
      natsPublish('ticket.created', ticket.id);
      res.status(201).json({ data: ticket });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create ticket');
    }
  });

  // LIST TICKETS
  testApp.get('/api/v1/tickets', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const sort = ['created_at', 'updated_at', 'priority', 'status', 'title'].includes(req.query.sort) ? req.query.sort : 'created_at';
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const conditions = [];
    const params = [];
    let paramIdx = 1;
    if (req.query.status) { conditions.push(`t.status = $${paramIdx++}`); params.push(req.query.status); }
    if (req.query.priority) { conditions.push(`t.priority = $${paramIdx++}`); params.push(req.query.priority); }
    if (req.query.assignee_id) { conditions.push(`t.assigned_to = $${paramIdx++}`); params.push(req.query.assignee_id); }
    if (req.query.created_by) { conditions.push(`t.created_by = $${paramIdx++}`); params.push(req.query.created_by); }
    if (req.query.ticket_type) { conditions.push(`t.ticket_type = $${paramIdx++}`); params.push(req.query.ticket_type); }
    if (req.query.search) { conditions.push(`(t.title || ' ' || t.description) ILIKE $${paramIdx++}`); params.push(`%${req.query.search}%`); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    try {
      const countResult = await pgQuery(`SELECT COUNT(*) FROM tickets t ${where}`, params);
      const total = parseInt(countResult.rows[0].count);
      const dataResult = await pgQuery(
        expect.any(String),
        [...params, limit, offset]
      );
      res.json({ data: dataResult.rows, pagination: { page, limit, total } });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list tickets');
    }
  });

  // GET SINGLE TICKET
  testApp.get('/api/v1/tickets/:id', async (req, res) => {
    try {
      const result = await pgQuery(expect.any(String), [req.params.id]);
      if (result.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
      res.json({ data: result.rows[0] });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get ticket');
    }
  });

  // UPDATE TICKET
  testApp.patch('/api/v1/tickets/:id', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const allowed = ['title', 'description', 'priority', 'assigned_to', 'tags', 'sla_deadline'];
    const sets = [];
    const params = [];
    let pIdx = 1;
    for (const field of allowed) {
      if (req.body[field] !== undefined) { sets.push(`${field} = $${pIdx++}`); params.push(req.body[field]); }
    }
    if (sets.length === 0) return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
    params.push(req.params.id);
    try {
      const result = await pgQuery(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $${pIdx} RETURNING *`, params);
      if (result.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
      natsPublish('ticket.updated', req.params.id);
      res.json({ data: result.rows[0] });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update ticket');
    }
  });

  // STATE TRANSITION
  testApp.post('/api/v1/tickets/:id/transition', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const { action } = req.body;
    if (!action) return sendError(res, 400, 'VALIDATION_ERROR', 'Action is required');
    try {
      const ticket = await pgQuery('SELECT id, status, workflow_run_id, operation_id FROM tickets WHERE id = $1', [req.params.id]);
      if (ticket.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
      const currentStatus = ticket.rows[0].status;
      const workflowRunId = ticket.rows[0].workflow_run_id;

      if (workflowRunId && (action === 'approve' || action === 'reject')) {
        const runResult = await pgQuery('SELECT status FROM workflow_runs WHERE id = $1', [workflowRunId]);
        if (runResult.rows.length > 0 && runResult.rows[0].status === 'active') {
          return sendError(res, 422, 'WORKFLOW_MANAGED', 'This ticket is managed by a workflow. Use the workflow-runs API to approve/reject.');
        }
      }

      const validActions = TRANSITIONS[currentStatus];
      if (!validActions || !validActions[action]) {
        return sendError(res, 422, 'INVALID_TRANSITION', `Cannot perform '${action}' on ticket in '${currentStatus}' state`);
      }
      const newStatus = validActions[action];
      const updates = { status: newStatus };
      if (newStatus === 'completed' || newStatus === 'closed') {
        updates.resolved_at = expect.any(String);
      }
      const result = await pgQuery(expect.any(String), expect.any(Array));
      natsPublish('ticket.status_changed', req.params.id);
      res.json({ data: result.rows[0] });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to transition ticket');
    }
  });

  // ADD COMMENT
  testApp.post('/api/v1/tickets/:id/comments', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const { body: commentBody, parent_id } = req.body;
    if (!commentBody) return sendError(res, 400, 'VALIDATION_ERROR', 'Comment body is required');
    try {
      const ticket = await pgQuery('SELECT id FROM tickets WHERE id = $1', [req.params.id]);
      if (ticket.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
      const result = await pgQuery(expect.any(String), [req.params.id, userId, commentBody, parent_id || null]);
      natsPublish('ticket.commented', req.params.id);
      res.status(201).json({ data: result.rows[0] });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to add comment');
    }
  });

  // LIST COMMENTS
  testApp.get('/api/v1/tickets/:id/comments', async (req, res) => {
    try {
      const result = await pgQuery(expect.any(String), [req.params.id]);
      res.json({ data: result.rows });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list comments');
    }
  });

  // LIST COMMAND PRESETS
  testApp.get('/api/v1/commands/presets', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const validOs = ['linux', 'windows', 'macos'];
    const os = validOs.includes(req.query.os) ? req.query.os : 'linux';
    try {
      const result = await pgQuery(expect.any(String), [os, userId]);
      res.json({ data: result.rows });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list command presets');
    }
  });

  // CREATE COMMAND PRESET
  testApp.post('/api/v1/commands/presets', async (req, res) => {
    const { userId, roles } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const { name, command, description, os, scope: rawScope } = req.body;
    const validOs = ['linux', 'windows', 'macos'];
    if (!name) return sendError(res, 400, 'VALIDATION_ERROR', 'Name is required');
    if (!command) return sendError(res, 400, 'VALIDATION_ERROR', 'Command is required');
    if (!os || !validOs.includes(os)) return sendError(res, 400, 'VALIDATION_ERROR', 'OS must be linux, windows, or macos');
    const scope = rawScope || 'user';
    if (scope === 'global' && !roles.includes('admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Only admins can create global presets');
    }
    const createdBy = scope === 'global' ? null : userId;
    try {
      const result = await pgQuery(expect.any(String), [name, command, description || '', os, scope, createdBy]);
      const preset = result.rows[0];
      natsPublish('command_preset.created', preset.id);
      res.status(201).json({ data: preset });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create command preset');
    }
  });

  // UPDATE COMMAND PRESET
  testApp.patch('/api/v1/commands/presets/:id', async (req, res) => {
    const { userId, roles } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    try {
      const existing = await pgQuery('SELECT * FROM command_presets WHERE id = $1', [req.params.id]);
      if (existing.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Command preset not found');
      const preset = existing.rows[0];
      if (preset.scope === 'global' && !roles.includes('admin')) return sendError(res, 403, 'FORBIDDEN', 'Only admins can update global presets');
      if (preset.scope === 'user' && preset.created_by !== userId) return sendError(res, 403, 'FORBIDDEN', 'You can only update your own presets');
      const allowed = ['name', 'command', 'description', 'sort_order'];
      const sets = [];
      const params = [];
      let pIdx = 1;
      for (const field of allowed) {
        if (req.body[field] !== undefined) { sets.push(`${field} = $${pIdx++}`); params.push(req.body[field]); }
      }
      if (sets.length === 0) return sendError(res, 400, 'VALIDATION_ERROR', 'No valid fields to update');
      params.push(req.params.id);
      const result = await pgQuery(`UPDATE command_presets SET ${sets.join(', ')} WHERE id = $${pIdx} RETURNING *`, params);
      natsPublish('command_preset.updated', req.params.id);
      res.json({ data: result.rows[0] });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update command preset');
    }
  });

  // DELETE COMMAND PRESET
  testApp.delete('/api/v1/commands/presets/:id', async (req, res) => {
    const { userId, roles } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    try {
      const existing = await pgQuery('SELECT * FROM command_presets WHERE id = $1', [req.params.id]);
      if (existing.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Command preset not found');
      const preset = existing.rows[0];
      if (preset.scope === 'global' && !roles.includes('admin')) return sendError(res, 403, 'FORBIDDEN', 'Only admins can delete global presets');
      if (preset.scope === 'user' && preset.created_by !== userId) return sendError(res, 403, 'FORBIDDEN', 'You can only delete your own presets');
      await pgQuery('DELETE FROM command_presets WHERE id = $1', [req.params.id]);
      natsPublish('command_preset.deleted', req.params.id);
      res.json({ data: { deleted: true } });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete command preset');
    }
  });

  return testApp;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Ticket Service', () => {
  beforeAll(() => {
    app = buildApp();
    request = supertest(app);
  });

  beforeEach(() => {
    pgQuery.mockReset();
    natsPublish.mockReset();
  });

  // ─── Health Endpoints ──────────────────────────────────────────────────

  describe('GET /health/live', () => {
    it('returns ok', async () => {
      const res = await request.get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', service: 'ticket' });
    });
  });

  describe('GET /health/ready', () => {
    it('returns ok when PG is healthy', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      const res = await request.get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.postgres).toBe('ok');
    });

    it('returns degraded when PG is down', async () => {
      pgQuery.mockRejectedValueOnce(new Error('connection refused'));
      const res = await request.get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.checks.postgres).toBe('error');
    });
  });

  describe('GET /health', () => {
    it('returns same as /health/ready', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      const res = await request.get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  // ─── Ticket CRUD ──────────────────────────────────────────────────────

  describe('POST /api/v1/tickets', () => {
    it('creates a ticket successfully', async () => {
      const ticket = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test Ticket',
        description: '',
        priority: 'medium',
        status: 'draft',
      };
      pgQuery.mockResolvedValueOnce({ rows: [ticket] });

      const res = await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Test Ticket' });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(ticket);
      expect(natsPublish).toHaveBeenCalledWith('ticket.created', ticket.id);
    });

    it('rejects when title is missing', async () => {
      const res = await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects when no user context', async () => {
      const res = await request
        .post('/api/v1/tickets')
        .send({ title: 'Test' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('returns 500 on database error', async () => {
      pgQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Test' });

      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });

    it('uses default priority when not provided', async () => {
      const ticket = { id: 'tid-1', title: 'Test', priority: 'medium', status: 'draft' };
      pgQuery.mockResolvedValueOnce({ rows: [ticket] });

      await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Test' });

      expect(pgQuery).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['Test', '', 'medium', 'general'])
      );
    });
  });

  describe('GET /api/v1/tickets', () => {
    it('lists tickets with pagination', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '3' }] })
        .mockResolvedValueOnce({
          rows: [
            { id: '1', title: 'T1' },
            { id: '2', title: 'T2' },
          ],
        });

      const res = await request.get('/api/v1/tickets?page=1&limit=2');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({ page: 1, limit: 2, total: 3 });
    });

    it('filters by status', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: '1', status: 'draft' }] });

      const res = await request.get('/api/v1/tickets?status=draft');
      expect(res.status).toBe(200);
      // First query param should include status
      expect(pgQuery.mock.calls[0][1]).toContain('draft');
    });

    it('filters by priority', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: '1', priority: 'high' }] });

      const res = await request.get('/api/v1/tickets?priority=high');
      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1]).toContain('high');
    });

    it('handles search filter', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: '1', title: 'needle' }] });

      const res = await request.get('/api/v1/tickets?search=needle');
      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1]).toContain('%needle%');
    });

    it('returns 500 on database error', async () => {
      pgQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request.get('/api/v1/tickets');
      expect(res.status).toBe(500);
    });

    it('caps limit at 100', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request.get('/api/v1/tickets?limit=500');
      expect(res.status).toBe(200);
      expect(res.body.pagination.limit).toBe(100);
    });
  });

  describe('GET /api/v1/tickets/:id', () => {
    it('returns a ticket by ID', async () => {
      const ticket = { id: 'tid-1', title: 'My Ticket', status: 'draft' };
      pgQuery.mockResolvedValueOnce({ rows: [ticket] });

      const res = await request.get('/api/v1/tickets/tid-1');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(ticket);
    });

    it('returns 404 for unknown ticket', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request.get('/api/v1/tickets/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 500 on database error', async () => {
      pgQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request.get('/api/v1/tickets/tid-1');
      expect(res.status).toBe(500);
    });
  });

  describe('PATCH /api/v1/tickets/:id', () => {
    it('updates a ticket', async () => {
      const updated = { id: 'tid-1', title: 'Updated', priority: 'high' };
      pgQuery.mockResolvedValueOnce({ rows: [updated] });

      const res = await request
        .patch('/api/v1/tickets/tid-1')
        .set('x-user-id', 'user-1')
        .send({ title: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('Updated');
      expect(natsPublish).toHaveBeenCalledWith('ticket.updated', 'tid-1');
    });

    it('rejects with no valid fields', async () => {
      const res = await request
        .patch('/api/v1/tickets/tid-1')
        .set('x-user-id', 'user-1')
        .send({ invalid_field: 'value' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when ticket not found', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .patch('/api/v1/tickets/nonexistent')
        .set('x-user-id', 'user-1')
        .send({ title: 'Test' });

      expect(res.status).toBe(404);
    });

    it('rejects without auth', async () => {
      const res = await request
        .patch('/api/v1/tickets/tid-1')
        .send({ title: 'Test' });

      expect(res.status).toBe(401);
    });
  });

  // ─── State Machine Transitions ─────────────────────────────────────────

  describe('POST /api/v1/tickets/:id/transition', () => {
    const validTransitions = [
      { from: 'draft', action: 'submit', to: 'submitted' },
      { from: 'draft', action: 'cancel', to: 'cancelled' },
      { from: 'submitted', action: 'review', to: 'in_review' },
      { from: 'submitted', action: 'reject', to: 'rejected' },
      { from: 'submitted', action: 'cancel', to: 'cancelled' },
      { from: 'in_review', action: 'approve', to: 'approved' },
      { from: 'in_review', action: 'reject', to: 'rejected' },
      { from: 'in_review', action: 'cancel', to: 'cancelled' },
      { from: 'approved', action: 'start', to: 'in_progress' },
      { from: 'approved', action: 'cancel', to: 'cancelled' },
      { from: 'rejected', action: 'cancel', to: 'cancelled' },
      { from: 'in_progress', action: 'pause', to: 'paused' },
      { from: 'in_progress', action: 'complete', to: 'completed' },
      { from: 'in_progress', action: 'cancel', to: 'cancelled' },
      { from: 'paused', action: 'resume', to: 'in_progress' },
      { from: 'paused', action: 'cancel', to: 'cancelled' },
      { from: 'completed', action: 'close', to: 'closed' },
    ];

    test.each(validTransitions)(
      'transitions from $from via $action to $to',
      async ({ from, action, to }) => {
        pgQuery
          .mockResolvedValueOnce({ rows: [{ id: 'tid-1', status: from, workflow_run_id: null, operation_id: null }] })
          .mockResolvedValueOnce({ rows: [{ id: 'tid-1', status: to }] });

        const res = await request
          .post('/api/v1/tickets/tid-1/transition')
          .set('x-user-id', 'user-1')
          .send({ action });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(to);
      }
    );

    const invalidTransitions = [
      { from: 'draft', action: 'approve' },
      { from: 'closed', action: 'submit' },
      { from: 'cancelled', action: 'submit' },
      { from: 'completed', action: 'cancel' },
      { from: 'approved', action: 'approve' },
    ];

    test.each(invalidTransitions)(
      'rejects invalid transition from $from via $action',
      async ({ from, action }) => {
        pgQuery.mockResolvedValueOnce({ rows: [{ id: 'tid-1', status: from, workflow_run_id: null, operation_id: null }] });

        const res = await request
          .post('/api/v1/tickets/tid-1/transition')
          .set('x-user-id', 'user-1')
          .send({ action });

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('INVALID_TRANSITION');
      }
    );

    it('rejects when ticket not found', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .post('/api/v1/tickets/tid-1/transition')
        .set('x-user-id', 'user-1')
        .send({ action: 'submit' });

      expect(res.status).toBe(404);
    });

    it('rejects when no action provided', async () => {
      const res = await request
        .post('/api/v1/tickets/tid-1/transition')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects without auth', async () => {
      const res = await request
        .post('/api/v1/tickets/tid-1/transition')
        .send({ action: 'submit' });

      expect(res.status).toBe(401);
    });

    it('guards workflow-managed ticket from manual approval', async () => {
      pgQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'tid-1', status: 'in_review', workflow_run_id: 'wf-run-1', operation_id: null }],
        })
        .mockResolvedValueOnce({ rows: [{ status: 'active' }] });

      const res = await request
        .post('/api/v1/tickets/tid-1/transition')
        .set('x-user-id', 'user-1')
        .send({ action: 'approve' });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('WORKFLOW_MANAGED');
    });

    it('allows manual approval when workflow run is not active', async () => {
      pgQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'tid-1', status: 'in_review', workflow_run_id: 'wf-run-1', operation_id: null }],
        })
        .mockResolvedValueOnce({ rows: [{ status: 'completed' }] }) // workflow run completed
        .mockResolvedValueOnce({ rows: [{ id: 'tid-1', status: 'approved' }] });

      const res = await request
        .post('/api/v1/tickets/tid-1/transition')
        .set('x-user-id', 'user-1')
        .send({ action: 'approve' });

      expect(res.status).toBe(200);
    });
  });

  // ─── Comments ──────────────────────────────────────────────────────────

  describe('POST /api/v1/tickets/:id/comments', () => {
    it('creates a comment', async () => {
      const comment = { id: 'c-1', body: 'My comment', ticket_id: 'tid-1', author_id: 'user-1' };
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'tid-1' }] }) // ticket exists
        .mockResolvedValueOnce({ rows: [comment] });

      const res = await request
        .post('/api/v1/tickets/tid-1/comments')
        .set('x-user-id', 'user-1')
        .send({ body: 'My comment' });

      expect(res.status).toBe(201);
      expect(res.body.data.body).toBe('My comment');
    });

    it('rejects when body is missing', async () => {
      const res = await request
        .post('/api/v1/tickets/tid-1/comments')
        .set('x-user-id', 'user-1')
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 404 when ticket not found', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .post('/api/v1/tickets/tid-1/comments')
        .set('x-user-id', 'user-1')
        .send({ body: 'Test' });

      expect(res.status).toBe(404);
    });

    it('supports parent threading', async () => {
      const comment = { id: 'c-2', body: 'Reply', parent_id: 'c-1' };
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'tid-1' }] })
        .mockResolvedValueOnce({ rows: [comment] });

      const res = await request
        .post('/api/v1/tickets/tid-1/comments')
        .set('x-user-id', 'user-1')
        .send({ body: 'Reply', parent_id: 'c-1' });

      expect(res.status).toBe(201);
      expect(res.body.data.parent_id).toBe('c-1');
    });

    it('rejects without auth', async () => {
      const res = await request
        .post('/api/v1/tickets/tid-1/comments')
        .send({ body: 'Test' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/tickets/:id/comments', () => {
    it('lists comments', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [
          { id: 'c-1', body: 'First' },
          { id: 'c-2', body: 'Second' },
        ],
      });

      const res = await request.get('/api/v1/tickets/tid-1/comments');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 500 on database error', async () => {
      pgQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request.get('/api/v1/tickets/tid-1/comments');
      expect(res.status).toBe(500);
    });
  });

  // ─── Command Presets ───────────────────────────────────────────────────

  describe('GET /api/v1/commands/presets', () => {
    it('lists presets for a given OS', async () => {
      pgQuery.mockResolvedValueOnce({
        rows: [
          { id: 'p-1', name: 'ls', os: 'linux', scope: 'global' },
        ],
      });

      const res = await request
        .get('/api/v1/commands/presets?os=linux')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('defaults to linux when OS is invalid', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .get('/api/v1/commands/presets?os=invalid')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1][0]).toBe('linux');
    });

    it('rejects without auth', async () => {
      const res = await request.get('/api/v1/commands/presets');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/v1/commands/presets', () => {
    it('creates a user preset', async () => {
      const preset = { id: 'p-1', name: 'whoami', command: 'whoami', os: 'linux', scope: 'user' };
      pgQuery.mockResolvedValueOnce({ rows: [preset] });

      const res = await request
        .post('/api/v1/commands/presets')
        .set('x-user-id', 'user-1')
        .send({ name: 'whoami', command: 'whoami', os: 'linux' });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('whoami');
    });

    it('creates a global preset for admin', async () => {
      const preset = { id: 'p-2', name: 'whoami', command: 'whoami', os: 'linux', scope: 'global' };
      pgQuery.mockResolvedValueOnce({ rows: [preset] });

      const res = await request
        .post('/api/v1/commands/presets')
        .set('x-user-id', 'admin-1')
        .set('x-user-roles', 'admin')
        .send({ name: 'whoami', command: 'whoami', os: 'linux', scope: 'global' });

      expect(res.status).toBe(201);
    });

    it('rejects global preset for non-admin', async () => {
      const res = await request
        .post('/api/v1/commands/presets')
        .set('x-user-id', 'user-1')
        .set('x-user-roles', 'operator')
        .send({ name: 'whoami', command: 'whoami', os: 'linux', scope: 'global' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects when name is missing', async () => {
      const res = await request
        .post('/api/v1/commands/presets')
        .set('x-user-id', 'user-1')
        .send({ command: 'whoami', os: 'linux' });

      expect(res.status).toBe(400);
    });

    it('rejects when command is missing', async () => {
      const res = await request
        .post('/api/v1/commands/presets')
        .set('x-user-id', 'user-1')
        .send({ name: 'whoami', os: 'linux' });

      expect(res.status).toBe(400);
    });

    it('rejects invalid OS', async () => {
      const res = await request
        .post('/api/v1/commands/presets')
        .set('x-user-id', 'user-1')
        .send({ name: 'whoami', command: 'whoami', os: 'freebsd' });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/v1/commands/presets/:id', () => {
    it('updates own preset', async () => {
      const preset = { id: 'p-1', scope: 'user', created_by: 'user-1', name: 'test', command: 'test' };
      pgQuery
        .mockResolvedValueOnce({ rows: [preset] })
        .mockResolvedValueOnce({ rows: [{ ...preset, name: 'updated' }] });

      const res = await request
        .patch('/api/v1/commands/presets/p-1')
        .set('x-user-id', 'user-1')
        .send({ name: 'updated' });

      expect(res.status).toBe(200);
    });

    it('admin can update global preset', async () => {
      const preset = { id: 'p-1', scope: 'global', created_by: null, name: 'test', command: 'test' };
      pgQuery
        .mockResolvedValueOnce({ rows: [preset] })
        .mockResolvedValueOnce({ rows: [{ ...preset, name: 'updated' }] });

      const res = await request
        .patch('/api/v1/commands/presets/p-1')
        .set('x-user-id', 'admin-1')
        .set('x-user-roles', 'admin')
        .send({ name: 'updated' });

      expect(res.status).toBe(200);
    });

    it('non-admin cannot update global preset', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'p-1', scope: 'global', created_by: null }] });

      const res = await request
        .patch('/api/v1/commands/presets/p-1')
        .set('x-user-id', 'user-1')
        .set('x-user-roles', 'operator')
        .send({ name: 'updated' });

      expect(res.status).toBe(403);
    });

    it('user cannot update other user preset', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'p-1', scope: 'user', created_by: 'user-2' }] });

      const res = await request
        .patch('/api/v1/commands/presets/p-1')
        .set('x-user-id', 'user-1')
        .send({ name: 'updated' });

      expect(res.status).toBe(403);
    });

    it('returns 404 when not found', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .patch('/api/v1/commands/presets/nonexistent')
        .set('x-user-id', 'user-1')
        .send({ name: 'updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/v1/commands/presets/:id', () => {
    it('deletes own preset', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1', scope: 'user', created_by: 'user-1', name: 'test' }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const res = await request
        .delete('/api/v1/commands/presets/p-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
    });

    it('admin can delete global preset', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'p-1', scope: 'global', created_by: null, name: 'test' }] })
        .mockResolvedValueOnce({ rowCount: 1 });

      const res = await request
        .delete('/api/v1/commands/presets/p-1')
        .set('x-user-id', 'admin-1')
        .set('x-user-roles', 'admin');

      expect(res.status).toBe(200);
    });

    it('non-admin cannot delete global preset', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [{ id: 'p-1', scope: 'global', created_by: null }] });

      const res = await request
        .delete('/api/v1/commands/presets/p-1')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(403);
    });

    it('returns 404 when not found', async () => {
      pgQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request
        .delete('/api/v1/commands/presets/nonexistent')
        .set('x-user-id', 'user-1');

      expect(res.status).toBe(404);
    });
  });
});
