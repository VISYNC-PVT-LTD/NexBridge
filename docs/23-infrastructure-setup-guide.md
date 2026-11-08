# Phase 15 — Infrastructure Setup Guide

**Date:** 2026-06-22
**Project:** Genesis Workforce HRMS
**Basis:** Production Readiness Review (docs/22) + Mobile Stability Verified (docs/22.7)
**Decision rule:** All REQUIRED items provisioned → GO. Any missing → NO-GO.

---

## Infrastructure Readiness Score

| Provider | Status | Score | Notes |
|----------|--------|-------|-------|
| MongoDB Atlas | PENDING | 0/10 | Not provisioned — connection string in .env.example is placeholder |
| JWT Secrets | PENDING | 0/10 | Values in .env.example appear populated; must verify not committed to git |
| Upstash Redis | PENDING | 0/10 | URL/token placeholders in .env.example |
| Firebase FCM | PARTIAL | 6/10 | `flutterfire configure` done; Admin SDK credentials not verified in Vercel |
| Brevo Email | PENDING | 0/10 | API key blank in .env.example |
| Vercel Project | PENDING | 0/10 | No deployment exists yet |

**Overall: NOT READY — 5 of 6 providers unprovisioned**

---

## Complete Environment Variable Reference

### 1. MongoDB Atlas

| Variable | `MONGODB_URI` |
|----------|---------------|
| **Purpose** | Database connection. Every API call fails without it. |
| **Source** | MongoDB Atlas → Cluster → Connect → Connect your application → copy connection string |
| **Format** | `mongodb+srv://USERNAME:PASSWORD@cluster0.XXXXX.mongodb.net/genesis-hrms?retryWrites=true&w=majority` |
| **Local dev** | Required (can point to Atlas or local `mongodb://localhost:27017/genesis-hrms`) |
| **Production** | Required |
| **Notes** | Replace `USERNAME`, `PASSWORD`, and cluster hostname. Database name `genesis-hrms` is set here. Mongoose `maxPoolSize: 10` — on Vercel serverless, monitor Atlas connection count. |

---

### 2. JWT Authentication

| Variable | `JWT_SECRET` |
|----------|--------------|
| **Purpose** | Signs and verifies all access tokens. Any request fails to authenticate without it. Also used as HMAC key for IP address hashing in rate limiter. |
| **Source** | Generate locally — see Step 2 |
| **Format** | 128-char hex string: `a3f19...` (64 random bytes → hex) |
| **Local dev** | Required |
| **Production** | Required |
| **Notes** | Minimum 64 bytes (128 hex chars). Must differ from `JWT_SECRET_PREVIOUS`. **If compromised: generate a new `JWT_SECRET` and leave `JWT_SECRET_PREVIOUS` UNSET** — never put a compromised key there (corrected 2026-11-08, docs/84). `JWT_SECRET_PREVIOUS` is only for routine rotation and is honoured only with `JWT_SECRET_PREVIOUS_EXPIRES_AT` ≤ 24 h ahead. |

| Variable | `JWT_SECRET_PREVIOUS` |
|----------|-----------------------|
| **Purpose** | Accepts tokens signed with previous secret during key rotation. |
| **Source** | Set to old `JWT_SECRET` value only during rotation events. |
| **Format** | Same as `JWT_SECRET` |
| **Local dev** | Leave blank |
| **Production** | Leave blank initially; set only during rotation |
| **Notes** | Both `proxy.ts` and `requireAuth.ts` fall back to this key when primary verification fails. Remove after all active sessions have naturally expired (max 15 min for access tokens). |

| Variable | `JWT_ACCESS_EXPIRES_IN` |
|----------|------------------------|
| **Purpose** | Access token lifetime. |
| **Source** | Set manually |
| **Format** | `15m` |
| **Local dev** | `15m` |
| **Production** | `15m` |
| **Notes** | Do not increase beyond 15m in production — short-lived tokens limit breach window. |

| Variable | `JWT_REFRESH_EXPIRES_IN` |
|----------|--------------------------|
| **Purpose** | Refresh token rolling window. Each successful refresh resets this timer. |
| **Source** | Set manually |
| **Format** | `7d` |
| **Local dev** | `7d` |
| **Production** | `7d` |
| **Notes** | Used by AuthService for DeviceSession `expiresAt`. |

| Variable | `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` |
|----------|-----------------------------------|
| **Purpose** | Absolute maximum session lifetime regardless of activity. |
| **Source** | Set manually |
| **Format** | `90d` |
| **Local dev** | `90d` |
| **Production** | `90d` |
| **Notes** | Forces re-login after 90 days even with continuous activity. |

| Variable | `JWT_REFRESH_SECRET` |
|----------|----------------------|
| **Purpose** | ⚠️ **DEAD VARIABLE** — documented in `.env.example` but never read by any source file. Refresh tokens are opaque random hex strings hashed with SHA-256, not JWTs. |
| **Source** | N/A |
| **Format** | N/A |
| **Local dev** | Do NOT set |
| **Production** | Do NOT set — omit entirely to avoid ops confusion |
| **Notes** | Present in `.env.example` as leftover from an earlier design. Setting it has no effect. |

---

### 3. Upstash Redis

| Variable | `UPSTASH_REDIS_REST_URL` |
|----------|--------------------------|
| **Purpose** | Rate limiter backend. Without it, `@upstash/redis` throws on import and all API routes crash. |
| **Source** | Upstash Console → Database → REST API → Endpoint |
| **Format** | `https://XXXXXXXX.upstash.io` |
| **Local dev** | Required (create a free Upstash database for dev) |
| **Production** | Required |
| **Notes** | Choose region matching Vercel deployment (e.g. `iad1` → `us-east-1`). Upstash REST API is serverless-safe — no persistent connection needed. |

| Variable | `UPSTASH_REDIS_REST_TOKEN` |
|----------|---------------------------|
| **Purpose** | Authenticates all Redis operations. |
| **Source** | Upstash Console → Database → REST API → Token |
| **Format** | `AXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXxx=` |
| **Local dev** | Required |
| **Production** | Required |
| **Notes** | Treat as secret — full read/write access to the database. |

---

### 4. Firebase / FCM

| Variable | `FIREBASE_PROJECT_ID` |
|----------|-----------------------|
| **Purpose** | Identifies the Firebase project for Admin SDK. Push notifications fail without it. |
| **Source** | Firebase Console → Project Settings → General → Project ID |
| **Format** | `genesis-hrms-XXXXX` |
| **Local dev** | Required if testing FCM |
| **Production** | Required |
| **Notes** | Same project used for mobile (`google-services.json` / `GoogleService-Info.plist`). |

| Variable | `FIREBASE_CLIENT_EMAIL` |
|----------|------------------------|
| **Purpose** | Service account identity for Firebase Admin SDK. |
| **Source** | Firebase Console → Project Settings → Service Accounts → Generate New Private Key → `client_email` field |
| **Format** | `firebase-adminsdk-XXXXX@genesis-hrms-XXXXX.iam.gserviceaccount.com` |
| **Local dev** | Required if testing FCM |
| **Production** | Required |

| Variable | `FIREBASE_PRIVATE_KEY` |
|----------|------------------------|
| **Purpose** | Service account private key — signs Firebase Admin SDK requests. |
| **Source** | Same JSON as `FIREBASE_CLIENT_EMAIL` → `private_key` field |
| **Format** | `-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhki...\n-----END PRIVATE KEY-----\n` |
| **Local dev** | Required if testing FCM |
| **Production** | Required |
| **Notes** | **Critical:** The key contains literal `\n` characters. In Vercel Dashboard, paste the raw value with actual newlines OR keep as `\\n` escaped — `admin.ts` calls `.replace(/\\n/g, '\n')` to unescape. Do NOT double-escape. When pasting in Vercel UI, paste the raw key with real line breaks. |

---

### 5. Brevo Email

| Variable | `BREVO_API_KEY` |
|----------|-----------------|
| **Purpose** | Authenticates all transactional email sends (password reset, leave notifications, payroll). Email delivery silently fails without it — no crash, but no emails. |
| **Source** | Brevo Console → Account → SMTP & API → API Keys → Create API Key |
| **Format** | `xkeysib-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX-XXXXXXXX` |
| **Local dev** | Optional (emails silently fail — no crash) |
| **Production** | Required |

| Variable | `BREVO_SENDER_EMAIL` |
|----------|---------------------|
| **Purpose** | From address for all outbound emails. Must be verified in Brevo or emails are rejected. |
| **Source** | Brevo Console → Senders & IPs → Add a sender |
| **Format** | `noreply@genesis.com` |
| **Local dev** | Optional |
| **Production** | Required — must be a Brevo-verified sender |
| **Notes** | Domain must have SPF and DKIM records configured in DNS. |

| Variable | `BREVO_SENDER_NAME` |
|----------|---------------------|
| **Purpose** | Display name in From field of all emails. |
| **Source** | Set manually |
| **Format** | `Genesis HR` |
| **Local dev** | Optional |
| **Production** | Required |

---

### 6. Cron Security

| Variable | `CRON_SECRET` |
|----------|---------------|
| **Purpose** | Authenticates Vercel's cron runner against the three cron endpoints. Without it, `assertCronAuth` returns 500 and all crons fail. |
| **Source** | Generate locally — see Step 2 |
| **Format** | 64-char hex string (32 random bytes → hex) |
| **Local dev** | Optional (crons not triggered locally) |
| **Production** | Required — must match value in `vercel.json` is handled automatically by Vercel |
| **Notes** | Vercel sends `Authorization: Bearer <CRON_SECRET>` to cron routes. Set this in Vercel env vars; Vercel reads it and sends it. |

---

### 7. Application

| Variable | `NEXT_PUBLIC_APP_URL` |
|----------|-----------------------|
| **Purpose** | Base URL for password reset links in emails. Wrong value = broken reset links. |
| **Source** | Your production domain |
| **Format** | `https://genesis-hrms.vercel.app` or `https://app.genesis.com` |
| **Local dev** | `http://localhost:3000` |
| **Production** | Required — full https URL, no trailing slash |

| Variable | `NODE_ENV` |
|----------|------------|
| **Purpose** | Controls cookie `secure` flag (production = HTTPS-only cookies). |
| **Source** | Vercel sets `production` automatically |
| **Format** | `production` / `development` |
| **Local dev** | `development` (in `.env.local`) |
| **Production** | **Do NOT set manually** — Vercel sets this |

| Variable | `MAINTENANCE_MODE` |
|----------|--------------------|
| **Purpose** | When set to `"true"`, proxy rewrites all page requests to `/maintenance.html`. |
| **Source** | Set manually in Vercel when needed |
| **Format** | `true` or unset |
| **Local dev** | Leave unset |
| **Production** | Leave unset; set to `"true"` only during planned maintenance |
| **Notes** | Undocumented in original `.env.example` — added as M7 finding. |

---

### 8. Seed-Only (Temporary)

| Variable | `SEED_ADMIN_EMAIL` |
|----------|--------------------|
| **Purpose** | Email address for the initial admin account created by `seed-admin.ts`. |
| **Source** | Set manually |
| **Format** | `admin@genesis.com` |
| **Local dev** | Optional (script has default `admin@genesis.com`) |
| **Production** | Set before seeding, **remove immediately after** |
| **Notes** | Script reads `SEED_ADMIN_EMAIL` (not `ADMIN_EMAIL` as documented in earlier .env.example). Default fallback is `admin@genesis.com`. |

| Variable | `SEED_ADMIN_PASSWORD` |
|----------|-----------------------|
| **Purpose** | Initial password for seeded admin account. |
| **Source** | Set manually |
| **Format** | Min 8 chars, mixed case + number: `Admin@123456` |
| **Local dev** | Optional (script has default `Admin@123456`) |
| **Production** | Set before seeding, **REMOVE IMMEDIATELY after seeding and first login** |
| **Notes** | Script reads `SEED_ADMIN_PASSWORD` (not `ADMIN_INITIAL_PASSWORD`). Change password via admin portal immediately after login. |

> **Note:** `.env.example` documents `ADMIN_EMAIL` / `ADMIN_INITIAL_PASSWORD` but seed-admin.ts actually reads `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`. Use the correct variable names.

---

### 9. Vercel Auto-Provided (Do NOT Set Manually)

| Variable | Set by | Purpose |
|----------|--------|---------|
| `VERCEL_URL` | Vercel | Deployment URL (changes per deployment) |
| `VERCEL_ENV` | Vercel | `preview` / `production` |
| `NODE_ENV` | Vercel | `production` on production deployments |

---

### 10. Mobile Build-Time (dart-define)

| Variable | `API_BASE_URL` |
|----------|----------------|
| **Purpose** | Backend API base URL compiled into the Flutter app. Wrong value = all API calls fail. |
| **Source** | Your production Vercel domain |
| **Format** | `https://genesis-hrms.vercel.app` (no trailing slash, no `/api/v1` — that's added by `ApiEndpoints`) |
| **Local dev** | `http://10.0.2.2:3000` (Android emulator → localhost) or `http://localhost:3000` (iOS simulator) |
| **Production** | Passed at build time: `--dart-define=API_BASE_URL=https://your-domain.vercel.app` |
| **Notes** | Defined in `api_endpoints.dart:2` as `String.fromEnvironment('API_BASE_URL', defaultValue: 'http://localhost:3000')`. Compiled into binary — not changeable at runtime. |

---

## Step-by-Step Setup Order

### Step 1 — MongoDB Atlas

1. Sign in to [cloud.mongodb.com](https://cloud.mongodb.com)
2. Create new project → Build a Cluster → **M10 Dedicated** (minimum for production)
3. Select cloud provider and region closest to Vercel deployment region
4. Create database user: Security → Database Access → Add New Database User
   - Authentication: Password
   - Username: `genesis-hrms-prod`
   - Password: generate strong password (save it)
   - Role: `readWrite@genesis-hrms`
5. Network Access → Add IP Address → `0.0.0.0/0` (allow all — acceptable with strong credentials; or use Vercel IP ranges)
6. Connect → Connect your application → Driver: Node.js → copy connection string
7. Replace `<password>` in connection string with your database user password
8. Set database name: append `/genesis-hrms` before `?retryWrites`
9. Enable backup: Backup → Enable Continuous Cloud Backup
10. **Result:** `MONGODB_URI=mongodb+srv://genesis-hrms-prod:PASSWORD@cluster0.XXXXX.mongodb.net/genesis-hrms?retryWrites=true&w=majority`

> Indexes are auto-created by Mongoose on first `connectDB()` call — no manual migration needed.

---

### Step 2 — JWT Secrets and CRON_SECRET

Generate all secrets locally before touching Vercel.

**Generate JWT_SECRET (64 bytes → 128 hex chars):**

```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# OpenSSL
openssl rand -hex 64
```

**Generate CRON_SECRET (32 bytes → 64 hex chars):**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Rules:**
- `JWT_SECRET` and `CRON_SECRET` must be different values
- `JWT_SECRET_PREVIOUS` — leave blank on first deployment
- `JWT_ACCESS_EXPIRES_IN` = `15m` (hardcoded default, but set for clarity)
- `JWT_REFRESH_EXPIRES_IN` = `7d`
- `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` = `90d`
- `JWT_REFRESH_SECRET` — **do not set** (dead variable)

---

### Step 3 — Upstash Redis

1. Sign in to [console.upstash.com](https://console.upstash.com)
2. Create Database → Name: `genesis-hrms-prod`
3. Type: Regional → select region matching Vercel deployment (e.g., `N. Virginia (us-east-1)` for `iad1`)
4. Enable Eviction: No (rate limiter data must not be evicted)
5. Copy from REST API tab:
   - `UPSTASH_REDIS_REST_URL` = Endpoint
   - `UPSTASH_REDIS_REST_TOKEN` = Token

---

### Step 4 — Firebase Admin SDK Credentials

> Mobile Firebase (`google-services.json`, `GoogleService-Info.plist`, `firebase_options.dart`) already provisioned via `flutterfire configure`. This step is for the **backend Admin SDK only**.

1. Firebase Console → select your Genesis Workforce project
2. Project Settings → Service Accounts tab
3. Click **Generate New Private Key** → download JSON file
4. Extract values from JSON:
   - `FIREBASE_PROJECT_ID` = `project_id` field
   - `FIREBASE_CLIENT_EMAIL` = `client_email` field
   - `FIREBASE_PRIVATE_KEY` = `private_key` field (the full `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` string)
5. Verify FCM is enabled: Firebase Console → Cloud Messaging → ensure it shows active

**FIREBASE_PRIVATE_KEY in Vercel:**
When pasting in Vercel Dashboard UI, paste the raw private key with real newlines (not `\n` escaped). Vercel stores it correctly. The code does `.replace(/\\n/g, '\n')` to handle the escaped form from `.env` files.

---

### Step 5 — Brevo Email

1. Sign in to [app.brevo.com](https://app.brevo.com)
2. Account → SMTP & API → API Keys → **Create a new API key**
   - Name: `genesis-hrms-prod`
   - Copy the key immediately (shown only once)
3. Senders & IPs → Add a sender
   - Email: `noreply@genesis.com`
   - Name: `Genesis HR`
4. Authenticate sender domain:
   - Senders & IPs → Domains → Add a domain → `genesis.com`
   - Add SPF record: `v=spf1 include:spf.brevo.com mx ~all`
   - Add DKIM record: provided by Brevo
   - Wait for DNS propagation (up to 48h)
5. Test delivery: Brevo Console → Send a test email to confirm SPF/DKIM pass

---

### Step 6 — Vercel Environment Variables

1. Vercel Dashboard → select Genesis HRMS project → Settings → Environment Variables
2. Add each variable below with the indicated scope:

| Variable | Environment | Value |
|----------|-------------|-------|
| `MONGODB_URI` | Production | `mongodb+srv://...` |
| `JWT_SECRET` | Production, Preview | generated 128-char hex |
| `JWT_SECRET_PREVIOUS` | — | leave blank |
| `JWT_ACCESS_EXPIRES_IN` | Production, Preview | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Production, Preview | `7d` |
| `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` | Production, Preview | `90d` |
| `UPSTASH_REDIS_REST_URL` | Production, Preview | from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Production, Preview | from Upstash |
| `FIREBASE_PROJECT_ID` | Production, Preview | from Firebase |
| `FIREBASE_CLIENT_EMAIL` | Production, Preview | from Firebase |
| `FIREBASE_PRIVATE_KEY` | Production, Preview | from Firebase (raw key) |
| `BREVO_API_KEY` | Production | from Brevo |
| `BREVO_SENDER_EMAIL` | Production | `noreply@genesis.com` |
| `BREVO_SENDER_NAME` | Production | `Genesis HR` |
| `CRON_SECRET` | Production | generated 64-char hex |
| `NEXT_PUBLIC_APP_URL` | Production | `https://your-domain.vercel.app` |
| `SEED_ADMIN_EMAIL` | Production | admin email (temporary) |
| `SEED_ADMIN_PASSWORD` | Production | strong password (temporary) |

**Do NOT set:** `NODE_ENV`, `VERCEL_URL`, `VERCEL_ENV`, `JWT_REFRESH_SECRET`

---

### Step 7 — Seed Admin

After Vercel environment variables are set and first deployment is live:

```bash
# From apps/admin/ directory, against production database
npx tsx scripts/seed-settings.ts   # Note: currently unimplemented (stub) — skip if so
npx tsx scripts/seed-admin.ts
```

Or trigger via Vercel CLI pointing at production env:
```bash
vercel env pull .env.production.local
npx tsx scripts/seed-admin.ts
```

**Post-seed checklist:**
- [ ] Log in to admin portal with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
- [ ] Confirm dashboard loads
- [ ] **Immediately remove** `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` from Vercel environment variables
- [ ] Change admin password from the initial value via Settings → Change Password
- [ ] Confirm login still works with new password

> **Warning:** `seed-settings.ts` is currently a stub (`throw new Error('Not implemented')`). If company settings (working days, shifts, geofence) are required before employees can use the app, this script must be implemented first or settings must be seeded manually via the admin portal.

---

### Step 8 — Deployment

```bash
# From repo root — push to main triggers Vercel auto-deploy
git push origin main
```

Or manually via Vercel CLI:
```bash
vercel --prod
```

**Verify build output includes:**
```
✓ Compiled successfully
ƒ Proxy (Middleware)                        — auth middleware active
ƒ /admin/cron/session-auto-close            — cron handler compiled
ƒ /admin/cron/leave-year-allocation         — cron handler compiled
ƒ /admin/cron/leave-carryforward-expiry     — cron handler compiled
```

If `ƒ Proxy (Middleware)` is absent, auth is not active — investigate `proxy.ts`.

---

### Step 9 — Post-Deployment Verification

#### Immediate (within 1 hour)

- [ ] `GET https://your-domain.vercel.app/api/v1/health` → 200 `{"success":true}`
- [ ] Admin portal loads at `https://your-domain.vercel.app/login`
- [ ] Admin login succeeds → dashboard visible
- [ ] Vercel Dashboard → Cron Jobs tab → 3 jobs listed
- [ ] MongoDB Atlas → Metrics → verify connection established
- [ ] `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` removed from Vercel env vars
- [ ] Admin password changed from initial value

#### Within 24 hours

- [ ] Trigger password reset → email arrives (Brevo delivery confirmed)
- [ ] Send test FCM notification via Firebase Console → Cloud Messaging
- [ ] Monitor Atlas connection count (should stay ≤ 10 per function invocation)
- [ ] Check Vercel Function logs for any errors

---

## Testing Checklist

| # | Test | Endpoint / Action | Expected | Pass |
|---|------|-------------------|----------|------|
| 1 | Backend health | `GET /api/v1/health` | 200 `{success:true}` | [ ] |
| 2 | Admin login | `POST /api/v1/auth/login` `{email,password}` | 200 + `{accessToken,refreshToken,sessionId}` + `__session` cookie | [ ] |
| 3 | Employee login | `POST /api/v1/auth/login` `{email,password,deviceFingerprint}` | 200 + tokens | [ ] |
| 4 | Token refresh | `POST /api/v1/auth/refresh` `{refreshToken,sessionId}` | 200 + new `accessToken` | [ ] |
| 5 | Attendance check-in | `POST /api/v1/attendance/checkin` with Bearer token | 200 | [ ] |
| 6 | Leave submit | `POST /api/v1/leaves` with Bearer token | 201 + push notification triggered | [ ] |
| 7 | Regularization submit | `POST /api/v1/regularizations` | 201 | [ ] |
| 8 | Payroll compute | `POST /api/v1/payroll/compute` (admin) | 200 | [ ] |
| 9 | Notifications list | `GET /api/v1/notifications` | 200 + `{data:[],meta:{...}}` | [ ] |
| 10 | FCM token register | `POST /api/v1/notifications/fcm-token` `{token,deviceId,platform}` | 200 `{message:"FCM token registered."}` | [ ] |
| 11 | Reports attendance | `GET /api/v1/reports/attendance` (admin) | 200 + data | [ ] |
| 12 | Admin portal UI | Browser → `/login` → submit credentials → `/dashboard` | Dashboard renders | [ ] |
| 13 | Cron auth valid | `GET /admin/cron/session-auto-close` `Authorization: Bearer <CRON_SECRET>` | 200 | [ ] |
| 14 | Cron auth invalid | Same without header | 401 | [ ] |
| 15 | Password reset email | `POST /api/v1/auth/password-reset/request` `{email}` | 200 + email arrives | [ ] |
| 16 | Rate limiter | 11 rapid `POST /api/v1/auth/login` requests | 11th → 429 `{code:"GEN_003"}` | [ ] |
| 17 | Unauthorized access | `GET /api/v1/notifications` without token | 401 `{code:"AUTH_003"}` | [ ] |
| 18 | Session persistence | Admin login → refresh page → still logged in | Redirect to dashboard (not login) | [ ] |

---

## Mobile Build Prerequisites

Not part of backend deployment. For reference when building the APK/AAB:

```bash
# Debug build (development)
flutter build apk --debug \
  --dart-define=API_BASE_URL=https://your-domain.vercel.app

# Release build (Play Store submission)
flutter build appbundle --release \
  --dart-define=API_BASE_URL=https://your-domain.vercel.app

# iOS release (App Store)
flutter build ipa --release \
  --dart-define=API_BASE_URL=https://your-domain.vercel.app
```

**Prerequisite not yet complete:** Android release signing keystore (C2 from audit — separate task). Release builds currently use debug keystore and will be rejected by Play Store.

---

## Environment Variable Audit: Unused / Dead Variables

| Variable | Status | Action |
|----------|--------|--------|
| `JWT_REFRESH_SECRET` | **Dead** — in `.env.example` but never read by any source file | Remove from `.env.example`; do not set in Vercel |
| `ADMIN_EMAIL` | **Wrong name** — `.env.example` uses this but seed script reads `SEED_ADMIN_EMAIL` | Update `.env.example` to use correct name |
| `ADMIN_INITIAL_PASSWORD` | **Wrong name** — seed script reads `SEED_ADMIN_PASSWORD` | Update `.env.example` to use correct name |

---

## Go / No-Go Decision

| Infrastructure Item | Required | Status | Blocker |
|--------------------|----------|--------|---------|
| MongoDB Atlas M10+ cluster | YES | PENDING | YES |
| MongoDB connection string | YES | PENDING | YES |
| `JWT_SECRET` (64+ bytes) | YES | PENDING | YES |
| `CRON_SECRET` (32+ bytes) | YES | PENDING | YES |
| Upstash Redis instance | YES | PENDING | YES |
| Firebase Admin SDK credentials | YES | PARTIAL (project exists, credentials not set in Vercel) | YES |
| Firebase mobile config | YES | READY (flutterfire done) | — |
| Brevo account + verified sender | YES | PENDING | YES |
| Vercel project created | YES | PENDING | YES |
| Vercel env vars set | YES | PENDING | YES |
| Admin seeded | YES | PENDING (requires Atlas + Vercel first) | YES |

```
╔══════════════════════════════════════════════════════════════════════╗
║                                                                      ║
║                         NO-GO                                        ║
║                                                                      ║
║  Infrastructure provisioning not complete.                           ║
║  5 of 6 providers unprovisioned.                                     ║
║                                                                      ║
║  Complete Steps 1–7 in order, then re-verify.                       ║
║                                                                      ║
║  Code is deployment-ready:                                           ║
║    Backend:  lint 0 · tsc 0 · build ✅ · 286/286 tests              ║
║    Mobile:   analyze 0 · 97/97 tests · Firebase wired ✅             ║
║                                                                      ║
║  READY FOR INFRASTRUCTURE SETUP — NOT READY FOR DEPLOYMENT           ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

*Infrastructure Setup Guide created: 2026-06-22*
*Do not modify code. Do not deploy. Wait for approval.*
