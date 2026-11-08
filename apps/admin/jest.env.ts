/**
 * Test isolation — environment sanitiser (runs via `setupFiles`, before the
 * test framework and before any application module is imported).
 *
 * next/jest loads .env* files from the app directory. A developer laptop may
 * have a real .env.local pointing at Atlas, Upstash, Brevo or Firebase. Every
 * variable that could route a test to a real service is overwritten here with
 * an inert dummy value, so tests can never reach a real database, cache,
 * email provider or push provider even when a real .env file is present.
 *
 * The network guard (jest.network-guard.ts) is a second, independent layer.
 */

const DUMMY_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  // `.invalid` is a reserved TLD (RFC 2606) — never resolves.
  MONGODB_URI: 'mongodb://test-guard.invalid:1/genesis-test-blocked',
  JWT_SECRET: 'test-only-jwt-secret-0000000000000000000000000000000000000000000000000000',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-000000000000000000000000000000000000000000000000',
  UPSTASH_REDIS_REST_URL: 'https://upstash.test-guard.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'test-only-upstash-token',
  BREVO_API_KEY: 'test-only-brevo-key',
  BREVO_SENDER_EMAIL: 'no-reply@example.invalid',
  BREVO_SENDER_NAME: 'Genesis Test',
  CRON_SECRET: 'test-only-cron-secret-00000000000000000000',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  GEOCODING_PROVIDER: 'disabled',
};

// Variables that must not exist at all during tests.
const REMOVED_ENV = [
  'JWT_SECRET_PREVIOUS',
  'JWT_SECRET_PREVIOUS_EXPIRES_AT',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'GOOGLE_MAPS_API_KEY',
  'BLOB_READ_WRITE_TOKEN',
  'SEED_ADMIN_EMAIL',
  'SEED_ADMIN_INITIAL_PASSWORD',
  'TRUST_PROXY_HEADERS',
  'MAINTENANCE_MODE',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
];

for (const key of REMOVED_ENV) delete process.env[key];
for (const [key, value] of Object.entries(DUMMY_ENV)) {
  (process.env as Record<string, string>)[key] = value;
}

export {};
