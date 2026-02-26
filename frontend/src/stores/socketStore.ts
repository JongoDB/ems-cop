import { create } from 'zustand'
import { io, Socket } from 'socket.io-client'
import { getAccessToken } from '../lib/api'

interface SocketEvent {
  topic: string
  data: unknown
  timestamp: number
}

interface SocketStore {
  socket: Socket | null
  connected: boolean
  rooms: Set<string>
  eventBuffers: Map<string, SocketEvent[]>

  connect: () => void
  disconnect: () => void
  subscribe: (topic: string) => void
  unsubscribe: (topic: string) => void
  getEvents: (topic: string) => SocketEvent[]

  // Terminal proxy
  terminalOpen: (sessionId: string) => void
  terminalInput: (sessionId: string, data: string) => void
  terminalResize: (sessionId: string, cols: number, rows: number) => void
  terminalClose: (sessionId: string) => void
  onTerminalData: (handler: (sessionId: string, data: string) => void) => () => void
  onTerminalReady: (handler: (sessionId: string) => void) => () => void
  onTerminalClosed: (handler: (sessionId: string) => void) => () => void
  onTerminalError: (handler: (msg: string) => void) => () => void
}

const MAX_EVENTS_PER_TOPIC = 100
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]

export const useSocketStore = create<SocketStore>((set, get) => {
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleReconnect() {
    if (reconnectTimer) return
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      const { socket } = get()
      if (!socket || !socket.connected) {
        get().connect()
      }
    }, delay)
  }

  return {
    socket: null,
    connected: false,
    rooms: new Set(),
    eventBuffers: new Map(),

    connect: () => {
      const existing = get().socket
      if (existing?.connected) return

      const token = getAccessToken()
      if (!token) return

      const socket = io(window.location.origin, {
        path: '/ws/socket.io',
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: false,
      })

      socket.on('connect', () => {
        reconnectAttempt = 0
        set({ connected: true })
        // Re-subscribe to all rooms
        const { rooms } = get()
        for (const topic of rooms) {
          socket.emit('subscribe', { topic })
        }
      })

      socket.on('disconnect', () => {
        set({ connected: false })
        scheduleReconnect()
      })

      socket.on('connect_error', () => {
        set({ connected: false })
        scheduleReconnect()
      })

      socket.on('event', (payload: { topic: string; data: unknown }) => {
        const { eventBuffers } = get()
        const topicKey = payload.topic
        const buffer = eventBuffers.get(topicKey) || []
        buffer.push({ topic: topicKey, data: payload.data, timestamp: Date.now() })
        if (buffer.length > MAX_EVENTS_PER_TOPIC) {
          buffer.splice(0, buffer.length - MAX_EVENTS_PER_TOPIC)
        }
        eventBuffers.set(topicKey, buffer)
        set({ eventBuffers: new Map(eventBuffers) })
      })

      set({ socket })
    },

    disconnect: () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const { socket } = get()
      if (socket) {
        socket.disconnect()
        set({ socket: null, connected: false })
      }
    },

    subscribe: (topic: string) => {
      const { socket, rooms } = get()
      rooms.add(topic)
      set({ rooms: new Set(rooms) })
      if (socket?.connected) {
        socket.emit('subscribe', { topic })
      }
    },

    unsubscribe: (topic: string) => {
      const { socket, rooms, eventBuffers } = get()
      rooms.delete(topic)
      eventBuffers.delete(topic)
      set({ rooms: new Set(rooms), eventBuffers: new Map(eventBuffers) })
      if (socket?.connected) {
        socket.emit('unsubscribe', { topic })
      }
    },

    getEvents: (topic: string) => {
      return get().eventBuffers.get(topic) || []
    },

    // Terminal proxy methods
    terminalOpen: (sessionId: string) => {
      get().socket?.emit('terminal.open', { session_id: sessionId })
    },
    terminalInput: (sessionId: string, data: string) => {
      get().socket?.emit('terminal.input', { session_id: sessionId, data })
    },
    terminalResize: (sessionId: string, cols: number, rows: number) => {
      get().socket?.emit('terminal.resize', { session_id: sessionId, cols, rows })
    },
    terminalClose: (sessionId: string) => {
      get().socket?.emit('terminal.close', { session_id: sessionId })
    },

    onTerminalData: (handler) => {
      const { socket } = get()
      const cb = (payload: { session_id: string; data: string }) => {
        handler(payload.session_id, payload.data)
      }
      socket?.on('terminal.data', cb)
      return () => { socket?.off('terminal.data', cb) }
    },
    onTerminalReady: (handler) => {
      const { socket } = get()
      const cb = (payload: { session_id: string }) => handler(payload.session_id)
      socket?.on('terminal.ready', cb)
      return () => { socket?.off('terminal.ready', cb) }
    },
    onTerminalClosed: (handler) => {
      const { socket } = get()
      const cb = (payload: { session_id: string }) => handler(payload.session_id)
      socket?.on('terminal.closed', cb)
      return () => { socket?.off('terminal.closed', cb) }
    },
    onTerminalError: (handler) => {
      const { socket } = get()
      const cb = (payload: { message: string }) => handler(payload.message)
      socket?.on('terminal.error', cb)
      return () => { socket?.off('terminal.error', cb) }
    },
  }
})
