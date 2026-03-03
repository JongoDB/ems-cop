import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

// ── Mocks ───────────────────────────────────────────────────────────

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockApiFetch = vi.fn();
const mockSetAccessToken = vi.fn();
const mockSetAuthFailureHandler = vi.fn();

vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  setAccessToken: (...args: unknown[]) => mockSetAccessToken(...args),
  setAuthFailureHandler: (...args: unknown[]) => mockSetAuthFailureHandler(...args),
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

// Mock fetch for token refresh
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// We need to import authStore before useAuth so we can reset it
import { useAuthStore } from '../../stores/authStore';
import { useAuth } from '../useAuth';

// Wrapper with router
function wrapper({ children }: { children: ReactNode }) {
  return createElement(MemoryRouter, null, children);
}

describe('useAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
    useAuthStore.setState({
      user: null,
      accessToken: null,
      isAuthenticated: false,
    });
    // Default fetch mock
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
  });

  it('returns initial unauthenticated state', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });

    // Wait for loading to complete
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.roles).toEqual([]);
  });

  it('sets up auth failure handler on mount', () => {
    renderHook(() => useAuth(), { wrapper });

    expect(mockSetAuthFailureHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it('login calls apiFetch and updates store', async () => {
    const mockUser = {
      id: 'u1',
      username: 'admin',
      display_name: 'Admin',
      email: 'admin@test.com',
      roles: ['admin'],
    };
    mockApiFetch.mockResolvedValueOnce({
      access_token: 'tok-123',
      refresh_token: 'ref-456',
      user: mockUser,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.login('admin', 'changeme');
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'changeme' }),
    });

    expect(result.current.user).toEqual(mockUser);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.roles).toEqual(['admin']);
  });

  it('logout clears store and navigates to /login', async () => {
    // Set up authenticated state
    useAuthStore.setState({
      user: { id: 'u1', username: 'admin', display_name: 'Admin', email: 'a@a.com', roles: ['admin'] },
      accessToken: 'tok',
      isAuthenticated: true,
    });

    mockApiFetch.mockResolvedValueOnce(undefined); // logout API call

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('logout navigates to /login even when API call fails', async () => {
    useAuthStore.setState({
      user: { id: 'u1', username: 'admin', display_name: 'Admin', email: 'a@a.com', roles: ['admin'] },
      accessToken: 'tok',
      isAuthenticated: true,
    });

    mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.isAuthenticated).toBe(false);
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('hydrates from storage and attempts token refresh on mount', async () => {
    const mockUser = {
      id: 'u1',
      username: 'admin',
      display_name: 'Admin',
      email: 'admin@test.com',
      roles: ['admin'],
    };

    localStorageMock.setItem('ems_user', JSON.stringify(mockUser));
    localStorageMock.setItem('ems_refresh_token', 'old-refresh-token');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'new-access-token' }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should have called the refresh endpoint
    expect(mockFetch).toHaveBeenCalledWith('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: 'old-refresh-token' }),
    });

    // User should be hydrated
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user).toEqual(mockUser);
  });

  it('returns roles from user object', async () => {
    useAuthStore.setState({
      user: { id: 'u1', username: 'op1', display_name: 'Op One', email: 'op@test.com', roles: ['operator', 'e3'] },
      accessToken: 'tok',
      isAuthenticated: true,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.roles).toEqual(['operator', 'e3']);
  });
});
