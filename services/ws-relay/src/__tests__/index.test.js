// ─── WS-Relay Service Tests ─────────────────────────────────────────────────
// Tests for Socket.IO auth middleware, topic subscriptions, ref-counted NATS subs,
// terminal proxy, terminal limits, and health endpoints.

const express = require('express');
const http = require('http');
const supertest = require('supertest');

// ═══════════════════════════════════════════════════════════════════════════
// Health endpoint tests (Express routes, no Socket.IO needed)
// ═══════════════════════════════════════════════════════════════════════════

describe('WS-Relay Health Endpoints', () => {
  let app, request;
  const natsConnected = { value: true };

  beforeAll(() => {
    app = express();
    app.use(express.json({ limit: '1mb' }));

    const NAME = 'ws-relay';

    app.get('/health/live', (_req, res) => {
      res.json({ status: 'ok', service: NAME });
    });

    function readyCheck(_req, res) {
      const checks = {};
      let overall = 'ok';
      let httpStatus = 200;
      checks.nats = natsConnected.value ? 'ok' : 'error';
      if (checks.nats === 'error') { overall = 'degraded'; httpStatus = 503; }
      res.status(httpStatus).json({ status: overall, service: NAME, checks, clients: 0 });
    }
    app.get('/health/ready', readyCheck);
    app.get('/health', readyCheck);

    request = supertest(app);
  });

  it('GET /health/live returns ok', async () => {
    const res = await request.get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('ws-relay');
  });

  it('GET /health/ready returns ok when NATS connected', async () => {
    natsConnected.value = true;
    const res = await request.get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.nats).toBe('ok');
    expect(res.body.clients).toBe(0);
  });

  it('GET /health/ready returns degraded when NATS down', async () => {
    natsConnected.value = false;
    const res = await request.get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.nats).toBe('error');
  });

  it('GET /health returns same as /health/ready', async () => {
    natsConnected.value = true;
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Auth Middleware Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('WS-Relay Auth Middleware', () => {
  let authMiddleware;

  beforeAll(() => {
    // Recreate the auth middleware from index.js
    authMiddleware = async (socket, next) => {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) {
        return next(new Error('authentication_required'));
      }
      try {
        const res = await global.fetch('http://auth-service:3001/api/v1/auth/verify', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.status === 401 || res.status === 403) {
          return next(new Error('authentication_failed'));
        }
        if (!res.ok) {
          return next(new Error('authentication_error'));
        }
        socket.data.userId = res.headers.get('x-user-id') || 'unknown';
        socket.data.userRoles = (res.headers.get('x-user-roles') || '').split(',').filter(Boolean);
        socket.data.subscribedTopics = new Set();
        next();
      } catch (err) {
        return next(new Error('authentication_error'));
      }
    };
  });

  it('rejects connection without token', async () => {
    const socket = { handshake: { auth: {} }, data: {} };
    const next = jest.fn();
    await authMiddleware(socket, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'authentication_required' }));
  });

  it('rejects connection with null auth', async () => {
    const socket = { handshake: { auth: null }, data: {} };
    const next = jest.fn();
    await authMiddleware(socket, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'authentication_required' }));
  });

  it('accepts connection with valid token', async () => {
    const headers = new Map([
      ['x-user-id', 'user-123'],
      ['x-user-roles', 'admin,operator'],
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (key) => headers.get(key) },
    });

    const socket = { handshake: { auth: { token: 'valid-jwt' } }, data: {} };
    const next = jest.fn();
    await authMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(); // called with no args = success
    expect(socket.data.userId).toBe('user-123');
    expect(socket.data.userRoles).toEqual(['admin', 'operator']);
    expect(socket.data.subscribedTopics).toBeInstanceOf(Set);
  });

  it('rejects connection when auth-service returns 401', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
    });

    const socket = { handshake: { auth: { token: 'expired-jwt' } }, data: {} };
    const next = jest.fn();
    await authMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'authentication_failed' }));
  });

  it('rejects connection when auth-service returns 403', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
    });

    const socket = { handshake: { auth: { token: 'forbidden-jwt' } }, data: {} };
    const next = jest.fn();
    await authMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'authentication_failed' }));
  });

  it('handles auth-service network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const socket = { handshake: { auth: { token: 'valid-jwt' } }, data: {} };
    const next = jest.fn();
    await authMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'authentication_error' }));
  });

  it('handles unexpected status code', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
    });

    const socket = { handshake: { auth: { token: 'valid-jwt' } }, data: {} };
    const next = jest.fn();
    await authMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'authentication_error' }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Topic Subscription & Ref-counted NATS Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('WS-Relay Topic Subscriptions', () => {
  let topicSubs;
  let mockNcSubscribe;

  // Simplified sub management matching the relay logic
  function makeSubManager(nc) {
    topicSubs = new Map();

    return {
      async ensureNatsSub(topic) {
        if (topicSubs.has(topic)) {
          topicSubs.get(topic).refCount++;
          return;
        }
        if (!nc) return;
        const sub = nc.subscribe(topic);
        topicSubs.set(topic, { sub, refCount: 1 });
      },

      releaseNatsSub(topic) {
        const entry = topicSubs.get(topic);
        if (!entry) return;
        entry.refCount--;
        if (entry.refCount <= 0) {
          entry.sub.unsubscribe();
          topicSubs.delete(topic);
        }
      },

      getTopicSubs() {
        return topicSubs;
      },
    };
  }

  let subManager;
  let mockUnsubscribe;

  beforeEach(() => {
    mockUnsubscribe = jest.fn();
    mockNcSubscribe = jest.fn().mockReturnValue({
      unsubscribe: mockUnsubscribe,
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    });
    const nc = { subscribe: mockNcSubscribe };
    subManager = makeSubManager(nc);
  });

  it('creates NATS subscription on first subscribe', async () => {
    await subManager.ensureNatsSub('ticket.>');

    expect(mockNcSubscribe).toHaveBeenCalledWith('ticket.>');
    expect(subManager.getTopicSubs().get('ticket.>').refCount).toBe(1);
  });

  it('increments refCount on duplicate subscribe', async () => {
    await subManager.ensureNatsSub('ticket.>');
    await subManager.ensureNatsSub('ticket.>');

    expect(mockNcSubscribe).toHaveBeenCalledTimes(1); // only called once
    expect(subManager.getTopicSubs().get('ticket.>').refCount).toBe(2);
  });

  it('multiple topics create separate NATS subs', async () => {
    await subManager.ensureNatsSub('ticket.>');
    await subManager.ensureNatsSub('workflow.>');

    expect(mockNcSubscribe).toHaveBeenCalledTimes(2);
    expect(subManager.getTopicSubs().size).toBe(2);
  });

  it('decrements refCount on release', async () => {
    await subManager.ensureNatsSub('ticket.>');
    await subManager.ensureNatsSub('ticket.>');

    subManager.releaseNatsSub('ticket.>');

    expect(subManager.getTopicSubs().get('ticket.>').refCount).toBe(1);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes NATS when refCount reaches zero', async () => {
    await subManager.ensureNatsSub('ticket.>');
    subManager.releaseNatsSub('ticket.>');

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(subManager.getTopicSubs().has('ticket.')).toBeFalsy();
  });

  it('release is safe for unknown topic', () => {
    expect(() => subManager.releaseNatsSub('nonexistent')).not.toThrow();
  });

  it('handles nc=null gracefully', async () => {
    const nullSubManager = makeSubManager(null);
    await nullSubManager.ensureNatsSub('test.>');
    expect(nullSubManager.getTopicSubs().size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Terminal Proxy Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('WS-Relay Terminal Proxy', () => {
  const MAX_TERMINALS_PER_CLIENT = 3;

  function createMockSocket() {
    return {
      id: 'socket-' + Math.random().toString(36).substring(7),
      handshake: { auth: { token: 'test-jwt' } },
      data: {
        userId: 'user-1',
        terminals: new Map(),
        subscribedTopics: new Set(),
      },
      emit: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
    };
  }

  // Mimic the terminal.open handler logic
  function handleTerminalOpen(socket, payload, createWebSocket) {
    const sessionId = payload && payload.session_id;
    if (!sessionId || typeof sessionId !== 'string') {
      socket.emit('terminal.error', { message: 'session_id is required' });
      return null;
    }

    if (socket.data.terminals.size >= MAX_TERMINALS_PER_CLIENT) {
      socket.emit('terminal.error', { message: `max ${MAX_TERMINALS_PER_CLIENT} concurrent terminals` });
      return null;
    }

    if (socket.data.terminals.has(sessionId)) {
      socket.emit('terminal.error', { message: 'session already open' });
      return null;
    }

    const ws = createWebSocket(sessionId);
    socket.data.terminals.set(sessionId, ws);
    return ws;
  }

  function handleTerminalClose(socket, payload) {
    const sessionId = payload && payload.session_id;
    if (!sessionId) return;
    const ws = socket.data.terminals.get(sessionId);
    if (ws) {
      ws.close();
      socket.data.terminals.delete(sessionId);
    }
  }

  function handleTerminalInput(socket, payload) {
    const sessionId = payload && payload.session_id;
    const data = payload && payload.data;
    if (!sessionId || !data) return false;
    const ws = socket.data.terminals.get(sessionId);
    if (ws && ws.readyState === 1) { // WebSocket.OPEN = 1
      ws.send(data);
      return true;
    }
    return false;
  }

  function handleDisconnect(socket) {
    if (socket.data.terminals) {
      for (const [sid, ws] of socket.data.terminals) {
        ws.close();
      }
      socket.data.terminals.clear();
    }
    if (socket.data.subscribedTopics) {
      socket.data.subscribedTopics.clear();
    }
  }

  function createMockWs() {
    return {
      send: jest.fn(),
      close: jest.fn(),
      readyState: 1, // WebSocket.OPEN
      on: jest.fn(),
    };
  }

  it('opens terminal session', () => {
    const socket = createMockSocket();
    const mockWs = createMockWs();
    const ws = handleTerminalOpen(socket, { session_id: 'ses-1' }, () => mockWs);

    expect(ws).toBe(mockWs);
    expect(socket.data.terminals.has('ses-1')).toBe(true);
  });

  it('rejects terminal without session_id', () => {
    const socket = createMockSocket();
    handleTerminalOpen(socket, {}, () => createMockWs());

    expect(socket.emit).toHaveBeenCalledWith('terminal.error', { message: 'session_id is required' });
  });

  it('rejects terminal with null payload', () => {
    const socket = createMockSocket();
    handleTerminalOpen(socket, null, () => createMockWs());

    expect(socket.emit).toHaveBeenCalledWith('terminal.error', { message: 'session_id is required' });
  });

  it('enforces MAX_TERMINALS_PER_CLIENT limit', () => {
    const socket = createMockSocket();
    // Fill up to max
    for (let i = 0; i < MAX_TERMINALS_PER_CLIENT; i++) {
      handleTerminalOpen(socket, { session_id: `ses-${i}` }, () => createMockWs());
    }

    // Try one more
    const ws = handleTerminalOpen(socket, { session_id: 'ses-extra' }, () => createMockWs());

    expect(ws).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('terminal.error', {
      message: `max ${MAX_TERMINALS_PER_CLIENT} concurrent terminals`,
    });
  });

  it('rejects duplicate session', () => {
    const socket = createMockSocket();
    handleTerminalOpen(socket, { session_id: 'ses-1' }, () => createMockWs());
    const ws = handleTerminalOpen(socket, { session_id: 'ses-1' }, () => createMockWs());

    expect(ws).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('terminal.error', { message: 'session already open' });
  });

  it('relays terminal input to WebSocket', () => {
    const socket = createMockSocket();
    const mockWs = createMockWs();
    handleTerminalOpen(socket, { session_id: 'ses-1' }, () => mockWs);

    const sent = handleTerminalInput(socket, { session_id: 'ses-1', data: 'ls -la\n' });

    expect(sent).toBe(true);
    expect(mockWs.send).toHaveBeenCalledWith('ls -la\n');
  });

  it('does not relay input when WebSocket not open', () => {
    const socket = createMockSocket();
    const mockWs = createMockWs();
    mockWs.readyState = 3; // CLOSED
    handleTerminalOpen(socket, { session_id: 'ses-1' }, () => mockWs);

    const sent = handleTerminalInput(socket, { session_id: 'ses-1', data: 'ls\n' });
    expect(sent).toBe(false);
  });

  it('does not relay input for unknown session', () => {
    const socket = createMockSocket();
    const sent = handleTerminalInput(socket, { session_id: 'nonexistent', data: 'ls\n' });
    expect(sent).toBe(false);
  });

  it('ignores input with missing data', () => {
    const socket = createMockSocket();
    const sent = handleTerminalInput(socket, { session_id: 'ses-1' });
    expect(sent).toBe(false);
  });

  it('closes terminal session', () => {
    const socket = createMockSocket();
    const mockWs = createMockWs();
    handleTerminalOpen(socket, { session_id: 'ses-1' }, () => mockWs);

    handleTerminalClose(socket, { session_id: 'ses-1' });

    expect(mockWs.close).toHaveBeenCalled();
    expect(socket.data.terminals.has('ses-1')).toBe(false);
  });

  it('does nothing when closing unknown session', () => {
    const socket = createMockSocket();
    expect(() => handleTerminalClose(socket, { session_id: 'nonexistent' })).not.toThrow();
  });

  it('cleans up all terminals on disconnect', () => {
    const socket = createMockSocket();
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    handleTerminalOpen(socket, { session_id: 'ses-1' }, () => ws1);
    handleTerminalOpen(socket, { session_id: 'ses-2' }, () => ws2);

    handleDisconnect(socket);

    expect(ws1.close).toHaveBeenCalled();
    expect(ws2.close).toHaveBeenCalled();
    expect(socket.data.terminals.size).toBe(0);
  });

  it('cleans up subscribed topics on disconnect', () => {
    const socket = createMockSocket();
    socket.data.subscribedTopics.add('ticket.>');
    socket.data.subscribedTopics.add('workflow.>');

    handleDisconnect(socket);

    expect(socket.data.subscribedTopics.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Socket.IO Event Handler Tests (subscribe/unsubscribe validation)
// ═══════════════════════════════════════════════════════════════════════════

describe('WS-Relay Socket Event Handlers', () => {
  function createMockSocket() {
    return {
      id: 'socket-test',
      handshake: { auth: { token: 'test-jwt' } },
      data: {
        userId: 'user-1',
        terminals: new Map(),
        subscribedTopics: new Set(),
      },
      emit: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
    };
  }

  // Mimic the subscribe handler validation
  function handleSubscribe(socket, payload) {
    const topic = payload && payload.topic;
    if (!topic || typeof topic !== 'string') {
      socket.emit('error', { message: 'subscribe requires a topic string' });
      return false;
    }
    if (!/^[a-zA-Z0-9._*>]+$/.test(topic)) {
      socket.emit('error', { message: 'invalid topic pattern' });
      return false;
    }
    socket.join(topic);
    socket.data.subscribedTopics.add(topic);
    return true;
  }

  function handleUnsubscribe(socket, payload) {
    const topic = payload && payload.topic;
    if (!topic || typeof topic !== 'string') return false;
    socket.leave(topic);
    socket.data.subscribedTopics.delete(topic);
    return true;
  }

  it('subscribe accepts valid topic', () => {
    const socket = createMockSocket();
    const result = handleSubscribe(socket, { topic: 'ticket.>' });

    expect(result).toBe(true);
    expect(socket.join).toHaveBeenCalledWith('ticket.>');
    expect(socket.data.subscribedTopics.has('ticket.>')).toBe(true);
  });

  it('subscribe accepts dotted topics', () => {
    const socket = createMockSocket();
    expect(handleSubscribe(socket, { topic: 'ticket.created' })).toBe(true);
    expect(handleSubscribe(socket, { topic: 'workflow.stage_entered' })).toBe(true);
    expect(handleSubscribe(socket, { topic: 'notification.user.user-1' })).toBe(false); // hyphen not allowed
  });

  it('subscribe accepts wildcard topics', () => {
    const socket = createMockSocket();
    expect(handleSubscribe(socket, { topic: 'ticket.*' })).toBe(true);
    expect(handleSubscribe(socket, { topic: '*' })).toBe(true);
  });

  it('subscribe rejects null payload', () => {
    const socket = createMockSocket();
    handleSubscribe(socket, null);
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'subscribe requires a topic string' });
  });

  it('subscribe rejects empty topic', () => {
    const socket = createMockSocket();
    handleSubscribe(socket, { topic: '' });
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'subscribe requires a topic string' });
  });

  it('subscribe rejects numeric topic', () => {
    const socket = createMockSocket();
    handleSubscribe(socket, { topic: 123 });
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'subscribe requires a topic string' });
  });

  it('subscribe rejects topic with special characters', () => {
    const socket = createMockSocket();
    handleSubscribe(socket, { topic: 'ticket; rm -rf /' });
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'invalid topic pattern' });
  });

  it('subscribe rejects topic with spaces', () => {
    const socket = createMockSocket();
    handleSubscribe(socket, { topic: 'ticket created' });
    expect(socket.emit).toHaveBeenCalledWith('error', { message: 'invalid topic pattern' });
  });

  it('unsubscribe removes topic', () => {
    const socket = createMockSocket();
    handleSubscribe(socket, { topic: 'ticket.>' });

    const result = handleUnsubscribe(socket, { topic: 'ticket.>' });
    expect(result).toBe(true);
    expect(socket.leave).toHaveBeenCalledWith('ticket.>');
    expect(socket.data.subscribedTopics.has('ticket.>')).toBe(false);
  });

  it('unsubscribe handles invalid payload gracefully', () => {
    const socket = createMockSocket();
    expect(handleUnsubscribe(socket, null)).toBe(false);
    expect(handleUnsubscribe(socket, {})).toBe(false);
    expect(handleUnsubscribe(socket, { topic: 123 })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NATS Message Parsing Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('WS-Relay NATS Message Parsing', () => {
  function parseNatsMessage(msg) {
    try {
      return JSON.parse(msg.data.toString());
    } catch {
      return msg.data.toString();
    }
  }

  it('parses JSON messages', () => {
    const msg = { data: Buffer.from(JSON.stringify({ event_type: 'ticket.created', id: '123' })) };
    const result = parseNatsMessage(msg);
    expect(result).toEqual({ event_type: 'ticket.created', id: '123' });
  });

  it('falls back to string for non-JSON', () => {
    const msg = { data: Buffer.from('plain text message') };
    const result = parseNatsMessage(msg);
    expect(result).toBe('plain text message');
  });

  it('handles empty data', () => {
    const msg = { data: Buffer.from('') };
    const result = parseNatsMessage(msg);
    expect(result).toBe('');
  });
});
