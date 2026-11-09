/**
 * Password policy for the one-off admin seed script.
 *
 * There is deliberately NO default password: a fallback that ships in the
 * repository is a known credential for every environment where the operator
 * forgot to set SEED_ADMIN_PASSWORD. The script refuses to run instead.
 */

const MIN_LENGTH = 12;

// Values that have appeared in this repository or are trivially guessable.
const KNOWN_WEAK = new Set(
  ['admin@123456', 'admin@123', 'password', 'password123', 'changeme', 'admin123', 'admin@genesis'].map((s) =>
    s.toLowerCase(),
  ),
);

export function seedAdminPasswordProblem(password: string | undefined): string | null {
  if (!password) return 'SEED_ADMIN_PASSWORD is not set. Refusing to create an admin with a default password.';
  if (password.length < MIN_LENGTH) return `SEED_ADMIN_PASSWORD must be at least ${MIN_LENGTH} characters.`;
  if (KNOWN_WEAK.has(password.toLowerCase())) return 'SEED_ADMIN_PASSWORD is a known/default password. Choose a unique one.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'SEED_ADMIN_PASSWORD must mix at least three of: lowercase, uppercase, digits, symbols.';
  return null;
}
