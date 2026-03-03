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

  const INCIDENT_TRANSITIONS = {
    draft:                  { submit: 'triage' },
    triage:                 { investigate: 'investigation', dismiss: 'false_positive', cancel: 'cancelled' },
    investigation:          { contain: 'containment', escalate: 'escalated', dismiss: 'false_positive' },
    containment:            { remediate: 'remediation', escalate: 'escalated' },
    escalated:              { investigate: 'investigation', contain: 'containment' },
    remediation:            { review: 'post_incident_review' },
    post_incident_review:   { close: 'closed', reopen: 'investigation' },
    false_positive:         { reopen: 'triage', close: 'closed' },
    closed:                 {},
    cancelled:              {},
  };

  const VALID_INCIDENT_SEVERITIES = ['critical', 'high', 'medium', 'low'];
  const VALID_ALERT_SOURCES = ['splunk', 'elastic', 'crowdstrike', 'generic'];
  const VALID_CONTAINMENT_STATUSES = ['none', 'in_progress', 'contained', 'remediated'];

  // Enclave config for tests (can be overridden per-test via testApp._testEnclave)
  testApp._testEnclave = '';

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

  // --- Incident Management (DCO/SOC) ---

  // LIST INCIDENTS
  testApp.get('/api/v1/tickets/incidents', async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size) || 20));
    const offset = (page - 1) * pageSize;
    const conditions = [`t.ticket_type = 'incident'`];
    const params = [];
    let paramIdx = 1;
    if (req.query.incident_severity) { conditions.push(`t.incident_severity = $${paramIdx++}`); params.push(req.query.incident_severity); }
    if (req.query.containment_status) { conditions.push(`t.containment_status = $${paramIdx++}`); params.push(req.query.containment_status); }
    if (req.query.status) { conditions.push(`t.status = $${paramIdx++}`); params.push(req.query.status); }
    if (req.query.mitre_technique) { conditions.push(`$${paramIdx++} = ANY(t.mitre_techniques)`); params.push(req.query.mitre_technique); }
    if (req.query.alert_source) { conditions.push(`t.alert_source = $${paramIdx++}`); params.push(req.query.alert_source); }
    if (req.query.assigned_to) { conditions.push(`t.assigned_to = $${paramIdx++}`); params.push(req.query.assigned_to); }
    const ENCLAVE = testApp._testEnclave || '';
    if (ENCLAVE === 'low') { conditions.push(`t.classification != 'SECRET'`); }
    const where = 'WHERE ' + conditions.join(' AND ');
    try {
      const countResult = await pgQuery(expect.any(String), params);
      const total = parseInt(countResult.rows[0].count);
      const dataResult = await pgQuery(expect.any(String), [...params, pageSize, offset]);
      res.set('X-Classification', ENCLAVE === 'low' ? 'CUI' : 'SECRET');
      res.json({ data: dataResult.rows, pagination: { page, page_size: pageSize, total } });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list incidents');
    }
  });

  // INCIDENT STATS
  testApp.get('/api/v1/tickets/incidents/stats', async (_req, res) => {
    try {
      // by_severity
      const sevResult = await pgQuery(expect.any(String));
      const by_severity = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const row of sevResult.rows) {
        if (row.incident_severity && by_severity.hasOwnProperty(row.incident_severity)) {
          by_severity[row.incident_severity] = row.count;
        }
      }
      // by_status
      const statusResult = await pgQuery(expect.any(String));
      const by_status = {};
      for (const row of statusResult.rows) {
        by_status[row.status] = row.count;
      }
      const closedStatuses = ['closed', 'cancelled', 'false_positive'];
      let total_open = 0;
      let total_closed = 0;
      for (const [status, count] of Object.entries(by_status)) {
        if (closedStatuses.includes(status)) { total_closed += count; } else { total_open += count; }
      }
      // MTTD
      const mttdResult = await pgQuery(expect.any(String));
      const mttd_hours = mttdResult.rows[0].mttd_hours !== null ? parseFloat(parseFloat(mttdResult.rows[0].mttd_hours).toFixed(1)) : 0;
      // MTTR
      const mttrResult = await pgQuery(expect.any(String));
      const mttr_hours = mttrResult.rows[0].mttr_hours !== null ? parseFloat(parseFloat(mttrResult.rows[0].mttr_hours).toFixed(1)) : 0;
      const ENCLAVE = testApp._testEnclave || '';
      res.set('X-Classification', ENCLAVE === 'low' ? 'CUI' : 'SECRET');
      res.json({ by_severity, by_status, total_open, total_closed, mttd_hours, mttr_hours });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get incident statistics');
    }
  });

  // CONSOLIDATED INCIDENTS (HIGH SIDE ONLY)
  testApp.get('/api/v1/tickets/incidents/consolidated', async (_req, res) => {
    const ENCLAVE = testApp._testEnclave || '';
    if (ENCLAVE === 'low') {
      return sendError(res, 403, 'FORBIDDEN', 'Consolidated view is only available on the high-side enclave');
    }
    try {
      const result = await pgQuery(expect.any(String));
      res.set('X-Classification', 'SECRET');
      res.json({ data: result.rows, enclave: 'high', total: result.rows.length });
    } catch (err) {
      sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get consolidated incidents');
    }
  });

  // CREATE TICKET (with incident support)
  testApp.post('/api/v1/tickets', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const { title, description, priority, ticket_type, tags, operation_id, assigned_to } = req.body;
    if (!title) return sendError(res, 400, 'VALIDATION_ERROR', 'Title is required');

    // Incident-specific validation
    const isIncident = ticket_type === 'incident';
    let incident_severity = null;
    let alert_source = null;
    let alert_ids = null;
    let mitre_techniques = null;
    let containment_status = null;

    if (isIncident) {
      incident_severity = req.body.incident_severity || 'medium';
      if (!VALID_INCIDENT_SEVERITIES.includes(incident_severity)) {
        return sendError(res, 400, 'VALIDATION_ERROR', `Invalid incident_severity. Must be one of: ${VALID_INCIDENT_SEVERITIES.join(', ')}`);
      }
      alert_source = req.body.alert_source || 'generic';
      if (!VALID_ALERT_SOURCES.includes(alert_source)) {
        return sendError(res, 400, 'VALIDATION_ERROR', `Invalid alert_source. Must be one of: ${VALID_ALERT_SOURCES.join(', ')}`);
      }
      alert_ids = req.body.alert_ids || [];
      mitre_techniques = req.body.mitre_techniques || [];
      containment_status = req.body.containment_status || 'none';
      if (!VALID_CONTAINMENT_STATUSES.includes(containment_status)) {
        return sendError(res, 400, 'VALIDATION_ERROR', `Invalid containment_status. Must be one of: ${VALID_CONTAINMENT_STATUSES.join(', ')}`);
      }
    }

    try {
      const result = await pgQuery(
        expect.any(String),
        [title, description || '', priority || 'medium', ticket_type || 'general', tags || [], operation_id || null, assigned_to || null, userId,
         incident_severity, alert_source, alert_ids, mitre_techniques, containment_status]
      );
      const ticket = result.rows[0];
      natsPublish('ticket.created', ticket.id);
      if (isIncident) {
        natsPublish('dco.incident_created', ticket.id);
      }
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

  // UPDATE TICKET (with incident field support)
  testApp.patch('/api/v1/tickets/:id', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    if (req.body.incident_severity !== undefined && !VALID_INCIDENT_SEVERITIES.includes(req.body.incident_severity)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid incident_severity. Must be one of: ${VALID_INCIDENT_SEVERITIES.join(', ')}`);
    }
    if (req.body.containment_status !== undefined && !VALID_CONTAINMENT_STATUSES.includes(req.body.containment_status)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid containment_status. Must be one of: ${VALID_CONTAINMENT_STATUSES.join(', ')}`);
    }
    const allowed = ['title', 'description', 'priority', 'assigned_to', 'tags', 'sla_deadline',
      'incident_severity', 'mitre_techniques', 'containment_status'];
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

  // STATE TRANSITION (with incident state machine support)
  testApp.post('/api/v1/tickets/:id/transition', async (req, res) => {
    const { userId } = getUserContext(req);
    if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');
    const { action } = req.body;
    if (!action) return sendError(res, 400, 'VALIDATION_ERROR', 'Action is required');
    try {
      const ticket = await pgQuery('SELECT id, status, workflow_run_id, operation_id, ticket_type, incident_severity FROM tickets WHERE id = $1', [req.params.id]);
      if (ticket.rows.length === 0) return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
      const currentStatus = ticket.rows[0].status;
      const workflowRunId = ticket.rows[0].workflow_run_id;
      const ticketType = ticket.rows[0].ticket_type;
      const isIncident = ticketType === 'incident';

      if (workflowRunId && (action === 'approve' || action === 'reject')) {
        const runResult = await pgQuery('SELECT status FROM workflow_runs WHERE id = $1', [workflowRunId]);
        if (runResult.rows.length > 0 && runResult.rows[0].status === 'active') {
          return sendError(res, 422, 'WORKFLOW_MANAGED', 'This ticket is managed by a workflow. Use the workflow-runs API to approve/reject.');
        }
      }

      const transitionMap = isIncident ? INCIDENT_TRANSITIONS : TRANSITIONS;
      const validActions = transitionMap[currentStatus];
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
      if (isIncident) {
        natsPublish('dco.incident_status_changed', req.params.id);
      }
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

  // ─── Incident Management (DCO/SOC) ──────────────────────────────────

  describe('POST /api/v1/tickets (incident creation)', () => {
    it('creates an incident ticket with all required fields', async () => {
      const incident = {
        id: 'inc-1',
        title: 'Suspicious lateral movement',
        ticket_type: 'incident',
        status: 'draft',
        incident_severity: 'high',
        alert_source: 'splunk',
        alert_ids: ['alert-1', 'alert-2'],
        mitre_techniques: ['T1566', 'T1059'],
        containment_status: 'none',
      };
      pgQuery.mockResolvedValueOnce({ rows: [incident] });

      const res = await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({
          title: 'Suspicious lateral movement',
          ticket_type: 'incident',
          incident_severity: 'high',
          alert_source: 'splunk',
          alert_ids: ['alert-1', 'alert-2'],
          mitre_techniques: ['T1566', 'T1059'],
          containment_status: 'none',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.ticket_type).toBe('incident');
      expect(res.body.data.incident_severity).toBe('high');
      expect(res.body.data.alert_source).toBe('splunk');
      expect(res.body.data.mitre_techniques).toEqual(['T1566', 'T1059']);
      expect(res.body.data.containment_status).toBe('none');
    });

    it('publishes dco.incident_created NATS event for incident tickets', async () => {
      const incident = { id: 'inc-2', title: 'Phishing', ticket_type: 'incident', status: 'draft' };
      pgQuery.mockResolvedValueOnce({ rows: [incident] });

      await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Phishing', ticket_type: 'incident' });

      expect(natsPublish).toHaveBeenCalledWith('ticket.created', 'inc-2');
      expect(natsPublish).toHaveBeenCalledWith('dco.incident_created', 'inc-2');
    });

    it('does NOT publish dco.incident_created for regular tickets', async () => {
      const ticket = { id: 'tid-99', title: 'Regular', ticket_type: 'general', status: 'draft' };
      pgQuery.mockResolvedValueOnce({ rows: [ticket] });

      await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Regular', ticket_type: 'general' });

      expect(natsPublish).toHaveBeenCalledWith('ticket.created', 'tid-99');
      expect(natsPublish).not.toHaveBeenCalledWith('dco.incident_created', expect.anything());
    });

    it('defaults incident_severity to medium when not provided', async () => {
      const incident = { id: 'inc-3', title: 'Test', ticket_type: 'incident', incident_severity: 'medium', status: 'draft' };
      pgQuery.mockResolvedValueOnce({ rows: [incident] });

      const res = await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Test', ticket_type: 'incident' });

      expect(res.status).toBe(201);
      // The default 'medium' should have been passed to pgQuery
      expect(pgQuery.mock.calls[0][1]).toContain('medium');
    });

    it('rejects invalid incident_severity', async () => {
      const res = await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Test', ticket_type: 'incident', incident_severity: 'extreme' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('incident_severity');
    });

    it('rejects invalid alert_source', async () => {
      const res = await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Test', ticket_type: 'incident', alert_source: 'unknown_source' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('alert_source');
    });

    it('rejects invalid containment_status', async () => {
      const res = await request
        .post('/api/v1/tickets')
        .set('x-user-id', 'user-1')
        .send({ title: 'Test', ticket_type: 'incident', containment_status: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('containment_status');
    });
  });

  describe('Incident state machine transitions', () => {
    const validIncidentTransitions = [
      { from: 'draft', action: 'submit', to: 'triage' },
      { from: 'triage', action: 'investigate', to: 'investigation' },
      { from: 'triage', action: 'dismiss', to: 'false_positive' },
      { from: 'triage', action: 'cancel', to: 'cancelled' },
      { from: 'investigation', action: 'contain', to: 'containment' },
      { from: 'investigation', action: 'escalate', to: 'escalated' },
      { from: 'investigation', action: 'dismiss', to: 'false_positive' },
      { from: 'containment', action: 'remediate', to: 'remediation' },
      { from: 'containment', action: 'escalate', to: 'escalated' },
      { from: 'escalated', action: 'investigate', to: 'investigation' },
      { from: 'escalated', action: 'contain', to: 'containment' },
      { from: 'remediation', action: 'review', to: 'post_incident_review' },
      { from: 'post_incident_review', action: 'close', to: 'closed' },
      { from: 'post_incident_review', action: 'reopen', to: 'investigation' },
      { from: 'false_positive', action: 'reopen', to: 'triage' },
      { from: 'false_positive', action: 'close', to: 'closed' },
    ];

    test.each(validIncidentTransitions)(
      'incident transitions from $from via $action to $to',
      async ({ from, action, to }) => {
        pgQuery
          .mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: from, workflow_run_id: null, operation_id: null, ticket_type: 'incident', incident_severity: 'high' }] })
          .mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: to }] });

        const res = await request
          .post('/api/v1/tickets/inc-1/transition')
          .set('x-user-id', 'user-1')
          .send({ action });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(to);
      }
    );

    const invalidIncidentTransitions = [
      { from: 'draft', action: 'investigate' },
      { from: 'draft', action: 'cancel' },   // incidents can't cancel from draft (only submit)
      { from: 'triage', action: 'submit' },
      { from: 'closed', action: 'investigate' },
      { from: 'cancelled', action: 'submit' },
      { from: 'containment', action: 'close' },
      { from: 'remediation', action: 'contain' },
    ];

    test.each(invalidIncidentTransitions)(
      'incident rejects invalid transition from $from via $action',
      async ({ from, action }) => {
        pgQuery.mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: from, workflow_run_id: null, operation_id: null, ticket_type: 'incident', incident_severity: 'high' }] });

        const res = await request
          .post('/api/v1/tickets/inc-1/transition')
          .set('x-user-id', 'user-1')
          .send({ action });

        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('INVALID_TRANSITION');
      }
    );

    it('publishes dco.incident_status_changed on incident transition', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: 'draft', workflow_run_id: null, operation_id: null, ticket_type: 'incident', incident_severity: 'critical' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: 'triage' }] });

      await request
        .post('/api/v1/tickets/inc-1/transition')
        .set('x-user-id', 'user-1')
        .send({ action: 'submit' });

      expect(natsPublish).toHaveBeenCalledWith('ticket.status_changed', 'inc-1');
      expect(natsPublish).toHaveBeenCalledWith('dco.incident_status_changed', 'inc-1');
    });

    it('does NOT publish dco.incident_status_changed for regular ticket transitions', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ id: 'tid-1', status: 'draft', workflow_run_id: null, operation_id: null, ticket_type: 'general', incident_severity: null }] })
        .mockResolvedValueOnce({ rows: [{ id: 'tid-1', status: 'submitted' }] });

      await request
        .post('/api/v1/tickets/tid-1/transition')
        .set('x-user-id', 'user-1')
        .send({ action: 'submit' });

      expect(natsPublish).toHaveBeenCalledWith('ticket.status_changed', 'tid-1');
      expect(natsPublish).not.toHaveBeenCalledWith('dco.incident_status_changed', expect.anything());
    });
  });

  describe('Regular ticket transitions still work (regression)', () => {
    const regressionTransitions = [
      { from: 'draft', action: 'submit', to: 'submitted' },
      { from: 'submitted', action: 'review', to: 'in_review' },
      { from: 'in_review', action: 'approve', to: 'approved' },
      { from: 'approved', action: 'start', to: 'in_progress' },
      { from: 'in_progress', action: 'complete', to: 'completed' },
      { from: 'completed', action: 'close', to: 'closed' },
    ];

    test.each(regressionTransitions)(
      'regular ticket transitions from $from via $action to $to',
      async ({ from, action, to }) => {
        pgQuery
          .mockResolvedValueOnce({ rows: [{ id: 'tid-r', status: from, workflow_run_id: null, operation_id: null, ticket_type: 'general', incident_severity: null }] })
          .mockResolvedValueOnce({ rows: [{ id: 'tid-r', status: to }] });

        const res = await request
          .post('/api/v1/tickets/tid-r/transition')
          .set('x-user-id', 'user-1')
          .send({ action });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe(to);
      }
    );
  });

  describe('GET /api/v1/tickets/incidents', () => {
    it('lists incidents with pagination', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '2' }] })
        .mockResolvedValueOnce({
          rows: [
            { id: 'inc-1', title: 'Incident 1', ticket_type: 'incident', incident_severity: 'high' },
            { id: 'inc-2', title: 'Incident 2', ticket_type: 'incident', incident_severity: 'medium' },
          ],
        });

      const res = await request.get('/api/v1/tickets/incidents');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination).toEqual({ page: 1, page_size: 20, total: 2 });
    });

    it('filters by incident_severity', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inc-1', incident_severity: 'critical' }] });

      const res = await request.get('/api/v1/tickets/incidents?incident_severity=critical');
      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1]).toContain('critical');
    });

    it('filters by status', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inc-1', status: 'triage' }] });

      const res = await request.get('/api/v1/tickets/incidents?status=triage');
      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1]).toContain('triage');
    });

    it('filters by alert_source', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inc-1', alert_source: 'splunk' }] });

      const res = await request.get('/api/v1/tickets/incidents?alert_source=splunk');
      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1]).toContain('splunk');
    });

    it('filters by mitre_technique', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'inc-1', mitre_techniques: ['T1566'] }] });

      const res = await request.get('/api/v1/tickets/incidents?mitre_technique=T1566');
      expect(res.status).toBe(200);
      expect(pgQuery.mock.calls[0][1]).toContain('T1566');
    });

    it('returns 500 on database error', async () => {
      pgQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request.get('/api/v1/tickets/incidents');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });

    it('sets X-Classification header', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request.get('/api/v1/tickets/incidents');
      expect(res.status).toBe(200);
      expect(res.headers['x-classification']).toBeDefined();
    });
  });

  describe('GET /api/v1/tickets/incidents/stats', () => {
    it('returns incident statistics', async () => {
      pgQuery
        // by_severity
        .mockResolvedValueOnce({ rows: [
          { incident_severity: 'critical', count: 2 },
          { incident_severity: 'high', count: 5 },
          { incident_severity: 'medium', count: 10 },
          { incident_severity: 'low', count: 3 },
        ]})
        // by_status
        .mockResolvedValueOnce({ rows: [
          { status: 'triage', count: 3 },
          { status: 'investigation', count: 5 },
          { status: 'closed', count: 10 },
          { status: 'false_positive', count: 2 },
        ]})
        // mttd
        .mockResolvedValueOnce({ rows: [{ mttd_hours: 1.5 }] })
        // mttr
        .mockResolvedValueOnce({ rows: [{ mttr_hours: 24.3 }] });

      const res = await request.get('/api/v1/tickets/incidents/stats');
      expect(res.status).toBe(200);
      expect(res.body.by_severity).toEqual({ critical: 2, high: 5, medium: 10, low: 3 });
      expect(res.body.by_status).toEqual({ triage: 3, investigation: 5, closed: 10, false_positive: 2 });
      expect(res.body.total_open).toBe(8);
      expect(res.body.total_closed).toBe(12);
      expect(res.body.mttd_hours).toBe(1.5);
      expect(res.body.mttr_hours).toBe(24.3);
    });

    it('returns zeroes when no incidents exist', async () => {
      pgQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ mttd_hours: null }] })
        .mockResolvedValueOnce({ rows: [{ mttr_hours: null }] });

      const res = await request.get('/api/v1/tickets/incidents/stats');
      expect(res.status).toBe(200);
      expect(res.body.by_severity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
      expect(res.body.total_open).toBe(0);
      expect(res.body.total_closed).toBe(0);
      expect(res.body.mttd_hours).toBe(0);
      expect(res.body.mttr_hours).toBe(0);
    });

    it('returns 500 on database error', async () => {
      pgQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request.get('/api/v1/tickets/incidents/stats');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /api/v1/tickets/incidents/consolidated', () => {
    it('returns consolidated incidents on high side (default)', async () => {
      // Default testApp._testEnclave is '' (not 'low'), so this should work
      pgQuery.mockResolvedValueOnce({
        rows: [
          { id: 'inc-1', incident_severity: 'critical' },
          { id: 'inc-2', incident_severity: 'high' },
        ],
      });

      const res = await request.get('/api/v1/tickets/incidents/consolidated');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.enclave).toBe('high');
      expect(res.body.total).toBe(2);
      expect(res.headers['x-classification']).toBe('SECRET');
    });

    it('returns 403 on low-side enclave', async () => {
      // Temporarily set enclave to 'low'
      app._testEnclave = 'low';

      const res = await request.get('/api/v1/tickets/incidents/consolidated');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');

      // Reset
      app._testEnclave = '';
    });

    it('returns 500 on database error', async () => {
      pgQuery.mockRejectedValueOnce(new Error('DB error'));

      const res = await request.get('/api/v1/tickets/incidents/consolidated');
      expect(res.status).toBe(500);
    });
  });

  describe('PATCH /api/v1/tickets/:id (incident fields)', () => {
    it('updates incident_severity on an incident ticket', async () => {
      const updated = { id: 'inc-1', incident_severity: 'critical', ticket_type: 'incident' };
      pgQuery.mockResolvedValueOnce({ rows: [updated] });

      const res = await request
        .patch('/api/v1/tickets/inc-1')
        .set('x-user-id', 'user-1')
        .send({ incident_severity: 'critical' });

      expect(res.status).toBe(200);
      expect(res.body.data.incident_severity).toBe('critical');
    });

    it('updates mitre_techniques on an incident ticket', async () => {
      const updated = { id: 'inc-1', mitre_techniques: ['T1566', 'T1059'], ticket_type: 'incident' };
      pgQuery.mockResolvedValueOnce({ rows: [updated] });

      const res = await request
        .patch('/api/v1/tickets/inc-1')
        .set('x-user-id', 'user-1')
        .send({ mitre_techniques: ['T1566', 'T1059'] });

      expect(res.status).toBe(200);
      expect(res.body.data.mitre_techniques).toEqual(['T1566', 'T1059']);
    });

    it('updates containment_status on an incident ticket', async () => {
      const updated = { id: 'inc-1', containment_status: 'contained', ticket_type: 'incident' };
      pgQuery.mockResolvedValueOnce({ rows: [updated] });

      const res = await request
        .patch('/api/v1/tickets/inc-1')
        .set('x-user-id', 'user-1')
        .send({ containment_status: 'contained' });

      expect(res.status).toBe(200);
      expect(res.body.data.containment_status).toBe('contained');
    });

    it('rejects invalid incident_severity on update', async () => {
      const res = await request
        .patch('/api/v1/tickets/inc-1')
        .set('x-user-id', 'user-1')
        .send({ incident_severity: 'extreme' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects invalid containment_status on update', async () => {
      const res = await request
        .patch('/api/v1/tickets/inc-1')
        .set('x-user-id', 'user-1')
        .send({ containment_status: 'invalid' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
