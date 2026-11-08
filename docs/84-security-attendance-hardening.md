# 84 — Security, Attendance and Test Hardening (2026-11-08)

Status: **local changes, not committed, not deployed.** Nothing in this document
has been verified against production, a real database, Redis, Brevo or Firebase.

---

## 1. Test isolation (new)

| Layer | File | What it does |
|---|---|---|
| Environment sanitiser | `apps/admin/jest.env.ts` (`setupFiles`) | Overwrites `MONGODB_URI`, Upstash, Brevo, JWT, cron and app-URL settings with inert dummies (`*.invalid` hosts); removes `JWT_SECRET_PREVIOUS`, Firebase, Google Maps, Blob and proxy variables; sets `GEOCODING_PROVIDER=disabled`. Runs before any app module, so a real `.env.local` can never be used by tests. |
| Network guard | `apps/admin/jest.network-guard.ts` (`setupFiles`) | Blocks `fetch`, `http(s).request/get` and raw TCP/TLS (`net.Socket#connect`) — **including loopback**, so a MongoDB/Redis/dev server on the laptop is unreachable. A test that starts its own isolated server must allow that exact port. |
| Default mocks | `apps/admin/jest.setup.ts` | `connectDB()` fails fast unless a test simulated/created a connection; `mongoose.set('bufferCommands', false)` so unmocked model calls fail immediately; Brevo, Firebase Admin and Upstash Redis are mocked. |
| Proof | `src/__tests__/guards/test-isolation.test.ts` | 12 tests proving each guard. |

Note: a test file's own `jest.mock()` does **not** reliably override the setup-file
mocks under next/jest. Use `jest.requireActual()` (see `__tests__/email/brevo.test.ts`).

---

## 2. Security changes

### 2.1 Authorization (server-side)
* **Policy (documented assumption):** HR data — attendance of others, leave,
  regularization, payroll, reports, devices, audit logs, settings — is visible to
  `admin` and `super_admin` only. `employee`, `manager` and `executive` see only
  their **own** records. No existing document grants managers/executives access to
  other employees' HR data; the proxy page map already limited HR pages to these
  two roles.
* Leave `list`/`getById`/`balance` and regularization `list`/`getById` were scoped
  only for `role === 'employee'`; managers/executives could read everyone's. Fixed.
* 62 HR route files checked `role === 'admin'` only, denying `super_admin` (who can
  open those pages). Now `isAttendanceAdmin()` / `assertAttendanceAdmin()`.
* Role-check failures in some routes (e.g. `GET /payroll`, `/reports/*`) escaped as
  **HTTP 500**; `AuthError` now extends `AppError`, so they are proper 401/403.
* Employees see only **finalised** payroll (`/payroll/me*`); drafts are admin
  working copies (assumption: "payslip" in the API spec means finalised).
* Invalid ObjectIds on regularization/leave lookups return 404 instead of a 500.

### 2.2 JWT keys
* Shared verifier `src/lib/auth/jwt.ts` (routes **and** proxy).
* `JWT_SECRET_PREVIOUS` is honoured only with `JWT_SECRET_PREVIOUS_EXPIRES_AT`
  ≤ 24 h in the future, only on a signature failure, never for expired tokens,
  never when equal to the current key. Algorithm pinned to HS256.
* **Never configure an exposed key as `JWT_SECRET_PREVIOUS`.** Docs 49 and 77 were
  corrected — doc 77 previously recommended exactly that.

### 2.3 Sessions and refresh tokens
* **`JWT_REFRESH_SECRET` was not used by the code before this change.** Refresh
  tokens are random 256-bit values; only their SHA-256 is stored in `DeviceSession`.
* **Rotation:** every successful refresh issues a new refresh token
  (`data.refreshToken`). Mobile already stored it. On the web, the proxy and the
  refresh route keep the HttpOnly `__rt` cookie current, and the browser client now
  refreshes with an empty body so the server uses that cookie (same-origin only) —
  a JavaScript-held copy would go stale after the proxy rotates the token.
* Known limit: the proxy's server-side refresh call carries no client IP, so on
  Vercel all proxy refreshes share one per-IP bucket (120/min). Fine for the small
  number of web admins; revisit if web usage grows.
* **Retry grace (1 h):** presenting the token that was just rotated out returns the
  *same* current token (idempotent) — covers lost responses and the web proxy +
  browser refreshing at once. The retry copy is AES-256-GCM-encrypted with a key
  derived from `JWT_REFRESH_SECRET` (falls back to `JWT_SECRET`); only hashes are
  used for lookup.
* **Reuse detection:** presenting a rotated-out token **after** the grace window
  revokes the session (`revokedReason: refresh-reuse`) and writes
  `AUTH_REFRESH_REUSE_DETECTED` to the audit log.
* **Unavoidable session impact:** a mobile client that loses a refresh response and
  retries more than 1 hour later is signed out once. Older app builds that ignore
  `refreshToken` keep working only until the first rotation's grace expires, then
  must sign in again (current app builds store it).
* Deactivated users: refresh revokes the session and returns `AUTH_007`.
* **Change password** now accepts optional `sessionId`; that session (if owned and
  live) stays signed in, all others are revoked, outstanding reset/invite links are
  invalidated, and a fresh `__session` cookie is set. Web and mobile send it.
  Without `sessionId` all sessions are revoked and the message says so (the old
  message claimed "other devices" while also revoking the caller's own session).
* Remaining limitation: access tokens are stateless (15 min). After deactivation,
  role change, logout or password change, an already-issued access token remains
  valid for up to 15 minutes.

### 2.4 Login
* Password verified **before** account status: `AUTH_007` (deactivated) is only
  revealed to someone who knows the password; unknown e-mails spend a dummy bcrypt
  comparison (timing). E-mail normalised to lower case.

### 2.5 Password reset and invites
* Lookup by **token hash** (previously "latest unused token for this e-mail", which
  let an older link become valid again after the newest was used).
* Requesting a reset invalidates all older unused reset/invite links.
* Atomic single use: conditional claim inside the transaction; concurrent
  confirmations → exactly one succeeds. All other links invalidated, all sessions
  revoked (`password-reset`).
* Deactivated accounts: no reset e-mail, outstanding links rejected.
* Raw request IP no longer stored on the token (HMAC hash).
* Wording verified: reset e-mail says 15 minutes (TTL 15 min); invite says 24 hours
  (TTL 24 h); reset page explains both.
* E-mail failure is swallowed (generic response kept) and logged without the link.

### 2.6 CSRF / CORS
* `getAuthUser()` falls back to the `__session` cookie (the old CSRF note claiming
  there was no cookie-only path was wrong). For cookie-authenticated
  `POST/PUT/PATCH/DELETE`, an `Origin` (or `Referer`) from the app's own origin,
  `NEXT_PUBLIC_APP_URL` or `ALLOWED_ORIGINS` is now required, and
  `Sec-Fetch-Site: cross-site` is rejected → `403 AUTH_012`. Bearer-token clients
  (mobile) are unaffected. No CORS allow headers are sent (unchanged).

### 2.7 Rate limiting
* Login keyed by `ip|email` (10/min) + per account (20/15 min) + per IP (100/min):
  colleagues behind one office IP no longer lock each other out.
* Change password per **user**; reset-confirm per IP; refresh per IP (120/min) and
  per session (10/min).
* **Redis outage:** falls back to an in-memory limiter with the same limits instead
  of failing open (per instance — weaker, not disabled). The reset-request route no
  longer 500s when Redis is down.
* 429 responses are generic and carry `Retry-After`.

### 2.8 Client IP
* Vercel docs ("Request headers") state Vercel overwrites `X-Forwarded-For` /
  `X-Real-IP` and does not forward external values. On Vercel (`VERCEL=1`) the
  app uses `x-vercel-forwarded-for`, then `x-real-ip`, then XFF; values must parse
  as IP addresses. Elsewhere forwarded headers are ignored unless
  `TRUST_PROXY_HEADERS=true`; otherwise the IP is `unknown` and office-IP
  attendance **denies** (fail closed).
* **Deployment check (owner):** confirm no CDN/proxy sits in front of Vercel; if
  one is added, re-verify before relying on office-IP attendance.

### 2.9 Other
* Fire-and-forget notification calls had no `.catch` → unhandled rejections on DB
  errors; fixed (`logNotificationFailure`, logs only the error class).
* Check-in audit log no longer duplicates the employee's coordinates.
* Cron secret compared in constant time.

---

## 3. Attendance and related workflows

| Area | Change |
|---|---|
| Checkout device binding | Checkout now requires the registered device's `X-Device-Fingerprint` (mobile already sends it on every request) — `AUTH_004`/`AUTH_005`. Deactivated → `AUTH_007`. |
| Checkout GPS | For ordinary employees under an **enabled geofence**, missing coordinates → **`422 ATT_010`** ("Location is required…"); accuracy above threshold → `ATT_002`; outside → `ATT_001`. Remote/override employees, office-IP mode and a disabled geofence still allow checkout without GPS, but the checkout is recorded with `isWithinGeoFence:false`, `locationProvided:false` (never "inside"). |
| Error codes | Office-network denial is now **`ATT_009`** (was `ATT_004`, which also means "nonce already used" — mobile showed "not on office network" for replays). `ATT_010` chosen because `ATT_008` is already used by the location-snapshot route. |
| Concurrency | Checkout closes the session with a conditional update (`isActive:true`) and adds minutes with `$inc` inside the transaction → duplicate/concurrent checkouts count once. |
| Nonce | Checkout nonce consumed after cheap validation (a GPS failure no longer burns it); replay still blocked by the unique index. |
| Timestamps | Unparseable client timestamps were accepted (NaN comparison); now `ATT_007`. |
| Forgotten checkouts | **SUPERSEDED by docs/85 (24-hour missed check-out rule).** The work-end crediting described here was removed: no punch-out or minutes are fabricated any more. |
| Cron | (Behaviour of the session job now per docs/85.) Vercel invokes crons with **GET** + `Authorization: Bearer <CRON_SECRET>`; routes exported only POST. All three now export GET and POST (same authenticated handler). Vercel documents possible duplicate delivery; auto-close is now idempotent per session. **Not verified:** whether production crons actually failed — check the Vercel Cron Jobs log (owner). |
| Regularization | Approve/reject/withdraw are conditional on `status:'pending'` (approve claims inside its transaction) — concurrent reviewer/employee actions: exactly one wins, no duplicate synthetic sessions. |
| Leave | Approve/revoke/withdraw claim the state inside the transaction; cancel/reject are conditional updates — prevents double balance deduction/restoration. |
| Mobile withdraw | App called `PATCH /regularizations/:id/cancel` (no such route → 404). Now `/withdraw`. |

### Remote attendance / location snapshots (reviewed, not changed)
* Snapshot creation requires the caller's **own** active **remote** session; list
  and map endpoints are HR-admin only.
* Snapshots are sent **only while the app is open** (60-minute foreground timer).
  There is no background tracking and none was added.
* **Privacy decisions outstanding (owner):**
  1. `GEOCODING_PROVIDER` defaults to **nominatim** — employee coordinates go to the
     public OpenStreetMap service (subject to its usage policy). Choose `google`
     (with a DPA), `disabled`, or keep with explicit sign-off.
  2. `LocationSnapshot` has **no retention/TTL**; define a retention period.

---

## 4. Contract changes for clients

| Endpoint | Change |
|---|---|
| `POST /auth/refresh` | Response adds `refreshToken` (rotated); also sets `__rt`. |
| `PATCH /auth/me/change-password` | Optional `sessionId`; response adds `currentSessionKept`; sets `__session`. |
| `POST /attendance/checkout` | Requires `X-Device-Fingerprint`; requires `latitude/longitude/accuracy` for ordinary geofence employees (`ATT_010`). |
| Check-in / checkout | Office network denial `ATT_009` (was `ATT_004`). |
| Cookie-auth mutations | Cross-origin → `403 AUTH_012`. |
| `GET /payroll/me*` | Finalised records only. |
| Cron paths | Accept GET and POST. |

---

## 5. Owner actions (not performed — require real accounts)

1. **Rotate every credential listed in doc 49** (MongoDB user/password, JWT_SECRET,
   JWT_REFRESH_SECRET, Upstash token, Firebase service-account key, Brevo key,
   CRON_SECRET, Google Maps key if any). Actual rotation status is **unknown**.
2. Leave `JWT_SECRET_PREVIOUS` **unset** for this incident rotation.
3. After rotating the database credentials, decide whether to revoke all existing
   `DeviceSession` documents (forces every user to sign in again).
4. Review provider logs for misuse during the exposure window: MongoDB Atlas access
   logs, Upstash, Brevo sending logs, Firebase/GCP audit logs, Vercel logs.
5. Git history still contains the exposed values; follow doc 77 §history rewrite
   (`git filter-repo`) **only** after rotation, coordinate re-clones, and ask
   GitHub to purge cached views if the repo was ever public. Rotation, not history
   rewriting, is what makes the old values harmless.
6. Check Vercel Cron Jobs logs for 405/401 responses before and after deploying.
7. Confirm no proxy/CDN in front of Vercel (client-IP trust, §2.8).
8. Decide geocoding provider and snapshot retention (§3).
9. Fix the uncommitted `gradle-wrapper.properties` change (Gradle 9.7.1 is
   incompatible with the project's AGP 8 — the debug APK build fails with it).

---

## 6. Verification performed (local only)

See the session report for exact counts. Summary: web unit/route tests, type-check
and lint run in isolation; Flutter analyze and tests run; real-database
concurrency tests exist (`src/__tests__/integration/db-concurrency.test.ts`) and run
only when a checksum-verified local MongoDB binary is supplied via
`MONGOMS_SYSTEM_BINARY` — otherwise they are reported as skipped.

Not tested: real Atlas/Redis/Brevo/Firebase, Vercel deployment and cron delivery,
physical-device GPS behaviour, browsers' actual Origin behaviour on the deployed
domain, mobile release build.
