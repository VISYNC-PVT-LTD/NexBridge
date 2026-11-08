const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  coverageProvider: 'v8',
  testEnvironment: 'node',
  // Isolation: sanitise env + block outbound network BEFORE any app module loads.
  setupFiles: ['<rootDir>/jest.env.ts', '<rootDir>/jest.network-guard.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@models/(.*)$': '<rootDir>/src/models/$1',
    '^@services/(.*)$': '<rootDir>/src/services/$1',
    '^@repositories/(.*)$': '<rootDir>/src/repositories/$1',
    '^@validators/(.*)$': '<rootDir>/src/validators/$1',
    '^@mw/(.*)$': '<rootDir>/src/middleware/$1',
    '^@lib/(.*)$': '<rootDir>/src/lib/$1',
    '^@engines/(.*)$': '<rootDir>/src/engines/$1',
    '^@components/(.*)$': '<rootDir>/src/components/$1',
    '^@hooks/(.*)$': '<rootDir>/src/hooks/$1',
    '^@app-types/(.*)$': '<rootDir>/src/types/$1',
    '^@constants/(.*)$': '<rootDir>/src/constants/$1',
    '^@genesis/types$': '<rootDir>/../../packages/types/src/index.ts',
  },
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts'],
};

module.exports = createJestConfig(config);
