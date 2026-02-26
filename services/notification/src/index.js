// EMS-COP Notification Service
// NATS consumer → notification dispatch (in-app, email, webhook) + Jira bidirectional sync

const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { connect, StringCodec } = require('nats');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.SERVICE_PORT || 3007;
const name = process.env.SERVICE_NAME || 'notification-service';
app.use(express.json());

// ════════════════════════════════════════════
//  DATABASE & CONNECTIONS
// ════════════════════════════════════════════

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB || 'ems_cop',
  user: process.env.POSTGRES_USER || 'ems_user',
  password: process.env.POSTGRES_PASSWORD || 'ems_password',
  max: 10,
});

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

let nc = null; // NATS connection
let sc = null; // String codec

// Email transport (optional — skip if SMTP_HOST not set)
let mailTransport = null;
const smtpHost = process.env.SMTP_HOST;
if (smtpHost) {
  mailTransport = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: (process.env.SMTP_PORT || '587') === '465',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  });
}

const TICKET_SERVICE_URL = process.env.TICKET_SERVICE_URL || 'http://ticket-service:3003';

// ════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════

function getUserID(req) {
  return req.headers['x-user-id'] || null;
}

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

async function publishEvent(eventType, details) {
  if (!nc) return;
  try {
    const payload = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      data: details,
    };
    nc.publish(eventType, sc.encode(JSON.stringify(payload)));
  } catch (err) {
    console.error(`[${name}] publish event error:`, err.message);
  }
}

// ════════════════════════════════════════════
//  NATS CONSUMER — EVENT SUBSCRIPTIONS
// ════════════════════════════════════════════

async function startNatsConsumer() {
  const natsUrl = process.env.NATS_URL || 'nats://nats:4222';
  nc = await connect({
    servers: natsUrl,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  });
  sc = StringCodec();
  console.log(`[${name}] connected to NATS`);

  // Subscribe to event topics
  const topics = ['ticket.>', 'workflow.>', 'operation.>'];
  for (const topic of topics) {
    const sub = nc.subscribe(topic);
    (async () => {
      for await (const msg of sub) {
        try {
          const raw = sc.decode(msg.data);
          const event = JSON.parse(raw);
          await handleEvent(msg.subject, event);
        } catch (err) {
          console.error(`[${name}] event processing error on ${msg.subject}:`, err.message);
        }
      }
    })();
  }
}

// ════════════════════════════════════════════
//  EVENT HANDLER — ROUTE TO NOTIFICATION + JIRA
// ════════════════════════════════════════════

async function handleEvent(subject, event) {
  // Normalize: some events have flat fields, others nest in data
  const data = event.data || event;
  const eventType = event.event_type || subject;

  // 1) Generate notifications
  const notifications = await resolveNotifications(subject, data, eventType);
  for (const notif of notifications) {
    await dispatchNotification(notif);
  }

  // 2) Jira outbound sync for ticket events
  if (subject.startsWith('ticket.')) {
    await handleJiraOutbound(subject, data);
  }
}

// ════════════════════════════════════════════
//  RECIPIENT RESOLUTION
// ════════════════════════════════════════════

async function resolveNotifications(subject, data, eventType) {
  const notifications = [];
  const actorId = data.actor_id || data.user_id || null;

  try {
    if (subject === 'ticket.created') {
      const ticket = await getTicketById(data.resource_id || data.ticket_id);
      if (!ticket) return notifications;
      if (ticket.assigned_to && ticket.assigned_to !== actorId) {
        notifications.push(makeNotif(ticket.assigned_to, 'ticket_assigned', 'Ticket Assigned',
          `You were assigned ticket ${ticket.ticket_number}: ${ticket.title}`,
          'ticket', ticket.id));
      }
    } else if (subject === 'ticket.updated' || subject === 'ticket.status_changed') {
      const ticket = await getTicketById(data.resource_id || data.ticket_id);
      if (!ticket) return notifications;
      const recipients = new Set([
        ...(ticket.watchers || []),
        ticket.assigned_to,
        ticket.created_by,
      ].filter(Boolean));
      recipients.delete(actorId);
      const action = subject === 'ticket.status_changed' ? `Status changed to ${data.new_status || data.details || 'updated'}` : 'updated';
      for (const uid of recipients) {
        notifications.push(makeNotif(uid, 'ticket_update',
          `Ticket ${ticket.ticket_number} ${action}`,
          `${ticket.title}`, 'ticket', ticket.id));
      }
    } else if (subject === 'ticket.commented') {
      const ticket = await getTicketById(data.resource_id || data.ticket_id);
      if (!ticket) return notifications;
      const recipients = new Set([
        ...(ticket.watchers || []),
        ticket.assigned_to,
        ticket.created_by,
      ].filter(Boolean));
      recipients.delete(actorId);
      for (const uid of recipients) {
        notifications.push(makeNotif(uid, 'ticket_comment',
          `New comment on ${ticket.ticket_number}`,
          ticket.title, 'ticket', ticket.id));
      }
    } else if (subject === 'workflow.stage_entered') {
      const roleName = data.required_role || data.data?.required_role;
      if (roleName) {
        const users = await getUsersByRole(roleName);
        for (const u of users) {
          if (u.id !== actorId) {
            notifications.push(makeNotif(u.id, 'approval_required',
              'Approval Required',
              `Stage "${data.stage_name || data.data?.stage_name || 'unknown'}" needs your review`,
              'ticket', data.resource_id || data.ticket_id));
          }
        }
      }
    } else if (subject === 'workflow.approved' || subject === 'workflow.rejected' || subject === 'workflow.kickback') {
      const ticketId = data.resource_id || data.ticket_id;
      const ticket = await getTicketById(ticketId);
      if (!ticket) return notifications;
      const recipients = new Set([
        ...(ticket.watchers || []),
        ticket.created_by,
      ].filter(Boolean));
      recipients.delete(actorId);
      const action = subject.split('.')[1];
      for (const uid of recipients) {
        notifications.push(makeNotif(uid, `workflow_${action}`,
          `Workflow ${action}`,
          `${ticket.ticket_number}: ${ticket.title}`, 'ticket', ticket.id));
      }
    } else if (subject === 'workflow.escalated') {
      const roleName = data.target_role || data.data?.target_role;
      if (roleName) {
        const users = await getUsersByRole(roleName);
        for (const u of users) {
          notifications.push(makeNotif(u.id, 'workflow_escalated',
            'Workflow Escalated',
            `An approval has been escalated to your role`, 'ticket', data.resource_id));
        }
      }
    } else if (subject === 'operation.created') {
      const supervisors = await getUsersByRole('supervisor');
      const leaders = await getUsersByRole('senior_leadership');
      const allRecipients = new Set([...supervisors, ...leaders].map(u => u.id));
      allRecipients.delete(actorId);
      for (const uid of allRecipients) {
        notifications.push(makeNotif(uid, 'operation_created',
          'New Operation Created',
          data.name || 'A new operation has been created',
          'operation', data.resource_id || data.operation_id));
      }
    } else if (subject === 'operation.member_added') {
      const addedUserId = data.member_id || data.data?.member_id;
      if (addedUserId && addedUserId !== actorId) {
        notifications.push(makeNotif(addedUserId, 'operation_member_added',
          'Added to Operation',
          `You have been added to an operation`,
          'operation', data.resource_id || data.operation_id));
      }
    }
  } catch (err) {
    console.error(`[${name}] recipient resolution error for ${subject}:`, err.message);
  }

  return notifications;
}

function makeNotif(userId, type, title, body, refType, refId) {
  return { user_id: userId, notification_type: type, title, body, reference_type: refType, reference_id: refId };
}

async function getTicketById(ticketId) {
  if (!ticketId) return null;
  try {
    const { rows } = await pool.query(
      'SELECT id, ticket_number, title, created_by, assigned_to, watchers FROM tickets WHERE id = $1',
      [ticketId]
    );
    return rows[0] || null;
  } catch { return null; }
}

async function getUsersByRole(roleName) {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id FROM users u
       JOIN role_bindings rb ON rb.user_id = u.id
       JOIN roles r ON r.id = rb.role_id
       WHERE r.name = $1 AND u.is_active = TRUE`, [roleName]);
    return rows;
  } catch { return []; }
}

// ════════════════════════════════════════════
//  DISPATCH PIPELINE
// ════════════════════════════════════════════

async function dispatchNotification(notif) {
  const { user_id, notification_type, title, body, reference_type, reference_id } = notif;

  try {
    // Check user preferences for opt-out
    const prefResult = await pool.query('SELECT preferences FROM users WHERE id = $1', [user_id]);
    if (prefResult.rows[0]?.preferences?.notifications?.[notification_type] === false) {
      return; // user opted out
    }

    // Rate limit: max 30 per minute per user
    const rateKey = `notif:rate:${user_id}`;
    const now = Date.now();
    await redis.zremrangebyscore(rateKey, 0, now - 60000);
    const count = await redis.zcard(rateKey);
    if (count >= 30) return; // rate limited
    await redis.zadd(rateKey, now, `${now}:${Math.random()}`);
    await redis.expire(rateKey, 120);

    // Dedup: same user+type+reference within 60s
    const dedupKey = `notif:dedup:${user_id}:${notification_type}:${reference_id || 'none'}`;
    const exists = await redis.get(dedupKey);
    if (exists) return;
    await redis.set(dedupKey, '1', 'EX', 60);

    // 1) In-app notification: always insert
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, title, body, notification_type, reference_type, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [user_id, title, body, notification_type, reference_type, reference_id]
    );
    const notifRecord = rows[0];

    // Publish to NATS for ws-relay → Socket.IO delivery
    if (nc) {
      const payload = {
        id: notifRecord.id,
        user_id, title, body, notification_type, reference_type, reference_id,
        is_read: false,
        created_at: notifRecord.created_at,
      };
      nc.publish(`notification.user.${user_id}`, sc.encode(JSON.stringify(payload)));
    }

    // 2) Email channel
    if (mailTransport) {
      try {
        const channelResult = await pool.query(
          `SELECT config FROM notification_channels WHERE user_id = $1 AND channel_type = 'email' AND enabled = TRUE LIMIT 1`,
          [user_id]
        );
        if (channelResult.rows[0]) {
          const emailAddr = channelResult.rows[0].config?.address;
          if (emailAddr) {
            await mailTransport.sendMail({
              from: process.env.SMTP_FROM || 'noreply@ems-cop.local',
              to: emailAddr,
              subject: `[EMS-COP] ${title}`,
              html: `<div style="font-family:sans-serif;color:#333"><h3>${title}</h3><p>${body}</p><hr/><small>EMS-COP Notification</small></div>`,
            });
          }
        }
      } catch (err) {
        console.error(`[${name}] email dispatch error:`, err.message);
      }
    }

    // 3) Webhook channels
    try {
      const webhookResult = await pool.query(
        `SELECT config FROM notification_channels WHERE user_id = $1 AND channel_type = 'webhook' AND enabled = TRUE`,
        [user_id]
      );
      for (const row of webhookResult.rows) {
        const url = row.config?.url;
        if (url) {
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(row.config?.headers || {}) },
            body: JSON.stringify({ title, body, notification_type, reference_type, reference_id, timestamp: new Date().toISOString() }),
            signal: AbortSignal.timeout(10000),
          }).catch(() => {}); // fire-and-forget
        }
      }
    } catch (err) {
      console.error(`[${name}] webhook dispatch error:`, err.message);
    }

    await publishEvent('notification.dispatched', { user_id, notification_type, reference_id });
  } catch (err) {
    console.error(`[${name}] dispatch error:`, err.message);
  }
}

// ════════════════════════════════════════════
//  JIRA SYNC — OUTBOUND
// ════════════════════════════════════════════

async function handleJiraOutbound(subject, data) {
  const ticketId = data.resource_id || data.ticket_id;
  if (!ticketId) return;

  try {
    // Check for sync lock (prevents outbound triggered by inbound)
    const lockKey = `jira:sync_lock:${ticketId}`;
    const locked = await redis.get(lockKey);
    if (locked) return;

    // Find matching Jira config
    const ticket = await getTicketById(ticketId);
    if (!ticket) return;

    // Look for operation-scoped or global config
    const configResult = await pool.query(
      `SELECT jc.* FROM jira_configs jc WHERE jc.is_active = TRUE
       AND jc.sync_direction IN ('outbound', 'both')
       ORDER BY jc.operation_id IS NOT NULL DESC LIMIT 1`
    );
    const config = configResult.rows[0];
    if (!config) return;

    // Check existing mapping
    const mappingResult = await pool.query(
      'SELECT * FROM jira_sync_mappings WHERE ticket_id = $1', [ticketId]
    );
    const mapping = mappingResult.rows[0];

    if (subject === 'ticket.created' && !mapping) {
      await jiraCreateIssue(config, ticket);
    } else if (mapping) {
      if (subject === 'ticket.updated') {
        await jiraUpdateIssue(config, mapping, ticket);
      } else if (subject === 'ticket.status_changed') {
        await jiraTransitionIssue(config, mapping, data);
      } else if (subject === 'ticket.commented') {
        await jiraAddComment(config, mapping, data);
      }
    }
  } catch (err) {
    console.error(`[${name}] jira outbound error:`, err.message);
  }
}

async function jiraApiCall(config, method, path, body) {
  const auth = config.auth || {};
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString('base64')}`,
  };
  const url = `${config.base_url}/rest/api/3${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Jira API ${method} ${path} returned ${res.status}: ${errBody}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function jiraCreateIssue(config, ticket) {
  try {
    const mappings = config.field_mappings || {};
    const priorityMap = mappings.priority || {};
    const result = await jiraApiCall(config, 'POST', '/issue', {
      fields: {
        project: { key: config.project_key },
        summary: `[${ticket.ticket_number}] ${ticket.title}`,
        issuetype: { name: 'Task' },
        ...(priorityMap[ticket.priority] ? { priority: { name: priorityMap[ticket.priority] } } : {}),
      },
    });

    if (result?.key) {
      await pool.query(
        `INSERT INTO jira_sync_mappings (config_id, ticket_id, jira_issue_key, jira_issue_id, sync_status, last_synced_at)
         VALUES ($1, $2, $3, $4, 'synced', NOW())`,
        [config.id, ticket.id, result.key, result.id]
      );
      await logJiraSync(config.id, null, 'outbound', 'create_issue', 'success', { issue_key: result.key });
    }
  } catch (err) {
    await logJiraSync(config.id, null, 'outbound', 'create_issue', 'error', {}, err.message);
    console.error(`[${name}] jira create issue error:`, err.message);
  }
}

async function jiraUpdateIssue(config, mapping, ticket) {
  try {
    await jiraApiCall(config, 'PUT', `/issue/${mapping.jira_issue_key}`, {
      fields: {
        summary: `[${ticket.ticket_number}] ${ticket.title}`,
      },
    });
    await pool.query(
      `UPDATE jira_sync_mappings SET sync_status = 'synced', last_synced_at = NOW(), ems_version = ems_version + 1 WHERE id = $1`,
      [mapping.id]
    );
    await logJiraSync(config.id, mapping.id, 'outbound', 'update_issue', 'success', {});
  } catch (err) {
    await pool.query(`UPDATE jira_sync_mappings SET sync_status = 'error', error_message = $1 WHERE id = $2`, [err.message, mapping.id]);
    await logJiraSync(config.id, mapping.id, 'outbound', 'update_issue', 'error', {}, err.message);
  }
}

async function jiraTransitionIssue(config, mapping, data) {
  try {
    const statusMap = (config.field_mappings || {}).status || {};
    const jiraStatus = statusMap[data.new_status || data.details];
    if (!jiraStatus) return; // no mapping for this status

    // Get available transitions
    const transitions = await jiraApiCall(config, 'GET', `/issue/${mapping.jira_issue_key}/transitions`);
    const match = (transitions?.transitions || []).find(t =>
      t.name.toLowerCase() === jiraStatus.toLowerCase() || t.to?.name?.toLowerCase() === jiraStatus.toLowerCase()
    );
    if (match) {
      await jiraApiCall(config, 'POST', `/issue/${mapping.jira_issue_key}/transitions`, { transition: { id: match.id } });
      await pool.query(
        `UPDATE jira_sync_mappings SET sync_status = 'synced', last_synced_at = NOW() WHERE id = $1`,
        [mapping.id]
      );
      await logJiraSync(config.id, mapping.id, 'outbound', 'transition', 'success', { status: jiraStatus });
    }
  } catch (err) {
    await logJiraSync(config.id, mapping.id, 'outbound', 'transition', 'error', {}, err.message);
  }
}

async function jiraAddComment(config, mapping, data) {
  try {
    const commentBody = data.comment_body || data.data?.body || 'Comment from EMS-COP';
    await jiraApiCall(config, 'POST', `/issue/${mapping.jira_issue_key}/comment`, {
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: commentBody }] }] },
    });
    await logJiraSync(config.id, mapping.id, 'outbound', 'add_comment', 'success', {});
  } catch (err) {
    await logJiraSync(config.id, mapping.id, 'outbound', 'add_comment', 'error', {}, err.message);
  }
}

async function logJiraSync(configId, mappingId, direction, action, status, details, errorMessage) {
  try {
    await pool.query(
      `INSERT INTO jira_sync_log (config_id, mapping_id, direction, action, status, details, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [configId, mappingId, direction, action, status, JSON.stringify(details), errorMessage || null]
    );
  } catch (err) {
    console.error(`[${name}] sync log error:`, err.message);
  }
}

// ════════════════════════════════════════════
//  JIRA SYNC — INBOUND WEBHOOK
// ════════════════════════════════════════════

app.post('/api/v1/notifications/jira/webhook', async (req, res) => {
  try {
    const event = req.body;
    const issueKey = event.issue?.key;
    if (!issueKey) return res.json({ ok: true, message: 'no issue key' });

    // Find mapping
    const mappingResult = await pool.query(
      `SELECT sm.*, jc.webhook_secret, jc.field_mappings, jc.sync_direction
       FROM jira_sync_mappings sm JOIN jira_configs jc ON jc.id = sm.config_id
       WHERE sm.jira_issue_key = $1`, [issueKey]
    );
    const mapping = mappingResult.rows[0];
    if (!mapping) return res.json({ ok: true, message: 'unmapped issue' });

    // Check sync direction allows inbound
    if (mapping.sync_direction === 'outbound') return res.json({ ok: true, message: 'inbound disabled' });

    // Set sync lock to prevent outbound loop
    const lockKey = `jira:sync_lock:${mapping.ticket_id}`;
    await redis.set(lockKey, '1', 'EX', 30);

    const webhookEvent = event.webhookEvent || '';

    if (webhookEvent === 'jira:issue_updated') {
      // Map status changes back
      const changelog = event.changelog?.items || [];
      for (const item of changelog) {
        if (item.field === 'status') {
          const reverseStatusMap = {};
          const statusMap = (mapping.field_mappings || {}).status || {};
          for (const [emsStatus, jiraStatus] of Object.entries(statusMap)) {
            reverseStatusMap[String(jiraStatus).toLowerCase()] = emsStatus;
          }
          const newEmsStatus = reverseStatusMap[item.toString?.toLowerCase()] || reverseStatusMap[item.to?.toLowerCase()];
          if (newEmsStatus) {
            try {
              await fetch(`${TICKET_SERVICE_URL}/api/v1/tickets/${mapping.ticket_id}/transition`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-User-ID': '00000000-0000-0000-0000-000000000001', // system user
                },
                body: JSON.stringify({ action: newEmsStatus }),
              });
              await logJiraSync(mapping.config_id, mapping.id, 'inbound', 'transition', 'success', { status: newEmsStatus });
            } catch (err) {
              await logJiraSync(mapping.config_id, mapping.id, 'inbound', 'transition', 'error', {}, err.message);
            }
          }
        }
      }

      // Sync summary changes
      const summaryChange = changelog.find(i => i.field === 'summary');
      if (summaryChange) {
        try {
          await fetch(`${TICKET_SERVICE_URL}/api/v1/tickets/${mapping.ticket_id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'X-User-ID': '00000000-0000-0000-0000-000000000001',
            },
            body: JSON.stringify({ title: summaryChange.toString }),
          });
          await logJiraSync(mapping.config_id, mapping.id, 'inbound', 'update_issue', 'success', {});
        } catch (err) {
          await logJiraSync(mapping.config_id, mapping.id, 'inbound', 'update_issue', 'error', {}, err.message);
        }
      }

      await pool.query(
        `UPDATE jira_sync_mappings SET sync_status = 'synced', last_synced_at = NOW(), jira_version = jira_version + 1 WHERE id = $1`,
        [mapping.id]
      );
    } else if (webhookEvent === 'comment_created') {
      const commentBody = event.comment?.body?.content?.[0]?.content?.[0]?.text || event.comment?.body || 'Comment from Jira';
      try {
        await fetch(`${TICKET_SERVICE_URL}/api/v1/tickets/${mapping.ticket_id}/comments`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-ID': '00000000-0000-0000-0000-000000000001',
          },
          body: JSON.stringify({ body: `[Jira] ${commentBody}` }),
        });
        await logJiraSync(mapping.config_id, mapping.id, 'inbound', 'add_comment', 'success', {});
      } catch (err) {
        await logJiraSync(mapping.config_id, mapping.id, 'inbound', 'add_comment', 'error', {}, err.message);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(`[${name}] jira webhook error:`, err.message);
    res.status(500).json({ error: { code: 'WEBHOOK_ERROR', message: err.message } });
  }
});

// ════════════════════════════════════════════
//  REST API — NOTIFICATIONS
// ════════════════════════════════════════════

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', service: name }));

// List notifications for current user
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

  if (isRead !== undefined) {
    where += ` AND is_read = $${paramIdx++}`;
    params.push(isRead === 'true');
  }
  if (type) {
    where += ` AND notification_type = $${paramIdx++}`;
    params.push(type);
  }

  try {
    const countResult = await pool.query(`SELECT COUNT(*) FROM notifications ${where}`, params);
    const total = parseInt(countResult.rows[0].count);

    const dataResult = await pool.query(
      `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      [...params, limit, offset]
    );

    res.json({ data: dataResult.rows, pagination: { page, limit, total } });
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// Unread count
app.get('/api/v1/notifications/unread-count', async (req, res) => {
  const userId = getUserID(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');

  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE',
      [userId]
    );
    res.json({ count: parseInt(rows[0].count) });
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// Mark read
app.patch('/api/v1/notifications/:id/read', async (req, res) => {
  const userId = getUserID(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');

  try {
    const { rows } = await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, userId]
    );
    if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Notification not found');
    res.json(rows[0]);
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// Mark unread
app.patch('/api/v1/notifications/:id/unread', async (req, res) => {
  const userId = getUserID(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');

  try {
    const { rows } = await pool.query(
      'UPDATE notifications SET is_read = FALSE WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, userId]
    );
    if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Notification not found');
    res.json(rows[0]);
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// Mark all read
app.post('/api/v1/notifications/mark-all-read', async (req, res) => {
  const userId = getUserID(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');

  try {
    const { rowCount } = await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE',
      [userId]
    );
    res.json({ updated: rowCount });
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// Delete notification
app.delete('/api/v1/notifications/:id', async (req, res) => {
  const userId = getUserID(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
      [req.params.id, userId]
    );
    if (!rowCount) return sendError(res, 404, 'NOT_FOUND', 'Notification not found');
    res.status(204).end();
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// ════════════════════════════════════════════
//  REST API — NOTIFICATION CHANNELS
// ════════════════════════════════════════════

app.get('/api/v1/notifications/channels', async (req, res) => {
  const userId = getUserID(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');

  try {
    const { rows } = await pool.query(
      'SELECT * FROM notification_channels WHERE user_id = $1 ORDER BY created_at',
      [userId]
    );
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
    const { rows } = await pool.query(
      `INSERT INTO notification_channels (user_id, channel_type, config, enabled)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, channel_type, JSON.stringify(config || {}), enabled !== false]
    );
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
    const { rows } = await pool.query(
      `UPDATE notification_channels SET ${updates.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING *`,
      params
    );
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
    const { rowCount } = await pool.query(
      'DELETE FROM notification_channels WHERE id = $1 AND user_id = $2',
      [req.params.id, userId]
    );
    if (!rowCount) return sendError(res, 404, 'NOT_FOUND', 'Channel not found');
    res.status(204).end();
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// ════════════════════════════════════════════
//  REST API — NOTIFICATION PREFERENCES
// ════════════════════════════════════════════

app.get('/api/v1/notifications/preferences', async (req, res) => {
  const userId = getUserID(req);
  if (!userId) return sendError(res, 401, 'UNAUTHORIZED', 'Missing user ID');

  try {
    const { rows } = await pool.query('SELECT preferences FROM users WHERE id = $1', [userId]);
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
    const { rows } = await pool.query(
      `UPDATE users SET preferences = jsonb_set(
        COALESCE(preferences, '{}'::jsonb),
        '{notifications}',
        $1::jsonb
      ) WHERE id = $2 RETURNING preferences`,
      [JSON.stringify(req.body), userId]
    );
    if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'User not found');
    res.json(rows[0].preferences?.notifications || {});
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// ════════════════════════════════════════════
//  REST API — JIRA CONFIGURATION
// ════════════════════════════════════════════

app.get('/api/v1/notifications/jira/configs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, base_url, project_key, operation_id, sync_direction, is_active, created_at, updated_at,
              (SELECT COUNT(*) FROM jira_sync_mappings WHERE config_id = jira_configs.id) AS linked_tickets
       FROM jira_configs ORDER BY created_at DESC`
    );
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
    const { rows } = await pool.query(
      `INSERT INTO jira_configs (name, base_url, auth, project_key, operation_id, field_mappings, sync_direction, webhook_secret, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [cfgName, base_url, JSON.stringify(auth || {}), project_key, operation_id || null,
       JSON.stringify(field_mappings || {}), sync_direction || 'both', webhook_secret || null, userId]
    );
    await publishEvent('jira.config_created', { config_id: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

app.get('/api/v1/notifications/jira/configs/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM jira_configs WHERE id = $1', [req.params.id]);
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
    if (req.body[f] !== undefined) {
      updates.push(`${f} = $${idx++}`);
      params.push(req.body[f]);
    }
  }
  if (req.body.auth !== undefined) { updates.push(`auth = $${idx++}`); params.push(JSON.stringify(req.body.auth)); }
  if (req.body.field_mappings !== undefined) { updates.push(`field_mappings = $${idx++}`); params.push(JSON.stringify(req.body.field_mappings)); }

  if (!updates.length) return sendError(res, 400, 'NO_CHANGES', 'Nothing to update');

  try {
    const { rows } = await pool.query(
      `UPDATE jira_configs SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Config not found');
    res.json(rows[0]);
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

app.delete('/api/v1/notifications/jira/configs/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM jira_configs WHERE id = $1', [req.params.id]);
    if (!rowCount) return sendError(res, 404, 'NOT_FOUND', 'Config not found');
    res.status(204).end();
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// Test Jira connection
app.post('/api/v1/notifications/jira/configs/:id/test', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM jira_configs WHERE id = $1', [req.params.id]);
    if (!rows[0]) return sendError(res, 404, 'NOT_FOUND', 'Config not found');

    const config = rows[0];
    const result = await jiraApiCall(config, 'GET', `/project/${config.project_key}`);
    res.json({ success: true, project: { key: result.key, name: result.name } });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Sync mappings
app.get('/api/v1/notifications/jira/mappings', async (req, res) => {
  const ticketId = req.query.ticket_id;
  try {
    let query = 'SELECT * FROM jira_sync_mappings';
    const params = [];
    if (ticketId) {
      query += ' WHERE ticket_id = $1';
      params.push(ticketId);
    }
    query += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json({ data: rows });
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// Force sync
app.post('/api/v1/notifications/jira/sync/:ticketId', async (req, res) => {
  const ticketId = req.params.ticketId;
  try {
    const ticket = await getTicketById(ticketId);
    if (!ticket) return sendError(res, 404, 'NOT_FOUND', 'Ticket not found');

    // Find config
    const configResult = await pool.query(
      `SELECT * FROM jira_configs WHERE is_active = TRUE AND sync_direction IN ('outbound', 'both') LIMIT 1`
    );
    const config = configResult.rows[0];
    if (!config) return sendError(res, 404, 'NOT_FOUND', 'No active Jira config');

    const mappingResult = await pool.query('SELECT * FROM jira_sync_mappings WHERE ticket_id = $1', [ticketId]);
    if (mappingResult.rows[0]) {
      await jiraUpdateIssue(config, mappingResult.rows[0], ticket);
      res.json({ status: 'synced', mapping: mappingResult.rows[0].jira_issue_key });
    } else {
      await jiraCreateIssue(config, ticket);
      const newMapping = await pool.query('SELECT * FROM jira_sync_mappings WHERE ticket_id = $1', [ticketId]);
      res.json({ status: 'created', mapping: newMapping.rows[0]?.jira_issue_key });
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
    if (configId) {
      query += ' WHERE config_id = $1';
      params.push(configId);
    }
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const { rows } = await pool.query(query, params);
    res.json({ data: rows });
  } catch (err) {
    sendError(res, 500, 'DB_ERROR', err.message);
  }
});

// ════════════════════════════════════════════
//  STARTUP
// ════════════════════════════════════════════

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log(`[${name}] connected to PostgreSQL`);
  } catch (err) {
    console.error(`[${name}] PostgreSQL connection failed:`, err.message);
  }

  try {
    await startNatsConsumer();
  } catch (err) {
    console.error(`[${name}] NATS connection failed, will retry:`, err.message);
    setTimeout(startNatsConsumer, 5000);
  }

  app.listen(port, () => console.log(`[${name}] listening on :${port}`));
}

start();
