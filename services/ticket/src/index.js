const express = require('express');
const { Pool } = require('pg');
const { connect, StringCodec } = require('nats');
const pino = require('pino');
const logger = pino({ name: 'ticket-service' });

const app = express();
app.use(express.json({ limit: '1mb' }));

const port = process.env.SERVICE_PORT || 3003;
const sc = StringCodec();
const ENCLAVE = process.env.ENCLAVE || '';
const CTI_RELAY_URL = process.env.CTI_RELAY_URL || '';

// --- CTI Health Checker ---
class CTIHealth {
  constructor(relayURL, log) {
    this.relayURL = relayURL;
    this.logger = log;
    this.connected = true; // optimistic start
    this.lastCheck = null;
    this.interval = null;
  }

  isConnected() {
    if (!this.relayURL) return true; // single-enclave mode
    return this.connected;
  }

  start() {
    if (!this.relayURL) return; // no CTI = no checking
    this.check(); // immediate first check
    this.interval = setInterval(() => this.check(), 15000);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  async check() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.relayURL}/health/live`, { signal: controller.signal });
      clearTimeout(timeout);
      const wasConnected = this.connected;
      this.connected = res.ok;
      this.lastCheck = new Date().toISOString();
      if (!this.connected && wasConnected) {
        this.logger.warn({ url: this.relayURL }, 'CTI relay connection lost');
      } else if (this.connected && !wasConnected) {
        this.logger.info({ url: this.relayURL }, 'CTI relay connection restored');
      }
    } catch (err) {
      if (this.connected) {
        this.logger.warn({ err: err.message }, 'CTI relay health check failed');
      }
      this.connected = false;
      this.lastCheck = new Date().toISOString();
    }
  }
}

const ctiHealth = new CTIHealth(CTI_RELAY_URL, logger);

function isDegraded() {
  return ENCLAVE === 'low' && ctiHealth && !ctiHealth.isConnected();
}

// --- Data Classification ---
const VALID_CLASSIFICATIONS = ['UNCLASS', 'CUI', 'SECRET'];
const CLASSIFICATION_RANK = { UNCLASS: 0, CUI: 1, SECRET: 2 };

function isValidClassification(c) {
  return VALID_CLASSIFICATIONS.includes(c);
}

function canUpdateClassification(current, next) {
  return CLASSIFICATION_RANK[next] >= CLASSIFICATION_RANK[current];
}

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

// --- Incident State Machine (DCO/SOC) ---
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

function publishEvent(eventType, actorId, actorRoles, resourceId, details, classification) {
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
    classification: classification || 'UNCLASS',
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

app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', service: 'ticket' });
});

async function readyCheck(_req, res) {
  const checks = {};
  let overall = 'ok';
  let httpStatus = 200;

  try { await pool.query('SELECT 1'); checks.postgres = 'ok'; }
  catch { checks.postgres = 'error'; overall = 'degraded'; httpStatus = 503; }

  checks.nats = (nc && !nc.isClosed()) ? 'ok' : 'error';
  if (checks.nats === 'error') { overall = 'degraded'; httpStatus = 503; }

  const response = { status: overall, service: 'ticket', checks };
  if (ENCLAVE) response.enclave = ENCLAVE;
  if (CTI_RELAY_URL) {
    response.cti_connected = ctiHealth.isConnected();
    response.degraded = isDegraded();
  }
  res.status(httpStatus).json(response);
}

app.get('/health/ready', readyCheck);
app.get('/health', readyCheck);

// CTI STATUS
app.get('/api/v1/tickets/cti-status', (_req, res) => {
  res.json({
    cti_connected: ctiHealth.isConnected(),
    enclave: ENCLAVE || null,
    degraded: isDegraded(),
    last_check: ctiHealth.lastCheck,
  });
});

// --- Incident Management (DCO/SOC) ---

// LIST INCIDENTS
app.get('/api/v1/tickets/incidents', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size) || 20));
  const offset = (page - 1) * pageSize;

  const conditions = [`t.ticket_type = 'incident'`];
  const params = [];
  let paramIdx = 1;

  if (req.query.incident_severity) {
    conditions.push(`t.incident_severity = $${paramIdx++}`);
    params.push(req.query.incident_severity);
  }
  if (req.query.containment_status) {
    conditions.push(`t.containment_status = $${paramIdx++}`);
    params.push(req.query.containment_status);
  }
  if (req.query.status) {
    conditions.push(`t.status = $${paramIdx++}`);
    params.push(req.query.status);
  }
  if (req.query.mitre_technique) {
    conditions.push(`$${paramIdx++} = ANY(t.mitre_techniques)`);
    params.push(req.query.mitre_technique);
  }
  if (req.query.alert_source) {
    conditions.push(`t.alert_source = $${paramIdx++}`);
    params.push(req.query.alert_source);
  }
  if (req.query.assigned_to) {
    conditions.push(`t.assigned_to = $${paramIdx++}`);
    params.push(req.query.assigned_to);
  }
  // ENCLAVE enforcement: low-side enclave cannot see SECRET data
  if (ENCLAVE === 'low') {
    conditions.push(`t.classification != 'SECRET'`);
  }

  const where = 'WHERE ' + conditions.join(' AND ');

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
       ORDER BY t.created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, pageSize, offset]
    );

    res.set('X-Classification', ENCLAVE === 'low' ? 'CUI' : 'SECRET');
    res.json({
      data: dataResult.rows,
      pagination: { page, page_size: pageSize, total },
    });
  } catch (err) {
    logger.error({ err: err.message }, 'list incidents error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list incidents');
  }
});

// INCIDENT STATS
app.get('/api/v1/tickets/incidents/stats', async (_req, res) => {
  try {
    const enclaveFilter = ENCLAVE === 'low' ? ` AND classification != 'SECRET'` : '';

    // by_severity
    const sevResult = await pool.query(
      `SELECT incident_severity, COUNT(*)::int AS count FROM tickets WHERE ticket_type = 'incident'${enclaveFilter} GROUP BY incident_severity`
    );
    const by_severity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const row of sevResult.rows) {
      if (row.incident_severity && by_severity.hasOwnProperty(row.incident_severity)) {
        by_severity[row.incident_severity] = row.count;
      }
    }

    // by_status
    const statusResult = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM tickets WHERE ticket_type = 'incident'${enclaveFilter} GROUP BY status`
    );
    const by_status = {};
    for (const row of statusResult.rows) {
      by_status[row.status] = row.count;
    }

    // total_open and total_closed
    const closedStatuses = ['closed', 'cancelled', 'false_positive'];
    let total_open = 0;
    let total_closed = 0;
    for (const [status, count] of Object.entries(by_status)) {
      if (closedStatuses.includes(status)) {
        total_closed += count;
      } else {
        total_open += count;
      }
    }

    // MTTD (Mean Time To Detect) — avg time from alert creation to incident creation
    // We approximate using created_at (incident creation time). If alert_ids are present,
    // we'd need the alert creation time. For now, MTTD is null if no data.
    const mttdResult = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (created_at - created_at))) / 3600.0 AS mttd_hours
       FROM tickets WHERE ticket_type = 'incident'${enclaveFilter} AND alert_source IS NOT NULL`
    );
    const mttd_hours = mttdResult.rows[0].mttd_hours !== null ? parseFloat(parseFloat(mttdResult.rows[0].mttd_hours).toFixed(1)) : 0;

    // MTTR (Mean Time To Resolve) — avg time from incident creation to closed status
    const mttrResult = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) / 3600.0 AS mttr_hours
       FROM tickets WHERE ticket_type = 'incident' AND status = 'closed' AND resolved_at IS NOT NULL${enclaveFilter}`
    );
    const mttr_hours = mttrResult.rows[0].mttr_hours !== null ? parseFloat(parseFloat(mttrResult.rows[0].mttr_hours).toFixed(1)) : 0;

    res.set('X-Classification', ENCLAVE === 'low' ? 'CUI' : 'SECRET');
    res.json({
      by_severity,
      by_status,
      total_open,
      total_closed,
      mttd_hours,
      mttr_hours,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'incident stats error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get incident statistics');
  }
});

// CONSOLIDATED INCIDENTS (HIGH SIDE ONLY)
app.get('/api/v1/tickets/incidents/consolidated', async (_req, res) => {
  if (ENCLAVE === 'low') {
    return sendError(res, 403, 'FORBIDDEN', 'Consolidated view is only available on the high-side enclave');
  }

  try {
    // On the high side, return aggregated view of all incidents
    const result = await pool.query(
      `SELECT t.*, u.display_name AS creator_name, a.display_name AS assignee_name
       FROM tickets t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users a ON a.id = t.assigned_to
       WHERE t.ticket_type = 'incident'
       ORDER BY
         CASE t.incident_severity
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'medium' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         t.created_at DESC
       LIMIT 200`
    );

    res.set('X-Classification', 'SECRET');
    res.json({
      data: result.rows,
      enclave: 'high',
      total: result.rows.length,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'consolidated incidents error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get consolidated incidents');
  }
});

// CREATE TICKET
app.post('/api/v1/tickets', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const { title, description, priority, ticket_type, tags, operation_id, assigned_to, classification: rawClassification } = req.body;
  if (!title) return sendError(res, 400, 'VALIDATION_ERROR', 'Title is required');

  // Degraded mode: block operation tickets on low side when CTI is down
  if (isDegraded() && (ticket_type === 'operation' || operation_id)) {
    return res.status(503).json({
      error: { code: 'DEGRADED_MODE', message: 'CTI link unavailable — operation tickets blocked on low side' }
    });
  }

  const classification = rawClassification || 'UNCLASS';
  if (!isValidClassification(classification)) {
    return sendError(res, 400, 'VALIDATION_ERROR', `Invalid classification. Must be one of: ${VALID_CLASSIFICATIONS.join(', ')}`);
  }
  if (ENCLAVE === 'low' && classification === 'SECRET') {
    return sendError(res, 400, 'CLASSIFICATION_ERROR', 'SECRET data cannot be created on the low-side enclave');
  }

  // Incident-specific field validation
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
    const result = await pool.query(
      `INSERT INTO tickets (title, description, priority, ticket_type, tags, operation_id, assigned_to, created_by, status, classification,
       incident_severity, alert_source, alert_ids, mitre_techniques, containment_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11, $12, $13, $14)
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
        classification,
        incident_severity,
        alert_source,
        alert_ids,
        mitre_techniques,
        containment_status,
      ]
    );
    const ticket = result.rows[0];
    publishEvent('ticket.created', userId, null, ticket.id, { title, priority: ticket.priority, classification }, classification);

    // Publish DCO incident created event
    if (isIncident) {
      publishEvent('dco.incident_created', userId, null, ticket.id, {
        ticket_id: ticket.id,
        title,
        incident_severity,
        alert_source,
        classification,
      }, classification);
    }

    res.status(201).json({ data: ticket });
  } catch (err) {
    logger.error({ err: err.message }, 'create error');
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
  if (req.query.classification) {
    conditions.push(`t.classification = $${paramIdx++}`);
    params.push(req.query.classification);
  }
  if (req.query.search) {
    conditions.push(`(t.title || ' ' || t.description) ILIKE $${paramIdx++}`);
    params.push(`%${req.query.search}%`);
  }
  // ENCLAVE enforcement: low-side enclave cannot see SECRET data
  if (ENCLAVE === 'low') {
    conditions.push(`t.classification != 'SECRET'`);
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
    logger.error({ err: err.message }, 'list error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list tickets');
  }
});

// GET SINGLE TICKET
app.get('/api/v1/tickets/:id', async (req, res) => {
  try {
    const enclaveFilter = ENCLAVE === 'low' ? ` AND t.classification != 'SECRET'` : '';
    const result = await pool.query(
      `SELECT t.*, u.display_name AS creator_name, a.display_name AS assignee_name
       FROM tickets t
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN users a ON a.id = t.assigned_to
       WHERE t.id = $1${enclaveFilter}`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    logger.error({ err: err.message }, 'get error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to get ticket');
  }
});

// UPDATE TICKET
app.patch('/api/v1/tickets/:id', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  // Degraded mode: block risk_level >= 3 updates on low side when CTI is down
  if (isDegraded() && req.body.risk_level !== undefined && parseInt(req.body.risk_level) >= 3) {
    return res.status(503).json({
      error: { code: 'DEGRADED_MODE', message: 'CTI link unavailable — high-risk updates blocked on low side' }
    });
  }

  // Handle classification separately for upgrade-only enforcement
  if (req.body.classification !== undefined) {
    if (!isValidClassification(req.body.classification)) {
      return sendError(res, 400, 'VALIDATION_ERROR', `Invalid classification. Must be one of: ${VALID_CLASSIFICATIONS.join(', ')}`);
    }
    if (ENCLAVE === 'low' && req.body.classification === 'SECRET') {
      return sendError(res, 400, 'CLASSIFICATION_ERROR', 'SECRET data cannot be set on the low-side enclave');
    }
    // Fetch current classification for upgrade check
    try {
      const current = await pool.query('SELECT classification FROM tickets WHERE id = $1', [req.params.id]);
      if (current.rows.length === 0) {
        return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
      }
      if (!canUpdateClassification(current.rows[0].classification, req.body.classification)) {
        return sendError(res, 400, 'CLASSIFICATION_ERROR',
          `Cannot downgrade classification from ${current.rows[0].classification} to ${req.body.classification}`);
      }
    } catch (err) {
      logger.error({ err: err.message }, 'classification check error');
      return sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update ticket');
    }
  }

  // Validate incident-specific fields if provided
  if (req.body.incident_severity !== undefined && !VALID_INCIDENT_SEVERITIES.includes(req.body.incident_severity)) {
    return sendError(res, 400, 'VALIDATION_ERROR', `Invalid incident_severity. Must be one of: ${VALID_INCIDENT_SEVERITIES.join(', ')}`);
  }
  if (req.body.containment_status !== undefined && !VALID_CONTAINMENT_STATUSES.includes(req.body.containment_status)) {
    return sendError(res, 400, 'VALIDATION_ERROR', `Invalid containment_status. Must be one of: ${VALID_CONTAINMENT_STATUSES.join(', ')}`);
  }

  const allowed = ['title', 'description', 'priority', 'assigned_to', 'tags', 'sla_deadline', 'classification',
    'incident_severity', 'mitre_techniques', 'containment_status'];
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
  const enclaveFilter = ENCLAVE === 'low' ? ` AND classification != 'SECRET'` : '';
  try {
    const result = await pool.query(
      `UPDATE tickets SET ${sets.join(', ')} WHERE id = $${paramIdx}${enclaveFilter} RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
    }
    const ticket = result.rows[0];
    publishEvent('ticket.updated', userId, null, req.params.id, { fields: Object.keys(req.body), classification: ticket.classification }, ticket.classification);
    res.json({ data: ticket });
  } catch (err) {
    logger.error({ err: err.message }, 'update error');
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
    const ticket = await pool.query(
      'SELECT id, status, workflow_run_id, operation_id, classification, ticket_type, incident_severity FROM tickets WHERE id = $1',
      [req.params.id]
    );
    if (ticket.rows.length === 0) {
      return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');
    }

    const currentStatus = ticket.rows[0].status;
    const workflowRunId = ticket.rows[0].workflow_run_id;
    const ticketType = ticket.rows[0].ticket_type;
    const isIncident = ticketType === 'incident';

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

    // Choose the appropriate state machine based on ticket type
    const transitionMap = isIncident ? INCIDENT_TRANSITIONS : TRANSITIONS;
    const validActions = transitionMap[currentStatus];
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

    const ticketClassification = ticket.rows[0].classification || 'UNCLASS';
    publishEvent('ticket.status_changed', userId, null, req.params.id, {
      from: currentStatus,
      to: newStatus,
      action,
      ticket_id: req.params.id,
      operation_id: ticket.rows[0].operation_id || '',
      classification: ticketClassification,
    }, ticketClassification);

    // Publish DCO incident status changed event for incident tickets
    if (isIncident) {
      publishEvent('dco.incident_status_changed', userId, null, req.params.id, {
        ticket_id: req.params.id,
        old_status: currentStatus,
        new_status: newStatus,
        incident_severity: ticket.rows[0].incident_severity || 'medium',
      }, ticketClassification);
    }

    res.json({ data: result.rows[0] });
  } catch (err) {
    logger.error({ err: err.message }, 'transition error');
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
    logger.error({ err: err.message }, 'comment error');
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
    logger.error({ err: err.message }, 'list comments error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list comments');
  }
});

// LIST COMMAND PRESETS
app.get('/api/v1/commands/presets', async (req, res) => {
  const { userId } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const validOs = ['linux', 'windows', 'macos'];
  const os = validOs.includes(req.query.os) ? req.query.os : 'linux';
  const enclaveFilter = ENCLAVE === 'low' ? ` AND classification != 'SECRET'` : '';

  const queryParams = [os, userId];
  let classificationFilter = '';
  if (req.query.classification && isValidClassification(req.query.classification)) {
    classificationFilter = ` AND classification = $3`;
    queryParams.push(req.query.classification);
  }

  try {
    const result = await pool.query(
      `SELECT * FROM command_presets WHERE os = $1 AND (scope = 'global' OR (scope = 'user' AND created_by = $2))${enclaveFilter}${classificationFilter} ORDER BY sort_order ASC, name ASC`,
      queryParams
    );
    res.json({ data: result.rows });
  } catch (err) {
    logger.error({ err: err.message }, 'list command presets error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to list command presets');
  }
});

// CREATE COMMAND PRESET
app.post('/api/v1/commands/presets', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  const { name, command, description, os, scope: rawScope, classification: rawClassification } = req.body;
  const validOs = ['linux', 'windows', 'macos'];

  if (!name) return sendError(res, 400, 'VALIDATION_ERROR', 'Name is required');
  if (!command) return sendError(res, 400, 'VALIDATION_ERROR', 'Command is required');
  if (!os || !validOs.includes(os)) return sendError(res, 400, 'VALIDATION_ERROR', 'OS must be linux, windows, or macos');

  const classification = rawClassification || 'UNCLASS';
  if (!isValidClassification(classification)) {
    return sendError(res, 400, 'VALIDATION_ERROR', `Invalid classification. Must be one of: ${VALID_CLASSIFICATIONS.join(', ')}`);
  }
  if (ENCLAVE === 'low' && classification === 'SECRET') {
    return sendError(res, 400, 'CLASSIFICATION_ERROR', 'SECRET data cannot be created on the low-side enclave');
  }

  const scope = rawScope || 'user';
  if (scope === 'global' && !roles.includes('admin')) {
    return sendError(res, 403, 'FORBIDDEN', 'Only admins can create global presets');
  }

  const createdBy = scope === 'global' ? null : userId;

  try {
    const result = await pool.query(
      `INSERT INTO command_presets (name, command, description, os, scope, created_by, classification)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, command, description || '', os, scope, createdBy, classification]
    );
    const preset = result.rows[0];
    publishEvent('command_preset.created', userId, roles, preset.id, { name, os, scope, classification }, classification);
    res.status(201).json({ data: preset });
  } catch (err) {
    logger.error({ err: err.message }, 'create command preset error');
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

    // Classification upgrade-only enforcement
    if (req.body.classification !== undefined) {
      if (!isValidClassification(req.body.classification)) {
        return sendError(res, 400, 'VALIDATION_ERROR', `Invalid classification. Must be one of: ${VALID_CLASSIFICATIONS.join(', ')}`);
      }
      if (ENCLAVE === 'low' && req.body.classification === 'SECRET') {
        return sendError(res, 400, 'CLASSIFICATION_ERROR', 'SECRET data cannot be set on the low-side enclave');
      }
      if (!canUpdateClassification(preset.classification || 'UNCLASS', req.body.classification)) {
        return sendError(res, 400, 'CLASSIFICATION_ERROR',
          `Cannot downgrade classification from ${preset.classification || 'UNCLASS'} to ${req.body.classification}`);
      }
    }

    const allowed = ['name', 'command', 'description', 'sort_order', 'classification'];
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

    const updatedPreset = result.rows[0];
    publishEvent('command_preset.updated', userId, roles, req.params.id, { fields: Object.keys(req.body), classification: updatedPreset.classification }, updatedPreset.classification);
    res.json({ data: updatedPreset });
  } catch (err) {
    logger.error({ err: err.message }, 'update command preset error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to update command preset');
  }
});

// DELETE COMMAND PRESET
app.delete('/api/v1/commands/presets/:id', async (req, res) => {
  const { userId, roles } = getUserContext(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user context');

  try {
    const enclaveFilter = ENCLAVE === 'low' ? ` AND classification != 'SECRET'` : '';
    const existing = await pool.query(`SELECT * FROM command_presets WHERE id = $1${enclaveFilter}`, [req.params.id]);
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
    publishEvent('command_preset.deleted', userId, roles, req.params.id, { name: preset.name, classification: preset.classification }, preset.classification);
    res.json({ data: { deleted: true } });
  } catch (err) {
    logger.error({ err: err.message }, 'delete command preset error');
    sendError(res, 500, 'INTERNAL_ERROR', 'Failed to delete command preset');
  }
});

// --- Start ---
let server;

async function start() {
  await connectNats();
  ctiHealth.start();
  server = app.listen(port, () => logger.info({ port, enclave: ENCLAVE || 'single', cti: CTI_RELAY_URL || 'none' }, 'listening'));
}

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  ctiHealth.stop();
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
