import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ───────────────────────────────────────────────────────────

// Mock lucide-react
vi.mock('lucide-react', () => ({
  Bell: ({ size }: { size: number }) => (
    <svg data-testid="bell-icon" width={size} height={size} />
  ),
  Ticket: () => <svg data-testid="ticket-icon" />,
  CheckCircle: () => <svg />,
  XCircle: () => <svg />,
  AlertTriangle: () => <svg />,
  Crosshair: () => <svg />,
  Trash2: () => <svg data-testid="trash-icon" />,
}));

// Notification store mock state
const mockToggleOpen = vi.fn();
const mockClose = vi.fn();
const mockFetchUnreadCount = vi.fn();
const mockMarkAllRead = vi.fn();
const mockMarkRead = vi.fn();
const mockDeleteNotification = vi.fn();
const mockAddRealtime = vi.fn();

let mockNotificationState = {
  unreadCount: 0,
  isOpen: false,
  notifications: [] as Array<{
    id: string;
    user_id: string;
    title: string;
    body: string;
    notification_type: string;
    reference_type: string | null;
    reference_id: string | null;
    is_read: boolean;
    created_at: string;
  }>,
  loading: false,
  toggleOpen: mockToggleOpen,
  close: mockClose,
  fetchUnreadCount: mockFetchUnreadCount,
  markAllRead: mockMarkAllRead,
  markRead: mockMarkRead,
  deleteNotification: mockDeleteNotification,
  addRealtime: mockAddRealtime,
  fetchNotifications: vi.fn(),
};

vi.mock('../../stores/notificationStore', () => ({
  useNotificationStore: (selector?: (s: typeof mockNotificationState) => unknown) => {
    if (selector) return selector(mockNotificationState);
    return mockNotificationState;
  },
}));

// Mock socket store
vi.mock('../../stores/socketStore', () => ({
  useSocketStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getEvents: () => [],
    };
    if (selector) return selector(state);
    return state;
  },
}));

// Mock useAuth hook
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1', username: 'admin', display_name: 'Admin', email: 'admin@test.com', roles: ['admin'] },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    roles: ['admin'],
  }),
}));

// Need to import after mocks are set up
import NotificationBell from '../NotificationBell';

function renderBell() {
  return render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>
  );
}

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotificationState = {
      unreadCount: 0,
      isOpen: false,
      notifications: [],
      loading: false,
      toggleOpen: mockToggleOpen,
      close: mockClose,
      fetchUnreadCount: mockFetchUnreadCount,
      markAllRead: mockMarkAllRead,
      markRead: mockMarkRead,
      deleteNotification: mockDeleteNotification,
      addRealtime: mockAddRealtime,
      fetchNotifications: vi.fn(),
    };
  });

  it('renders the bell icon', () => {
    renderBell();

    expect(screen.getByTestId('bell-icon')).toBeInTheDocument();
  });

  it('renders the notification button', () => {
    renderBell();

    expect(screen.getByTitle('Notifications')).toBeInTheDocument();
  });

  it('does not show badge when unread count is 0', () => {
    mockNotificationState.unreadCount = 0;
    renderBell();

    expect(screen.queryByText('0')).not.toBeInTheDocument();
    // No badge element should be present
    const button = screen.getByTitle('Notifications');
    const badge = button.querySelector('.notif-badge');
    expect(badge).toBeNull();
  });

  it('shows unread count badge when > 0', () => {
    mockNotificationState.unreadCount = 5;
    renderBell();

    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows 99+ when unread count exceeds 99', () => {
    mockNotificationState.unreadCount = 150;
    renderBell();

    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('calls toggleOpen when bell button is clicked', async () => {
    const user = userEvent.setup();
    renderBell();

    await user.click(screen.getByTitle('Notifications'));

    expect(mockToggleOpen).toHaveBeenCalled();
  });

  it('shows notification panel when isOpen is true', () => {
    mockNotificationState.isOpen = true;
    renderBell();

    expect(screen.getByText('NOTIFICATIONS')).toBeInTheDocument();
  });

  it('does not show notification panel when isOpen is false', () => {
    mockNotificationState.isOpen = false;
    renderBell();

    expect(screen.queryByText('NOTIFICATIONS')).not.toBeInTheDocument();
  });

  it('shows "No notifications" when list is empty and not loading', () => {
    mockNotificationState.isOpen = true;
    mockNotificationState.notifications = [];
    mockNotificationState.loading = false;
    renderBell();

    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('shows "Loading..." when loading with no notifications', () => {
    mockNotificationState.isOpen = true;
    mockNotificationState.notifications = [];
    mockNotificationState.loading = true;
    renderBell();

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows "Mark all read" button when unread count > 0 and panel is open', () => {
    mockNotificationState.isOpen = true;
    mockNotificationState.unreadCount = 3;
    renderBell();

    expect(screen.getByText('Mark all read')).toBeInTheDocument();
  });

  it('does not show "Mark all read" button when unread count is 0', () => {
    mockNotificationState.isOpen = true;
    mockNotificationState.unreadCount = 0;
    renderBell();

    expect(screen.queryByText('Mark all read')).not.toBeInTheDocument();
  });
});
