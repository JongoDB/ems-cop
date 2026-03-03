import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from '../authStore';

// Mock ../lib/api
vi.mock('../../lib/api', () => ({
  setAccessToken: vi.fn(),
  getAccessToken: vi.fn(() => null),
  apiFetch: vi.fn(),
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((_index: number) => null),
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

describe('authStore', () => {
  beforeEach(() => {
    // Reset Zustand store to initial state
    useAuthStore.setState({
      user: null,
      accessToken: null,
      isAuthenticated: false,
    });
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('has correct initial state', () => {
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.accessToken).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('setAuth sets user, token, and isAuthenticated', () => {
    const mockUser = {
      id: 'user-1',
      username: 'admin',
      display_name: 'Admin User',
      email: 'admin@test.com',
      roles: ['admin'],
    };

    useAuthStore.getState().setAuth(mockUser, 'access-token-123', 'refresh-token-456');

    const state = useAuthStore.getState();
    expect(state.user).toEqual(mockUser);
    expect(state.accessToken).toBe('access-token-123');
    expect(state.isAuthenticated).toBe(true);
  });

  it('setAuth persists refresh token and user to localStorage', () => {
    const mockUser = {
      id: 'user-1',
      username: 'admin',
      display_name: 'Admin User',
      email: 'admin@test.com',
      roles: ['admin'],
    };

    useAuthStore.getState().setAuth(mockUser, 'access-token-123', 'refresh-token-456');

    expect(localStorageMock.setItem).toHaveBeenCalledWith('ems_refresh_token', 'refresh-token-456');
    expect(localStorageMock.setItem).toHaveBeenCalledWith('ems_user', JSON.stringify(mockUser));
  });

  it('setAuth calls setAccessToken from api module', async () => {
    const { setAccessToken } = await import('../../lib/api');
    const mockUser = {
      id: 'user-1',
      username: 'admin',
      display_name: 'Admin User',
      email: 'admin@test.com',
      roles: ['admin'],
    };

    useAuthStore.getState().setAuth(mockUser, 'my-token', 'my-refresh');

    expect(setAccessToken).toHaveBeenCalledWith('my-token');
  });

  it('clearAuth resets state to unauthenticated', () => {
    const mockUser = {
      id: 'user-1',
      username: 'admin',
      display_name: 'Admin User',
      email: 'admin@test.com',
      roles: ['admin'],
    };

    useAuthStore.getState().setAuth(mockUser, 'access-token', 'refresh-token');
    useAuthStore.getState().clearAuth();

    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.accessToken).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('clearAuth removes tokens from localStorage', () => {
    useAuthStore.getState().clearAuth();

    expect(localStorageMock.removeItem).toHaveBeenCalledWith('ems_refresh_token');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('ems_user');
  });

  it('hydrateFromStorage returns true and restores user when data exists', () => {
    const mockUser = {
      id: 'user-1',
      username: 'admin',
      display_name: 'Admin User',
      email: 'admin@test.com',
      roles: ['admin'],
    };

    localStorageMock.setItem('ems_user', JSON.stringify(mockUser));
    localStorageMock.setItem('ems_refresh_token', 'refresh-token-456');

    const result = useAuthStore.getState().hydrateFromStorage();

    expect(result).toBe(true);
    const state = useAuthStore.getState();
    expect(state.user).toEqual(mockUser);
    expect(state.isAuthenticated).toBe(true);
  });

  it('hydrateFromStorage returns false when no data in localStorage', () => {
    const result = useAuthStore.getState().hydrateFromStorage();

    expect(result).toBe(false);
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('hydrateFromStorage returns false when only user exists (no refresh token)', () => {
    localStorageMock.setItem('ems_user', JSON.stringify({ id: 'user-1' }));

    const result = useAuthStore.getState().hydrateFromStorage();

    expect(result).toBe(false);
  });

  it('hydrateFromStorage returns false when user JSON is invalid', () => {
    localStorageMock.setItem('ems_user', 'not-valid-json{');
    localStorageMock.setItem('ems_refresh_token', 'some-token');

    const result = useAuthStore.getState().hydrateFromStorage();

    expect(result).toBe(false);
  });

  it('hydrateFromStorage does not set accessToken (only user + isAuthenticated)', () => {
    const mockUser = {
      id: 'user-1',
      username: 'admin',
      display_name: 'Admin User',
      email: 'admin@test.com',
      roles: ['admin'],
    };

    localStorageMock.setItem('ems_user', JSON.stringify(mockUser));
    localStorageMock.setItem('ems_refresh_token', 'refresh-token-456');

    useAuthStore.getState().hydrateFromStorage();

    const state = useAuthStore.getState();
    // accessToken remains null — it will be obtained via refresh
    expect(state.accessToken).toBeNull();
    expect(state.isAuthenticated).toBe(true);
  });
});
