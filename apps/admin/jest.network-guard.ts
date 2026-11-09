/**
 * Test isolation — outbound network guard (runs via `setupFiles`).
 *
 * Blocks every outbound connection made by code under test:
 *   - global fetch (Node/undici and any polyfill)
 *   - http/https request/get
 *   - raw TCP/TLS sockets (net.Socket#connect — also covers undici,
 *     the MongoDB driver, ioredis-style clients and tls.connect)
 *
 * Loopback is blocked too, so a test can never reach a MongoDB, Redis or dev
 * server that happens to be running on the developer's laptop. A test that
 * starts its OWN isolated server (e.g. mongodb-memory-server) must explicitly
 * allow that exact port via `globalThis.__TEST_NETWORK_GUARD__.allowLoopbackPort`.
 *
 * Tests that need HTTP behaviour must mock fetch / the client module.
 */
import http from 'http';
import https from 'https';
import net from 'net';

export class BlockedNetworkError extends Error {
  constructor(target: string) {
    super(
      `[test-network-guard] Outbound connection blocked: ${target}. ` +
        'Tests must mock network clients; real services are never reachable from tests.',
    );
    this.name = 'BlockedNetworkError';
  }
}

interface GuardState {
  allowedLoopbackPorts: Set<number>;
  blockedAttempts: string[];
  allowLoopbackPort(port: number): void;
  revokeLoopbackPort(port: number): void;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// This setup file runs once PER TEST FILE, but `net`, `http` and `https` are
// Node core modules shared by every test file in the same Jest worker process.
// The guard state and the core-module patches must therefore be per WORKER:
// previously each file stacked a new wrapper with its own allow-list on top of
// the previous file's wrapper, so a later file's allowLoopbackPort() was
// checked against an older, stale allow-list and its own isolated MongoDB was
// blocked (integration suites failed whenever two shared a worker, e.g. CI).
// NOTE: anchored on the `net` core-module object itself — that object IS shared
// across test files in a worker (that is why wrappers used to stack), whereas
// Jest gives every test file its own copy of `process` and of `globalThis`.
const STATE_KEY = Symbol.for('genesis.test-network-guard.state');
const PATCHED_KEY = Symbol.for('genesis.test-network-guard.core-patched');
const proc = net as unknown as Record<symbol, unknown>;

if (!proc[STATE_KEY]) {
  const s: GuardState = {
    allowedLoopbackPorts: new Set<number>(),
    blockedAttempts: [],
    allowLoopbackPort(port: number) {
      s.allowedLoopbackPorts.add(Number(port));
    },
    revokeLoopbackPort(port: number) {
      s.allowedLoopbackPorts.delete(Number(port));
    },
  };
  proc[STATE_KEY] = s;
}
const state = proc[STATE_KEY] as GuardState;
// Every test file starts with an empty allow-list and attempt log.
state.allowedLoopbackPorts.clear();
state.blockedAttempts.length = 0;

(globalThis as unknown as { __TEST_NETWORK_GUARD__: GuardState }).__TEST_NETWORK_GUARD__ = state;

function isAllowed(host: string | undefined, port: number | undefined): boolean {
  if (!host || port === undefined || Number.isNaN(port)) return false;
  return LOOPBACK_HOSTS.has(host) && state.allowedLoopbackPorts.has(port);
}

function block(target: string): never {
  state.blockedAttempts.push(target);
  throw new BlockedNetworkError(target);
}

// Core modules are patched once per worker (see above).
const corePatched = proc[PATCHED_KEY] === true;
proc[PATCHED_KEY] = true;

// ── Raw sockets ────────────────────────────────────────────────────────────
if (!corePatched) {
const originalConnect = net.Socket.prototype.connect;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(net.Socket.prototype as any).connect = function guardedConnect(this: net.Socket, ...args: any[]) {
  // Node internally calls connect([options, cb]) with a normalised array.
  let opts: unknown = args[0];
  if (Array.isArray(opts)) opts = opts[0];

  let host: string | undefined;
  let port: number | undefined;
  let path: string | undefined;
  if (typeof opts === 'object' && opts !== null) {
    const o = opts as { host?: string; port?: number | string; path?: string };
    host = o.host ?? (o.path ? undefined : 'localhost');
    port = o.port !== undefined ? Number(o.port) : undefined;
    path = o.path;
  } else if (typeof opts === 'number' || (typeof opts === 'string' && /^\d+$/.test(opts))) {
    port = Number(opts);
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof opts === 'string') {
    path = opts;
  }

  if (path !== undefined) block(`ipc:${path}`);
  if (!isAllowed(host, port)) block(`tcp:${host ?? '?'}:${port ?? '?'}`);
  return originalConnect.apply(this, args as Parameters<typeof originalConnect>);
};

// ── http / https ───────────────────────────────────────────────────────────
function guardHttp(mod: typeof http | typeof https, scheme: string) {
  const origRequest = mod.request;
  const origGet = mod.get;
  function target(args: unknown[]): { host?: string; port?: number; label: string } {
    const first = args[0];
    try {
      if (typeof first === 'string' || first instanceof URL) {
        const u = new URL(String(first));
        const port = u.port ? Number(u.port) : scheme === 'https' ? 443 : 80;
        return { host: u.hostname, port, label: `${u.protocol}//${u.host}` };
      }
      if (first && typeof first === 'object') {
        const o = first as { hostname?: string; host?: string; port?: number | string };
        const host = o.hostname ?? o.host ?? 'localhost';
        const port = o.port ? Number(o.port) : scheme === 'https' ? 443 : 80;
        return { host, port, label: `${scheme}://${host}:${port}` };
      }
    } catch {
      /* fall through */
    }
    return { label: `${scheme}://<unknown>` };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mod as any).request = function (...args: any[]) {
    const t = target(args);
    if (!isAllowed(t.host, t.port)) block(t.label);
    return (origRequest as (...a: unknown[]) => unknown).apply(mod, args);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mod as any).get = function (...args: any[]) {
    const t = target(args);
    if (!isAllowed(t.host, t.port)) block(t.label);
    return (origGet as (...a: unknown[]) => unknown).apply(mod, args);
  };
}
guardHttp(http, 'http');
guardHttp(https, 'https');
} // end: once-per-worker core-module patches

// fetch lives on the per-test-file global, so it is guarded per file (using
// the shared, per-worker state above).

// ── fetch ──────────────────────────────────────────────────────────────────
const originalFetch = globalThis.fetch;
if (typeof originalFetch === 'function') {
  const guardedFetch = async function guardedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let url: URL | null = null;
    try {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      url = new URL(raw);
    } catch {
      /* relative URL — no host to reach */
    }
    if (url) {
      const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
      if (!isAllowed(url.hostname, port)) block(`${url.protocol}//${url.host}`);
    }
    return originalFetch(input, init);
  };
  globalThis.fetch = guardedFetch as typeof fetch;
}

export {};
