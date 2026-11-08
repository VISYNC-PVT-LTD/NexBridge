/**
 * @jest-environment node
 */

// Test the api-client module in isolation
// Import after setting up fetch mock so the module initialises cleanly.

let setAccessToken: (t: string | null) => void;
let getAccessToken: () => string | null;
let registerSessionExpiredHandler: (fn: () => void) => void;
let setSessionCredentials: (rt: string, sid: string) => void;
let apiFetch: <T>(path: string, options?: RequestInit) => Promise<T>;
let apiFetchBlob: (path: string, options?: RequestInit) => Promise<Blob>;

beforeEach(() => {
  jest.resetModules();
  // Provide a minimal fetch implementation
  global.fetch = jest.fn();
  ({
    setAccessToken,
    getAccessToken,
    registerSessionExpiredHandler,
    setSessionCredentials,
    apiFetch,
    apiFetchBlob,
  } = require('@lib/utils/api-client'));
});

afterEach(() => {
  jest.resetAllMocks();
});

describe('setAccessToken / getAccessToken', () => {
  it('stores and retrieves token', () => {
    setAccessToken('abc123');
    expect(getAccessToken()).toBe('abc123');
  });

  it('clears token when set to null', () => {
    setAccessToken('abc');
    setAccessToken(null);
    expect(getAccessToken()).toBeNull();
  });
});

describe('apiFetch', () => {
  it('sends Authorization header when token set', async () => {
    setAccessToken('tok');
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: {} }),
    });
    await apiFetch('/api/v1/test');
    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer tok');
  });

  it('includes Content-Type json header', async () => {
    setAccessToken(null);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    await apiFetch('/api/v1/test');
    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('returns parsed JSON on success', async () => {
    setAccessToken(null);
    const payload = { success: true, data: { id: '1' } };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve(payload),
    });
    const result = await apiFetch<typeof payload>('/api/v1/test');
    expect(result).toEqual(payload);
  });

  it('returns error body on non-2xx (non-401) response', async () => {
    // apiFetch does NOT throw for 422 — it returns the parsed JSON.
    // Callers check response.success to detect errors.
    setAccessToken(null);
    const errBody = { success: false, error: { code: 'VAL_001', message: 'Bad input' } };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false, status: 422,
      json: () => Promise.resolve(errBody),
    });
    const result = await apiFetch<typeof errBody>('/api/v1/test');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VAL_001');
  });

  it('attempts silent refresh on 401 then retries', async () => {
    setAccessToken('expired-tok');
    setSessionCredentials('refresh-tok', 'session-id');
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false, status: 401,
        json: () => Promise.resolve({ error: { code: 'AUTH_003', message: 'Expired' } }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ data: { accessToken: 'new-tok' } }),
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ success: true, data: 'retried' }),
      });

    const result = await apiFetch<{ success: boolean; data: string }>('/api/v1/test');
    expect(result.data).toBe('retried');
    expect(getAccessToken()).toBe('new-tok');
  });

  it('fires session expired handler when refresh also fails', async () => {
    const expired = jest.fn();
    registerSessionExpiredHandler(expired);
    setAccessToken('tok');
    // Session expiry handling only applies when an authenticated session exists.
    setSessionCredentials('refresh-tok', 'session-id');
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false, status: 401,
        json: () => Promise.resolve({ error: { code: 'AUTH_003', message: 'x' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) });

    await expect(apiFetch('/api/v1/test')).rejects.toThrow('SESSION_EXPIRED');
    expect(expired).toHaveBeenCalled();
  });

  it('returns the 401 body (no expiry handler) when there is no session, e.g. wrong login password', async () => {
    const expired = jest.fn();
    registerSessionExpiredHandler(expired);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false, status: 401,
      json: () => Promise.resolve({ success: false, error: { code: 'AUTH_001', message: 'x' } }),
    });

    await expect(apiFetch('/api/v1/auth/login')).resolves.toEqual({
      success: false, error: { code: 'AUTH_001', message: 'x' },
    });
    expect(expired).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('apiFetchBlob', () => {
  it('returns a Blob on success', async () => {
    setAccessToken('tok');
    const blob = new Blob(['data'], { type: 'application/vnd.ms-excel' });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true, status: 200,
      blob: () => Promise.resolve(blob),
    });
    const result = await apiFetchBlob('/api/v1/export');
    expect(result).toBe(blob);
  });

  it('throws on non-OK response', async () => {
    setAccessToken(null);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false, status: 500,
      blob: () => Promise.resolve(new Blob()),
    });
    await expect(apiFetchBlob('/api/v1/export')).rejects.toBeDefined();
  });
});
