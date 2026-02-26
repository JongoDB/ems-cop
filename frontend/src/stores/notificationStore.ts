import { create } from 'zustand'
import { apiFetch } from '../lib/api'

export interface Notification {
  id: string
  user_id: string
  title: string
  body: string
  notification_type: string
  reference_type: string | null
  reference_id: string | null
  is_read: boolean
  created_at: string
}

interface NotificationStore {
  notifications: Notification[]
  unreadCount: number
  isOpen: boolean
  loading: boolean

  fetchNotifications: () => Promise<void>
  fetchUnreadCount: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  deleteNotification: (id: string) => Promise<void>
  addRealtime: (notification: Notification) => void
  toggleOpen: () => void
  close: () => void
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  isOpen: false,
  loading: false,

  fetchNotifications: async () => {
    set({ loading: true })
    try {
      const res = await apiFetch<{ data: Notification[] }>('/notifications?limit=30')
      set({ notifications: res.data, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  fetchUnreadCount: async () => {
    try {
      const res = await apiFetch<{ count: number }>('/notifications/unread-count')
      set({ unreadCount: res.count })
    } catch { /* ignore */ }
  },

  markRead: async (id) => {
    try {
      await apiFetch(`/notifications/${id}/read`, { method: 'PATCH' })
      set((s) => ({
        notifications: s.notifications.map((n) => n.id === id ? { ...n, is_read: true } : n),
        unreadCount: Math.max(0, s.unreadCount - 1),
      }))
    } catch { /* ignore */ }
  },

  markAllRead: async () => {
    try {
      await apiFetch('/notifications/mark-all-read', { method: 'POST' })
      set((s) => ({
        notifications: s.notifications.map((n) => ({ ...n, is_read: true })),
        unreadCount: 0,
      }))
    } catch { /* ignore */ }
  },

  deleteNotification: async (id) => {
    try {
      await apiFetch(`/notifications/${id}`, { method: 'DELETE' })
      set((s) => ({
        notifications: s.notifications.filter((n) => n.id !== id),
        unreadCount: s.notifications.find((n) => n.id === id && !n.is_read)
          ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
      }))
    } catch { /* ignore */ }
  },

  addRealtime: (notification) => {
    set((s) => ({
      notifications: [notification, ...s.notifications].slice(0, 50),
      unreadCount: s.unreadCount + 1,
    }))
  },

  toggleOpen: () => {
    const wasOpen = get().isOpen
    set({ isOpen: !wasOpen })
    if (!wasOpen) {
      get().fetchNotifications()
    }
  },

  close: () => set({ isOpen: false }),
}))
