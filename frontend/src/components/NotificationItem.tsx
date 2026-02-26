import { useNavigate } from 'react-router-dom'
import { Ticket, CheckCircle, XCircle, AlertTriangle, Crosshair, Bell, Trash2 } from 'lucide-react'
import { useNotificationStore, type Notification } from '../stores/notificationStore'

const TYPE_ICONS: Record<string, typeof Bell> = {
  ticket_assigned: Ticket,
  ticket_update: Ticket,
  ticket_comment: Ticket,
  approval_required: AlertTriangle,
  workflow_approved: CheckCircle,
  workflow_rejected: XCircle,
  workflow_kickback: AlertTriangle,
  workflow_escalated: AlertTriangle,
  operation_created: Crosshair,
  operation_member_added: Crosshair,
}

const TYPE_COLORS: Record<string, string> = {
  ticket_assigned: 'var(--color-accent)',
  ticket_update: 'var(--color-info)',
  ticket_comment: 'var(--color-text-muted)',
  approval_required: 'var(--color-warning)',
  workflow_approved: 'var(--color-success)',
  workflow_rejected: 'var(--color-danger)',
  workflow_kickback: 'var(--color-warning)',
  workflow_escalated: 'var(--color-warning)',
  operation_created: 'var(--color-accent)',
  operation_member_added: 'var(--color-accent)',
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = Math.floor((now - then) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

interface Props {
  notification: Notification
}

export default function NotificationItem({ notification }: Props) {
  const navigate = useNavigate()
  const markRead = useNotificationStore((s) => s.markRead)
  const deleteNotification = useNotificationStore((s) => s.deleteNotification)
  const close = useNotificationStore((s) => s.close)

  const Icon = TYPE_ICONS[notification.notification_type] || Bell
  const iconColor = TYPE_COLORS[notification.notification_type] || 'var(--color-text-muted)'

  const handleClick = () => {
    if (!notification.is_read) markRead(notification.id)
    close()
    if (notification.reference_type === 'ticket') {
      navigate('/tickets')
    } else if (notification.reference_type === 'operation' && notification.reference_id) {
      navigate(`/operations/${notification.reference_id}`)
    }
  }

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    deleteNotification(notification.id)
  }

  return (
    <div className={`notif-item${notification.is_read ? '' : ' unread'}`} onClick={handleClick}>
      <div className="notif-icon" style={{ color: iconColor }}>
        <Icon size={14} />
      </div>
      <div className="notif-content">
        <div className="notif-title">{notification.title}</div>
        <div className="notif-body">{notification.body}</div>
        <div className="notif-time">{timeAgo(notification.created_at)}</div>
      </div>
      <button className="notif-delete" onClick={handleDelete} title="Delete">
        <Trash2 size={12} />
      </button>
    </div>
  )
}
