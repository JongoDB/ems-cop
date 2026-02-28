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

const log = (msg, ...args) => console.log(`[${NAME}] ${msg}`, ...args);
const logErr = (msg, ...args) => console.error(`[${NAME}] ${msg}`, ...args);

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

  res.status(httpStatus).json({
    status: overall,
    service: NAME,
    checks,
    clients: io.engine ? io.engine.clientsCount : 0,
  });
}

app.get('/health/ready', readyCheck);
app.get('/health', readyCheck);

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
          io.to(topic).emit('event', { topic: msg.subject, data });
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

  server.listen(PORT, () => {
    log(`listening on :${PORT}`);
  });
}

main().catch((err) => {
  logErr('fatal startup error:', err.message);
  process.exit(1);
});
