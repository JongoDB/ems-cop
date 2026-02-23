const API_BASE = '/api/v1';

let accessToken: string | null = null;
let onAuthFailure: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAuthFailureHandler(handler: () => void) {
  onAuthFailure = handler;
}

async function refreshToken(currentRefreshToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: currentRefreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');

  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    // Try refresh
    const rt = localStorage.getItem('ems_refresh_token');
    if (rt) {
      const newToken = await refreshToken(rt);
      if (newToken) {
        accessToken = newToken;
        headers.set('Authorization', `Bearer ${newToken}`);
        const retry = await fetch(`${API_BASE}${path}`, { ...options, headers });
        if (retry.ok) return retry.json();
      }
    }
    // Refresh failed — clear and redirect
    accessToken = null;
    localStorage.removeItem('ems_refresh_token');
    onAuthFailure?.();
    throw new Error('Authentication failed');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error?.message || `Request failed: ${res.status}`;
    const err = new Error(msg) as Error & { code?: string; status?: number };
    err.code = body?.error?.code;
    err.status = res.status;
    throw err;
  }

  return res.json();
}
