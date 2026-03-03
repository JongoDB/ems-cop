import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useNotificationStore, type Notification } from '../notificationStore';

const mockApiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'notif-1',
    user_id: 'user-1',
    title: 'Test Notification',
    body: 'Test body',
    notification_type: 'ticket_assigned',
    reference_type: 'ticket',
    reference_id: 'ticket-1',
    is_read: false,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('notificationStore', () => {
  beforeEach(() => {
    useNotificationStore.setState({
      notifications: [],
      unreadCount: 0,
      isOpen: false,
      loading: false,
    });
    vi.clearAllMocks();
  });

  it('has correct initial state', () => {
    const state = useNotificationStore.getState();
    expect(state.notifications).toEqual([]);
    expect(state.unreadCount).toBe(0);
    expect(state.isOpen).toBe(false);
    expect(state.loading).toBe(false);
  });

  describe('fetchNotifications', () => {
    it('populates notifications from API', async () => {
      const notifications = [makeNotification(), makeNotification({ id: 'notif-2' })];
      mockApiFetch.mockResolvedValueOnce({ data: notifications });

      await useNotificationStore.getState().fetchNotifications();

      const state = useNotificationStore.getState();
      expect(state.notifications).toEqual(notifications);
      expect(state.loading).toBe(false);
    });

    it('sets loading to false on error', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

      await useNotificationStore.getState().fetchNotifications();

      expect(useNotificationStore.getState().loading).toBe(false);
    });
  });

  describe('fetchUnreadCount', () => {
    it('sets unread count from API', async () => {
      mockApiFetch.mockResolvedValueOnce({ count: 5 });

      await useNotificationStore.getState().fetchUnreadCount();

      expect(useNotificationStore.getState().unreadCount).toBe(5);
    });

    it('does not throw on error', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('fail'));

      await expect(
        useNotificationStore.getState().fetchUnreadCount()
      ).resolves.not.toThrow();
    });
  });

  describe('markRead', () => {
    it('marks a single notification as read and decrements unread count', async () => {
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: 'n1', is_read: false }),
          makeNotification({ id: 'n2', is_read: false }),
        ],
        unreadCount: 2,
      });
      mockApiFetch.mockResolvedValueOnce(undefined);

      await useNotificationStore.getState().markRead('n1');

      const state = useNotificationStore.getState();
      expect(state.notifications[0].is_read).toBe(true);
      expect(state.notifications[1].is_read).toBe(false);
      expect(state.unreadCount).toBe(1);
    });

    it('does not go below 0 unread', async () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 'n1', is_read: false })],
        unreadCount: 0,
      });
      mockApiFetch.mockResolvedValueOnce(undefined);

      await useNotificationStore.getState().markRead('n1');

      expect(useNotificationStore.getState().unreadCount).toBe(0);
    });
  });

  describe('markAllRead', () => {
    it('marks all notifications as read and sets unread count to 0', async () => {
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: 'n1', is_read: false }),
          makeNotification({ id: 'n2', is_read: false }),
          makeNotification({ id: 'n3', is_read: true }),
        ],
        unreadCount: 2,
      });
      mockApiFetch.mockResolvedValueOnce(undefined);

      await useNotificationStore.getState().markAllRead();

      const state = useNotificationStore.getState();
      expect(state.notifications.every((n) => n.is_read)).toBe(true);
      expect(state.unreadCount).toBe(0);
    });
  });

  describe('deleteNotification', () => {
    it('removes notification from list', async () => {
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: 'n1' }),
          makeNotification({ id: 'n2' }),
        ],
        unreadCount: 1,
      });
      mockApiFetch.mockResolvedValueOnce(undefined);

      await useNotificationStore.getState().deleteNotification('n1');

      const state = useNotificationStore.getState();
      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0].id).toBe('n2');
    });

    it('decrements unread count when deleting an unread notification', async () => {
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: 'n1', is_read: false }),
        ],
        unreadCount: 3,
      });
      mockApiFetch.mockResolvedValueOnce(undefined);

      await useNotificationStore.getState().deleteNotification('n1');

      expect(useNotificationStore.getState().unreadCount).toBe(2);
    });

    it('does not decrement unread count when deleting a read notification', async () => {
      useNotificationStore.setState({
        notifications: [
          makeNotification({ id: 'n1', is_read: true }),
        ],
        unreadCount: 3,
      });
      mockApiFetch.mockResolvedValueOnce(undefined);

      await useNotificationStore.getState().deleteNotification('n1');

      expect(useNotificationStore.getState().unreadCount).toBe(3);
    });
  });

  describe('addRealtime', () => {
    it('prepends notification to the list', () => {
      useNotificationStore.setState({
        notifications: [makeNotification({ id: 'n1' })],
        unreadCount: 1,
      });

      const newNotif = makeNotification({ id: 'n-new', title: 'New Alert' });
      useNotificationStore.getState().addRealtime(newNotif);

      const state = useNotificationStore.getState();
      expect(state.notifications[0].id).toBe('n-new');
      expect(state.notifications[1].id).toBe('n1');
      expect(state.unreadCount).toBe(2);
    });

    it('caps the list at 50 notifications', () => {
      const existing = Array.from({ length: 50 }, (_, i) =>
        makeNotification({ id: `n-${i}` })
      );
      useNotificationStore.setState({ notifications: existing, unreadCount: 50 });

      useNotificationStore.getState().addRealtime(
        makeNotification({ id: 'n-overflow' })
      );

      const state = useNotificationStore.getState();
      expect(state.notifications).toHaveLength(50);
      expect(state.notifications[0].id).toBe('n-overflow');
    });
  });

  describe('toggleOpen / close', () => {
    it('toggleOpen opens the panel and fetches notifications', async () => {
      mockApiFetch.mockResolvedValueOnce({ data: [] });

      useNotificationStore.getState().toggleOpen();

      expect(useNotificationStore.getState().isOpen).toBe(true);
    });

    it('toggleOpen closes the panel when already open', () => {
      useNotificationStore.setState({ isOpen: true });

      useNotificationStore.getState().toggleOpen();

      expect(useNotificationStore.getState().isOpen).toBe(false);
    });

    it('close sets isOpen to false', () => {
      useNotificationStore.setState({ isOpen: true });

      useNotificationStore.getState().close();

      expect(useNotificationStore.getState().isOpen).toBe(false);
    });
  });
});
