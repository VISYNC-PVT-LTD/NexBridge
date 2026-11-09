# Phase 15.2 — Environment Configuration Guide

**Date:** 2026-06-22
**Scope:** Backend (Next.js/Vercel), Mobile (Flutter dart-defines), Seed scripts
**Method:** Source-verified — all variables traced to exact file:line from Phase 15.1 audit
**Status:** DEFINITIVE — supersedes docs/23 and docs/24 on variable naming

---

## SECURITY ALERT

**`apps/admin/.env.example` contains real credentials.** This file has actual values for:
- `MONGODB_URI` — real Atlas cluster URI with password
- `JWT_SECRET` — real 128-char hex value (deployed secret)
- `CRON_SECRET` — real 64-char hex value (deployed secret)

**Before commit: rotate JWT_SECRET and CRON_SECRET immediately if these values are in version control. Replace .env.example values with placeholders.**

---

## Environment Configuration Score

| Dimension | Score | Finding |
|-----------|-------|---------|
| Required vars documented | 12/12 | All 12 confirmed present after correction |
| Dead vars removed | 0/4 | 4 dead vars still in `.env.example` |
| Wrong names corrected | 0/2 | `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` still wrong |
| Missing vars added | 0/5 | 5 undocumented vars not in `.env.example` |
| Mobile dart-defines | 1/2 correct | `API_BASE_URL` value has wrong suffix; `ENVIRONMENT` dead |
| Credentials in example | ❌ FAIL | Real secrets present in `.env.example` |

**Overall: 5/6 dimensions need correction. This guide provides the definitive corrected reference.**

---

## Final Environment Variable Matrix

### Category 1 — MongoDB Atlas

| Variable | Required | Local Dev | Production | Source |
|----------|----------|-----------|-----------|--------|
| `MONGODB_URI` | **YES** | YES | YES | `lib/db/connect.ts:15` |

**Format:**
```
mongodb+srv://USERNAME:PASSWORD@cluster.XXXXX.mongodb.net/genesis-hrms?retryWrites=true&w=majority
```

**Notes:**
- Database name is embedded in the URI string (`genesis-hrms`)
- 19 collections auto-created by Mongoose on first connect — no manual setup
- Connection pool: `maxPoolSize: 10` (hardcoded)
- Throws immediately if undefined — all routes crash

---

### Category 2 — JWT Authentication

| Variable | Required | Local Dev | Production | Source | Notes |
|----------|----------|-----------|-----------|--------|-------|
| `JWT_SECRET` | **YES** | YES | YES | `AuthService.ts:26`, `requireAuth.ts:15`, `proxy.ts:26`, `hash.ts:8` | Signs HS256 access tokens; also HMAC key for IP hashing |
| `JWT_SECRET_PREVIOUS` | Optional | NO | Rotation only | `requireAuth.ts:21`, `proxy.ts:32` | Leave blank. Routine rotation only, with `JWT_SECRET_PREVIOUS_EXPIRES_AT` ≤ 24 h ahead; **never a compromised key** (docs/84) |

**Token strategy (all hardcoded — env vars do NOT change these):**
- Access token: JWT HS256, `JWT_SECRET`, TTL = `'15m'` (hardcoded `AuthService.ts:35`)
- Refresh token: opaque `randomBytes(32).toString('hex')` — NOT a JWT, no secret signing
- Rolling expiry: 30 days (hardcoded `AuthService.ts:92`)
- Absolute expiry: 90 days (hardcoded `AuthService.ts:91`)

**Generation:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

#### DEAD JWT Variables — DO NOT SET

| Variable | Status | Evidence |
|----------|--------|---------|
| `JWT_REFRESH_SECRET` | **DEAD** | Refresh tokens are opaque hex — no JWT signing occurs. Never read by source. |
| `JWT_ACCESS_EXPIRES_IN` | **DEAD** | `signAccessToken()` hardcodes `'15m'` at `AuthService.ts:35`. Env var never read. |
| `JWT_REFRESH_EXPIRES_IN` | **DEAD** | Rolling expiry hardcoded at `AuthService.ts:92`. Env var never read. |
| `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` | **DEAD** | Absolute expiry hardcoded at `AuthService.ts:91`. Env var never read. |

Setting these in Vercel has zero effect on application behavior.

---

### Category 3 — Upstash Redis

| Variable | Required | Local Dev | Production | Source |
|----------|----------|-----------|-----------|--------|
| `UPSTASH_REDIS_REST_URL` | **YES** | YES | YES | `lib/redis/client.ts:4` |
| `UPSTASH_REDIS_REST_TOKEN` | **YES** | YES | YES | `lib/redis/client.ts:5` |

**Notes:**
- Read at module import time — if either undefined, Redis client throws immediately, crashing all routes that import from this module
- Uses `@upstash/redis` REST client — stateless, serverless-safe (no TCP keep-alive)
- Powers 3 rate limiters: auth (login), API (general), strict (password reset)
- Eviction policy: **DISABLE eviction** — rate limit counters must not evict
- Region: match Vercel deployment region to minimize latency

**Format:**
```
UPSTASH_REDIS_REST_URL=https://YOUR-ENDPOINT.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXXXaaaaaaaaaaaaaaaaaa...
```

---

### Category 4 — Firebase Admin SDK

| Variable | Required | Local Dev | Production | Source |
|----------|----------|-----------|-----------|--------|
| `FIREBASE_PROJECT_ID` | **YES** | YES | YES | `lib/firebase/admin.ts:8` |
| `FIREBASE_CLIENT_EMAIL` | **YES** | YES | YES | `lib/firebase/admin.ts:9` |
| `FIREBASE_PRIVATE_KEY` | **YES** | YES | YES | `lib/firebase/admin.ts:10` |

**Source in service account JSON:**
```json
{
  "project_id":    → FIREBASE_PROJECT_ID
  "client_email":  → FIREBASE_CLIENT_EMAIL
  "private_key":   → FIREBASE_PRIVATE_KEY
}
```

**FIREBASE_PRIVATE_KEY newline handling:**
Code: `process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')`

| Environment | Format |
|-------------|--------|
| `.env.local` | `FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIE...\\n-----END PRIVATE KEY-----\\n"` (escaped `\\n`) |
| Vercel Dashboard | Paste raw key with real newlines — Vercel stores verbatim |

**FCM flows (backend sends push notifications for):**
- Leave approved / rejected / revoked → employee
- Regularization approved / rejected → employee
- Payroll finalized → employee
- Account activated / deactivated → employee
- Leave / regularization submitted → all active admins
- Attendance reminder cron → unchecked-in employees

---

### Category 5 — Brevo Email

| Variable | Required | Local Dev | Production | Source |
|----------|----------|-----------|-----------|--------|
| `BREVO_API_KEY` | **YES** | YES | YES | `lib/email/brevo.ts:11` |
| `BREVO_SENDER_EMAIL` | **YES** | YES | YES | `lib/email/brevo.ts:16` — must be verified Brevo sender |
| `BREVO_SENDER_NAME` | **YES** | YES | YES | `lib/email/brevo.ts:17` |

**Notes:**
- All three read per email send — missing any causes HTTP 4xx from Brevo API
- Email failures are caught in NotificationService and do not crash API responses
- `BREVO_SENDER_EMAIL` must be a verified sender in Brevo dashboard
- Domain authentication (SPF + DKIM) required for deliverability

**Format:**
```
BREVO_API_KEY=xkeysib-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxx
BREVO_SENDER_EMAIL=noreply@genesis.com
BREVO_SENDER_NAME=Genesis HR
```

---

### Category 6 — Cron Jobs

| Variable | Required | Local Dev | Production | Source |
|----------|----------|-----------|-----------|--------|
| `CRON_SECRET` | **YES** | YES | YES | `lib/utils/cron-guard.ts:5` |

**Validation pattern:** `Authorization: Bearer <CRON_SECRET>`
If `CRON_SECRET` is unset, `validateCronSecret()` returns `false` for all requests — all cron jobs silently fail.

**Cron endpoints protected:**
- `/admin/cron/session-auto-close`
- `/admin/cron/leave-year-allocation`
- `/admin/cron/leave-carryforward-expiry`

**In Vercel `vercel.json`:** The `Authorization` header value must match `CRON_SECRET` exactly.

**Generation:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

### Category 7 — Vercel / Application

| Variable | Required | Local Dev | Production | Source | Notes |
|----------|----------|-----------|-----------|--------|-------|
| `NEXT_PUBLIC_APP_URL` | **YES** | YES | YES | `services/AuthService.ts:207` | Base URL for password reset links in emails |
| `NODE_ENV` | Auto | NO | Auto | `auth/login/route.ts:48`, `auth/logout/route.ts:49`, `auth/refresh/route.ts:35` | Cookie `secure` flag. Vercel sets automatically — do NOT set manually |
| `MAINTENANCE_MODE` | Optional | NO | When needed | `proxy.ts:93` | Set `"true"` during planned maintenance; unset otherwise |

**Format:**
```
NEXT_PUBLIC_APP_URL=https://genesis-workforce.vercel.app
```

**Vercel auto-provides (do not set):**
- `VERCEL_URL` — deployment URL
- `VERCEL_ENV` — `preview` | `production`
- `NODE_ENV` — set to `production` in Vercel builds automatically

---

### Category 8 — Seed Scripts

> **Correction from docs/23:** `.env.example` documents `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD` — these are wrong. Source reads `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`.

| Variable | Required | Default | Source |
|----------|----------|---------|--------|
| `SEED_ADMIN_EMAIL` | YES (for seed) | `admin@genesis.com` | `scripts/seed-admin.ts:12` |
| `SEED_ADMIN_PASSWORD` | YES (for seed) | **none** — script refuses if unset, <12 chars, <3 character classes or a known default *(changed 2026-11-08; the former hard-coded default must be treated as compromised)* | `scripts/seed-admin.ts` |
| `SEED_ADMIN_EMPLOYEE_ID` | Optional | `EMP001` | `scripts/seed-admin.ts:14` |
| `SEED_ADMIN_FIRST_NAME` | Optional | `Super` | `scripts/seed-admin.ts:15` |
| `SEED_ADMIN_LAST_NAME` | Optional | `Admin` | `scripts/seed-admin.ts:16` |

**Seed script behavior:** Idempotent — if admin with `SEED_ADMIN_EMAIL` exists, exits cleanly without error.

**Security protocol:**
1. Set `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` in Vercel env vars (Production)
2. Run seed: `npx ts-node scripts/seed-admin.ts`
3. Verify admin login
4. **Immediately remove `SEED_ADMIN_PASSWORD` from Vercel**

> `seed-settings.ts` is a stub (`throw new Error('Not implemented — Phase 2.5')`). Do not run it.

---

### Category 9 — Mobile Dart-Defines

These are NOT environment variables — they are Flutter build-time arguments passed with `--dart-define`.

| Dart-Define | Required | Default | Source | Notes |
|-------------|----------|---------|--------|-------|
| `API_BASE_URL` | **YES** for production | `http://localhost:3000` | `lib/core/constants/api_endpoints.dart:2` | Base URL only — no path suffix |
| `ENVIRONMENT` | **DEAD** | `production` | `lib/core/constants/app_constants.dart:2` | `AppConstants.environment` has zero consumers in codebase |

**CRITICAL: `API_BASE_URL` format**

| ❌ WRONG (in `.env.example.json`) | ✅ CORRECT |
|----------------------------------|-----------|
| `https://your-app.vercel.app/api/v1` | `https://your-app.vercel.app` |

The dart code appends full paths (`/api/v1/auth/login`, `/api/v1/attendance/checkin`, etc.) to `baseUrl`. Adding `/api/v1` to `API_BASE_URL` doubles the prefix — all API calls would 404.

**Build command:**
```bash
flutter build appbundle --release --dart-define=API_BASE_URL=https://genesis-workforce.vercel.app
flutter build ipa --release --dart-define=API_BASE_URL=https://genesis-workforce.vercel.app
```

---

## `.env.example` Discrepancy Audit

| Variable in `.env.example` | Status | Action Required |
|----------------------------|--------|----------------|
| `MONGODB_URI` | ✅ Correct name | Contains real credentials — **ROTATE IMMEDIATELY** |
| `JWT_SECRET` | ✅ Correct name | Contains real value — **ROTATE IMMEDIATELY** |
| `JWT_REFRESH_SECRET` | ❌ DEAD | Remove from `.env.example` |
| `JWT_ACCESS_EXPIRES_IN` | ❌ DEAD | Remove from `.env.example` |
| `JWT_REFRESH_EXPIRES_IN` | ❌ DEAD | Remove from `.env.example` |
| `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` | ❌ DEAD | Remove from `.env.example` |
| `UPSTASH_REDIS_REST_URL` | ✅ Correct name | Blank placeholder — OK |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ Correct name | Blank placeholder — OK |
| `FIREBASE_PROJECT_ID` | ✅ Correct name | Blank placeholder — OK |
| `FIREBASE_CLIENT_EMAIL` | ✅ Correct name | Blank placeholder — OK |
| `FIREBASE_PRIVATE_KEY` | ✅ Correct name | Blank placeholder — OK |
| `BREVO_API_KEY` | ✅ Correct name | Blank placeholder — OK |
| `BREVO_SENDER_EMAIL` | ✅ Correct name | Value OK (`noreply@genesis.com`) |
| `BREVO_SENDER_NAME` | ✅ Correct name | Value OK (`Genesis HR`) |
| `ADMIN_EMAIL` | ❌ WRONG NAME | Replace with `SEED_ADMIN_EMAIL` |
| `ADMIN_INITIAL_PASSWORD` | ❌ WRONG NAME | Replace with `SEED_ADMIN_PASSWORD` |
| `CRON_SECRET` | ✅ Correct name | Contains real value — **ROTATE IMMEDIATELY** |
| `NEXT_PUBLIC_APP_URL` | ✅ Correct name | Placeholder OK |
| `NODE_ENV` | ⚠️ Misplaced | Do not set manually — Vercel sets it. Remove from `.env.example` |

**Variables used in source but missing from `.env.example`:**

| Missing Variable | Category | Priority |
|-----------------|----------|---------|
| `JWT_SECRET_PREVIOUS` | JWT | Add — optional, rotation only |
| `MAINTENANCE_MODE` | Application | Add — optional, maintenance only |
| `SEED_ADMIN_EMPLOYEE_ID` | Seed | Add (replace `ADMIN_EMAIL`) |
| `SEED_ADMIN_FIRST_NAME` | Seed | Add |
| `SEED_ADMIN_LAST_NAME` | Seed | Add |

---

## Local `.env.local` Template

Copy this to `apps/admin/.env.local` for local development. Do not commit this file.

```bash
# ── MongoDB Atlas ─────────────────────────────────────────────────────────────
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster.XXXXX.mongodb.net/genesis-hrms?retryWrites=true&w=majority

# ── JWT Authentication ────────────────────────────────────────────────────────
# Generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=<64-byte-hex>
JWT_SECRET_PREVIOUS=   # Leave blank — only set during key rotation

# ── Upstash Redis ─────────────────────────────────────────────────────────────
UPSTASH_REDIS_REST_URL=https://YOUR-ENDPOINT.upstash.io
UPSTASH_REDIS_REST_TOKEN=<token-from-upstash-dashboard>

# ── Firebase Admin SDK ────────────────────────────────────────────────────────
FIREBASE_PROJECT_ID=genesis-workforce-XXXXX
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-XXXXX@genesis-workforce-XXXXX.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"

# ── Brevo Email ───────────────────────────────────────────────────────────────
BREVO_API_KEY=xkeysib-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX-XXXXXXXXXXXXXXXXXXXX
BREVO_SENDER_EMAIL=noreply@genesis.com
BREVO_SENDER_NAME=Genesis HR

# ── Cron Security ─────────────────────────────────────────────────────────────
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRON_SECRET=<32-byte-hex>

# ── Application ───────────────────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000

# ── Seed Admin (run once — do not commit with real values) ────────────────────
SEED_ADMIN_EMAIL=admin@genesis.com
SEED_ADMIN_PASSWORD=<strong-password>
SEED_ADMIN_EMPLOYEE_ID=EMP001
SEED_ADMIN_FIRST_NAME=Super
SEED_ADMIN_LAST_NAME=Admin

# ── Maintenance (leave blank unless in maintenance) ───────────────────────────
# MAINTENANCE_MODE=true
```

**Variables intentionally omitted:**
- `JWT_REFRESH_SECRET` — dead
- `JWT_ACCESS_EXPIRES_IN` — dead (15m hardcoded)
- `JWT_REFRESH_EXPIRES_IN` — dead (30d hardcoded)
- `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` — dead (90d hardcoded)
- `NODE_ENV` — set by Next.js dev server automatically

---

## Production Vercel Environment Variable Checklist

Set all variables under **Environment: Production** in Vercel Dashboard → Settings → Environment Variables.

### Required — set before first deployment

- [ ] `MONGODB_URI` — full Atlas connection string including database name (`genesis-hrms`)
- [ ] `JWT_SECRET` — generate 64-byte hex; store in password manager
- [ ] `UPSTASH_REDIS_REST_URL` — from Upstash dashboard → REST API → Endpoint
- [ ] `UPSTASH_REDIS_REST_TOKEN` — from Upstash dashboard → REST API → Token
- [ ] `FIREBASE_PROJECT_ID` — from service account JSON: `project_id`
- [ ] `FIREBASE_CLIENT_EMAIL` — from service account JSON: `client_email`
- [ ] `FIREBASE_PRIVATE_KEY` — from service account JSON: `private_key` (paste with real newlines in Vercel Dashboard)
- [ ] `BREVO_API_KEY` — from Brevo dashboard → API Keys
- [ ] `BREVO_SENDER_EMAIL` — must be a verified sender in Brevo (e.g. `noreply@genesis.com`)
- [ ] `BREVO_SENDER_NAME` — display name (e.g. `Genesis HR`)
- [ ] `CRON_SECRET` — generate 32-byte hex; must match value in `vercel.json` cron authorization header
- [ ] `NEXT_PUBLIC_APP_URL` — production domain (e.g. `https://genesis-workforce.vercel.app`)

### Temporary — set for seeding, remove immediately after

- [ ] `SEED_ADMIN_EMAIL` — real admin email address
- [ ] `SEED_ADMIN_PASSWORD` — strong password (min 12 chars, mixed case + symbols)
- [ ] `SEED_ADMIN_EMPLOYEE_ID` — e.g. `EMP001`
- [ ] `SEED_ADMIN_FIRST_NAME` — admin first name
- [ ] `SEED_ADMIN_LAST_NAME` — admin last name

### Optional — leave blank unless needed

- [ ] `JWT_SECRET_PREVIOUS` — blank initially; set during JWT rotation events only
- [ ] `MAINTENANCE_MODE` — leave unset; set `"true"` during planned maintenance windows

### Verification — confirm these are NOT set

- [ ] `JWT_REFRESH_SECRET` — must not exist (dead variable)
- [ ] `JWT_ACCESS_EXPIRES_IN` — must not exist (dead variable)
- [ ] `JWT_REFRESH_EXPIRES_IN` — must not exist (dead variable)
- [ ] `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` — must not exist (dead variable)
- [ ] `NODE_ENV` — must not exist (Vercel sets automatically)
- [ ] `ADMIN_EMAIL` — must not exist (wrong name — won't be read)
- [ ] `ADMIN_INITIAL_PASSWORD` — must not exist (wrong name — won't be read)

---

## Seed Admin Checklist

> Run after first successful deployment with MongoDB Atlas connected.

- [ ] Verify `SEED_ADMIN_EMAIL` set in Vercel Production env vars
- [ ] Verify `SEED_ADMIN_PASSWORD` set in Vercel Production env vars
- [ ] Verify `MONGODB_URI` reachable from Vercel (Network Access: `0.0.0.0/0` or Vercel IP ranges)
- [ ] Run seed command:
  ```bash
  cd apps/admin
  MONGODB_URI=<your-uri> SEED_ADMIN_EMAIL=<email> SEED_ADMIN_PASSWORD=<password> \
    npx ts-node scripts/seed-admin.ts
  ```
  Or trigger via Vercel deployment environment if script is wired to build step.
- [ ] Confirm console output: `[seed-admin] Admin created: <email>`
- [ ] **Immediately remove `SEED_ADMIN_PASSWORD` from Vercel env vars**
- [ ] Optionally remove remaining `SEED_ADMIN_*` vars after seeding

---

## First Login Checklist

> Run after seed-admin completes successfully.

- [ ] Open `NEXT_PUBLIC_APP_URL` in browser
- [ ] Login with `SEED_ADMIN_EMAIL` and the seeded password
- [ ] Confirm redirect to dashboard (not error page)
- [ ] Open Settings → Company — confirm page loads
- [ ] Open Settings → Holidays — add one test holiday, verify save
- [ ] Open Settings → Shift — confirm default shift visible
- [ ] Open Settings → Working Days — confirm settings visible
- [ ] Open Settings → Leave Types — confirm leave types visible (or create first)
- [ ] Open Settings → Geofence — confirm map loads
- [ ] Navigate to Employees — confirm empty state (no employees yet)
- [ ] Create one test employee
- [ ] Confirm welcome email delivered to test employee email
- [ ] Check Admin → Notifications page — confirm no errors
- [ ] Check Admin → Audit Logs page — confirm login event logged
- [ ] Confirm password change forced on first employee login via mobile

---

## Missing Providers

| Provider | Status | Impact if missing |
|----------|--------|------------------|
| MongoDB Atlas | ❌ PENDING | App crashes on all requests — no DB |
| Upstash Redis | ❌ PENDING | All API routes crash at import — rate limiters uninitialized |
| Firebase Admin SDK | ❌ PENDING | FCM push delivery fails — soft failure (caught in NotificationService) |
| Brevo Email | ❌ PENDING | Email delivery fails — soft failure (caught in NotificationService) |
| JWT Secret | ❌ PENDING | All auth fails — no token signing |
| Cron Secret | ❌ PENDING | All cron jobs silently fail |

**Hard failures (app won't serve requests):** MongoDB, Upstash Redis, JWT_SECRET
**Soft failures (app runs, feature degraded):** Firebase, Brevo, Cron

---

## Ready For MongoDB Configuration

```
╔════════════════════════════════════════════════════╗
║  READY FOR MONGODB CONFIGURATION                   ║
║                                                    ║
║  Variable:  MONGODB_URI                           ║
║  Database:  genesis-hrms                          ║
║  Pool:      maxPoolSize: 10 (hardcoded)           ║
║  Timeout:   serverSelection: 5s, socket: 45s     ║
║  Schema:    19 collections auto-created           ║
║  TTLs:      5 collections with TTL indexes        ║
║                                                    ║
║  ACTION: Create Atlas cluster → create DB user    ║
║          → whitelist IPs → copy URI               ║
╚════════════════════════════════════════════════════╝
```

---

## Ready For Vercel Configuration

```
╔════════════════════════════════════════════════════╗
║  READY FOR VERCEL CONFIGURATION                    ║
║                                                    ║
║  Required vars:   12                              ║
║  Seed-only vars:  5  (remove after seeding)       ║
║  Optional vars:   2  (rotation / maintenance)     ║
║  Dead vars:       4  (do NOT set)                 ║
║  Wrong-name vars: 2  (do NOT set old names)       ║
║                                                    ║
║  ACTION: Set 12 required vars in Vercel Dashboard  ║
║          → Production environment                  ║
║          → Deploy → Seed → Remove seed password   ║
╚════════════════════════════════════════════════════╝
```

---

## Mobile Build Reference

```bash
# Android release
flutter build appbundle --release \
  --dart-define=API_BASE_URL=https://genesis-workforce.vercel.app

# iOS release
flutter build ipa --release \
  --dart-define=API_BASE_URL=https://genesis-workforce.vercel.app

# Local dev (default value used automatically — no dart-define needed)
flutter run
```

> `ENVIRONMENT` dart-define: **DO NOT PASS** — `AppConstants.environment` is declared but has zero consumers. Passing it has no effect.

---

*Environment Configuration Guide generated: 2026-06-22*
*Source-verified against Phase 15.1 infrastructure provisioning audit*
*No files modified. Do not deploy. Wait for approval.*
