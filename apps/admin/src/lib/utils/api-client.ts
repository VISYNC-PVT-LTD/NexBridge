let accessToken: string | null = null;
let _refreshToken: string | null = null;
let _sessionId: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionExpired: (() => void) | null = null;

// Restore session credentials from sessionStorage on module load (browser only)
if (typeof window !== 'undefined') {
  _refreshToken = sessionStorage.getItem('_rt');
  _sessionId = sessionStorage.getItem('_sid');
}

export function setAccessToken(token: string | null) { accessToken = token; }
export function getAccessToken() { return accessToken; }
export function getSessionId() { return _sessionId; }
export function registerSessionExpiredHandler(fn: () => void) { onSessionExpired = fn; }

export function setSessionCredentials(rt: string, sid: string) {
  _refreshToken = rt;
  _sessionId = sid;
  if (typeof window !== 'undefined') {
    sessionStorage.setItem('_rt', rt);
    sessionStorage.setItem('_sid', sid);
  }
}

export function clearSessionCredentials() {
  _refreshToken = null;
  _sessionId = null;
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem('_rt');
    sessionStorage.removeItem('_sid');
  }
}

export async function tryRefresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  if (!_refreshToken || !_sessionId) return false;
  refreshing = (async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Empty body: the server uses the HttpOnly __rt cookie, which is the
        // single, always-current copy (the proxy may have rotated the token
        // since this tab stored its sessionStorage copy).
        body: JSON.stringify({}),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { data?: { accessToken?: string; refreshToken?: string } };
      if (json.data?.accessToken) {
        accessToken = json.data.accessToken;
        // Refresh tokens rotate on every refresh — keep the new one.
        if (json.data.refreshToken && _sessionId) setSessionCredentials(json.data.refreshToken, _sessionId);
        return true;
      }
      return false;
    } catch { return false; }
    finally { refreshing = null; }
  })();
  return refreshing;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> ?? {}),
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  let res = await fetch(path, { ...options, headers, credentials: 'include' });

  if (res.status === 401 && path !== '/api/v1/auth/refresh') {
    // Only treat 401 as session expiry when an authenticated session exists.
    // Without a session (e.g. login attempt with wrong credentials) the 401 JSON
    // must be returned so the caller can surface the correct error code.
    if (_refreshToken && _sessionId) {
      const ok = await tryRefresh();
      if (ok) {
        if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
        res = await fetch(path, { ...options, headers, credentials: 'include' });
      }
      if (!ok || res.status === 401) {
        accessToken = null;
        clearSessionCredentials();
        onSessionExpired?.();
        throw new Error('SESSION_EXPIRED');
      }
    }
  }

  const data = (await res.json()) as T;
  return data;
}

export async function apiFetchBlob(path: string, options?: RequestInit): Promise<Blob> {
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> ?? {}),
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(path, { ...options, headers, credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}
