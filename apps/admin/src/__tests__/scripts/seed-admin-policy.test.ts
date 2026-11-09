import { readFileSync } from 'fs';
import { resolve } from 'path';
import { seedAdminPasswordProblem } from '../../../scripts/seed-admin-policy';

describe('seed-admin password policy (no default password)', () => {
  it('refuses when SEED_ADMIN_PASSWORD is unset or empty', () => {
    expect(seedAdminPasswordProblem(undefined)).toMatch(/not set/);
    expect(seedAdminPasswordProblem('')).toMatch(/not set/);
  });

  it('refuses short passwords', () => {
    expect(seedAdminPasswordProblem('Ab1!short')).toMatch(/at least 12/);
  });

  it('refuses the formerly hard-coded default and other known weak values', () => {
    expect(seedAdminPasswordProblem('Admin@123456')).not.toBeNull();
    expect(seedAdminPasswordProblem('ADMIN@123456')).not.toBeNull();
  });

  it('refuses passwords with fewer than three character classes', () => {
    expect(seedAdminPasswordProblem('alllowercaseletters')).toMatch(/three/);
  });

  it('accepts a long mixed password', () => {
    expect(seedAdminPasswordProblem('Tq7-correct-Horse-battery')).toBeNull();
  });

  it('seed-admin.ts has no fallback password, never prints it, and forces a change', () => {
    const src = readFileSync(resolve(__dirname, '../../../scripts/seed-admin.ts'), 'utf-8');
    expect(src).not.toMatch(/SEED_ADMIN_PASSWORD\s*\?\?/);
    expect(src).not.toMatch(/Admin@123456/);
    expect(src).not.toMatch(/console\.log\([^)]*password/i);
    expect(src).toMatch(/requiresPasswordChange:\s*true/);
  });
});
