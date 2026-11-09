import './bootstrap-env';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from '../src/models/User';
import { seedAdminPasswordProblem } from './seed-admin-policy';

export async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not defined');

  // No default password: refuse before touching the database.
  const password = process.env.SEED_ADMIN_PASSWORD;
  const problem = seedAdminPasswordProblem(password);
  if (problem || !password) throw new Error(problem ?? 'SEED_ADMIN_PASSWORD is not set.');

  await mongoose.connect(uri);
  console.log('[seed-admin] Connected to MongoDB');

  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@genesis.com';
  const employeeId = process.env.SEED_ADMIN_EMPLOYEE_ID ?? 'EMP001';
  const firstName = process.env.SEED_ADMIN_FIRST_NAME ?? 'Super';
  const lastName = process.env.SEED_ADMIN_LAST_NAME ?? 'Admin';

  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`[seed-admin] Admin already exists: ${email}`);
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await User.create({
    employeeId,
    firstName,
    lastName,
    email,
    passwordHash,
    role: 'admin',
    monthlySalary: 0,
    dateOfJoining: new Date(),
    isActive: true,
    requiresPasswordChange: true, // force a change on first login
    registeredDevice: null,
  });

  console.log(`[seed-admin] Admin created: ${email}`);
  // The password is never printed.
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[seed-admin] Error:', err instanceof Error ? err.message : 'unknown error');
  process.exit(1);
});
