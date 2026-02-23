import { create } from 'zustand';
import { setAccessToken } from '../lib/api';

interface AuthUser {
  id: string;
  username: string;
  display_name: string;
  email: string;
  roles: string[];
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  setAuth: (user: AuthUser, accessToken: string, refreshToken: string) => void;
  clearAuth: () => void;
  hydrateFromStorage: () => boolean;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,

  setAuth: (user, accessToken, refreshToken) => {
    setAccessToken(accessToken);
    localStorage.setItem('ems_refresh_token', refreshToken);
    localStorage.setItem('ems_user', JSON.stringify(user));
    set({ user, accessToken, isAuthenticated: true });
  },

  clearAuth: () => {
    setAccessToken(null);
    localStorage.removeItem('ems_refresh_token');
    localStorage.removeItem('ems_user');
    set({ user: null, accessToken: null, isAuthenticated: false });
  },

  hydrateFromStorage: () => {
    const userJSON = localStorage.getItem('ems_user');
    const refreshToken = localStorage.getItem('ems_refresh_token');
    if (userJSON && refreshToken) {
      try {
        const user = JSON.parse(userJSON) as AuthUser;
        set({ user, isAuthenticated: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  },
}));
