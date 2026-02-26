const express = require('express');
const { Pool } = require('pg');
const { connect, StringCodec } = require('nats');

const app = express();
app.use(express.json());

const port = process.env.SERVICE_PORT || 3003;
const sc = StringCodec();

// --- State Machine ---
const TRANSITIONS = {
  draft:       { submit: 'submitted', cancel: 'cancelled' },
  submitted:   { review: 'in_review', reject: 'rejected', cancel: 'cancelled' },
  in_review:   { approve: 'approved', reject: 'rejected', cancel: 'cancelled' },
  approved:    { start: 'in_progress', cancel: 'cancelled' },
  rejected:    { cancel: 'cancelled' },
  in_progress: { pause: 'paused', complete: 'completed', cancel: 'cancelled' },
  paused:      { resume: 'in_progress', cancel: 'cancelled' },
  completed:   { close: 'closed' },
  closed:      {},
  cancelled:   {},
};

// --- Database ---
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'ems_cop',
  user: process.env.POSTGRES_USER || 'ems',
  password: process.env.POSTGRES_PASSWORD || 'ems_dev_password',
});

// --- NATS ---
let nc = null;
async function connectNats() {
  try {
    nc = await connect({ servers: process.env.NATS_URL || 'nats://localhost:4222' });
    console.log('[ticket] connected to nats');
  } catch (err) {
    console.error('[ticket] nats connection failed, retrying in 5s:', err.message);
    setTimeout(connectNats, 5000);
  }
}

function publishEvent(eventType, actorId, actorRoles, resourceId, details) {
  if (!nc) return;
  const event = {
    event_type: eventType,
    actor_id: actorId || '',
    actor_username: '',
    actor_ip: '',
    session_id: '',
    resource_type: eventType.startsWith('command_preset') ? 'command_preset' : 'ticket',
    resource_id: resourceId || '',
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

// --- Routes ---

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ticket' });
});

// CREATE TICKET
app.post('/api/v1/tickets', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const { title, description, priority, ticket_type, tags, operation_id, assigned_to } = req.body;
  if (!title) return sendError(res, 400, 'VALIDATION_ERROR', 'Title is required');

  try {
    const result = await pool.query(
      `INSERT INTO tickets (title, description, priority, ticket_type, tags, operation_id, assigned_to, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
       RETURNING *`,
      [
        title,
        description || '',
        priority || 'medium',
        ticket_type || 'general',
        tags || [],
        operation_id || null,
        assigned_to || null,
        userId,
      ]
    );
    const ticket = result.rows[0];
    publishEvent('ticket.created', userId, null, ticket.id, { title, priority: ticket.priority });
    res.status(201).json({ data: ticket });
  } catch (err) {
    console.error('[ticket] create error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create ticket');
  }
});

// LIST TICKETS
app.get('/api/v1/tickets', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const sort = ['created_at', 'updated_at', 'priority', 'status', 'title'].includes(req.query.sort)
    ? req.query.sort : 'created_at';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';

  const conditions = [];
  const params = [];
  let paramIdx = 1;

  if (req.query.status) {
    conditions.push(`t.status = $${paramIdx++}`);
    params.push(req.query.status);
  }
  if (req.query.priority) {
    conditions.push(`t.priority = $${paramIdx++}`);
    params.push(req.query.priority);
  }
  if (req.query.assignee_id) {
    conditions.push(`t.assigned_to = $${paramIdx++}`);
    params.push(req.query.assignee_id);
  }
  if (req.query.created_by) {
    conditions.push(`t.created_by = $${paramIdx++}`);
    params.push(req.query.created_by);
  }
  if (req.query.ticket_type) {
    conditions.push(`t.ticket_type = $${paramIdx++}`);
    params.push(req.query.ticket_type);
  }
  if (req.query.search) {
    conditions.push(`(t.title || ' ' || t.description) ILIKE $${paramIdx++}`);
    params.push(`%${req.query.search}%`);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM tickets t ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT t.*, u.display_name AS creator_name, a.display_name AS assignee_name
       FROM tickets t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users a ON a.id = t.assigned_to
       ${where}
       ORDER BY t.${sort} ${order}
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset]
    );

    res.json({
      data: dataResult.rows,
      pagination: { page, limit, total },
    });
  } catch (err) {
    console.error('[ticket] list error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list tickets');
  }
});

// GET SINGLE TICKET
app.get('/api/v1/tickets/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, u.display_name AS creator_name, a.display_name AS assignee_name
       FROM tickets t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users a ON a.id = t.assigned_to
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[ticket] get error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get ticket');
  }
});

// UPDATE TICKET
app.patch('/api/v1/tickets/:id', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const allowed = ['title', 'description', 'priority', 'assigned_to', 'tags', 'sla_deadline'];
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

  params.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE tickets SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
    }
    publishEvent('ticket.updated', userId, null, req.params.id, { fields: Object.keys(req.body) });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[ticket] update error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update ticket');
  }
});

// STATE TRANSITION
app.post('/api/v1/tickets/:id/transition', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const { action } = req.body;
  if (!action) return sendError(res, 400, 'VALIDATION_ERROR', 'Action is required');

  try {
    const ticket = await pool.query('SELECT id, status, workflow_run_id, operation_id FROM tickets WHERE id = $1', [req.params.id]);
    if (ticket.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
    }

    const currentStatus = ticket.rows[0].status;
    const workflowRunId = ticket.rows[0].workflow_run_id;

    // Guard workflow-managed tickets from manual approval/rejection
    if (workflowRunId && (action === 'approve' || action === 'reject')) {
      // Check if the run is active
      const runResult = await pool.query(
        'SELECT status FROM workflow_runs WHERE id = $1', [workflowRunId]
      );
      if (runResult.rows.length > 0 && runResult.rows[0].status === 'active') {
        return sendError(res, 422, 'WORKFLOW_MANAGED',
          'This ticket is managed by a workflow. Use the workflow-runs API to approve/reject.');
      }
    }

    const validActions = TRANSITIONS[currentStatus];
    if (!validActions || !validActions[action]) {
      return sendError(res, 422, 'INVALID_TRANSITION',
        `Cannot perform '${action}' on ticket in '${currentStatus}' state`);
    }

    const newStatus = validActions[action];
    const updates = { status: newStatus };
    if (newStatus === 'completed' || newStatus === 'closed') {
      updates.resolved_at = new Date().toISOString();
    }

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`);
    const result = await pool.query(
      `UPDATE tickets SET ${setClauses.join(', ')} WHERE id = $${setClauses.length + 1} RETURNING *`,
      [...Object.values(updates), req.params.id]
    );

    publishEvent('ticket.status_changed', userId, null, req.params.id, {
      from: currentStatus,
      to: newStatus,
      action,
      ticket_id: req.params.id,
      operation_id: ticket.rows[0].operation_id || '',
    });

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[ticket] transition error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to transition ticket');
  }
});

// ADD COMMENT
app.post('/api/v1/tickets/:id/comments', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const { body, parent_id } = req.body;
  if (!body) return sendError(res, 400, 'VALIDATION_ERROR', 'Comment body is required');

  try {
    // Verify ticket exists
    const ticket = await pool.query('SELECT id FROM tickets WHERE id = $1', [req.params.id]);
    if (ticket.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
    }

    const result = await pool.query(
      `INSERT INTO ticket_comments (ticket_id, author_id, body, parent_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, userId, body, parent_id || null]
    );

    publishEvent('ticket.commented', userId, null, req.params.id, {
      comment_id: result.rows[0].id,
    });

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('[ticket] comment error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to add comment');
  }
});

// LIST COMMENTS
app.get('/api/v1/tickets/:id/comments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.display_name AS author_name
       FROM ticket_comments c
       LEFT JOIN users u ON u.id = c.author_id
       WHERE c.ticket_id = $1
       ORDER BY c.created_at ASC`,
      [req.params.id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[ticket] list comments error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list comments');
  }
});

// LIST COMMAND PRESETS
app.get('/api/v1/commands/presets', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const validOs = ['linux', 'windows', 'macos'];
  const os = validOs.includes(req.query.os) ? req.query.os : 'linux';

  try {
    const result = await pool.query(
      `SELECT * FROM command_presets WHERE os = $1 AND (scope = 'global' OR (scope = 'user' AND created_by = $2)) ORDER BY sort_order ASC, name ASC`,
      [os, userId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[ticket] list command presets error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list command presets');
  }
});

// CREATE COMMAND PRESET
app.post('/api/v1/commands/presets', async (req, res) => {
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
    const result = await pool.query(
      `INSERT INTO command_presets (name, command, description, os, scope, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, command, description || '', os, scope, createdBy]
    );
    const preset = result.rows[0];
    publishEvent('command_preset.created', userId, roles, preset.id, { name, os, scope });
    res.status(201).json({ data: preset });
  } catch (err) {
    console.error('[ticket] create command preset error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to create command preset');
  }
});

// UPDATE COMMAND PRESET
app.patch('/api/v1/commands/presets/:id', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  try {
    const existing = await pool.query('SELECT * FROM command_presets WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Command preset not found');
    }

    const preset = existing.rows[0];
    if (preset.scope === 'global' && !roles.includes('admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Only admins can update global presets');
    }
    if (preset.scope === 'user' && preset.created_by !== userId) {
      return sendError(res, 403, 'FORBIDDEN', 'You can only update your own presets');
    }

    const allowed = ['name', 'command', 'description', 'sort_order'];
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

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE command_presets SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      params
    );

    publishEvent('command_preset.updated', userId, roles, req.params.id, { fields: Object.keys(req.body) });
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[ticket] update command preset error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update command preset');
  }
});

// DELETE COMMAND PRESET
app.delete('/api/v1/commands/presets/:id', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  try {
    const existing = await pool.query('SELECT * FROM command_presets WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Command preset not found');
    }

    const preset = existing.rows[0];
    if (preset.scope === 'global' && !roles.includes('admin')) {
      return sendError(res, 403, 'FORBIDDEN', 'Only admins can delete global presets');
    }
    if (preset.scope === 'user' && preset.created_by !== userId) {
      return sendError(res, 403, 'FORBIDDEN', 'You can only delete your own presets');
    }

    await pool.query('DELETE FROM command_presets WHERE id = $1', [req.params.id]);
    publishEvent('command_preset.deleted', userId, roles, req.params.id, { name: preset.name });
    res.json({ data: { deleted: true } });
  } catch (err) {
    console.error('[ticket] delete command preset error:', err.message);
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete command preset');
  }
});

// --- Start ---
async function start() {
  await connectNats();
  app.listen(port, () => console.log(`[ticket] listening on :${port}`));
}

start().catch(err => {
  console.error('[ticket] startup failed:', err);
  process.exit(1);
});
