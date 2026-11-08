import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

/**
 * Test isolation — default mocks for every external integration.
 * (Environment sanitising and the network block run earlier, in setupFiles:
 * see jest.env.ts and jest.network-guard.ts.)
 *
 * NOTE: a test file's own jest.mock() of the same module does NOT reliably
 * replace these (setup-file registration wins under next/jest). To exercise a
 * real implementation, use jest.requireActual() directly (see
 * __tests__/email/brevo.test.ts); to change behaviour, use the exported
 * jest.fn()s (mockImplementationOnce etc.).
 */

// Unmocked model calls must fail immediately instead of buffering for 10s and
// then (on a misconfigured machine) silently connecting somewhere real.
// (Node environment only — jsdom component tests never load mongoose/bson.)
if (typeof window === 'undefined') {
  (require('mongoose') as typeof import('mongoose')).set('bufferCommands', false);
}

// ── Database: fail fast unless a test has simulated or created a connection ──
jest.mock('@lib/db/connect', () => {
  const mg = require('mongoose') as typeof import('mongoose');
  return {
    connectDB: jest.fn(async () => {
      if (mg.connection.readyState === 1) return;
      throw new Error(
        '[test-db-guard] connectDB() called without a mocked or isolated test database. ' +
          'Mock the model calls, simulate readyState, or use the isolated memory replica set helper.',
      );
    }),
  };
});

// ── Email: never send real mail ────────────────────────────────────────────
jest.mock('@lib/email/brevo', () => {
  class EmailProviderError extends Error {
    constructor(message: string, public readonly status?: number) {
      super(message);
      this.name = 'EmailProviderError';
    }
  }
  return {
    sendEmail: jest.fn(async () => undefined),
    sendTransactionalEmail: jest.fn(async () => ({ messageId: 'test-message-id' })),
    EmailProviderError,
  };
});

// ── Firebase (push notifications) ──────────────────────────────────────────
jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(() => ({ name: 'test-app' })),
  getApps: jest.fn(() => []),
  cert: jest.fn(() => ({})),
}));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => ({ send: jest.fn(async () => 'test-message-id') })),
}));

// ── Upstash Redis: every command rejects immediately (no retries, no network) ─
jest.mock('@upstash/redis', () => {
  class Redis {
    constructor() {
      return new Proxy(this, {
        get(_target, prop) {
          if (prop === 'then') return undefined; // not a thenable
          return () => Promise.reject(new Error('[test-redis-guard] Redis is not available in tests.'));
        },
      });
    }
  }
  return { Redis };
});
