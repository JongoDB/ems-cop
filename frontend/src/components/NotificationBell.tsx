import { useEffect, useRef } from 'react'
import { Bell } from 'lucide-react'
import { useNotificationStore } from '../stores/notificationStore'
import { useSocketStore } from '../stores/socketStore'
import { useAuth } from '../hooks/useAuth'
import NotificationItem from './NotificationItem'

export default function NotificationBell() {
  const { user } = useAuth()
  const { unreadCount, isOpen, notifications, loading, toggleOpen, close, fetchUnreadCount, addRealtime } = useNotificationStore()
  const subscribe = useSocketStore((s) => s.subscribe)
  const unsubscribe = useSocketStore((s) => s.unsubscribe)
  const getEvents = useSocketStore((s) => s.getEvents)
  const panelRef = useRef<HTMLDivElement>(null)
  const lastEventCount = useRef(0)

  // Poll unread count every 30s
  useEffect(() => {
    fetchUnreadCount()
    const interval = setInterval(fetchUnreadCount, 30000)
    return () => clearInterval(interval)
  }, [fetchUnreadCount])

  // Subscribe to real-time notifications via Socket.IO
  useEffect(() => {
    if (!user?.id) return
    const topic = `notification.user.${user.id}`
    subscribe(topic)
    return () => unsubscribe(topic)
  }, [user?.id, subscribe, unsubscribe])

  // Process new Socket.IO events
  useEffect(() => {
    if (!user?.id) return
    const topic = `notification.user.${user.id}`
    const events = getEvents(topic)
    if (events.length > lastEventCount.current) {
      const newEvents = events.slice(lastEventCount.current)
      for (const evt of newEvents) {
        if (evt.data && typeof evt.data === 'object') {
          addRealtime(evt.data as any)
        }
      }
      lastEventCount.current = events.length
    }
  })

  // Close panel on outside click
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        close()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen, close])

  const markAllRead = useNotificationStore((s) => s.markAllRead)

  return (
    <div className="notif-bell-wrap" ref={panelRef}>
      <button className="notif-bell-btn" onClick={toggleOpen} title="Notifications">
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="notif-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
      </button>

      {isOpen && (
        <div className="notif-panel">
          <div className="notif-panel-header">
            <span>NOTIFICATIONS</span>
            {unreadCount > 0 && (
              <button className="notif-mark-all" onClick={markAllRead}>Mark all read</button>
            )}
          </div>
          <div className="notif-panel-list">
            {loading && notifications.length === 0 ? (
              <div className="notif-empty">Loading...</div>
            ) : notifications.length === 0 ? (
              <div className="notif-empty">No notifications</div>
            ) : (
              notifications.map((n) => <NotificationItem key={n.id} notification={n} />)
            )}
          </div>
        </div>
      )}
    </div>
  )
}
