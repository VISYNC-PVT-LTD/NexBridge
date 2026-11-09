/**
 * @jest-environment node
 *
 * Regression: jest.network-guard.ts runs once per TEST FILE, but net/http/https
 * are shared by every test file in a Jest worker process. Each file used to
 * wrap net.Socket#connect again with its own allow-list, so in the second file
 * of a worker the previous file's (stale) wrapper blocked the port the current
 * file had just allowed — every real-DB integration suite after the first one
 * in a worker timed out (seen with --runInBand and in CI's shared workers).
 */
import { describe, it, expect, jest } from '@jest/globals';
import net from 'net';

type Guard = { allowLoopbackPort(p: number): void; revokeLoopbackPort(p: number): void; blockedAttempts: string[] };
const currentGuard = () => (globalThis as unknown as { __TEST_NETWORK_GUARD__: Guard }).__TEST_NETWORK_GUARD__;

function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => s.end());
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

function tryConnect(port: number): Promise<'connected' | string> {
  return new Promise((resolve) => {
    try {
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve('connected'); });
      sock.once('error', (e) => resolve(e.message));
    } catch (e) {
      resolve((e as Error).message);
    }
  });
}

describe('network guard shared by several test files in one worker', () => {
  it('a port allowed by the second test file in a worker is really reachable', async () => {
    // Simulate the setup file running again for the next test file in this worker.
    jest.isolateModules(() => { require('../../../jest.network-guard'); });
    const server = await startServer();
    try {
      currentGuard().allowLoopbackPort(server.port);
      expect(await tryConnect(server.port)).toBe('connected');
    } finally {
      currentGuard().revokeLoopbackPort(server.port);
      await server.close();
    }
  });

  it('loopback ports that were not allowed are still blocked after re-installation', async () => {
    jest.isolateModules(() => { require('../../../jest.network-guard'); });
    const server = await startServer();
    try {
      const result = await tryConnect(server.port);
      expect(result).toContain('[test-network-guard] Outbound connection blocked');
      expect(currentGuard().blockedAttempts).toContain(`tcp:127.0.0.1:${server.port}`);
    } finally {
      await server.close();
    }
  });

  it('a new test file starts with an empty allow-list', async () => {
    const server = await startServer();
    try {
      currentGuard().allowLoopbackPort(server.port);
      jest.isolateModules(() => { require('../../../jest.network-guard'); }); // next file
      expect(await tryConnect(server.port)).toContain('Outbound connection blocked');
    } finally {
      await server.close();
    }
  });
});
