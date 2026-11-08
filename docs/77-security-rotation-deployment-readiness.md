# Phase 18.00 — Security Rotation and Deployment Readiness

**Date:** 2026-07-09
**Scope:** Secret rotation tracking, local verification, production readiness
**Rules:** No secret values printed. No rotation performed automatically. No commits/pushes.

---

## Executive Summary

Real credentials were found in two committed files on the public GitHub remote:
- `apps/admin/.env.local` — added in commit `9b941a9`, removed in `4cc4b8d`. Still accessible via git history.
- `apps/admin/.env.example` — contained real values from `5bf3a15` through `4cc4b8d`. Sanitized locally (not yet committed).

Root `.gitignore` had `!.env.local` exception allowing accidental future commits. Fixed locally (not yet committed).

All DIAG logs removed. No test routes remain. Static checks pass. APK build in progress.

**Deployment readiness decision: NOT READY** — secret rotation required before production push.

---

## Exposed Secret Categories (no values printed)

| # | Category | Env Var(s) | Found In | Rotation Priority |
|---|---|---|---|---|
| 1 | MongoDB Atlas user+password | `MONGODB_URI` | `.env.example` HEAD, `.env.local` history | P0 |
| 2 | JWT signing secret | `JWT_SECRET` | `.env.example` HEAD, `.env.local` history | P0 |
| 3 | JWT refresh secret | `JWT_REFRESH_SECRET` | `.env.example` HEAD, `.env.local` history | P0 |
| 4 | Upstash Redis REST token | `UPSTASH_REDIS_REST_TOKEN` | `.env.example` HEAD, `.env.local` history | P0 |
| 5 | Upstash Redis URL | `UPSTASH_REDIS_REST_URL` | `.env.example` HEAD, `.env.local` history | P0 |
| 6 | Firebase service account private key | `FIREBASE_PRIVATE_KEY` | `.env.example` HEAD, `.env.local` history | P0 |
| 7 | Firebase service account email | `FIREBASE_CLIENT_EMAIL` | `.env.example` HEAD, `.env.local` history | P1 |
| 8 | Firebase project ID | `FIREBASE_PROJECT_ID` | `.env.example` HEAD, `.env.local` history | P2 (not a secret) |
| 9 | Brevo API key | `BREVO_API_KEY` | `.env.example` HEAD, `.env.local` history | P0 |
| 10 | Cron secret | `CRON_SECRET` | `.env.example` HEAD, `.env.local` history | P0 |
| 11 | Seed admin email | `SEED_ADMIN_EMAIL` | `.env.example` HEAD, `.env.local` history | P2 |
| 12 | Seed admin initial password | `SEED_ADMIN_INITIAL_PASSWORD` | `.env.local` history (was blank) | P2 |
| 13 | Brevo sender email | `BREVO_SENDER_EMAIL` | `.env.example` HEAD | P3 (not a credential) |

---

## Phase A — Current State Audit Results

| Check | Result |
|---|---|
| Working tree (git status) | 2 modified files only: `.gitignore`, `apps/admin/.env.example` |
| `.env.local` ignored | YES — both `apps/admin/.gitignore` and root `.gitignore` ignore it |
| `.env.local` tracked in HEAD | NO — `git ls-files` confirms not tracked |
| `.env.example` placeholders | YES — 11 placeholder lines, zero real credential values |
| `[DIAG]` logs in source | NONE — `apps/` fully clean |
| Test routes in proxy | NONE — PUBLIC_PATHS contains only legitimate auth paths |
| Test API route files | NONE — payroll grep match was `.test()` regex call (false positive) |
| Stale dev server processes | NONE — node PIDs are Claude MCP + Adobe CC (unrelated) |
| TypeScript check (`tsc --noEmit`) | PASS — zero errors |
| Flutter analyze | PASS — no issues (ran 3.8s) |
| APK build (`flutter build apk --debug`) | PASS — `build/app/outputs/flutter-apk/app-debug.apk` |

---

## Phase B — Rotation Checklist

### 1. MongoDB Atlas — DB user password

- **Where to rotate:** https://cloud.mongodb.com → Database Access → find the db user → Edit → Autogenerate Secure Password → Save
- **Local env var:** `MONGODB_URI` in `apps/admin/.env.local` — replace the `<user>:<password>` segment in the URI with new credentials
- **Vercel env var:** `MONGODB_URI` — update under Project → Settings → Environment Variables
- **Expected behavior after rotation:** Existing connections drop on next reconnect. App reconnects automatically. Cold-start will use new URI immediately.
- **Verify (no value print):** `curl -s http://localhost:3000/api/v1/auth/me -H "Authorization: Bearer <valid-token>" | grep -v password` → 200 response means DB connected. Check admin portal loads employees list.
- **Operator status:** ☐ NOT DONE

---

### 2. JWT_SECRET

- **Where to rotate:** Generate locally: `openssl rand -hex 64`
- **Local env var:** `JWT_SECRET` in `apps/admin/.env.local`
- **Vercel env var:** `JWT_SECRET` — update in Vercel project settings
- **Do NOT set the exposed value as `JWT_SECRET_PREVIOUS`.** *(Corrected 2026-11-08, see doc 84.)* The old key is the compromised key: trusting it during a "grace period" lets anyone holding it keep minting valid access tokens. For an incident rotation leave `JWT_SECRET_PREVIOUS` **unset**.
- `JWT_SECRET_PREVIOUS` exists only for *routine, non-compromise* rotation. Since doc 84 it is honoured only when `JWT_SECRET_PREVIOUS_EXPIRES_AT` is also set to a timestamp ≤ 24 h in the future, and it never rescues expired tokens.
- **Expected behavior after rotation:** Access tokens (15-minute JWTs) signed with the old key stop working immediately. Refresh sessions are stored in MongoDB and are **not** derived from `JWT_SECRET`, so signed-in mobile/web users silently obtain a new access token and are **not** logged out. If you also want to end every existing session (recommended when the database credentials were exposed), that is a separate owner action — see doc 84 §Owner actions.
- **Verify:** Login with admin credentials → 200 with `accessToken` → make authenticated API call → succeeds.
- **Operator status:** ☐ NOT DONE

---

### 3. JWT_REFRESH_SECRET

- **Where to rotate:** Generate locally: `openssl rand -hex 64` (different value from JWT_SECRET)
- **Local env var:** `JWT_REFRESH_SECRET` in `apps/admin/.env.local`
- **Vercel env var:** `JWT_REFRESH_SECRET`
- **Expected behavior (corrected 2026-11-08, see doc 84):** Until doc 84 this variable was **not used by the code at all** — refresh tokens are random values whose SHA-256 hashes are stored in `DeviceSession`; they were never signed with this secret, so rotating it did **not** invalidate anything. Since doc 84 it is used only to encrypt the short-lived "retry copy" of a just-rotated refresh token (1-hour grace window). Rotating it now only affects a client that lost a refresh response in the last hour (that client must sign in again). Still rotate it, because the old value was exposed.
- **Verify:** After login, wait for access token expiry (15 min) or test refresh endpoint → new access token issued.
- **Operator status:** ☐ NOT DONE

---

### 4. Upstash Redis — REST token

- **Where to rotate:** https://console.upstash.com → select database → Details tab → Reset Token
- **Local env var:** `UPSTASH_REDIS_REST_TOKEN` in `apps/admin/.env.local`. Also confirm `UPSTASH_REDIS_REST_URL` still matches (URL doesn't change on token reset).
- **Vercel env var:** `UPSTASH_REDIS_REST_TOKEN`
- **Expected behavior:** Old token rejected by Upstash immediately. App rate-limiter reconnects using new token on next request. No downtime if env var updated before restart.
- **Verify:** Hit `POST /api/v1/auth/password-reset/request` with a test email → returns 200 (always-OK) without server error → Redis rate-limit store functioning.
- **Operator status:** ☐ NOT DONE

---

### 5. Firebase service account private key

- **Where to rotate:**
  1. https://console.firebase.google.com → Project Settings → Service Accounts → Generate new private key → Download JSON
  2. In Google Cloud IAM (https://console.cloud.google.com → IAM → Service Accounts → find `firebase-adminsdk-fbsvc@...` → Keys tab) → Delete the old key
- **Local env var:** `FIREBASE_PRIVATE_KEY` and `FIREBASE_CLIENT_EMAIL` in `apps/admin/.env.local` — extract from downloaded JSON, set key as single-line with literal `\n` for newlines
- **Vercel env var:** `FIREBASE_PRIVATE_KEY` and `FIREBASE_CLIENT_EMAIL`
- **Expected behavior:** Old key rejected by Google APIs immediately after deletion. New key active immediately. FCM send uses Admin SDK which re-initializes on app restart.
- **Verify:** Trigger a test regularization approval via admin → employee mobile device receives FCM push notification.
- **Operator status:** ☐ NOT DONE

---

### 6. Brevo API key

- **Where to rotate:** https://app.brevo.com → SMTP & API → API Keys → Delete old key → Create new key with same permissions
- **Local env var:** `BREVO_API_KEY` in `apps/admin/.env.local`
- **Vercel env var:** `BREVO_API_KEY`
- **Expected behavior:** Old key rejected by Brevo API immediately. New key active immediately.
- **Verify:** Submit forgot-password request via admin login page with a real email → check inbox for reset email → email received = Brevo working.
- **Operator status:** ☐ NOT DONE

---

### 7. CRON_SECRET

- **Where to rotate:** Generate locally: `openssl rand -hex 32`
- **Local env var:** `CRON_SECRET` in `apps/admin/.env.local`
- **Vercel env var:** `CRON_SECRET`
- **Expected behavior:** Vercel cron jobs send `Authorization: Bearer <CRON_SECRET>`. Cron routes reject any bearer token that doesn't match. Update Vercel before next cron trigger.
- **Verify:** `curl -s http://localhost:3000/api/v1/cron/<route> -H "Authorization: Bearer wrongsecret"` → 401. Then with correct bearer → 200 or expected cron response.
- **Operator status:** ☐ NOT DONE

---

### 8. User password shared in chat

- **Scope:** Review whether any admin or employee account password was typed directly into a chat message during this or prior sessions.
- **Where to rotate:** Admin panel → Employees → select user → change password. Or admin's own account via change-password flow.
- **Transcript reference:** `C:\Users\Sarvesh\.claude\projects\D--projects-Company\d775a917-4afa-4a18-8ee3-e0da9077aa6b.jsonl`
- **Operator status:** ☐ PENDING OPERATOR REVIEW

---

## Phase C — Local Verification Plan (after each rotation)

Run after operator confirms each secret is rotated and `.env.local` updated. Restart dev server between each.

```bash
# restart dev server
cd apps/admin && npm run dev
```

| Service | Verification command / action | Expected result |
|---|---|---|
| MongoDB | Load `http://localhost:3000` → navigate to Employees | Employee list loads without DB error |
| JWT | Login with valid credentials | 200 + `accessToken` in response |
| JWT refresh | After login, call `POST /api/v1/auth/refresh` with refresh token | New `accessToken` issued |
| Upstash | `POST /api/v1/auth/password-reset/request` with any email | 200 (always-OK), no Redis error in server log |
| Firebase | Approve a regularization request via admin | Employee device receives FCM push notification |
| Brevo | Submit forgot-password for real email | Password reset email received in inbox |
| CRON_SECRET | `curl .../api/v1/cron/... -H "Authorization: Bearer WRONG"` | 401 Unauthorized |

---

## Phase D — Production / Vercel Readiness Checklist

### Pre-deploy requirements

- [ ] All P0 secrets rotated (7 categories above)
- [ ] All rotated secrets set in Vercel Production environment variables
- [ ] `apps/admin/.env.example` sanitized commit merged (Commit A)
- [ ] Root `.gitignore` fix committed (Commit A, same commit)
- [ ] Git history rewrite (`git filter-repo`) performed OR acknowledged as deferred risk

### Vercel environment variables — full set required

| Env Var | Source | Set in Vercel? |
|---|---|---|
| `MONGODB_URI` | MongoDB Atlas connection string | ☐ |
| `JWT_SECRET` | Generated 64-char hex | ☐ |
| `JWT_REFRESH_SECRET` | Generated 64-char hex (different) | ☐ |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | ☐ |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | ☐ |
| `JWT_REFRESH_ABSOLUTE_EXPIRES_IN` | `90d` | ☐ |
| `UPSTASH_REDIS_REST_URL` | Upstash console | ☐ |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash console (rotated) | ☐ |
| `FIREBASE_PROJECT_ID` | Firebase project settings | ☐ |
| `FIREBASE_CLIENT_EMAIL` | New service account JSON | ☐ |
| `FIREBASE_PRIVATE_KEY` | New service account JSON | ☐ |
| `BREVO_API_KEY` | Brevo API console (rotated) | ☐ |
| `BREVO_SENDER_EMAIL` | Brevo sender identity | ☐ |
| `BREVO_SENDER_NAME` | `Genesis HR` | ☐ |
| `CRON_SECRET` | Generated 32-char hex | ☐ |
| `NEXT_PUBLIC_APP_URL` | Production URL | ☐ |

### Production smoke tests (post-deploy)

- [ ] `GET https://<prod-url>/health` → 200 (if health endpoint is public) or check Vercel function logs
- [ ] Admin login → 200 + session established
- [ ] Employee list loads (confirms DB connection)
- [ ] Forgot-password email received (confirms Brevo)
- [ ] Regularization approval → FCM push on device (confirms Firebase)
- [ ] Rate-limit check: 6+ rapid forgot-password requests blocked (confirms Upstash)
- [ ] No `[DIAG]` output in Vercel function logs
- [ ] No `.env.local` committed (confirm via `git ls-files *env.local`)
- [ ] Cron endpoint rejects wrong bearer (confirms CRON_SECRET)

---

## Commit Plan (pending operator approval)

### Commit A — Security hygiene

**Files:**
```
.gitignore
apps/admin/.env.example
```

**Message:**
```
security: sanitize .env.example credentials, harden root .gitignore

Replace real credentials in .env.example with safe placeholders.
Root .gitignore had !.env.local exception that allowed accidental commits;
replaced with explicit .env.local + .env.*.local ignore rules.
```

**Safe to commit before rotation:** YES  
**Safe to push before rotation:** YES (removes live HEAD exposure; history exposure pre-dates this commit)

### Optional Commit B — Git history rewrite (after rotation)

```bash
pip install git-filter-repo
git filter-repo --path apps/admin/.env.local --invert-paths --force
git filter-repo --path apps/admin/.env.example --invert-paths --force
# Re-add clean .env.example
git add apps/admin/.env.example && git commit -m "security: add sanitized .env.example after history rewrite"
git push --force-with-lease origin master
```

**Risk:** Rewrites all commit hashes. Anyone with a local clone must re-clone. Do this only if the repo must be kept and old secrets cannot be treated as rotated-therefore-safe.

---

## Remaining Blockers

| Blocker | Severity | Required Before Push | Required Before Production |
|---|---|:---:|:---:|
| 7 P0 secrets not yet rotated | CRITICAL | NO | YES |
| `.env.example` sanitized but not committed | HIGH | YES | YES |
| Root `.gitignore` fix not committed | HIGH | YES | YES |
| Git history contains exposed secrets | HIGH | — | Acknowledged / deferred until rotation done |
| Vercel env vars not verified post-rotation | MEDIUM | — | YES |

---

## Readiness Decision

| Gate | Status |
|---|---|
| Static checks (TSC, flutter analyze) | PASS |
| APK build | PASS |
| DIAG logs removed | PASS |
| Test routes removed | PASS |
| `.env.example` sanitized locally | PASS (not committed) |
| `.gitignore` hardened locally | PASS (not committed) |
| Secret rotation | NOT DONE |
| Vercel env vars updated | NOT VERIFIED |

**Overall: NOT READY FOR PRODUCTION**  
Blocker: P0 secret rotation required. Commit A (hygiene) can be made at any time.
