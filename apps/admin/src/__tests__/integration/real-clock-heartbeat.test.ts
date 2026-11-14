/**
 * Regression for the intermittent real-DB suite failures
 * ("[test-db-guard] connectDB() called without a mocked or isolated test
 * database" in the middle of attendance-e2e).
 *
 * Cause: under Jest fake timers Mongoose stamps heartbeats with the fake Date
 * but its readyState getter reads the real clock, so one heartbeat inside a
 * fake-clock test made a healthy connection report readyState 0 — and kept
 * reporting it into the next test until a real-clock heartbeat arrived.
 * See real-clock-heartbeat.ts. These tests wait for actual heartbeats, so they
 * reproduce the race deterministically instead of by chance.
 *
 * Run: MONGOMS_SYSTEM_BINARY=/path/to/mongod npx jest src/__tests__/integration
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, jest } from '@jest/globals';
import net from 'net';
import mongoose from 'mongoose';
import { stampHeartbeatsWithRealClock } from './real-clock-heartbeat';

const BIN = process.env.MONGOMS_SYSTEM_BINARY;
const suite = BIN || process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
jest.setTimeout(120_000);

const guard = (globalThis as unknown as { __TEST_NETWORK_GUARD__: { allowLoopbackPort(p: number): void } })
  .__TEST_NETWORK_GUARD__;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}
// Same fake-timer configuration the attendance suites use.
function setClock(d: Date) {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  jest.setSystemTime(d);
}
const nextHeartbeat = (c: mongoose.Connection) =>
  new Promise<void>((resolve) => c.getClient().once('serverHeartbeatSucceeded', () => setImmediate(resolve)));

suite('real-DB suites: heartbeats under a fake clock', () => {
  let rs: { getUri(): string; stop(): Promise<boolean> };
  let uri: string;

  beforeAll(async () => {
    const port = await freePort();
    guard.allowLoopbackPort(port);
    const { MongoMemoryReplSet } = await import('mongodb-memory-server');
    rs = await MongoMemoryReplSet.create({
      binary: { systemBinary: BIN },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ port, ip: '127.0.0.1' }],
    });
    uri = rs.getUri();
  });
  afterEach(() => { jest.useRealTimers(); });
  afterAll(async () => { jest.useRealTimers(); await rs?.stop(); });

  it('without the helper, a heartbeat during a past fake date makes a live connection report 0 (the bug)', async () => {
    const conn = await mongoose.createConnection(uri, { dbName: 'hb-control' }).asPromise();
    try {
      expect(conn.readyState).toBe(1);
      setClock(new Date('2026-03-02T03:30:00Z'));
      await nextHeartbeat(conn);
      expect(conn.readyState).toBe(0);
      // The connection itself is healthy — only the heuristic is fooled.
      await expect(conn.db!.command({ ping: 1 })).resolves.toMatchObject({ ok: 1 });
      // …and the wrong state outlives the fake clock until a real heartbeat.
      jest.useRealTimers();
      expect(conn.readyState).toBe(0);
    } finally {
      await conn.close();
    }
  });

  it('with the helper, readyState stays 1 across fake-clock heartbeats, forward jumps and the switch back', async () => {
    const conn = await mongoose.createConnection(uri, { dbName: 'hb-fixed' }).asPromise();
    stampHeartbeatsWithRealClock(conn);
    try {
      setClock(new Date('2026-03-02T03:30:00Z'));
      await nextHeartbeat(conn);
      expect(conn.readyState).toBe(1);
      jest.setSystemTime(new Date('2026-03-03T03:30:00Z')); // +24 h, as in the missed-checkout tests
      expect(conn.readyState).toBe(1);
      jest.useRealTimers();
      expect(conn.readyState).toBe(1);
    } finally {
      await conn.close();
    }
  });

  it('the stale-connection check still works on the real clock', async () => {
    const conn = await mongoose.createConnection(uri, { dbName: 'hb-stale' }).asPromise();
    stampHeartbeatsWithRealClock(conn);
    try {
      await nextHeartbeat(conn);
      expect(conn.readyState).toBe(1);
      // Simulate a server that has really been silent for a minute.
      (conn as unknown as { _lastHeartbeatAt: number })._lastHeartbeatAt = performance.timeOrigin + performance.now() - 60_000;
      expect(conn.readyState).toBe(0);
    } finally {
      await conn.close();
    }
  });
});
