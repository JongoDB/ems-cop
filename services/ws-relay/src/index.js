const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { connect, StringCodec } = require('nats');
const { WebSocket } = require('ws');

const PORT = parseInt(process.env.SERVICE_PORT, 10) || 3009;
const NAME = process.env.SERVICE_NAME || 'ws-relay';
const NATS_URL = process.env.NATS_URL || 'nats://nats:4222';
const AUTH_VERIFY_URL = 'http://auth-service:3001/api/v1/auth/verify';
const C2_GATEWAY_URL = process.env.C2_GATEWAY_URL || 'http://c2-gateway:3005';
const MAX_TERMINALS_PER_CLIENT = 3;
const ENCLAVE = process.env.ENCLAVE || '';
const CTI_RELAY_URL = process.env.CTI_RELAY_URL || '';

const pino = require('pino');
const logger = pino({ name: NAME });
const log = (msg, ...args) => logger.info({ extra: args.length ? args : undefined }, msg);
const logErr = (msg, ...args) => logger.error({ extra: args.length ? args : undefined }, msg);

// --- CTI Health Checker ---
class CTIHealth {
  constructor(relayURL, log) {
    this.relayURL = relayURL;
    this.logger = log;
    this.connected = true; // optimistic start
    this.lastCheck = null;
    this.interval = null;
    this.onStatusChange = null; // callback for status changes
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
        if (this.onStatusChange) this.onStatusChange();
      } else if (this.connected && !wasConnected) {
        this.logger.info({ url: this.relayURL }, 'CTI relay connection restored');
        if (this.onStatusChange) this.onStatusChange();
      }
    } catch (err) {
      const wasConnected = this.connected;
      if (wasConnected) {
        this.logger.warn({ err: err.message }, 'CTI relay health check failed');
      }
      this.connected = false;
      this.lastCheck = new Date().toISOString();
      if (wasConnected && this.onStatusChange) this.onStatusChange();
    }
  }
}

const ctiHealth = new CTIHealth(CTI_RELAY_URL, logger);

function isDegraded() {
  return ENCLAVE === 'low' && ctiHealth && !ctiHealth.isConnected();
}

// ---------------------------------------------------------------------------
// Express + Socket.IO setup
// ---------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:18080').split(','),
    methods: ['GET', 'POST']
  },
  pingTimeout: 30000,
  pingInterval: 10000,
});

app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// NATS connection state
// ---------------------------------------------------------------------------
let nc = null;   // NATS connection
let js = null;   // JetStream context
const sc = StringCodec();

// Map of topic pattern -> { sub, refCount }
// refCount tracks how many sockets are subscribed to this pattern
const topicSubs = new Map();

async function connectNats() {
  try {
    nc = await connect({ servers: NATS_URL, name: NAME });
    js = nc.jetstream();
    log('connected to NATS at', NATS_URL);

    // Monitor NATS connection closure
    nc.closed().then((err) => {
      if (err) {
        logErr('NATS connection closed with error:', err.message);
      } else {
        log('NATS connection closed');
      }
      nc = null;
      js = null;
    });
  } catch (err) {
    logErr('failed to connect to NATS:', err.message);
    // Retry after delay
    setTimeout(connectNats, 5000);
  }
}

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok', service: NAME });
});

function readyCheck(_req, res) {
  const checks = {};
  let overall = 'ok';
  let httpStatus = 200;

  checks.nats = (nc && !nc.isClosed()) ? 'ok' : 'error';
  if (checks.nats === 'error') { overall = 'degraded'; httpStatus = 503; }

  const response = {
    status: overall,
    service: NAME,
    checks,
    clients: io.engine ? io.engine.clientsCount : 0,
  };
  if (ENCLAVE) response.enclave = ENCLAVE;
  if (CTI_RELAY_URL) {
    response.cti_connected = ctiHealth.isConnected();
    response.degraded = isDegraded();
  }
  res.status(httpStatus).json(response);
}

app.get('/health/ready', readyCheck);
app.get('/health', readyCheck);

// CTI STATUS (REST, not WebSocket)
app.get('/ws/cti-status', (_req, res) => {
  res.json({
    cti_connected: ctiHealth.isConnected(),
    enclave: ENCLAVE || null,
    degraded: isDegraded(),
    last_check: ctiHealth.lastCheck,
  });
});

// ---------------------------------------------------------------------------
// Socket.IO auth middleware — validate JWT via auth-service
// ---------------------------------------------------------------------------
io.use(async (socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) {
    return next(new Error('authentication_required'));
  }

  try {
    const res = await fetch(AUTH_VERIFY_URL, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.status === 401 || res.status === 403) {
      return next(new Error('authentication_failed'));
    }

    if (!res.ok) {
      logErr('auth verify returned unexpected status:', res.status);
      return next(new Error('authentication_error'));
    }

    // Extract user info from response headers
    socket.data.userId = res.headers.get('x-user-id') || 'unknown';
    socket.data.userRoles = (res.headers.get('x-user-roles') || '').split(',').filter(Boolean);
    socket.data.subscribedTopics = new Set();

    next();
  } catch (err) {
    logErr('auth verify request failed:', err.message);
    return next(new Error('authentication_error'));
  }
});

// ---------------------------------------------------------------------------
// NATS topic subscription management
// ---------------------------------------------------------------------------

/**
 * Subscribe to a NATS topic pattern if not already subscribed.
 * Messages are broadcast to all Socket.IO clients in the matching room.
 */
async function ensureNatsSub(topic) {
  if (topicSubs.has(topic)) {
    topicSubs.get(topic).refCount++;
    return;
  }

  if (!nc) {
    logErr('cannot subscribe to NATS topic (not connected):', topic);
    return;
  }

  try {
    const sub = nc.subscribe(topic);
    topicSubs.set(topic, { sub, refCount: 1 });
    log('NATS subscribed to:', topic);

    // Async iterator to relay messages to Socket.IO rooms
    (async () => {
      try {
        for await (const msg of sub) {
          const data = parseNatsMessage(msg);

          // Filter SECRET-classified events on low-side enclave
          if (ENCLAVE === 'low') {
            try {
              const parsed = (typeof data === 'object') ? data : JSON.parse(msg.data);
              if (parsed.classification === 'SECRET') {
                continue; // silently drop SECRET events on low-side
              }
            } catch (e) {
              // non-JSON messages pass through (no classification)
            }
          }

          const eventPayload = { topic: msg.subject, data };
          // Include classification from the event if present
          if (data && typeof data === 'object' && data.classification) {
            eventPayload.classification = data.classification;
          }
          io.to(topic).emit('event', eventPayload);
        }
      } catch (err) {
        // Subscription closed or error — this is expected on shutdown
        if (!err.message || !err.message.includes('TIMEOUT')) {
          log('NATS subscription ended for:', topic);
        }
      }
    })();
  } catch (err) {
    logErr('failed to subscribe to NATS topic:', topic, err.message);
  }
}

/**
 * Decrement refCount for a NATS topic and unsubscribe if zero.
 */
function releaseNatsSub(topic) {
  const entry = topicSubs.get(topic);
  if (!entry) return;

  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.sub.unsubscribe();
    topicSubs.delete(topic);
    log('NATS unsubscribed from:', topic);
  }
}

/**
 * Parse a NATS message payload. Tries JSON, falls back to string.
 */
function parseNatsMessage(msg) {
  try {
    return JSON.parse(sc.decode(msg.data));
  } catch {
    return sc.decode(msg.data);
  }
}

// ---------------------------------------------------------------------------
// Socket.IO connection handler
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  log(`client connected: ${socket.id} (user: ${socket.data.userId})`);

  // Send current CTI status to newly connected client (if CTI is configured)
  if (CTI_RELAY_URL) {
    socket.emit('cti:status', {
      connected: ctiHealth.isConnected(),
      degraded: isDegraded(),
      timestamp: new Date().toISOString(),
    });
  }

  // --- subscribe to a NATS topic ---
  socket.on('subscribe', async (payload) => {
    const topic = payload && payload.topic;
    if (!topic || typeof topic !== 'string') {
      socket.emit('error', { message: 'subscribe requires a topic string' });
      return;
    }

    // Validate topic pattern (basic sanity check — alphanumeric, dots, stars, >)
    if (!/^[a-zA-Z0-9._*>]+$/.test(topic)) {
      socket.emit('error', { message: 'invalid topic pattern' });
      return;
    }

    socket.join(topic);
    socket.data.subscribedTopics.add(topic);
    await ensureNatsSub(topic);
    log(`client ${socket.id} subscribed to: ${topic}`);
  });

  // --- unsubscribe from a NATS topic ---
  socket.on('unsubscribe', (payload) => {
    const topic = payload && payload.topic;
    if (!topic || typeof topic !== 'string') return;

    socket.leave(topic);
    socket.data.subscribedTopics.delete(topic);
    releaseNatsSub(topic);
    log(`client ${socket.id} unsubscribed from: ${topic}`);
  });

  // --- Terminal session management ---
  if (!socket.data.terminals) socket.data.terminals = new Map();

  socket.on('terminal.open', (payload) => {
    const sessionId = payload && payload.session_id;
    if (!sessionId || typeof sessionId !== 'string') {
      socket.emit('terminal.error', { message: 'session_id is required' });
      return;
    }

    if (socket.data.terminals.size >= MAX_TERMINALS_PER_CLIENT) {
      socket.emit('terminal.error', { message: `max ${MAX_TERMINALS_PER_CLIENT} concurrent terminals` });
      return;
    }

    if (socket.data.terminals.has(sessionId)) {
      socket.emit('terminal.error', { message: 'session already open' });
      return;
    }

    log(`terminal.open: ${socket.id} → session ${sessionId}`);

    // Build WebSocket URL to C2 Gateway shell endpoint
    const wsUrl = C2_GATEWAY_URL.replace(/^http/, 'ws') + `/api/v1/c2/sessions/${sessionId}/shell`;
    const token = socket.handshake.auth && socket.handshake.auth.token;

    try {
      const ws = new WebSocket(wsUrl, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      socket.data.terminals.set(sessionId, ws);

      ws.on('open', () => {
        log(`terminal proxy connected: session ${sessionId}`);
        socket.emit('terminal.ready', { session_id: sessionId, status: 'connected' });
      });

      ws.on('message', (data) => {
        // Forward C2 Gateway stdout → client
        socket.emit('terminal.data', {
          session_id: sessionId,
          data: data.toString(),
        });
      });

      ws.on('close', (code, reason) => {
        log(`terminal proxy closed: session ${sessionId} (code: ${code})`);
        socket.data.terminals.delete(sessionId);
        socket.emit('terminal.closed', { session_id: sessionId, code });
      });

      ws.on('error', (err) => {
        logErr(`terminal proxy error: session ${sessionId}:`, err.message);
        socket.data.terminals.delete(sessionId);
        socket.emit('terminal.error', {
          session_id: sessionId,
          message: 'shell connection failed: ' + err.message,
        });
      });
    } catch (err) {
      logErr(`terminal.open failed for session ${sessionId}:`, err.message);
      socket.emit('terminal.error', {
        session_id: sessionId,
        message: 'failed to open shell: ' + err.message,
      });
    }
  });

  socket.on('terminal.input', (payload) => {
    const sessionId = payload && payload.session_id;
    const data = payload && payload.data;
    if (!sessionId || !data) return;

    const ws = socket.data.terminals.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  socket.on('terminal.resize', (payload) => {
    const sessionId = payload && payload.session_id;
    const cols = payload && payload.cols;
    const rows = payload && payload.rows;
    if (!sessionId || !cols || !rows) return;

    const ws = socket.data.terminals.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  socket.on('terminal.close', (payload) => {
    const sessionId = payload && payload.session_id;
    if (!sessionId) return;

    const ws = socket.data.terminals.get(sessionId);
    if (ws) {
      ws.close();
      socket.data.terminals.delete(sessionId);
      log(`terminal closed by client: session ${sessionId}`);
    }
  });

  // --- disconnect ---
  socket.on('disconnect', (reason) => {
    log(`client disconnected: ${socket.id} (reason: ${reason})`);

    // Clean up all terminal sessions
    if (socket.data.terminals) {
      for (const [sid, ws] of socket.data.terminals) {
        ws.close();
        log(`terminal auto-closed on disconnect: session ${sid}`);
      }
      socket.data.terminals.clear();
    }

    // Clean up all NATS subscriptions this client held
    if (socket.data.subscribedTopics) {
      for (const topic of socket.data.subscribedTopics) {
        releaseNatsSub(topic);
      }
      socket.data.subscribedTopics.clear();
    }
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  log(`${signal} received, shutting down...`);

  ctiHealth.stop();

  // Close Socket.IO (disconnects all clients)
  io.close(() => {
    log('Socket.IO server closed');
  });

  // Drain and close NATS
  if (nc) {
    try {
      await nc.drain();
      log('NATS connection drained');
    } catch (err) {
      logErr('error draining NATS:', err.message);
    }
  }

  // Close HTTP server
  server.close(() => {
    log('HTTP server closed');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    logErr('forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  await connectNats();

  // Wire up CTI status change broadcast to all Socket.IO clients
  ctiHealth.onStatusChange = () => {
    const status = {
      connected: ctiHealth.isConnected(),
      degraded: isDegraded(),
      timestamp: new Date().toISOString(),
    };
    log(`CTI status changed: connected=${status.connected} degraded=${status.degraded}`);
    io.emit('cti:status', status);
  };
  ctiHealth.start();

  server.listen(PORT, () => {
    log(`listening on :${PORT} (enclave: ${ENCLAVE || 'single'}, cti: ${CTI_RELAY_URL || 'none'})`);
  });
}

main().catch((err) => {
  logErr('fatal startup error:', err.message);
  process.exit(1);
});
