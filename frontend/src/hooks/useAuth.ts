import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { apiFetch, setAccessToken, setAuthFailureHandler } from '../lib/api';

export function useAuth() {
  const { user, isAuthenticated, setAuth, clearAuth, hydrateFromStorage } = useAuthStore();
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    setAuthFailureHandler(() => {
      clearAuth();
      navigate('/login');
    });
  }, [clearAuth, navigate]);

  useEffect(() => {
    const hydrated = hydrateFromStorage();
    if (hydrated) {
      // Try to refresh the access token silently
      const rt = localStorage.getItem('ems_refresh_token');
      if (rt) {
        fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
        })
          .then((res) => (res.ok ? res.json() : null))
          .then((data) => {
            if (data?.access_token) {
              setAccessToken(data.access_token);
              useAuthStore.setState({ accessToken: data.access_token });
            }
          })
          .finally(() => setIsLoading(false));
        return;
      }
    }
    setIsLoading(false);
  }, [hydrateFromStorage]);

  const login = useCallback(
    async (username: string, password: string) => {
      const data = await apiFetch<{
        access_token: string;
        refresh_token: string;
        user: { id: string; username: string; display_name: string; email: string; roles: string[] };
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setAuth(data.user, data.access_token, data.refresh_token);
    },
    [setAuth]
  );

  const logout = useCallback(async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // Best effort
    }
    clearAuth();
    navigate('/login');
  }, [clearAuth, navigate]);

  const roles = user?.roles ?? [];

  return { user, roles, isAuthenticated, isLoading, login, logout };
}
