# 04 — API Specification
**Workforce Management Platform — REST API v1**
Last updated: 2026-06-14
Base URL: `/api/v1`

---

## Table of Contents

1. [API Standards](#1-api-standards)
2. [Centralized Error Catalog](#2-centralized-error-catalog)
3. [Authentication](#3-authentication)
4. [Employee Management](#4-employee-management)
5. [Attendance](#5-attendance)
6. [Leave Management](#6-leave-management)
7. [Regularization](#7-regularization)
8. [Payroll](#8-payroll)
9. [Notifications](#9-notifications)
10. [Reports](#10-reports)
11. [Settings](#11-settings)
12. [Audit Logs](#12-audit-logs)
13. [Cron Endpoints (Internal)](#13-cron-endpoints-internal)
14. [TypeScript Schema Definitions](#14-typescript-schema-definitions)

---

## 1. API Standards

### 1.1 Route Handler Convention

All endpoints are implemented as Next.js App Router Route Handlers (`app/api/v1/**/route.ts`).

```typescript
// Canonical Route Handler pattern
export const dynamic = 'force-dynamic'; // disable Next.js GET caching for all API routes

export async function GET(request: NextRequest): Promise<Response> {
  // Edge Middleware validates JWT before this runs
  // Route Handler: parse → validate → call service → return ApiResponse
}
```

Route file locations follow the pattern:
```
src/app/api/v1/
  auth/
    login/route.ts
    refresh/route.ts
    logout/route.ts
    register-device/route.ts
    password-reset/
      request/route.ts
      confirm/route.ts
    me/route.ts
  employees/
    route.ts                        # GET (list), POST (create)
    [id]/
      route.ts                      # GET, PUT
      activate/route.ts             # PATCH
      deactivate/route.ts           # PATCH
      register-device/route.ts      # PATCH
      reset-device/route.ts         # PATCH
      attendance/route.ts           # GET (admin view)
  attendance/
    checkin/route.ts
    checkout/route.ts
    status/route.ts
    history/route.ts
    today/route.ts                  # admin all-employees today
    weekly/route.ts
    monthly/route.ts
  leaves/
    route.ts                        # GET (list), POST (apply)
    balance/route.ts
    pending/route.ts                # admin only
    [id]/
      route.ts                      # GET
      cancel/route.ts
      approve/route.ts
      reject/route.ts
      revoke/route.ts
  regularizations/
    route.ts                        # GET, POST
    pending/route.ts                # admin only
    [id]/
      route.ts
      withdraw/route.ts
      approve/route.ts
      reject/route.ts
  payroll/
    compute/route.ts
    route.ts                        # GET (admin list)
    me/route.ts                     # GET (employee own list)
    me/[yearMonth]/route.ts         # GET (employee own month)
    [id]/[yearMonth]/               # :id = MongoDB ObjectId (24-char hex) — not company employeeId
      route.ts                      # GET (admin)
      finalize/route.ts
      unfinalize/route.ts
      export/route.ts
  notifications/
    route.ts
    read-all/route.ts               # PATCH (bulk mark-read) — added R-API-001
    fcm-token/route.ts
    [id]/read/route.ts
  reports/
    attendance/route.ts
    attendance/export/route.ts
    leave/route.ts
    leave/export/route.ts
    payroll/export/route.ts
  settings/
    route.ts
    geofence/route.ts
    holidays/
      route.ts
      [id]/route.ts
  audit-logs/
    route.ts
    [id]/route.ts
  cron/
    midnight-session-close/route.ts
    leave-year-allocation/route.ts
    carry-forward-expiry/route.ts
    attendance-reminder/route.ts
```

---

### 1.2 Response Envelope

**Success (all non-paginated):**
```json
{
  "success": true,
  "data": { }
}
```

**Success (paginated list):**
```json
{
  "success": true,
  "data": [ ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

**Success (with advisory warnings):**
```json
{
  "success": true,
  "data": { },
  "warnings": [
    "Payroll for 2026-01 is finalised. Recomputation required."
  ]
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "code": "AUTH_001",
    "message": "Invalid email or password.",
    "details": { }
  }
}
```

`details` is optional. Used for field-level validation errors:
```json
{
  "details": {
    "email": "Must be a valid email address.",
    "password": "Must be at least 8 characters."
  }
}
```

---

### 1.3 Pagination

| Query Param | Type | Default | Max | Description |
|---|---|---|---|---|
| `page` | integer | `1` | — | 1-based page number |
| `limit` | integer | `20` | `100` | Records per page |

All list endpoints return `meta.total` (total matching records) and `meta.totalPages`.

---

### 1.4 Sorting

| Query Param | Type | Default | Description |
|---|---|---|---|
| `sortBy` | string | endpoint-specific | Field name to sort by |
| `sortOrder` | `asc` \| `desc` | `desc` | Sort direction |

Valid `sortBy` values documented per endpoint.

---

### 1.5 Date & Time Formats

| Format | Description | Example |
|---|---|---|
| `ISO 8601 UTC` | All stored timestamps | `2026-06-14T09:30:00.000Z` |
| `YYYY-MM-DD` | Date-only (IST date) | `2026-06-14` |
| `YYYY-MM` | Year-month | `2026-06` |
| `HH:mm` | Time-only (24h) | `09:30` |

All `dateString` values represent the IST local date derived from UTC timestamp + `companySettings.timezone`. All API responses return timestamps in UTC ISO 8601.

---

### 1.6 Authentication Headers

| Client | Token Transport | Header |
|---|---|---|
| Flutter app | Access token in bearer header | `Authorization: Bearer <accessToken>` |
| Admin portal | Access token in bearer header **or** httpOnly cookie | `Authorization: Bearer <accessToken>` |

Edge Middleware reads the token from `Authorization: Bearer` header (Flutter) or from the `__session` httpOnly cookie (admin portal). Both paths are supported simultaneously.

```typescript
// Edge Middleware token extraction order:
// 1. Authorization: Bearer <token>
// 2. Cookie: __session=<token>
```

---

### 1.7 CSRF Protection

CSRF applies only to cookie-based auth (admin portal).

| Condition | CSRF Check |
|---|---|
| Request has `Authorization: Bearer` header | Skipped (Bearer = non-browser = no CSRF risk) |
| Request reads token from `__session` cookie | `Origin` header must match `NEXT_PUBLIC_APP_URL` |

CSRF is enforced in Edge Middleware, not in Route Handlers. Route Handlers do not need to check CSRF.

---

### 1.8 Idempotency

| Header | Format | TTL | Scope |
|---|---|---|---|
| `X-Idempotency-Key` | UUID v4 | 24 hours | POST endpoints that create resources |

If the server has already processed a request with this key, it returns the original response without re-executing. Attendance checkin/checkout use the `nonce` field in the request body instead of `X-Idempotency-Key` (the nonce serves the same purpose with tighter security).

---

### 1.9 Versioning Strategy

- Current version: `v1` — prefix `/api/v1/`
- Future version deployment: `/api/v2/` runs in parallel (never in-place breaking change)
- Deprecated v1 endpoints include response header: `Sunset: <ISO date>`
- Clients should check for `Sunset` header and alert operators

---

### 1.10 Rate Limiters

Three distinct Upstash Redis rate limiters:

| Limiter | Applied To | Limit | Key |
|---|---|---|---|
| `authLimiter` | Login, password-reset request | 10 req / 1 min | Per IP |
| `attendanceLimiter` | Checkin, checkout | 60 req / 1 min | Per employee ID |
| `passwordResetLimiter` | Password reset request | 3 req / 1 hr | Per email **AND** per IP (dual-keyed) |

Password reset always returns HTTP 200 regardless of rate limit status (prevents enumeration). All other rate-limited endpoints return HTTP 429 with `GEN_003`.

---

### 1.11 Device Validation

Endpoints marked **Device Required** validate the `X-Device-Fingerprint` request header against the employee's registered device hash.

| Header | Required By | Description |
|---|---|---|
| `X-Device-Fingerprint` | Attendance checkin/checkout | SHA-256 of device hardware identifiers, hex-encoded |

The fingerprint is validated in the attendanceService before session creation. Mismatch → `AUTH_005`.

---

## 2. Centralized Error Catalog

Total: **40 error codes** across 7 namespaces.

### AUTH Namespace — Authentication & Authorization

| Code | Name | HTTP Status | Description |
|---|---|---|---|
| `AUTH_001` | `INVALID_CREDENTIALS` | 401 | Wrong email or password. Same response for both (prevents enumeration). |
| `AUTH_002` | `TOKEN_EXPIRED` | 401 | JWT access token or refresh session has expired. |
| `AUTH_003` | `TOKEN_INVALID` | 401 | JWT is malformed, signature invalid, or session is revoked. |
| `AUTH_004` | `DEVICE_NOT_REGISTERED` | 401 | Employee has no registered device on file. Admin must register one. |
| `AUTH_005` | `DEVICE_FINGERPRINT_MISMATCH` | 401 | Provided fingerprint does not match the registered device hash. |
| `AUTH_006` | `INSUFFICIENT_PERMISSIONS` | 403 | Authenticated user's role does not allow this operation. |
| `AUTH_007` | `ACCOUNT_DEACTIVATED` | 401 | Employee account is inactive (`isActive: false`). |
| `AUTH_008` | `PASSWORD_RESET_TOKEN_EXPIRED` | 400 | Password reset token has passed its TTL. |
| `AUTH_009` | `PASSWORD_RESET_TOKEN_INVALID` | 400 | Password reset token is invalid, already used, or not found. |
| `AUTH_010` | `PASSWORD_CHANGE_REQUIRED` | 403 | Temporary password must be changed before accessing this endpoint. Only `PATCH /auth/me/change-password`, `POST /auth/logout`, and `GET /auth/me` are accessible. |

### ATT Namespace — Attendance

| Code | Name | HTTP Status | Description |
|---|---|---|---|
| `ATT_001` | `OUTSIDE_GEOFENCE` | 422 | Employee location is outside the configured geofence radius. |
| `ATT_002` | `GPS_ACCURACY_LOW` | 422 | GPS accuracy exceeds `gpsAccuracyThresholdMeters`. |
| `ATT_003` | `SESSION_ALREADY_ACTIVE` | 409 | Employee already has an active check-in session. |
| `ATT_004` | `NONCE_REPLAYED` | 409 | This nonce has already been used. Possible replay attack. |
| `ATT_005` | `NO_ACTIVE_SESSION` | 422 | No active session exists to check out from. |
| `ATT_006` | `GPS_MOCK_DETECTED` | 422 | GPS accuracy is 0 or mock GPS indicators detected, and mock GPS is disallowed by settings. |
| `ATT_007` | `OUTSIDE_TIMESTAMP_WINDOW` | 422 | Client-provided timestamp differs from server time by more than the allowed window. |

### LVE Namespace — Leave Management

| Code | Name | HTTP Status | Description |
|---|---|---|---|
| `LVE_001` | `LEAVE_BALANCE_INSUFFICIENT` | 422 | Insufficient leave balance for the requested number of days. |
| `LVE_002` | `LEAVE_DATE_CONFLICT` | 409 | Requested dates overlap with an existing approved or pending leave. |
| `LVE_003` | `LEAVE_ON_HOLIDAY` | 422 | All requested dates fall on public holidays. |
| `LVE_004` | `LEAVE_ON_WEEKEND` | 422 | All requested dates fall on non-working days (weekends). |
| `LVE_005` | `LEAVE_STATUS_INVALID` | 422 | Action is not allowed for the current leave request status. |
| `LVE_006` | `LEAVE_REVOCATION_NOT_ALLOWED` | 422 | Leave can only be revoked when it is in `approved` status. |
| `LVE_007` | `LEAVE_CANCELLATION_NOT_ALLOWED` | 422 | Employees can only cancel their own `pending` leave requests. |
| `LVE_008` | `LEAVE_TYPE_INVALID` | 400 | Requested leave type is not configured in company settings. |

### REG Namespace — Regularization

| Code | Name | HTTP Status | Description |
|---|---|---|---|
| `REG_001` | `REGULARIZATION_LOOKBACK_EXCEEDED` | 422 | Requested date is older than the configured lookback window. |
| `REG_002` | `REGULARIZATION_DUPLICATE` | 409 | A regularization request already exists for this employee and date. |
| `REG_003` | `REGULARIZATION_STATUS_INVALID` | 422 | Action is not allowed for the current regularization request status. |

### PAY Namespace — Payroll

| Code | Name | HTTP Status | Description |
|---|---|---|---|
| `PAY_001` | `PAYROLL_ALREADY_FINALISED` | 409 | Payroll for this month is finalised and cannot be recomputed or modified. |
| `PAY_002` | `PAYROLL_NOT_FOUND` | 404 | No payroll summary found for this employee and month. |
| `PAY_003` | `PAYROLL_COMPUTATION_FAILED` | 500 | Internal error during payroll computation (logged + alerted). |
| `PAY_004` | `PAYROLL_NOT_FINALISED` | 422 | Operation requires payroll to be finalised (e.g., attempting to unfinalize a draft). |

### SET Namespace — Settings

| Code | Name | HTTP Status | Description |
|---|---|---|---|
| `SET_001` | `SETTINGS_VALIDATION_FAILED` | 422 | Settings update failed cross-field validation (e.g., halfDayThreshold >= required minutes). |

### GEN Namespace — General

| Code | Name | HTTP Status | Description |
|---|---|---|---|
| `GEN_001` | `VALIDATION_ERROR` | 400 | Request body or parameters failed schema validation. `details` contains field-level messages. |
| `GEN_002` | `NOT_FOUND` | 404 | Requested resource does not exist. |
| `GEN_003` | `RATE_LIMITED` | 429 | Rate limit exceeded. Retry after the `Retry-After` response header value (seconds). |
| `GEN_004` | `INTERNAL_ERROR` | 500 | Unexpected server error. Logged with trace ID. |
| `GEN_005` | `SERVICE_UNAVAILABLE` | 503 | External dependency (FCM, Brevo, Atlas) is unavailable. |
| `GEN_006` | `CONFLICT` | 409 | Unique constraint violation or resource already exists. |
| `GEN_007` | `INVALID_PAYROLL_INPUT` | 400 | Payroll engine received invalid input (negative presentDays, negative salary). |

---

## 3. Authentication

### 3.1 `POST /api/v1/auth/login`

**Purpose:** Exchange credentials + device fingerprint for access and refresh tokens.

| Property | Value |
|---|---|
| Auth Required | No |
| CSRF Required | No |
| Device Validation | Yes — `deviceFingerprint` in request body validated against registered hash |
| Rate Limit | `authLimiter` — 10 req/min per IP |
| Idempotency | N/A |

**Request Headers**

| Header | Required | Value |
|---|---|---|
| `Content-Type` | Yes | `application/json` |

**Request Body**
```json
{
  "email": "string",             // required; valid email; max 255 chars
  "password": "string",          // required; min 8, max 128 chars
  "deviceFingerprint": "string"  // required; 64-char hex (SHA-256 of device identifiers)
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "accessToken": "string",      // JWT; 15-minute TTL; signed with JWT_SECRET
    "refreshToken": "string",     // opaque session token; 30-day inactivity + 90-day absolute
    "sessionId": "string",        // deviceSession _id; stored by client for logout
    "employee": {
      "id": "string",
      "employeeId": "string",
      "email": "string",
      "firstName": "string",
      "lastName": "string",
      "role": "admin | employee",
      "requiresPasswordChange": true
    }
  }
}
```

`requiresPasswordChange: true` on first login. Flutter must redirect to change-password screen before any other action when this is `true`. Only `PATCH /auth/me/change-password`, `POST /auth/logout`, and `GET /auth/me` are accessible in this state.

**Validation Rules**
- `email`: required, RFC 5321 email format, max 255 chars
- `password`: required, 8–128 chars
- `deviceFingerprint`: required, exactly 64 hex characters

**Business Rules**
- BR-AUTH-01: Same error (`AUTH_001`) returned for wrong email **and** wrong password — no enumeration
- BR-AUTH-02: `isActive` check occurs before password compare — deactivated accounts return `AUTH_007`
- BR-AUTH-03: `deviceFingerprint` from request body compared with `user.registeredDeviceHash`; mismatch → `AUTH_005`
- BR-AUTH-04: No registered device → `AUTH_004`; admin must register device first
- BR-AUTH-05: Successful login creates new `deviceSession` with `absoluteExpiresAt = now + 90 days`
- BR-AUTH-06: `lastLoginAt` updated on `users` document
- BR-AUTH-06b: JWT access token payload includes `requiresPasswordChange` claim; Edge Middleware enforces access restrictions when `true`

**Error Responses**

| Code | Condition |
|---|---|
| `AUTH_001` | Wrong email or password |
| `AUTH_004` | No device registered for this account |
| `AUTH_005` | Device fingerprint mismatch |
| `AUTH_007` | Account deactivated |
| `GEN_001` | Missing or invalid request fields |
| `GEN_003` | Rate limit exceeded (10/min per IP) |

---

### 3.2 `POST /api/v1/auth/refresh`

**Purpose:** Exchange a valid refresh session for a new access token.

| Property | Value |
|---|---|
| Auth Required | No (refresh token is the credential) |
| CSRF Required | No |
| Device Validation | No |
| Rate Limit | None (refresh tokens are already long-lived; rate limit is at login) |
| Idempotency | N/A |

**Request Body**
```json
{
  "refreshToken": "string",  // required; the opaque refresh token from login
  "sessionId": "string"      // required; deviceSession _id from login response
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "accessToken": "string"  // new JWT; 15-minute TTL
  }
}
```

**Business Rules**
- BR-AUTH-07: Look up `deviceSession` by `sessionId`; verify `refreshToken` matches stored hash
- BR-AUTH-08: Check `isRevoked`; if true → `AUTH_003`
- BR-AUTH-09: Check `expiresAt < now()` → `AUTH_002` (inactivity timeout)
- BR-AUTH-10: Check `absoluteExpiresAt < now()` → `AUTH_002` (hard limit)
- BR-AUTH-11: Extend `expiresAt` = `min(now + 30d, absoluteExpiresAt)`; update `lastUsedAt`
- BR-AUTH-12: Issue new access token with same `employeeId`, `role` from user record (re-fetched, not from old token)

**Error Responses**

| Code | Condition |
|---|---|
| `AUTH_002` | Session expired (inactivity or absolute max) |
| `AUTH_003` | Session revoked or refresh token invalid |
| `AUTH_007` | Employee deactivated (re-checked on each refresh) |
| `GEN_001` | Missing `refreshToken` or `sessionId` |

---

### 3.3 `POST /api/v1/auth/logout`

**Purpose:** Revoke the current device session.

| Property | Value |
|---|---|
| Auth Required | Yes (Bearer access token) |
| CSRF Required | Yes (if cookie auth) |
| Rate Limit | None |

**Request Body**
```json
{
  "sessionId": "string"  // required; deviceSession _id to revoke
}
```

**Response 200**
```json
{
  "success": true,
  "data": { "message": "Logged out successfully." }
}
```

**Business Rules**
- BR-AUTH-13: Employee can only revoke their own sessions (validate `deviceSession.employeeId` matches JWT)
- BR-AUTH-14: Sets `isRevoked: true`, `revokedAt: now()` on the session
- BR-AUTH-15: If admin portal uses httpOnly cookie, the portal's BFF layer clears the cookie after this call

---

### 3.4 `PATCH /api/v1/employees/:id/register-device`

**Purpose:** Admin registers a device fingerprint for an employee, enabling their first login.

> Documented here with Employee Management (Section 4.7) — cross-reference.

---

### 3.5 `POST /api/v1/auth/password-reset/request`

**Purpose:** Initiate password reset — generate token and email it to the employee.

| Property | Value |
|---|---|
| Auth Required | No |
| CSRF Required | No |
| Rate Limit | `passwordResetLimiter` — 3 req/hr per email AND 3 req/hr per IP (dual-keyed) |

**Request Body**
```json
{
  "email": "string"  // required; valid email
}
```

**Response 200** (always 200 — no enumeration)
```json
{
  "success": true,
  "data": { "message": "If that email is registered, a reset link has been sent." }
}
```

**Business Rules**
- BR-AUTH-16: Always return 200 regardless of whether email exists or rate limit hit
- BR-AUTH-17: If email exists and within rate limit: create `passwordResetTokens` doc; email reset link via Brevo
- BR-AUTH-18: Token is `crypto.randomBytes(32).toString('hex')` (64-char hex, 256-bit entropy). Stored as `SHA-256(rawToken)` hex string in `passwordResetTokens.tokenHash`. Raw token embedded in email link. Never stored in DB.
- BR-AUTH-19: `expiresAt = now + 15 minutes`; MongoDB TTL index auto-deletes after expiry
- BR-AUTH-20: Any existing unexpired tokens for this email are not invalidated (they will expire on their own)

**Error Responses**
- None returned externally. All errors (rate limit, email failure) are swallowed; always 200.

---

### 3.6 `POST /api/v1/auth/password-reset/confirm`

**Purpose:** Validate reset token and set new password.

| Property | Value |
|---|---|
| Auth Required | No |
| CSRF Required | No |
| Rate Limit | `authLimiter` — 10 req/min per IP |

**Request Body**
```json
{
  "token": "string",        // required; raw token from email link
  "email": "string",        // required; used to look up the token record
  "newPassword": "string"   // required; 8–128 chars
}
```

**Response 200**
```json
{
  "success": true,
  "data": { "message": "Password updated successfully. Please log in again." }
}
```

**Business Rules**
- BR-AUTH-21: Look up `passwordResetTokens` by email. Compute `SHA-256(providedToken)`; compare with `tokenRecord.tokenHash` using `crypto.timingSafeEqual`. Non-match or record not found → `AUTH_009` (same error — prevents enumeration).
- BR-AUTH-22: Check `expiresAt`; expired → `AUTH_008`
- BR-AUTH-23: Check `isUsed`; used → `AUTH_009`
- BR-AUTH-24: Inside `withTransaction`: update `passwordHash`, set `tokenRecord.isUsed = true`, revoke all `deviceSessions` for this user
- BR-AUTH-25: New password must not be the same as current (bcryptjs compare before update)

**Error Responses**

| Code | Condition |
|---|---|
| `AUTH_008` | Token expired |
| `AUTH_009` | Token invalid or already used |
| `GEN_001` | Missing or invalid fields; password too short |

---

### 3.7 `GET /api/v1/auth/me`

**Purpose:** Return the authenticated employee's profile.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes (if cookie auth) |
| Role | admin, employee |
| Rate Limit | None |

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "employeeId": "string",
    "email": "string",
    "firstName": "string",
    "lastName": "string",
    "role": "admin | employee",
    "phone": "string | null",
    "department": "string | null",
    "designation": "string | null",
    "monthlySalary": 50000,
    "dateOfJoining": "2025-01-01",
    "dateOfLeaving": null,
    "isActive": true,
    "hasRegisteredDevice": true,
    "requiresPasswordChange": false,
    "leaveBalances": {
      "paidLeave":   { "currentYear": 12, "carriedForward": 3, "carryForwardExpiry": "2026-03-31" },
      "sickLeave":   { "currentYear": 8,  "carriedForward": 0 },
      "casualLeave": { "currentYear": 3,  "carriedForward": 0 }
    },
    "createdAt": "2025-01-01T00:00:00.000Z",
    "updatedAt": "2026-06-14T09:00:00.000Z"
  }
}
```

---

### 3.8 `PATCH /api/v1/auth/me/change-password`

**Purpose:** Authenticated employee changes their own password.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes (if cookie auth) |
| Role | admin, employee |
| Rate Limit | `authLimiter` — 10 req/min per IP |

**Request Body**
```json
{
  "currentPassword": "string",  // required; verified before update
  "newPassword": "string"       // required; 8–128 chars; must differ from current
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "message": "Password changed successfully. Other devices have been logged out.",
    "accessToken": "string"  // fresh JWT with requiresPasswordChange: false — Flutter updates immediately
  }
}
```

**Business Rules**
- BR-AUTH-26: Verify `currentPassword` against stored hash before proceeding
- BR-AUTH-27: Inside `withTransaction`: update `passwordHash`; revoke all sessions; set `requiresPasswordChange = false`
- BR-AUTH-28: New password must differ from current
- BR-AUTH-29: Issue fresh access token (with `requiresPasswordChange: false`) and return in response — Flutter replaces its stored token immediately, no re-login required

**Error Responses**

| Code | Condition |
|---|---|
| `AUTH_001` | `currentPassword` incorrect |
| `GEN_001` | New password too short, same as current |

---

## 4. Employee Management

### 4.1 `GET /api/v1/employees`

**Purpose:** List all employees (admin) or just own record (employee).

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes (if cookie auth) |
| Role | admin (full list); employee (own only — use `/auth/me` instead) |

**Query Parameters**

| Param | Type | Default | Description |
|---|---|---|---|
| `page` | integer | `1` | Page number |
| `limit` | integer | `20` | Records per page (max 100) |
| `search` | string | — | Search by name or employeeId (case-insensitive) |
| `department` | string | — | Filter by department |
| `isActive` | boolean | — | Filter by active status |
| `sortBy` | string | `createdAt` | `firstName`, `lastName`, `employeeId`, `createdAt`, `dateOfJoining` |
| `sortOrder` | `asc\|desc` | `desc` | — |

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "employeeId": "string",
      "firstName": "string",
      "lastName": "string",
      "email": "string",
      "role": "employee",
      "department": "string | null",
      "designation": "string | null",
      "monthlySalary": 50000,
      "dateOfJoining": "2025-01-01",
      "isActive": true,
      "hasRegisteredDevice": true
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 45, "totalPages": 3 }
}
```

**Business Rules**
- BR-EMP-01: `monthlySalary` visible to admins only; excluded from response if requester is `employee` role

---

### 4.2 `POST /api/v1/employees`

**Purpose:** Create a new employee account.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |
| Idempotency | `X-Idempotency-Key` recommended |

**Request Body**
```json
{
  "employeeId": "string",    // required; unique company ID (e.g. "EMP042"); max 20 chars
  "firstName": "string",     // required; max 50 chars
  "lastName": "string",      // required; max 50 chars
  "email": "string",         // required; unique; valid email
  "role": "employee",        // required; "admin" | "employee"
  "phone": "string",         // optional; E.164 format
  "department": "string",    // optional; max 100 chars
  "designation": "string",   // optional; max 100 chars
  "monthlySalary": 50000,    // required; >= 0
  "dateOfJoining": "2026-06-14"  // required; YYYY-MM-DD; cannot be future
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "employeeId": "string",
    "email": "string",
    "temporaryPassword": "string"  // plaintext; shown ONCE; admin must share securely
  }
}
```

**Business Rules**
- BR-EMP-02: Temporary password is 12-char random string; hash stored; raw value returned once in this response only (not logged, not stored)
- BR-EMP-03: `leaveBalances` initialized with pro-rated values based on `dateOfJoining` and current leave year
- BR-EMP-04: Annual leave allocation cron will handle future years; this endpoint only initializes current year
- BR-EMP-05: Audit log `EMPLOYEE_CREATED` written
- BR-EMP-06: `registeredDeviceHash` is null until admin calls register-device
- BR-EMP-22: `requiresPasswordChange: true` set on all newly created employees; enforced by Edge Middleware until `PATCH /auth/me/change-password` is called
- BR-EMP-23: All URL path parameters (`/:id`) use the employee's MongoDB ObjectId (24-char hex), never the human-readable company `employeeId` string — no URL path collisions possible with ObjectId values
- **Recovery path:** If admin loses the temp password before sharing it, the employee uses `POST /auth/password-reset/request` (self-service) with their email. Admin confirms the email is correct; employee receives reset link and sets their own password, satisfying the `requiresPasswordChange` requirement.

**Error Responses**

| Code | Condition |
|---|---|
| `GEN_001` | Invalid fields |
| `GEN_006` | `email` or `employeeId` already exists |

---

### 4.3 `GET /api/v1/employees/:id`

**Purpose:** Get a single employee's full profile (admin) or own profile (employee via `/auth/me`).

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin |

**Path Parameters**

| Param | Type | Description |
|---|---|---|
| `id` | string | Employee MongoDB `_id` |

**Response 200** — same shape as `GET /auth/me` but includes all admin-visible fields.

**Business Rules**
- BR-EMP-07: Employees cannot call this endpoint for other employees; use `/auth/me` for self

---

### 4.4 `PUT /api/v1/employees/:id`

**Purpose:** Update employee profile fields.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body** — all fields optional; only provided fields are updated:
```json
{
  "firstName": "string",
  "lastName": "string",
  "phone": "string | null",
  "department": "string | null",
  "designation": "string | null",
  "monthlySalary": 55000,
  "dateOfLeaving": "2026-12-31 | null"
}
```

**Response 200** — updated employee object.

**Business Rules**
- BR-EMP-08: `email`, `employeeId`, `role`, `dateOfJoining` are immutable after creation
- BR-EMP-09: `dateOfLeaving` can be set for employees who have resigned; affects payroll computation
- BR-EMP-10: Audit log `EMPLOYEE_UPDATED` written with before/after snapshot (excluding `passwordHash`)

**Error Responses**

| Code | Condition |
|---|---|
| `GEN_001` | Invalid field values |
| `GEN_002` | Employee not found |

---

### 4.5 `PATCH /api/v1/employees/:id/activate`

**Purpose:** Re-activate a deactivated employee.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body** — empty body `{}`

**Response 200**
```json
{
  "success": true,
  "data": { "message": "Employee activated. They must log in fresh on each device." }
}
```

**Business Rules**
- BR-EMP-11: Sets `isActive: true`; does NOT restore any `deviceSessions` (per session policy — must re-login)
- BR-EMP-12: Audit log `EMPLOYEE_REACTIVATED` written

---

### 4.6 `PATCH /api/v1/employees/:id/deactivate`

**Purpose:** Deactivate an employee — immediately blocks access.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body**
```json
{
  "reason": "string"  // optional; logged in audit
}
```

**Response 200**
```json
{
  "success": true,
  "data": { "message": "Employee deactivated. All sessions revoked." }
}
```

**Business Rules**
- BR-EMP-13: Inside `withTransaction`: sets `isActive: false`; sets `isRevoked: true` on ALL employee `deviceSessions`
- BR-EMP-14: Audit log `EMPLOYEE_DEACTIVATED` written with reason
- BR-EMP-15: In-progress attendance sessions are NOT auto-closed (cron handles this at end of day)

---

### 4.7 `PATCH /api/v1/employees/:id/register-device`

**Purpose:** Register a device fingerprint for an employee, enabling their first login on that device.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body**
```json
{
  "deviceFingerprint": "string",  // required; 64-char hex
  "deviceName": "string"          // optional; human label e.g. "Samsung Galaxy A55"
}
```

**Response 200**
```json
{
  "success": true,
  "data": { "message": "Device registered. Employee can now log in." }
}
```

**Business Rules**
- BR-EMP-16: `deviceFingerprint` is stored as `SHA-256(fingerprint)` hex string in `registeredDeviceHash`; raw fingerprint not stored. Comparison at checkin uses `crypto.timingSafeEqual`.
- BR-EMP-17: Overwrites any previously registered device hash
- BR-EMP-18: Does NOT revoke existing `deviceSessions` (those are from prior device; they will expire or are already revoked)
- BR-EMP-19: Audit log `DEVICE_REGISTERED` written

---

### 4.8 `PATCH /api/v1/employees/:id/reset-device`

**Purpose:** Clear the registered device — employee must re-register a new device.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body** — empty `{}`

**Response 200**
```json
{
  "success": true,
  "data": { "message": "Device reset. All sessions revoked. Admin must register a new device." }
}
```

**Business Rules**
- BR-EMP-20: Clears `registeredDeviceHash`; revokes ALL `deviceSessions`; employee cannot log in until admin registers a new device
- BR-EMP-21: Audit log `DEVICE_RESET` written

---

## 5. Attendance

### 5.1 `POST /api/v1/attendance/checkin`

**Purpose:** Record employee check-in with GPS validation and nonce-based replay prevention.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | No (Bearer only from Flutter) |
| Role | employee, admin |
| Device Validation | Yes — `X-Device-Fingerprint` header |
| Rate Limit | `attendanceLimiter` — 60 req/min per employee ID |

**Request Headers**

| Header | Required | Description |
|---|---|---|
| `Authorization` | Yes | `Bearer <accessToken>` |
| `X-Device-Fingerprint` | Yes | 64-char hex; validated against registered device |
| `Content-Type` | Yes | `application/json` |

**Request Body**
```json
{
  "latitude": 19.0760,           // required; -90 to 90
  "longitude": 72.8777,          // required; -180 to 180
  "accuracy": 12.5,              // required; meters; >= 0
  "nonce": "string",             // required; UUID v4; unique per request; replay prevention
  "timestamp": "2026-06-14T09:28:00.000Z"  // required; client UTC time; within server window
}
```

Device fingerprint is transported exclusively via the `X-Device-Fingerprint` header. It must NOT be included in the request body (removed per R-API-002 — dual-transport bypass).

**Response 200**
```json
{
  "success": true,
  "data": {
    "sessionId": "string",
    "checkInTimestamp": "2026-06-14T03:58:00.000Z",  // server-recorded UTC time
    "dateString": "2026-06-14",                        // IST date of check-in
    "status": "checked-in",
    "flags": {
      "possibleMockGps": false,   // true if accuracy == 0
      "outsideGracePeriod": false
    }
  }
}
```

**Validation Rules**
- `latitude`: -90 ≤ value ≤ 90, required
- `longitude`: -180 ≤ value ≤ 180, required
- `accuracy`: ≥ 0, required
- `nonce`: UUID v4 format, required, max 36 chars
- `timestamp`: valid ISO 8601 UTC datetime, required
- `X-Device-Fingerprint` header: required; must match `/^[0-9a-f]{64}$/i`; missing or malformed → `AUTH_004`

**Business Rules**
- BR-ATT-01: Validate `|serverTime - request.timestamp| ≤ checkinTimestampWindowMinutes` → `ATT_007`
- BR-ATT-02: Read fingerprint from `X-Device-Fingerprint` header (sole source — not body). Compare with `user.registeredDeviceHash`; missing/malformed header → `AUTH_004`; hash mismatch → `AUTH_005`
- BR-ATT-03: Insert `usedNonces { nonce, employeeId, expiresAt: now+10min }`; unique index violation → `ATT_004`
- BR-ATT-04: If `companySettings.geoFence.isEnabled`: compute haversine distance; exceed radius → `ATT_001`
- BR-ATT-05: If `accuracy > gpsAccuracyThresholdMeters` → `ATT_002`
- BR-ATT-06: If `accuracy == 0` set `flags.possibleMockGps = true`; if settings disallow mock GPS → `ATT_006`
- BR-ATT-07: Inside `withTransaction`: create `AttendanceSession { isActive: true }`; upsert `AttendanceDay { dateString: toISTDateString(serverTime) }`. Partial unique index on `{ employeeId } where isActive=true` prevents duplicate active sessions at DB level → `ATT_003`
- BR-ATT-08: `dateString` derived using `toISTDateString(serverTime, companySettings.timezone)` — never from client timestamp

**Error Responses**

| Code | Condition |
|---|---|
| `ATT_001` | Outside geofence |
| `ATT_002` | GPS accuracy too low |
| `ATT_003` | Already checked in |
| `ATT_004` | Nonce replayed |
| `ATT_006` | Mock GPS detected (if disallowed) |
| `ATT_007` | Timestamp outside window |
| `AUTH_005` | Device fingerprint mismatch |
| `AUTH_007` | Account deactivated |
| `GEN_001` | Invalid request fields |
| `GEN_003` | Rate limited |

---

### 5.2 `POST /api/v1/attendance/checkout`

**Purpose:** Record check-out and compute session duration and day status.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | No |
| Role | employee, admin |
| Device Validation | No (checkout does not re-validate device) |
| Rate Limit | `attendanceLimiter` — 60 req/min per employee ID |

**Request Body**
```json
{
  "nonce": "string",            // required; UUID v4; separate nonce from checkin
  "timestamp": "2026-06-14T18:35:00.000Z"  // required; client UTC time
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "sessionId": "string",
    "checkInTimestamp": "2026-06-14T03:58:00.000Z",
    "checkOutTimestamp": "2026-06-14T13:05:00.000Z",
    "durationMinutes": 547,
    "day": {
      "dateString": "2026-06-14",
      "status": "present",
      "totalMinutes": 547,
      "overtimeMinutes": 7
    }
  }
}
```

**Business Rules**
- BR-ATT-09: Find active session (`isActive: true`) for employee; none → `ATT_005`
- BR-ATT-10: Validate timestamp window (same as checkin)
- BR-ATT-11: Nonce consumed in `usedNonces` (same replay prevention)
- BR-ATT-12: Inside `withTransaction`: close session (`isActive: false`, `checkOut: serverTime`); compute `durationMinutes`; update `AttendanceDay.totalMinutes` (cumulative); derive day `status` based on `totalMinutes` vs settings thresholds
- BR-ATT-13: Day status priority: `leave` > `holiday` > `weekend` > attendance-derived (`present`/`half-day`/`absent`)
- BR-ATT-14: `overtimeMinutes = max(0, totalMinutes - requiredDailyMinutes)`

**Error Responses**

| Code | Condition |
|---|---|
| `ATT_004` | Nonce replayed |
| `ATT_005` | No active session |
| `ATT_007` | Timestamp outside window |
| `GEN_001` | Invalid request fields |

---

### 5.3 `GET /api/v1/attendance/status`

**Purpose:** Return today's attendance status for the authenticated employee. Used by Flutter for timer anchor recovery on app restart.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee, admin (own only) |
| Rate Limit | None |

**Response 200 — `AttendanceStatusResponse`**
```json
{
  "success": true,
  "data": {
    "isCheckedIn": true,
    "todayDateString": "2026-06-14",
    "currentSession": {
      "sessionId": "string",
      "checkInTimestamp": "2026-06-14T03:58:00.000Z",
      "checkInLocation": { "latitude": 19.0760, "longitude": 72.8777 }
    },
    "todaySummary": {
      "totalMinutes": 230,
      "status": "absent",
      "sessions": [
        {
          "sessionId": "string",
          "checkInTimestamp": "2026-06-14T03:58:00.000Z",
          "checkOutTimestamp": null,
          "durationMinutes": 230,
          "closedBySystem": false
        }
      ]
    }
  }
}
```

When not checked in:
```json
{
  "success": true,
  "data": {
    "isCheckedIn": false,
    "todayDateString": "2026-06-14",
    "currentSession": null,
    "todaySummary": {
      "totalMinutes": 0,
      "status": "absent",
      "sessions": []
    }
  }
}
```

**Business Rules**
- BR-ATT-15: `todayDateString` is the current IST date (not UTC date)
- BR-ATT-16: `currentSession` is populated only when `isCheckedIn: true`
- BR-ATT-17: `totalMinutes` is cumulative across all sessions for today (including closed sessions)

---

### 5.4 `GET /api/v1/attendance/history`

**Purpose:** Employee views own attendance history; admin views any employee's history via query param.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own), admin (any) |

**Query Parameters**

| Param | Type | Required | Description |
|---|---|---|---|
| `employeeId` | string | Admin only | Target employee (omit for own data) |
| `startDate` | `YYYY-MM-DD` | Yes | Start of date range (IST) |
| `endDate` | `YYYY-MM-DD` | Yes | End of date range (IST); max 31-day window |
| `status` | string | No | Filter by day status (`present`, `absent`, `half-day`, `leave`, `holiday`, `weekend`) |
| `page` | integer | No | Default 1 |
| `limit` | integer | No | Default 31, max 100 |

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "dateString": "2026-06-14",
      "dayOfWeek": "Sunday",
      "status": "present",
      "totalMinutes": 547,
      "overtimeMinutes": 7,
      "isHoliday": false,
      "isWeekend": true,
      "isRegularized": false,
      "sessions": [
        {
          "sessionId": "string",
          "checkInTimestamp": "2026-06-14T03:58:00.000Z",
          "checkOutTimestamp": "2026-06-14T13:05:00.000Z",
          "durationMinutes": 547,
          "closedBySystem": false
        }
      ]
    }
  ],
  "meta": { "page": 1, "limit": 31, "total": 22, "totalPages": 1 }
}
```

**Validation Rules**
- `startDate` and `endDate` required; `endDate >= startDate`; range ≤ 31 days
- `employeeId` only accepted from admin role; ignored from employee role

---

### 5.5 `GET /api/v1/attendance/today`

**Purpose:** Admin dashboard — all employees' attendance status for today.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters**

| Param | Type | Default | Description |
|---|---|---|---|
| `status` | string | — | Filter by status (`checked-in`, `checked-out`, `absent`) |
| `department` | string | — | Filter by department |
| `page` | integer | `1` | — |
| `limit` | integer | `50` | Max 200 |

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "employeeId": "EMP001",
      "firstName": "string",
      "lastName": "string",
      "department": "string | null",
      "isCheckedIn": true,
      "checkInTime": "2026-06-14T03:58:00.000Z",
      "elapsedMinutes": 230,
      "dayStatus": "absent",
      "totalMinutesToday": 230
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 45, "totalPages": 1 }
}
```

---

### 5.6 `GET /api/v1/attendance/weekly`

**Purpose:** Employee's weekly attendance summary.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own), admin (query by `employeeId`) |

**Query Parameters**

| Param | Type | Required | Description |
|---|---|---|---|
| `week` | `YYYY-Www` (ISO week) | No | Default: current week. Example: `2026-W24` |
| `employeeId` | string | Admin only | Target employee |

**Response 200**
```json
{
  "success": true,
  "data": {
    "week": "2026-W24",
    "startDate": "2026-06-08",
    "endDate": "2026-06-14",
    "totalMinutes": 2400,
    "totalOvertimeMinutes": 45,
    "days": [ ]  // same shape as attendance/history items
  }
}
```

---

### 5.7 `GET /api/v1/attendance/monthly`

**Purpose:** Employee's monthly attendance summary with aggregated stats.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own), admin (query by `employeeId`) |

**Query Parameters**

| Param | Type | Required | Description |
|---|---|---|---|
| `yearMonth` | `YYYY-MM` | No | Default: current month |
| `employeeId` | string | Admin only | Target employee |

**Response 200**
```json
{
  "success": true,
  "data": {
    "yearMonth": "2026-06",
    "summary": {
      "workingDaysInMonth": 22,
      "presentDays": 18,
      "halfDays": 2,
      "absentDays": 1,
      "leaveDays": 1,
      "holidayDays": 0,
      "weekendDays": 9,
      "totalMinutes": 9870,
      "overtimeMinutes": 120
    },
    "days": [ ]  // same shape as attendance/history items
  }
}
```

---

### 5.8 `GET /api/v1/employees/:id/attendance`

**Purpose:** Admin views a specific employee's attendance — equivalent to `/attendance/history` but employee scoped via URL.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters** — same as `GET /attendance/history` minus `employeeId` (taken from path).

---

## 6. Leave Management

### 6.1 `POST /api/v1/leaves`

**Purpose:** Employee applies for leave.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | employee, admin (on behalf) |
| Idempotency | `X-Idempotency-Key` recommended |

**Request Body**
```json
{
  "leaveType": "paidLeave | sickLeave | casualLeave | lwp",  // required
  "startDate": "2026-06-20",   // required; YYYY-MM-DD; IST date
  "endDate": "2026-06-22",     // required; YYYY-MM-DD; >= startDate
  "duration": "full | half",   // required
  "halfDayPeriod": "morning | afternoon",  // required if duration = "half"
  "reason": "string"           // optional; max 500 chars
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "leaveType": "paidLeave",
    "startDate": "2026-06-20",
    "endDate": "2026-06-22",
    "totalDays": 3,
    "affectedDates": ["2026-06-20", "2026-06-21", "2026-06-22"],
    "status": "pending",
    "leaveYear": 2026,
    "createdAt": "2026-06-14T09:00:00.000Z"
  }
}
```

**Validation Rules**
- `leaveType`: must be one of configured types
- `startDate`: must be today or future
- `endDate`: must be >= `startDate`
- `halfDayPeriod`: required when `duration = "half"`; only valid when `startDate == endDate`

**Business Rules**
- BR-LVE-01: `affectedDates` computed server-side by excluding weekends and holidays from `startDate..endDate`
- BR-LVE-02: If `affectedDates` is empty after exclusions → `LVE_003` or `LVE_004` accordingly
- BR-LVE-03: Check for overlapping approved/pending leave on any date in `affectedDates` → `LVE_002`
- BR-LVE-04: Check `leaveBalance >= totalDays` (for non-LWP types) → `LVE_001`
- BR-LVE-05: `leaveYear` = `getLeaveYearBoundaries(startDate, leaveYearStartMonth).leaveYear`
- BR-LVE-06: Balance NOT deducted at application time — only on approval
- BR-LVE-07: `duration: 'half'` → `totalDays = 0.5`; only valid for single-day requests

**Error Responses**

| Code | Condition |
|---|---|
| `LVE_001` | Insufficient balance |
| `LVE_002` | Date conflict with existing leave |
| `LVE_003` | All dates are holidays |
| `LVE_004` | All dates are weekends |
| `LVE_008` | Invalid leave type |
| `GEN_001` | Invalid fields |

---

### 6.2 `GET /api/v1/leaves`

**Purpose:** List leave requests — own for employee, all or filtered for admin.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own), admin (all) |

**Query Parameters**

| Param | Type | Description |
|---|---|---|
| `employeeId` | string | Admin only — filter by employee |
| `status` | string | `pending`, `approved`, `rejected`, `cancelled`, `revoked` |
| `leaveType` | string | Filter by leave type |
| `leaveYear` | integer | Filter by fiscal leave year |
| `startDate` | `YYYY-MM-DD` | Filter requests with startDate >= this |
| `endDate` | `YYYY-MM-DD` | Filter requests with endDate <= this |
| `page` | integer | Default 1 |
| `limit` | integer | Default 20, max 100 |
| `sortBy` | string | `createdAt`, `startDate`, `status`; default `createdAt` |

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "employeeId": "string",
      "employeeName": "string",
      "leaveType": "paidLeave",
      "startDate": "2026-06-20",
      "endDate": "2026-06-22",
      "totalDays": 3,
      "duration": "full",
      "status": "pending",
      "leaveYear": 2026,
      "reason": "string | null",
      "approvedBy": "string | null",
      "approvedAt": "string | null",
      "rejectedBy": "string | null",
      "rejectedAt": "string | null",
      "rejectionReason": "string | null",
      "createdAt": "string"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 12, "totalPages": 1 }
}
```

---

### 6.3 `GET /api/v1/leaves/:id`

**Purpose:** Get a single leave request.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own), admin (any) |

**Business Rules**
- BR-LVE-08: Employee can only access own leave requests

---

### 6.4 `PATCH /api/v1/leaves/:id/cancel`

**Purpose:** Employee cancels own pending leave request.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | employee (own), admin |

**Request Body** — empty `{}`

**Response 200**
```json
{
  "success": true,
  "data": { "id": "string", "status": "cancelled" }
}
```

**Business Rules**
- BR-LVE-09: Only `pending` requests can be cancelled by employees → `LVE_007`
- BR-LVE-10: Cancelled leave releases no balance (pending = no deduction yet)
- BR-LVE-11: Audit log `LEAVE_CANCELLED` written

---

### 6.5 `GET /api/v1/leaves/balance`

**Purpose:** Return authenticated employee's current leave balances.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own), admin (query by `employeeId`) |

**Query Parameters**

| Param | Type | Description |
|---|---|---|
| `employeeId` | string | Admin only |

**Response 200**
```json
{
  "success": true,
  "data": {
    "paidLeave": {
      "currentYear": 12,
      "carriedForward": 3,
      "carryForwardExpiry": "2026-03-31",
      "total": 15
    },
    "sickLeave": {
      "currentYear": 8,
      "carriedForward": 0,
      "total": 8
    },
    "casualLeave": {
      "currentYear": 3,
      "carriedForward": 0,
      "total": 3
    },
    "asOf": "2026-06-14T09:00:00.000Z"
  }
}
```

---

### 6.6 `GET /api/v1/leaves/pending`

**Purpose:** Admin — list all pending leave requests awaiting approval.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters** — `employeeId`, `leaveType`, `page`, `limit`, `sortBy` (default `createdAt asc`).

**Response** — same shape as `GET /leaves` filtered to `status: 'pending'`.

---

### 6.7 `PATCH /api/v1/leaves/:id/approve`

**Purpose:** Admin approves a pending leave request.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body** — empty `{}`

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "status": "approved",
    "approvedBy": "string",
    "approvedAt": "2026-06-14T10:00:00.000Z",
    "balanceAfter": {
      "currentYear": 9,
      "carriedForward": 3
    }
  },
  "warnings": []  // populated if leave date has active attendance session
}
```

**Business Rules**
- BR-LVE-12: Only `pending` → `approved` transition allowed → `LVE_005` otherwise
- BR-LVE-13: Inside `withTransaction`: atomic balance deduction via `$expr $gte` (`carriedForward` consumed first); create `leaveTransaction { type: 'deduction-approval' }`; update `AttendanceDay.status = 'leave'` for all `affectedDates`; update `leaveRequest.status = 'approved'`
- BR-LVE-14: If any `affectedDate` has an active attendance session → approval still succeeds; warning included in response: `"Employee is currently checked in on {date}. Attendance session preserved."`
- BR-LVE-15: Push notification sent to employee (via `notificationService`, outside transaction)
- BR-LVE-16: Audit log `LEAVE_APPROVED` written

**Error Responses**

| Code | Condition |
|---|---|
| `LVE_001` | Balance insufficient (rechecked at approval time) |
| `LVE_005` | Leave is not in `pending` status |
| `GEN_002` | Leave request not found |

---

### 6.8 `PATCH /api/v1/leaves/:id/reject`

**Purpose:** Admin rejects a pending leave request.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body**
```json
{
  "reason": "string"  // optional; shown to employee in notification
}
```

**Response 200**
```json
{
  "success": true,
  "data": { "id": "string", "status": "rejected" }
}
```

**Business Rules**
- BR-LVE-17: Only `pending` can be rejected → `LVE_005`
- BR-LVE-18: No balance change (balance not deducted for pending requests)
- BR-LVE-19: Push notification + audit log `LEAVE_REJECTED`

---

### 6.9 `PATCH /api/v1/leaves/:id/revoke`

**Purpose:** Admin revokes an already-approved leave request.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body**
```json
{
  "reason": "string"  // required for audit; min 10 chars
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "status": "revoked",
    "balanceAfter": { "currentYear": 12, "carriedForward": 3 }
  },
  "warnings": [
    "Payroll for 2026-06 is finalised. Manual recomputation required."
  ]
}
```

**Business Rules**
- BR-LVE-20: Only `approved` can be revoked → `LVE_006`
- BR-LVE-21: Inside `withTransaction`: restore balance (reverse carry-forward priority); create `leaveTransaction { type: 'restoration-revocation' }`; update `leaveRequest.status = 'revoked'`; update `AttendanceDay.status` for all `affectedDates` (reset from `leave` to prior status based on attendance sessions or `absent`)
- BR-LVE-22: If the month's payroll is `finalised`: include warning in response; do NOT block the revocation; do NOT auto-modify payroll
- BR-LVE-23: Push notification + audit log `LEAVE_REVOKED`

**Error Responses**

| Code | Condition |
|---|---|
| `LVE_006` | Leave is not `approved` |
| `GEN_002` | Not found |

---

## 7. Regularization

### 7.1 `POST /api/v1/regularizations`

**Purpose:** Employee submits a regularization request for a past attendance discrepancy.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | employee, admin (on behalf) |
| Idempotency | `X-Idempotency-Key` recommended |

**Request Body**
```json
{
  "date": "2026-06-10",         // required; YYYY-MM-DD; within lookback window
  "type": "forgotCheckIn | forgotCheckOut | workAwayFromOffice | officialTravel | clientVisit",
  "requestedCheckIn": "2026-06-10T04:00:00.000Z",   // required for forgotCheckIn
  "requestedCheckOut": "2026-06-10T13:30:00.000Z",  // required for forgotCheckOut
  "reason": "string"            // required; min 10 chars
}
```

**Response 201**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "date": "2026-06-10",
    "type": "forgotCheckIn",
    "status": "pending",
    "createdAt": "2026-06-14T09:00:00.000Z"
  }
}
```

**Validation Rules**
- `date`: required; must be within `now - regularizationLookbackDays` window
- `type`: must be one of the enumerated values
- `requestedCheckIn`: required for `forgotCheckIn` type; must be on the same calendar day as `date` (IST)
- `requestedCheckOut`: required for `forgotCheckOut` type; must be on same or next day (if crossed midnight)

**Business Rules**
- BR-REG-01: `date` must be within `regularizationLookbackDays` → `REG_001`
- BR-REG-02: Only one regularization per employee per date → `REG_002`
- BR-REG-03: Audit log `REGULARIZATION_CREATED` written

**Error Responses**

| Code | Condition |
|---|---|
| `REG_001` | Date older than lookback window |
| `REG_002` | Duplicate request for this date |
| `GEN_001` | Invalid fields |

---

### 7.2 `GET /api/v1/regularizations`

**Purpose:** List regularization requests — own for employee, all for admin.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own), admin (all) |

**Query Parameters** — `employeeId` (admin), `status`, `startDate`, `endDate`, `page`, `limit`.

**Response 200** — paginated list of regularization requests.

---

### 7.3 `GET /api/v1/regularizations/:id`

**Purpose:** Get single regularization request.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own), admin (any) |

---

### 7.4 `PATCH /api/v1/regularizations/:id/withdraw`

**Purpose:** Employee withdraws (cancels) their own pending regularization.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | employee (own) |

**Request Body** — empty `{}`

**Business Rules**
- BR-REG-04: Only `pending` can be withdrawn → `REG_003`
- BR-REG-05: Audit log `REGULARIZATION_WITHDRAWN`

---

### 7.5 `GET /api/v1/regularizations/pending`

**Purpose:** Admin — all pending regularization requests.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

---

### 7.6 `PATCH /api/v1/regularizations/:id/approve`

**Purpose:** Admin approves a regularization request and updates attendance records.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body** — empty `{}`

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "status": "approved",
    "attendanceDayId": "string",
    "updatedDayStatus": "present"
  }
}
```

**Business Rules**
- BR-REG-06: Only `pending` → `approved` → `REG_003`
- BR-REG-07: Inside `withTransaction`:
  - `forgotCheckIn`: create `AttendanceSession` with `requestedCheckIn`; create `AttendanceDay` if not exists; recompute day `status`
  - `forgotCheckOut`: find open session for that day; set `checkOut = requestedCheckOut`; recompute day `status`
  - `workAwayFromOffice | officialTravel | clientVisit`: upsert `AttendanceDay { status: 'present', isRegularized: true }` without creating session
- BR-REG-08: Set `attendanceDayId` on regularization request
- BR-REG-09: Audit log `REGULARIZATION_APPROVED`; push notification to employee

---

### 7.7 `PATCH /api/v1/regularizations/:id/reject`

**Purpose:** Admin rejects a regularization request.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body**
```json
{
  "reason": "string"  // optional; shown to employee
}
```

**Business Rules**
- BR-REG-10: Only `pending` → `rejected` → `REG_003`
- BR-REG-11: No attendance changes; audit log `REGULARIZATION_REJECTED`; push notification

---

## 8. Payroll

> **Path parameter convention:** All payroll routes that reference a specific employee use `/:id` where `:id` is the employee's MongoDB ObjectId (24-char hex). The human-readable company `employeeId` (e.g., "EMP001") is never used in URL paths. This eliminates any route collision with static segments like `/payroll/me`. (See BR-PAY-17, BR-EMP-23)

### 8.1 `POST /api/v1/payroll/compute`

**Purpose:** Admin triggers payroll computation for one or all active employees for a given month.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |
| Rate Limit | None (long-running operation) |

**Request Body**
```json
{
  "yearMonth": "2026-06",       // required; YYYY-MM; cannot be future month
  "employeeId": "string"        // optional; if omitted, computes for ALL active employees
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "computed": 45,
    "skipped": 0,
    "errors": [],
    "yearMonth": "2026-06"
  }
}
```

Single employee response:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "employeeId": "string",
    "yearMonth": "2026-06",
    "status": "draft",
    "payableAmount": 47727.27,
    "effectiveWorkingDays": 22,
    "effectivePresentDays": 21,
    "deductions": 2272.73
  }
}
```

**Business Rules**
- BR-PAY-01: `yearMonth` must be current or past month; future → `GEN_001`
- BR-PAY-02: If existing payroll `status: 'finalised'` → `PAY_001` (block recompute for that employee)
- BR-PAY-03: Existing `status: 'draft'` → overwrite (idempotent recompute)
- BR-PAY-04: Payroll formula uses attendance data from `AttendanceDay` collection for the month
- BR-PAY-05: `effectiveWorkingDays = getWorkingDaysBetween(max(monthStart, joinDate), min(monthEnd, leaveDate), workingDays, holidays)`
- BR-PAY-06: `employeeSnapshot` captured at compute time; excludes `passwordHash`
- BR-PAY-07: Bulk compute (no `employeeId`): processes employees in batches of 10; errors for individual employees collected in `errors` array; bulk does not fail on single-employee error
- BR-PAY-08: Audit log `PAYROLL_COMPUTED` written per employee
- BR-PAY-17: When `employeeId` is provided in the body, it is the MongoDB ObjectId; validated against the DB before computation

**Error Responses**

| Code | Condition |
|---|---|
| `PAY_001` | Payroll already finalised (single-employee request only) |
| `GEN_001` | Invalid `yearMonth` or future month |
| `GEN_002` | Employee not found (single-employee request) |
| `GEN_007` | Invalid payroll input (engine validation failed) |

---

### 8.2 `GET /api/v1/payroll`

**Purpose:** Admin — list payroll summaries with filtering.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters**

| Param | Type | Description |
|---|---|---|
| `yearMonth` | `YYYY-MM` | Filter by month |
| `employeeId` | string | Filter by employee |
| `status` | `draft \| finalised` | Filter by status |
| `page` | integer | Default 1 |
| `limit` | integer | Default 20, max 100 |

**Response 200** — paginated list of `PayrollSummary` objects (abbreviated).

---

### 8.3 `GET /api/v1/payroll/me`

**Purpose:** Employee views own payslip history.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee |

**Query Parameters** — `page`, `limit`, `yearMonth` (optional filter).

**Response 200** — paginated list of employee's own payroll summaries.

---

### 8.4 `GET /api/v1/payroll/me/:yearMonth`

**Purpose:** Employee views own payslip for a specific month.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee |

**Path Parameters**

| Param | Type | Description |
|---|---|---|
| `yearMonth` | `YYYY-MM` | Target month |

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "yearMonth": "2026-06",
    "status": "finalised",
    "employeeSnapshot": {
      "employeeId": "EMP001",
      "firstName": "string",
      "lastName": "string",
      "designation": "string | null",
      "monthlySalary": 50000
    },
    "effectiveWorkingDays": 22,
    "effectivePresentDays": 21.5,
    "effectiveLwpDays": 0.5,
    "halfDayLwpDays": 1,
    "paidLeaveDays": 1,
    "absentDays": 0,
    "payableAmount": 48863.64,
    "deductions": 1136.36,
    "finalisedAt": "2026-07-01T10:00:00.000Z"
  }
}
```

**Business Rules**
- BR-PAY-09: Employee can only see own payroll; `status: 'draft'` payrolls visible but labelled as provisional

---

### 8.5 `GET /api/v1/payroll/:id/:yearMonth`

**Purpose:** Admin views specific employee's payroll for a month.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Path Parameters**

| Param | Type | Description |
|---|---|---|
| `:id` | string | Employee MongoDB ObjectId (24-char hex) |
| `:yearMonth` | `YYYY-MM` | Target month |

**Response 200** — full `PayrollSummary` including `joiningDateSnapshot`, `leavingDateSnapshot`, `unfinalisedAt`, etc.

---

### 8.6 `PATCH /api/v1/payroll/:id/:yearMonth/finalize`

**Purpose:** Admin finalises a draft payroll — locks it from further computation.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body** — empty `{}`

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "status": "finalised",
    "finalisedAt": "2026-07-01T10:00:00.000Z",
    "finalisedBy": "string"
  }
}
```

**Business Rules**
- BR-PAY-10: `status: 'draft'` required; already finalised → `PAY_001`
- BR-PAY-11: Audit log `PAYROLL_FINALISED`

---

### 8.7 `PATCH /api/v1/payroll/:id/:yearMonth/unfinalize`

**Purpose:** Admin reverts a finalised payroll to draft status to allow recomputation.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body**
```json
{
  "reason": "string"  // required; min 10 chars; logged in audit
}
```

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "status": "draft",
    "unfinalisedAt": "2026-07-02T11:00:00.000Z",
    "unfinalisedBy": "string"
  }
}
```

**Business Rules**
- BR-PAY-12: `status: 'finalised'` required; if `status: 'draft'` → `PAY_004`
- BR-PAY-13: Sets `unfinalisedAt`, `unfinalisedBy`; status → `draft`
- BR-PAY-14: Audit log `PAYROLL_UNFINALISED` with reason

---

### 8.8 `GET /api/v1/payroll/:id/:yearMonth/export`

**Purpose:** Admin downloads an individual employee's payslip as PDF or Excel.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters**

| Param | Type | Default | Description |
|---|---|---|---|
| `format` | `pdf \| xlsx` | `pdf` | Output format |

**Response 200**
- `Content-Type`: `application/pdf` or `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `Content-Disposition`: `attachment; filename="payslip-EMP001-2026-06.pdf"`

**Business Rules**
- BR-PAY-15: Payroll must exist (`PAY_002` if not found); need not be finalised for export (draft exports are labelled "DRAFT")
- BR-PAY-16: PDF generation via a PDF library (not ExcelJS); Excel via ExcelJS

---

## 9. Notifications

### 9.1 `GET /api/v1/notifications`

**Purpose:** Employee retrieves their notification history.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee, admin (own) |

**Query Parameters** — `page`, `limit`, `isRead` (boolean filter), `type`.

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "type": "leave-approved | leave-rejected | regularization-approved | payroll-finalised | custom",
      "title": "string",
      "body": "string",
      "isRead": false,
      "relatedEntityType": "leaveRequest | regularizationRequest | payrollSummary | null",
      "relatedEntityId": "string | null",
      "createdAt": "2026-06-14T10:00:00.000Z"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 5, "totalPages": 1 }
}
```

---

### 9.2 `PATCH /api/v1/notifications/:id/read`

**Purpose:** Mark a notification as read.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | employee (own only) |

**Request Body** — empty `{}`

**Business Rules**
- BR-NOT-01: Employee can only mark own notifications as read
- BR-NOT-02: Idempotent — marking already-read notification returns 200

---

### 9.3 `PATCH /api/v1/notifications/read-all`

**Purpose:** Mark all unread notifications as read (or a specific subset by ID). Prevents N serial requests for bulk dismissal.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes (if cookie auth) |
| Role | employee, admin (own only) |
| Rate Limit | None |

**Request Body** (optional — omit to mark all):
```json
{
  "ids": ["string", "string"]  // optional; if omitted, marks ALL unread for this employee
}
```

**Response 200**
```json
{
  "success": true,
  "data": { "markedRead": 12 }
}
```

**Business Rules**
- BR-NOT-05: Scoped to authenticated employee only — cannot mark other employees' notifications
- BR-NOT-06: Idempotent — already-read notifications are included in `markedRead` count without error
- BR-NOT-07: If `ids` is provided, only those notification IDs are marked; IDs not belonging to the employee are silently ignored (not errored)
- BR-NOT-08: Uses `updateMany` internally; atomic per employee, not transactional across notification list

---

### 9.4 `POST /api/v1/notifications/fcm-token`

**Purpose:** Flutter app registers or refreshes its FCM push token.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | No (Bearer only) |
| Role | employee, admin |

**Request Body**
```json
{
  "token": "string",           // required; FCM registration token
  "deviceId": "string",        // required; stable device identifier (not fingerprint)
  "platform": "android | ios"  // required
}
```

**Response 200**
```json
{
  "success": true,
  "data": { "message": "FCM token registered." }
}
```

**Business Rules**
- BR-NOT-03: Upsert `fcmTokens` by `{ employeeId, deviceId }`; update `token`, `lastRefreshedAt`, `isActive: true`
- BR-NOT-04: Deactivate old tokens for same device automatically (covered by upsert)

---

## 10. Reports

### 10.1 `GET /api/v1/reports/attendance`

**Purpose:** Admin — paginated attendance data for all employees across a date range (for in-app display before export).

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters**

| Param | Type | Required | Description |
|---|---|---|---|
| `startDate` | `YYYY-MM-DD` | Yes | Range start |
| `endDate` | `YYYY-MM-DD` | Yes | Range end; max 90-day window |
| `employeeId` | string | No | Filter single employee |
| `department` | string | No | Filter by department |
| `status` | string | No | Day status filter |
| `page` | integer | No | Default 1 |
| `limit` | integer | No | Default 20, max 50 |

**Response 200** — paginated list of attendance day records with employee identifiers.

---

### 10.2 `GET /api/v1/reports/attendance/export`

**Purpose:** Admin — download full attendance report as Excel file (streamed).

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters** — same as `GET /reports/attendance` minus pagination (`page`, `limit`).

**Response 200**
- `Content-Type`: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `Content-Disposition`: `attachment; filename="attendance-report-2026-06-01-to-2026-06-30.xlsx"`
- Body: streamed Excel file generated via ExcelJS

**Business Rules**
- BR-REP-01: Max date range for export: 366 days (1 year)
- BR-REP-02: Large exports (>500 employees × >30 days) are streamed to avoid memory pressure
- BR-REP-03: Response does NOT use the standard `{ success, data }` envelope — raw binary response

---

### 10.3 `GET /api/v1/reports/leave`

**Purpose:** Admin — leave data for all employees (paginated, for display).

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters** — `employeeId`, `leaveType`, `status`, `leaveYear`, `startDate`, `endDate`, `page`, `limit`.

---

### 10.4 `GET /api/v1/reports/leave/export`

**Purpose:** Admin — download leave report as Excel.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters** — same as `GET /reports/leave` minus pagination.

**Response** — binary Excel file (same pattern as attendance export).

---

### 10.5 `GET /api/v1/reports/payroll/export`

**Purpose:** Admin — download payroll report for a month as Excel.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters**

| Param | Type | Required | Description |
|---|---|---|---|
| `yearMonth` | `YYYY-MM` | Yes | Target payroll month |
| `status` | `draft \| finalised` | No | Filter by status; default includes both |

**Response** — binary Excel file.

**Business Rules**
- BR-REP-04: Each row = one employee's payroll summary for the month
- BR-REP-05: Draft payroll rows clearly labelled "DRAFT" in the report

---

## 11. Settings

### 11.1 `GET /api/v1/settings`

**Purpose:** Return company settings. Admin sees all fields; employee sees a limited subset.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin (full), employee (limited) |

**Response 200 — admin view**
```json
{
  "success": true,
  "data": {
    "companyName": "string",
    "timezone": "Asia/Kolkata",
    "currency": "INR",
    "workStartTime": "09:00",
    "workEndTime": "18:30",
    "gracePeriodMinutes": 30,
    "requiredDailyMinutes": 540,
    "halfDayThresholdMinutes": 270,
    "workingDays": ["monday","tuesday","wednesday","thursday","friday"],
    "leaveYearStartMonth": 1,
    "geoFence": {
      "latitude": 19.0760,
      "longitude": 72.8777,
      "radiusMeters": 200,
      "isEnabled": true
    },
    "gpsAccuracyThresholdMeters": 100,
    "regularizationLookbackDays": 7,
    "checkinTimestampWindowMinutes": 2,
    "payrollCutoffDay": 1,
    "leaveTypes": {
      "paidLeave": {
        "annualAllocation": 15,
        "carryForward": { "enabled": true, "maxDays": 5, "expiryMonths": 3 },
        "encashable": false
      },
      "sickLeave": { "annualAllocation": 10, "carryForward": { "enabled": false } },
      "casualLeave": { "annualAllocation": 5, "carryForward": { "enabled": false } }
    },
    "attendanceReminderEnabled": true,
    "attendanceReminderTime": "09:30",
    "updatedAt": "2026-06-14T09:00:00.000Z"
  }
}
```

**Employee-visible subset:** `companyName`, `timezone`, `workStartTime`, `workEndTime`, `workingDays`, `leaveYearStartMonth` — no salary-relevant, geo-fence, or GPS settings.

---

### 11.2 `PUT /api/v1/settings`

**Purpose:** Admin updates company settings.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body** — partial update; only provided fields are updated. Same shape as GET response (excluding geo-fence, which has its own endpoint).

**Response 200** — updated settings object.

**Validation Rules**
- `halfDayThresholdMinutes < requiredDailyMinutes` — cross-field; → `SET_001`
- `workStartTime < workEndTime` — cross-field; → `SET_001`
- `workingDays`: non-empty array of valid day names → `SET_001`
- `leaveYearStartMonth`: 1–12 → `SET_001`
- `gracePeriodMinutes`: 0–120
- `regularizationLookbackDays`: 1–30

**Business Rules**
- BR-SET-01: If `leaveYearStartMonth` changed: response includes warning: `"Leave year start month changed. Existing leave records use the previous fiscal year. Cron schedules must be manually updated in vercel.json."`
- BR-SET-02: Audit log `SETTINGS_UPDATED` with before/after snapshot

**Error Responses**

| Code | Condition |
|---|---|
| `SET_001` | Cross-field validation failure |
| `GEN_001` | Field-level validation failure |

---

### 11.3 `GET /api/v1/settings/geofence`

**Purpose:** Admin — get current geofence configuration.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Response 200** — `{ latitude, longitude, radiusMeters, isEnabled, gpsAccuracyThresholdMeters }`

---

### 11.4 `PUT /api/v1/settings/geofence`

**Purpose:** Admin updates geofence configuration.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body**
```json
{
  "latitude": 19.0760,
  "longitude": 72.8777,
  "radiusMeters": 200,
  "isEnabled": true,
  "gpsAccuracyThresholdMeters": 100
}
```

**Validation Rules**
- `latitude`: -90 to 90, required
- `longitude`: -180 to 180, required
- `radiusMeters`: 10–10000, required
- `gpsAccuracyThresholdMeters`: 10–500, required

**Business Rules**
- BR-SET-03: Audit log `GEOFENCE_UPDATED`

---

### 11.5 `GET /api/v1/settings/holidays`

**Purpose:** Return list of configured public holidays.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin, employee |

**Query Parameters** — `year` (default current), `page`, `limit`.

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "date": "2026-08-15",
      "name": "Independence Day",
      "description": "string | null"
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 18, "totalPages": 1 }
}
```

---

### 11.6 `POST /api/v1/settings/holidays`

**Purpose:** Admin adds a public holiday.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Request Body**
```json
{
  "date": "2026-08-15",       // required; YYYY-MM-DD
  "name": "string",           // required; max 100 chars
  "description": "string"     // optional
}
```

**Response 201** — created holiday object.

**Business Rules**
- BR-SET-04: Duplicate date → `GEN_006`
- BR-SET-05: Audit log `HOLIDAY_ADDED`

---

### 11.7 `DELETE /api/v1/settings/holidays/:id`

**Purpose:** Admin removes a public holiday.

| Property | Value |
|---|---|
| Auth Required | Yes |
| CSRF Required | Yes |
| Role | admin only |

**Response 200**
```json
{ "success": true, "data": { "message": "Holiday removed." } }
```

**Business Rules**
- BR-SET-06: Audit log `HOLIDAY_REMOVED`; leave requests affected by this holiday are NOT auto-updated

---

## 12. Audit Logs

### 12.1 `GET /api/v1/audit-logs`

**Purpose:** Admin — paginated audit log with filtering.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Query Parameters**

| Param | Type | Description |
|---|---|---|
| `employeeId` | string | Filter by actor or subject employee |
| `action` | string | Filter by audit action type |
| `entityType` | string | `leaveRequest`, `employee`, `payrollSummary`, etc. |
| `entityId` | string | Filter by specific entity |
| `startDate` | `YYYY-MM-DD` | Log timestamp range start |
| `endDate` | `YYYY-MM-DD` | Log timestamp range end |
| `page` | integer | Default 1 |
| `limit` | integer | Default 20, max 100 |
| `sortBy` | string | `createdAt` (default, only option) |
| `sortOrder` | `asc\|desc` | Default `desc` |

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "action": "LEAVE_APPROVED",
      "actorId": "string",
      "actorRole": "admin",
      "entityType": "leaveRequest",
      "entityId": "string",
      "before": { },
      "after": { },
      "ipAddress": "192.168.1.100",
      "userAgent": "string",
      "createdAt": "2026-06-14T10:00:00.000Z"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 500, "totalPages": 25 }
}
```

**Business Rules**
- BR-AUD-01: Audit logs are read-only via API; no POST, PUT, DELETE endpoints
- BR-AUD-02: `ipAddress` is raw IP from `auditLogs` collection (legal basis documented in architecture); not returned to employee-role requesters
- BR-AUD-03: `before` and `after` fields never contain `passwordHash`

---

### 12.2 `GET /api/v1/audit-logs/:id`

**Purpose:** Admin — single audit log entry.

| Property | Value |
|---|---|
| Auth Required | Yes |
| Role | admin only |

**Response 200** — single audit log document.

---

## 13. Cron Endpoints (Internal)

These endpoints are called by Vercel Cron (defined in `vercel.json`) and are not accessible to authenticated users.

**Protection:** `Authorization: Bearer ${CRON_SECRET}` header — validated in each route handler before any operation.

### 13.1 `POST /api/v1/cron/midnight-session-close`

**Schedule:** `30 20 * * *` UTC (02:00 IST)

**Purpose:** Close all attendance sessions that are still active from the previous day (orphaned sessions from employees who forgot to check out).

**Request Header:** `Authorization: Bearer ${CRON_SECRET}`

**Idempotency:** `systemEvents` collection checked before processing. If a `{ type: 'MIDNIGHT_SESSION_CLOSE', dateString, status: 'success' }` document exists, request is skipped.

**Response 200**
```json
{
  "success": true,
  "data": {
    "closed": 3,
    "skipped": 0,
    "systemEventId": "string"
  }
}
```

---

### 13.2 `POST /api/v1/cron/leave-year-allocation`

**Schedule:** Configurable (depends on `leaveYearStartMonth`); default `0 0 1 1 *` UTC (Jan 1)

**Purpose:** Credit annual leave allocations to all active employees for the new leave year.

**Idempotency:** `systemEvents { type: 'LEAVE_YEAR_ALLOCATION', leaveYear, status: 'success' }` checked. `leaveYearAllocations` unique index provides DB-level double-allocation prevention.

---

### 13.3 `POST /api/v1/cron/carry-forward-expiry`

**Schedule:** `0 0 * * *` UTC (daily midnight)

**Purpose:** Zero out expired carry-forward leave balances and create `leaveTransaction { type: 'carry-forward-expiry' }` records.

**Idempotency:** `systemEvents { type: 'CARRY_FORWARD_EXPIRY', dateString, status: 'success' }` checked.

---

### 13.4 `POST /api/v1/cron/attendance-reminder`

**Schedule:** Matches `companySettings.attendanceReminderTime` (converted to UTC)

**Purpose:** Send push notifications to employees who haven't checked in by the reminder time.

**Idempotency:** `systemEvents { type: 'ATTENDANCE_REMINDER', dateString, status: 'success' }` checked.

---

## 14. TypeScript Schema Definitions

### 14.1 Shared Types

```typescript
// src/lib/types/api.ts

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  warnings?: string[];
}

export interface ApiPaginatedResponse<T> {
  success: true;
  data: T[];
  meta: PaginationMeta;
  warnings?: string[];
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, string>;
  };
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
export type ApiPaginated<T> = ApiPaginatedResponse<T> | ApiErrorResponse;
```

### 14.2 ApiErrorCode Enum

```typescript
// src/lib/errors/ApiErrorCode.ts

export enum ApiErrorCode {
  // AUTH namespace
  INVALID_CREDENTIALS              = 'AUTH_001',
  TOKEN_EXPIRED                    = 'AUTH_002',
  TOKEN_INVALID                    = 'AUTH_003',
  DEVICE_NOT_REGISTERED            = 'AUTH_004',
  DEVICE_FINGERPRINT_MISMATCH      = 'AUTH_005',
  INSUFFICIENT_PERMISSIONS         = 'AUTH_006',
  ACCOUNT_DEACTIVATED              = 'AUTH_007',
  PASSWORD_RESET_TOKEN_EXPIRED     = 'AUTH_008',
  PASSWORD_RESET_TOKEN_INVALID     = 'AUTH_009',
  PASSWORD_CHANGE_REQUIRED         = 'AUTH_010',

  // ATT namespace
  OUTSIDE_GEOFENCE                 = 'ATT_001',
  GPS_ACCURACY_LOW                 = 'ATT_002',
  SESSION_ALREADY_ACTIVE           = 'ATT_003',
  NONCE_REPLAYED                   = 'ATT_004',
  NO_ACTIVE_SESSION                = 'ATT_005',
  GPS_MOCK_DETECTED                = 'ATT_006',
  OUTSIDE_TIMESTAMP_WINDOW         = 'ATT_007',

  // LVE namespace
  LEAVE_BALANCE_INSUFFICIENT       = 'LVE_001',
  LEAVE_DATE_CONFLICT              = 'LVE_002',
  LEAVE_ON_HOLIDAY                 = 'LVE_003',
  LEAVE_ON_WEEKEND                 = 'LVE_004',
  LEAVE_STATUS_INVALID             = 'LVE_005',
  LEAVE_REVOCATION_NOT_ALLOWED     = 'LVE_006',
  LEAVE_CANCELLATION_NOT_ALLOWED   = 'LVE_007',
  LEAVE_TYPE_INVALID               = 'LVE_008',

  // REG namespace
  REGULARIZATION_LOOKBACK_EXCEEDED = 'REG_001',
  REGULARIZATION_DUPLICATE         = 'REG_002',
  REGULARIZATION_STATUS_INVALID    = 'REG_003',

  // PAY namespace
  PAYROLL_ALREADY_FINALISED        = 'PAY_001',
  PAYROLL_NOT_FOUND                = 'PAY_002',
  PAYROLL_COMPUTATION_FAILED       = 'PAY_003',
  PAYROLL_NOT_FINALISED            = 'PAY_004',

  // SET namespace
  SETTINGS_VALIDATION_FAILED       = 'SET_001',

  // GEN namespace
  VALIDATION_ERROR                 = 'GEN_001',
  NOT_FOUND                        = 'GEN_002',
  RATE_LIMITED                     = 'GEN_003',
  INTERNAL_ERROR                   = 'GEN_004',
  SERVICE_UNAVAILABLE              = 'GEN_005',
  CONFLICT                         = 'GEN_006',
  INVALID_PAYROLL_INPUT            = 'GEN_007',
}
```

### 14.3 Request/Response Schemas

```typescript
// src/lib/types/attendance.ts

export interface CheckinRequest {
  latitude: number;
  longitude: number;
  accuracy: number;
  nonce: string;
  timestamp: string;  // ISO 8601 UTC
  // deviceFingerprint NOT in body — transmitted via X-Device-Fingerprint header only
}

// X-Device-Fingerprint header: required; /^[0-9a-f]{64}$/i; read server-side from request.headers

export interface CheckinResponse {
  sessionId: string;
  checkInTimestamp: string;
  dateString: string;
  status: 'checked-in';
  flags: {
    possibleMockGps: boolean;
    outsideGracePeriod: boolean;
  };
}

export interface AttendanceStatusResponse {
  isCheckedIn: boolean;
  todayDateString: string;
  currentSession: {
    sessionId: string;
    checkInTimestamp: string;
    checkInLocation?: { latitude: number; longitude: number };
  } | null;
  todaySummary: {
    totalMinutes: number;
    status: AttendanceDayStatus;
    sessions: Array<{
      sessionId: string;
      checkInTimestamp: string;
      checkOutTimestamp: string | null;
      durationMinutes: number;
      closedBySystem: boolean;
    }>;
  };
}

export type AttendanceDayStatus =
  | 'present' | 'half-day' | 'absent'
  | 'leave' | 'holiday' | 'weekend';
```

```typescript
// src/lib/types/leave.ts

export type LeaveType = 'paidLeave' | 'sickLeave' | 'casualLeave' | 'lwp';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'revoked';
export type LeaveDuration = 'full' | 'half';
export type HalfDayPeriod = 'morning' | 'afternoon';

export interface ApplyLeaveRequest {
  leaveType: LeaveType;
  startDate: string;    // YYYY-MM-DD
  endDate: string;      // YYYY-MM-DD
  duration: LeaveDuration;
  halfDayPeriod?: HalfDayPeriod;
  reason?: string;
}

export interface LeaveBalance {
  currentYear: number;
  carriedForward: number;
  carryForwardExpiry?: string;
  total: number;
}
```

```typescript
// src/lib/types/payroll.ts

export interface PayrollComputeRequest {
  yearMonth: string;      // YYYY-MM
  employeeId?: string;    // omit for bulk computation
}

export interface PayrollSummaryResponse {
  id: string;
  employeeId: string;
  yearMonth: string;
  status: 'draft' | 'finalised';
  employeeSnapshot: {
    employeeId: string;
    firstName: string;
    lastName: string;
    designation: string | null;
    monthlySalary: number;
    joiningDateSnapshot: string;
    leavingDateSnapshot: string | null;
  };
  effectiveWorkingDays: number;
  effectivePresentDays: number;
  effectiveLwpDays: number;
  halfDayLwpDays: number;
  paidLeaveDays: number;
  absentDays: number;
  overtimeDays: number;
  payableAmount: number;    // 2 decimal places; Math.round(value * 100) / 100
  deductions: number;
  finalisedAt: string | null;
  finalisedBy: string | null;
  unfinalisedAt: string | null;
  unfinalisedBy: string | null;
  computedAt: string;
}
```

```typescript
// src/lib/types/auth.ts

export interface LoginRequest {
  email: string;
  password: string;
  deviceFingerprint: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  employee: {
    id: string;
    employeeId: string;
    email: string;
    firstName: string;
    lastName: string;
    role: 'admin' | 'employee';
    requiresPasswordChange: boolean;  // true on first login; Flutter routes to change-password screen
  };
}

export interface ChangePasswordResponse {
  message: string;
  accessToken: string;  // fresh token with requiresPasswordChange: false
}

export interface RefreshRequest {
  refreshToken: string;
  sessionId: string;
}

export interface RefreshResponse {
  accessToken: string;
}

export interface JwtPayload {
  sub: string;                      // employee MongoDB _id
  role: 'admin' | 'employee';
  requiresPasswordChange: boolean;  // Edge Middleware enforces restricted access when true
  iat: number;
  exp: number;
}
```

---

## Appendix A — Endpoint Summary

| # | Method | Route | Role | Auth | Rate Limit |
|---|---|---|---|---|---|
| 1 | POST | `/api/v1/auth/login` | — | No | authLimiter |
| 2 | POST | `/api/v1/auth/refresh` | — | No | — |
| 3 | POST | `/api/v1/auth/logout` | all | Yes | — |
| 4 | POST | `/api/v1/auth/password-reset/request` | — | No | passwordResetLimiter |
| 5 | POST | `/api/v1/auth/password-reset/confirm` | — | No | authLimiter |
| 6 | GET | `/api/v1/auth/me` | all | Yes | — |
| 7 | PATCH | `/api/v1/auth/me/change-password` | all | Yes | authLimiter |
| 8 | GET | `/api/v1/employees` | admin | Yes | — |
| 9 | POST | `/api/v1/employees` | admin | Yes | — |
| 10 | GET | `/api/v1/employees/:id` | admin | Yes | — |
| 11 | PUT | `/api/v1/employees/:id` | admin | Yes | — |
| 12 | PATCH | `/api/v1/employees/:id/activate` | admin | Yes | — |
| 13 | PATCH | `/api/v1/employees/:id/deactivate` | admin | Yes | — |
| 14 | PATCH | `/api/v1/employees/:id/register-device` | admin | Yes | — |
| 15 | PATCH | `/api/v1/employees/:id/reset-device` | admin | Yes | — |
| 16 | GET | `/api/v1/employees/:id/attendance` | admin | Yes | — |
| 17 | POST | `/api/v1/attendance/checkin` | employee, admin | Yes | attendanceLimiter |
| 18 | POST | `/api/v1/attendance/checkout` | employee, admin | Yes | attendanceLimiter |
| 19 | GET | `/api/v1/attendance/status` | all | Yes | — |
| 20 | GET | `/api/v1/attendance/history` | all | Yes | — |
| 21 | GET | `/api/v1/attendance/today` | admin | Yes | — |
| 22 | GET | `/api/v1/attendance/weekly` | all | Yes | — |
| 23 | GET | `/api/v1/attendance/monthly` | all | Yes | — |
| 24 | POST | `/api/v1/leaves` | employee, admin | Yes | — |
| 25 | GET | `/api/v1/leaves` | all | Yes | — |
| 26 | GET | `/api/v1/leaves/:id` | all | Yes | — |
| 27 | PATCH | `/api/v1/leaves/:id/cancel` | employee | Yes | — |
| 28 | GET | `/api/v1/leaves/balance` | all | Yes | — |
| 29 | GET | `/api/v1/leaves/pending` | admin | Yes | — |
| 30 | PATCH | `/api/v1/leaves/:id/approve` | admin | Yes | — |
| 31 | PATCH | `/api/v1/leaves/:id/reject` | admin | Yes | — |
| 32 | PATCH | `/api/v1/leaves/:id/revoke` | admin | Yes | — |
| 33 | POST | `/api/v1/regularizations` | employee, admin | Yes | — |
| 34 | GET | `/api/v1/regularizations` | all | Yes | — |
| 35 | GET | `/api/v1/regularizations/:id` | all | Yes | — |
| 36 | PATCH | `/api/v1/regularizations/:id/withdraw` | employee | Yes | — |
| 37 | GET | `/api/v1/regularizations/pending` | admin | Yes | — |
| 38 | PATCH | `/api/v1/regularizations/:id/approve` | admin | Yes | — |
| 39 | PATCH | `/api/v1/regularizations/:id/reject` | admin | Yes | — |
| 40 | POST | `/api/v1/payroll/compute` | admin | Yes | — |
| 41 | GET | `/api/v1/payroll` | admin | Yes | — |
| 42 | GET | `/api/v1/payroll/me` | employee | Yes | — |
| 43 | GET | `/api/v1/payroll/me/:yearMonth` | employee | Yes | — |
| 44 | GET | `/api/v1/payroll/:id/:yearMonth` | admin | Yes | — |
| 45 | PATCH | `/api/v1/payroll/:id/:yearMonth/finalize` | admin | Yes | — |
| 46 | PATCH | `/api/v1/payroll/:id/:yearMonth/unfinalize` | admin | Yes | — |
| 47 | GET | `/api/v1/payroll/:id/:yearMonth/export` | admin | Yes | — |
| 48 | GET | `/api/v1/notifications` | all | Yes | — |
| 49 | PATCH | `/api/v1/notifications/:id/read` | all | Yes | — |
| 50 | PATCH | `/api/v1/notifications/read-all` | all | Yes | — |
| 51 | POST | `/api/v1/notifications/fcm-token` | all | Yes | — |
| 52 | GET | `/api/v1/reports/attendance` | admin | Yes | — |
| 53 | GET | `/api/v1/reports/attendance/export` | admin | Yes | — |
| 54 | GET | `/api/v1/reports/leave` | admin | Yes | — |
| 55 | GET | `/api/v1/reports/leave/export` | admin | Yes | — |
| 56 | GET | `/api/v1/reports/payroll/export` | admin | Yes | — |
| 57 | GET | `/api/v1/settings` | all | Yes | — |
| 58 | PUT | `/api/v1/settings` | admin | Yes | — |
| 59 | GET | `/api/v1/settings/geofence` | admin | Yes | — |
| 60 | PUT | `/api/v1/settings/geofence` | admin | Yes | — |
| 61 | GET | `/api/v1/settings/holidays` | all | Yes | — |
| 62 | POST | `/api/v1/settings/holidays` | admin | Yes | — |
| 63 | DELETE | `/api/v1/settings/holidays/:id` | admin | Yes | — |
| 64 | GET | `/api/v1/audit-logs` | admin | Yes | — |
| 65 | GET | `/api/v1/audit-logs/:id` | admin | Yes | — |
| 66 | POST | `/api/v1/cron/midnight-session-close` | cron | CRON_SECRET | — |
| 67 | POST | `/api/v1/cron/leave-year-allocation` | cron | CRON_SECRET | — |
| 68 | POST | `/api/v1/cron/carry-forward-expiry` | cron | CRON_SECRET | — |
| 69 | POST | `/api/v1/cron/attendance-reminder` | cron | CRON_SECRET | — |

**Total: 69 endpoints** (65 authenticated API + 4 cron-internal)

---

## Appendix B — Business Rule Index

| ID | Endpoint | Rule |
|---|---|---|
| BR-AUTH-01 to BR-AUTH-29 | Auth endpoints | See Section 3 |
| BR-EMP-01 to BR-EMP-23 | Employee endpoints | See Section 4 |
| BR-ATT-01 to BR-ATT-17 | Attendance endpoints | See Section 5 |
| BR-LVE-01 to BR-LVE-23 | Leave endpoints | See Section 6 |
| BR-REG-01 to BR-REG-11 | Regularization endpoints | See Section 7 |
| BR-PAY-01 to BR-PAY-17 | Payroll endpoints | See Section 8 |
| BR-NOT-01 to BR-NOT-08 | Notification endpoints | See Section 9 |
| BR-REP-01 to BR-REP-05 | Report endpoints | See Section 10 |
| BR-SET-01 to BR-SET-06 | Settings endpoints | See Section 11 |
| BR-AUD-01 to BR-AUD-03 | Audit log endpoints | See Section 12 |

---

## Revision History

| Version | Date | Changes |
|---|---|---|
| v1.0 | 2026-06-14 | Initial API specification — 68 endpoints, 39 error codes, all modules |
| v1.1 | 2026-06-14 | Remediation of 5 HIGH findings — 69 endpoints, 40 error codes; added bulk notification mark-read; removed dual fingerprint transport from checkin; SHA-256 for password reset tokens; forced password change on first login (`requiresPasswordChange`, `AUTH_010`, `JwtPayload`); payroll routes use `:id` (ObjectId) not `:employeeId` |

---

> **Contract changes 2026-11-08** — see `docs/84-security-attendance-hardening.md` §4:
> refresh-token rotation (`POST /auth/refresh` returns `refreshToken`), optional
> `sessionId` on change-password, checkout requires `X-Device-Fingerprint` and (for
> ordinary geofence employees) GPS (`ATT_010`), office-network denial is `ATT_009`,
> cookie-authenticated cross-origin mutations return `403 AUTH_012`,
> `/payroll/me*` returns finalised records only, cron paths accept GET and POST.

> **Contract changes 2026-11-08 (b)** — see `docs/85-missed-checkout-24h-rule-and-acceptance.md`:
> 24-hour missed check-out rule. `GET /attendance/status` adds `currentSession.checkoutDeadline`,
> `unresolvedMissedCheckoutDates`; `forgotCheckout`/`staleSession` now describe an unresolved
> missed check-out on a past day. Sessions add `isActive`, `missedCheckout`; day records add
> `hasUnresolvedMissedCheckout`. `POST /attendance/checkout` at/after the deadline → `422 ATT_011`.
> Admin list rows add `missedCheckout`, `hasUnresolvedMissedCheckout`, `isCheckedIn`, and times are in the
> company timezone. Regularization approve: `REG_007`. Leave apply: past dates allowed only for
> unresolved missed check-out days. Cron returns `sessionsExpired`.
