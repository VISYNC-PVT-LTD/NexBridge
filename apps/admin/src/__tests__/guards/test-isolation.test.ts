/**
 * Proves the test-isolation guards work. If any of these fail, the suite is
 * NOT safe to run on a developer laptop with real credentials present.
 */
import { describe, it, expect } from '@jest/globals';
import http from 'http';
import https from 'https';
import net from 'net';
import mongoose from 'mongoose';
import { connectDB } from '@lib/db/connect';
import { sendEmail, sendTransactionalEmail } from '@lib/email/brevo';
import { GeocodingService } from '@services/GeocodingService';
import { redis } from '@lib/redis/client';

describe('test isolation guards', () => {
  describe('environment', () => {
    it('replaces database / cache / provider settings with inert dummies', () => {
      expect(process.env.NODE_ENV).toBe('test');
      expect(process.env.MONGODB_URI).toContain('.invalid');
      expect(process.env.UPSTASH_REDIS_REST_URL).toContain('.invalid');
      expect(process.env.JWT_SECRET).toMatch(/^test-only-/);
      expect(process.env.BREVO_API_KEY).toMatch(/^test-only-/);
      expect(process.env.GEOCODING_PROVIDER).toBe('disabled');
    });

    it('removes previous-key, Firebase and Google credentials entirely', () => {
      for (const key of [
        'JWT_SECRET_PREVIOUS',
        'FIREBASE_PRIVATE_KEY',
        'FIREBASE_CLIENT_EMAIL',
        'GOOGLE_MAPS_API_KEY',
        'BLOB_READ_WRITE_TOKEN',
      ]) {
        expect(process.env[key]).toBeUndefined();
      }
    });
  });

  describe('outbound network', () => {
    it('blocks fetch to external hosts', async () => {
      await expect(fetch('https://example.com/')).rejects.toThrow(/test-network-guard/);
    });

    it('blocks fetch to loopback services that the test did not start', async () => {
      await expect(fetch('http://127.0.0.1:3000/')).rejects.toThrow(/test-network-guard/);
    });

    it('blocks http.request and https.get', () => {
      expect(() => http.request('http://example.com/')).toThrow(/test-network-guard/);
      expect(() => https.get('https://example.com/')).toThrow(/test-network-guard/);
    });

    it('blocks raw TCP sockets, including a local MongoDB / Redis on the laptop', () => {
      expect(() => net.connect({ host: '127.0.0.1', port: 27017 })).toThrow(/test-network-guard/);
      expect(() => net.connect(6379, 'localhost')).toThrow(/test-network-guard/);
      expect(() => net.connect({ host: 'cluster0.example.mongodb.net', port: 27017 })).toThrow(
        /test-network-guard/,
      );
    });

    it('records blocked attempts for diagnostics', () => {
      const guard = (globalThis as unknown as { __TEST_NETWORK_GUARD__: { blockedAttempts: string[] } })
        .__TEST_NETWORK_GUARD__;
      expect(guard.blockedAttempts.length).toBeGreaterThan(0);
    });
  });

  describe('database', () => {
    it('connectDB fails fast when no isolated/mocked DB is present', async () => {
      expect(mongoose.connection.readyState).not.toBe(1);
      const started = Date.now();
      await expect(connectDB()).rejects.toThrow(/test-db-guard/);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('unmocked model calls fail immediately instead of buffering', async () => {
      const Model =
        mongoose.models.__GuardProbe ??
        mongoose.model('__GuardProbe', new mongoose.Schema({ x: Number }));
      const started = Date.now();
      await expect(Model.findOne({}).exec()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  describe('integrations', () => {
    it('email is mocked — no real message is sent', async () => {
      await expect(
        sendEmail({ to: { email: 'nobody@example.invalid' }, subject: 's', htmlContent: 'h' }),
      ).resolves.toBeUndefined();
      expect(jestFn(sendEmail).mock).toBeDefined();
      await expect(
        sendTransactionalEmail({ to: ['nobody@example.invalid'], subject: 's', htmlContent: 'h' }),
      ).resolves.toEqual({ messageId: 'test-message-id' });
    });

    it('reverse geocoding is disabled (no third-party location exposure)', async () => {
      await expect(GeocodingService.reverseGeocode(12.9, 77.6)).resolves.toEqual({
        address: null,
        geocodingStatus: 'disabled',
        geocodingProvider: null,
      });
    });

    it('redis commands reject immediately without network', async () => {
      await expect(redis.get('anything')).rejects.toThrow(/test-redis-guard/);
    });
  });
});

function jestFn(fn: unknown): { mock: unknown } {
  return fn as { mock: unknown };
}
