# 01 — System Architecture
**Workforce Management Platform — Admin Portal + API**
Last updated: 2026-06-14

---

## 1. Final System Architecture

### Overview

Single Next.js 16 application deployed on Vercel serves two responsibilities:

1. **Admin Web Portal** — React UI for HR/admin operations
2. **Backend API** — Route Handlers consumed by the Flutter employee mobile app and the admin portal itself

Each client company receives a fully isolated deployment:

```
┌─────────────────────────────────────────────────────────────────┐
│                        VERCEL (per-client project)              │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Next.js 16 Application                    │  │
│  │                                                            │  │
│  │   React UI (Admin Portal)   │   Route Handlers (API)      │  │
│  │   /app/(admin)/*            │   /app/api/v1/*             │  │
│  │                             │                              │  │
│  │   ┌─────────────────────────────────────────────────┐    │  │
│  │   │                  lib/services/                   │    │  │
│  │   │           (all business logic lives here)        │    │  │
│  │   └─────────────────────────────────────────────────┘    │  │
│  │                             │                              │  │
│  │   ┌──────────────────────────────────────────────────┐   │  │
│  │   │  lib/utils/withTransaction.ts  (session wrapper)  │   │  │
│  │   └──────────────────────────────────────────────────┘   │  │
│  │                             │                              │  │
│  │   ┌─────────────────────────────────────────────────┐    │  │
│  │   │               lib/repositories/                  │    │  │
│  │   │           (all MongoDB queries live here)        │    │  │
│  │   └─────────────────────────────────────────────────┘    │  │
│  │                             │                              │  │
│  │   ┌─────────────────────────────────────────────────┐    │  │
│  │   │                  lib/engines/                    │    │  │
│  │   │   geoFenceEngine  │  payrollEngine  │  reportEngine  │  │
│  │   └─────────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│   middleware.ts (Edge)                                           │
│   JWT token check → rewrite or 401 before Route Handler runs    │
└─────────────────────────┬────────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
   MongoDB Atlas       Firebase        Brevo
   (primary store)    Admin SDK       (transactional
   (replica set —    (FCM push)          email)
   transactions
   supported)
```

### Request Flow — Flutter Employee App

```
Flutter App
  → HTTPS POST /api/v1/attendance/checkin
      → middleware.ts (Edge): verify JWT, reject if invalid
      → Route Handler: parse + validate request body (zod)
          → withAuth(): verify JWT, attach user to context
          → withDeviceCheck(): verify device fingerprint
          → withRateLimit(): check request rate
          → attendanceService.checkin()
              → UsedNonce.create({ nonce }) ← atomic replay prevention (throws on duplicate)
              → geoFenceEngine.validate()
              → attendanceRepository.createSession()   ← partial unique index prevents double-active
              → attendanceRepository.updateDay()
              → notificationService.sendPush()
              → auditService.log()
          → return ApiResponse
```

### Request Flow — Admin Portal

```
Browser (React)
  → Server Component or Client fetch to /api/v1/*
      → Same middleware.ts Edge JWT check
      → Route Handler → service → withTransaction() (if Tier 1) → repository → MongoDB
```

### Request Flow — Multi-Collection Write (Tier 1)

```
leaveService.approve(leaveId, adminId)
  → withTransaction(session => {
      LeaveRequest.findByIdAndUpdate(..., { session })
      User.findOneAndUpdate({ balance check }, $inc, { session })   ← atomic conditional
      LeaveTransaction.create([...], { session })                   ← ledger entry
      AttendanceDay.updateMany(..., { session })
    })
  → notificationService.sendPush()    ← outside transaction (idempotent, non-critical)
  → auditService.log()                ← outside transaction (append-only, non-critical)
```

### Isolation Model

Every client deployment is independent:

| Resource | Per-client |
|---|---|
| Vercel project | ✓ |
| MongoDB Atlas cluster (replica set) | ✓ |
| Environment variables | ✓ |
| Domain | ✓ |
| Firebase project | ✓ |
| Brevo sender identity | ✓ |

---

## 2. Folder Structure

```
company/                              ← this repository
├── src/
│   ├── app/
│   │   ├── (auth)/                   ← unauthenticated route group
│   │   │   └── login/
│   │   │       └── page.tsx
│   │   │
│   │   ├── (admin)/                  ← protected admin route group
│   │   │   ├── layout.tsx            ← sidebar + topbar shell
│   │   │   ├── dashboard/
│   │   │   │   └── page.tsx
│   │   │   ├── employees/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx
│   │   │   ├── attendance/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [employeeId]/
│   │   │   │       └── page.tsx
│   │   │   ├── leave/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx
│   │   │   ├── regularization/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx
│   │   │   ├── payroll/
│   │   │   │   ├── page.tsx
│   │   │   │   └── [month]/
│   │   │   │       └── page.tsx
│   │   │   ├── reports/
│   │   │   │   └── page.tsx
│   │   │   └── settings/
│   │   │       └── page.tsx
│   │   │
│   │   └── api/
│   │       └── v1/                   ← ALL API routes versioned under v1
│   │           ├── auth/
│   │           │   ├── login/
│   │           │   │   └── route.ts
│   │           │   ├── logout/
│   │           │   │   └── route.ts
│   │           │   ├── refresh/
│   │           │   │   └── route.ts
│   │           │   └── password-reset/
│   │           │       ├── request/
│   │           │       │   └── route.ts  ← POST request reset email
│   │           │       └── confirm/
│   │           │           └── route.ts  ← POST submit new password + token
│   │           │
│   │           ├── attendance/
│   │           │   ├── checkin/
│   │           │   │   └── route.ts
│   │           │   ├── status/
│   │           │   │   └── route.ts      ← GET current session + timer anchor
│   │           │   └── history/
│   │           │       └── route.ts
│   │           │
│   │           ├── leave/
│   │           │   ├── route.ts
│   │           │   ├── balance/
│   │           │   │   └── route.ts
│   │           │   └── [id]/
│   │           │       └── route.ts
│   │           │
│   │           ├── regularization/
│   │           │   ├── route.ts
│   │           │   └── [id]/
│   │           │       └── route.ts
│   │           │
│   │           ├── employees/
│   │           │   ├── route.ts
│   │           │   ├── me/
│   │           │   │   └── route.ts
│   │           │   └── [id]/
│   │           │       ├── route.ts
│   │           │       ├── device-reset/
│   │           │       │   └── route.ts
│   │           │       └── password-reset/
│   │           │           └── route.ts
│   │           │
│   │           ├── payroll/
│   │           │   ├── compute/
│   │           │   │   └── route.ts
│   │           │   └── [yearMonth]/
│   │           │       └── route.ts
│   │           │
│   │           ├── reports/
│   │           │   ├── attendance/
│   │           │   │   └── route.ts
│   │           │   ├── leave/
│   │           │   │   └── route.ts
│   │           │   └── payroll/
│   │           │       └── route.ts
│   │           │
│   │           ├── notifications/
│   │           │   ├── route.ts
│   │           │   └── fcm-token/
│   │           │       └── route.ts
│   │           │
│   │           ├── holidays/
│   │           │   ├── route.ts
│   │           │   └── [id]/
│   │           │       └── route.ts
│   │           │
│   │           └── settings/
│   │               └── route.ts
│   │
│   ├── lib/
│   │   ├── db/
│   │   │   └── mongodb.ts
│   │   │
│   │   ├── models/
│   │   │   ├── User.ts
│   │   │   ├── AttendanceDay.ts
│   │   │   ├── AttendanceSession.ts
│   │   │   ├── LeaveRequest.ts
│   │   │   ├── LeaveTransaction.ts              ← v1.1 (C-001)
│   │   │   ├── LeaveYearAllocation.ts           ← v1.1 (F-004 / C-005)
│   │   │   ├── RegularizationRequest.ts
│   │   │   ├── Holiday.ts
│   │   │   ├── CompanySettings.ts
│   │   │   ├── Notification.ts
│   │   │   ├── AuditLog.ts
│   │   │   ├── PayrollSummary.ts
│   │   │   ├── DeviceSession.ts
│   │   │   ├── FcmToken.ts
│   │   │   ├── PasswordResetToken.ts            ← v1.1 (C-003 / S-007)
│   │   │   ├── UsedNonce.ts                     ← v1.1 (C-002 / S-006)
│   │   │   └── SystemEvent.ts                   ← v1.2 (F-006 / C-004)
│   │   │
│   │   ├── repositories/
│   │   │   ├── userRepository.ts
│   │   │   ├── attendanceRepository.ts
│   │   │   ├── leaveRepository.ts
│   │   │   ├── leaveTransactionRepository.ts    ← v1.1
│   │   │   ├── leaveYearAllocationRepository.ts ← v1.1
│   │   │   ├── regularizationRepository.ts
│   │   │   ├── holidayRepository.ts
│   │   │   ├── settingsRepository.ts
│   │   │   ├── notificationRepository.ts
│   │   │   ├── auditRepository.ts
│   │   │   ├── payrollRepository.ts
│   │   │   ├── passwordResetRepository.ts       ← v1.1
│   │   │   ├── nonceRepository.ts               ← v1.1
│   │   │   └── systemEventRepository.ts         ← v1.2
│   │   │
│   │   ├── services/
│   │   │   ├── authService.ts
│   │   │   ├── attendanceService.ts
│   │   │   ├── leaveService.ts
│   │   │   ├── regularizationService.ts
│   │   │   ├── employeeService.ts
│   │   │   ├── payrollService.ts
│   │   │   ├── notificationService.ts
│   │   │   ├── auditService.ts
│   │   │   ├── reportService.ts
│   │   │   └── settingsService.ts               ← v1.1 (F-005)
│   │   │
│   │   ├── engines/
│   │   │   ├── geoFenceEngine.ts
│   │   │   ├── payrollEngine.ts                 ← rounding contract v1.2 (P-001)
│   │   │   └── reportEngine.ts
│   │   │
│   │   ├── middleware/
│   │   │   ├── withAuth.ts
│   │   │   ├── withAdminAuth.ts
│   │   │   ├── withDeviceCheck.ts
│   │   │   └── withRateLimit.ts
│   │   │
│   │   └── utils/
│   │       ├── jwt.ts                           ← dual-secret verify v1.2 (SEC-004)
│   │       ├── hash.ts                          ← hashIpAddress() v1.2 (SEC-003)
│   │       ├── dateUtils.ts                     ← getLeaveYearBoundaries() (F-004)
│   │       ├── apiResponse.ts                   ← ApiErrorCode enum v1.2 (M-003)
│   │       ├── rateLimit.ts                     ← passwordResetLimiter v1.2 (SEC-002)
│   │       ├── deviceFingerprint.ts
│   │       └── withTransaction.ts               ← v1.1 (F-001)
│   │
│   ├── components/
│   │   ├── ui/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   ├── Topbar.tsx
│   │   │   └── PageShell.tsx
│   │   ├── attendance/
│   │   ├── leave/
│   │   ├── employees/
│   │   ├── payroll/
│   │   └── reports/
│   │
│   ├── hooks/
│   │   ├── useAttendance.ts
│   │   ├── useLeave.ts
│   │   └── useEmployees.ts
│   │
│   └── types/
│       └── index.ts
│
├── src/scripts/
│   └── seed.ts                            ← NEW: first-deployment initialization
│
├── middleware.ts
├── next.config.ts
├── tsconfig.json
├── vercel.json                            ← cron job definitions
├── .env.local
├── .env.example
└── docs/
    ├── 01-system-architecture.md
    ├── 02-database-design.md
    ├── 02.1-database-review.md
    ├── 02.2-high-severity-remediation.md
    ├── 02.3-post-remediation-validation.md
    ├── 02.4-medium-severity-remediation.md
    └── 02.5-final-architecture-database-validation.md
```

**Flutter app lives in a separate repository** (`company-mobile`). Targets `/api/v1/*` base path.

---

## 3. Module Structure

Each domain module follows the same vertical slice:

```
Domain Module: Leave (example — Tier 1 write)
──────────────────────────────────────────────
Route Handler          app/api/v1/leave/[id]/route.ts
  ↓ calls
Middleware             withAdminAuth → withRateLimit
  ↓ calls
Service                lib/services/leaveService.ts
  ↓ wraps in
Transaction            lib/utils/withTransaction.ts  ← NEW
  ↓ calls (with session)
Repository × N         lib/repositories/leaveRepository.ts
                       lib/repositories/userRepository.ts
                       lib/repositories/leaveTransactionRepository.ts
                       lib/repositories/attendanceRepository.ts
  ↓ after transaction
Service (no session)   lib/services/notificationService.ts
                       lib/services/auditService.ts
  ↓ queries
Models                 lib/models/LeaveRequest.ts
                       lib/models/User.ts
                       lib/models/LeaveTransaction.ts
                       lib/models/AttendanceDay.ts
  ↓ maps to
MongoDB Atlas          leaveRequests, users, leaveTransactions, attendanceDays
```

### Module Boundaries

| Module | Service | Repository | Models |
|---|---|---|---|
| Auth | authService | userRepository, passwordResetRepository | User, DeviceSession, PasswordResetToken |
| Attendance | attendanceService | attendanceRepository, nonceRepository | AttendanceDay, AttendanceSession, UsedNonce |
| Leave | leaveService | leaveRepository, leaveTransactionRepository, userRepository | LeaveRequest, LeaveTransaction, User |
| Leave Allocation | leaveService (year-end cron) | leaveYearAllocationRepository, leaveTransactionRepository, userRepository | LeaveYearAllocation, LeaveTransaction, User |
| Regularization | regularizationService | regularizationRepository, attendanceRepository | RegularizationRequest, AttendanceSession, AttendanceDay |
| Employee | employeeService | userRepository | User |
| Payroll | payrollService | payrollRepository, attendanceRepository, leaveRepository | PayrollSummary, AttendanceDay, LeaveRequest |
| Notifications | notificationService | notificationRepository | Notification, FcmToken |
| Audit | auditService | auditRepository | AuditLog |
| Reports | reportService | attendanceRepository, leaveRepository, payrollRepository | (reads only) |
| Settings | settingsService | settingsRepository, holidayRepository | CompanySettings, Holiday |
| Cron Tracking | (cron handlers directly) | systemEventRepository | SystemEvent |

### Cross-Module Rules

- Services may call other services (e.g., `leaveService` calls `auditService`, `notificationService`).
- `auditService.log()` and `notificationService.send*()` are always called **outside** the transaction — both are idempotent/non-critical and must not cause transaction rollback on failure.
- Repositories must never call other repositories or services.
- Engines receive data as parameters, return computed results — no DB access.
- Route Handlers never contain business logic. Parse input → call service → return response.
- `withTransaction()` is called inside services, never inside repositories or route handlers.

---

## 4. Transaction Strategy

### Tiers

**Tier 1 — Transaction Required** (multi-collection writes):

| Service Method | Collections Written | Reason |
|---|---|---|
| `leaveService.approve()` | leaveRequests + users + leaveTransactions + attendanceDays | Balance deduction must be atomic with status change |
| `leaveService.reject()` | leaveRequests + users + leaveTransactions | Balance restoration must be atomic |
| `leaveService.cancel()` | leaveRequests + users + leaveTransactions | Balance restoration must be atomic |
| `leaveService.revoke()` | leaveRequests + users + leaveTransactions + attendanceDays | Admin revocation must be fully consistent |
| `regularizationService.approve()` | regularizationRequests + attendanceSessions + attendanceDays | Session creation must be atomic with day update |
| `attendanceService.checkout()` | attendanceSessions + attendanceDays | Duration + day total must be atomic |
| `employeeService.deactivate()` | users + deviceSessions + fcmTokens | Session revocation must be atomic with deactivation |
| `authService.confirmPasswordReset()` | users + passwordResetTokens + deviceSessions | Token mark-used must be atomic with password change |
| `payrollService.compute()` | payrollSummaries + systemEvents | Computation record must be atomic with tracking |
| `leaveAllocationCron.run()` | users + leaveTransactions + leaveYearAllocations + systemEvents | Allocation must be atomic with ledger entry |

**Tier 2 — No Transaction** (single-collection or idempotent):
- Checkin (session insert — uniqueness handled by partial index)
- Notification send
- Audit log insert
- FCM token register
- Nonce claim

### Standard Implementation

```typescript
// src/lib/utils/withTransaction.ts
import mongoose from 'mongoose';

export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession) => Promise<T>
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(fn, {
      readConcern:  { level: 'local' },
      writeConcern: { w: 'majority' },
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}
```

### Atomic Balance Deduction Pattern

Used in every leave approval / deduction path. Prevents negative balances under concurrent requests:

```typescript
// Always inside withTransaction — session passed in
const balanceField = `leaveBalances.${leaveType}.currentYear`;
const carryField   = `leaveBalances.${leaveType}.carriedForward`;

const updated = await User.findOneAndUpdate(
  {
    _id: employeeId,
    $expr: {
      $gte: [
        { $add: [`$${balanceField}`, `$${carryField}`] },
        daysToDeduct,
      ],
    },
  },
  [
    {
      $set: {
        [carryField]: { $max: [0, { $subtract: [`$${carryField}`, daysToDeduct] }] },
        [balanceField]: {
          $max: [
            0,
            {
              $subtract: [
                `$${balanceField}`,
                { $max: [0, { $subtract: [daysToDeduct, `$${carryField}`] }] },
              ],
            },
          ],
        },
      },
    },
  ],
  { new: true, session }
);

if (!updated) throw new AppError('LEAVE_BALANCE_INSUFFICIENT', 'LVE_001');
```

---

## 5. Cron Jobs

Defined in `vercel.json`. All cron handlers are in `app/api/v1/cron/*/route.ts` (admin-inaccessible — protected by `CRON_SECRET` header).

```json
{
  "crons": [
    {
      "path": "/api/v1/cron/midnight-session-close",
      "schedule": "30 20 * * *"
    },
    {
      "path": "/api/v1/cron/leave-year-allocation",
      "schedule": "0 1 1 * *"
    },
    {
      "path": "/api/v1/cron/carry-forward-expiry",
      "schedule": "0 2 * * *"
    },
    {
      "path": "/api/v1/cron/attendance-reminder",
      "schedule": "30 9 * * *"
    }
  ]
}
```

> Note: Times in UTC. Adjust for company timezone in cron handler using `companySettings.timezone`.

### Cron: `midnight-session-close`

```
Trigger: daily at workEndTime + gracePeriodMinutes (company timezone)

1. Load companySettings (workEndTime, gracePeriodMinutes, timezone)
2. Check systemEvents — skip if already ran successfully for today
3. Insert systemEvent { type: 'midnight-session-close', targetKey: today, status: 'running' }
4. Find all AttendanceSessions { isActive: true, 'checkIn.timestamp' < today midnight }
5. For each:
   a. capTime = min(workEndTime timestamp, checkIn.timestamp + 16h)
   b. Set checkOut = { timestamp: capTime, ... }
   c. durationMinutes = (capTime - checkIn) / 60000
   d. closedBySystem = true, systemCloseReason = 'midnight-rollover'
   e. isActive = false
   f. Update AttendanceDay.totalMinutes += durationMinutes, recompute status
   g. Audit: ATTENDANCE_SESSION_SYSTEM_CLOSED
6. Update systemEvent { status: 'success', affectedCount }
```

### Cron: `leave-year-allocation`

```
Trigger: 1st of every month at 01:00 UTC
         Handler checks if today == leave year start (based on leaveYearStartMonth)

1. Load companySettings (leaveYearStartMonth, leaveTypes)
2. Compute current leave year using getLeaveYearBoundaries()
3. Check systemEvents — skip if allocation for this leaveYear already ran
4. Insert systemEvent { type: 'leave-year-allocation', targetKey: leaveYear, status: 'running' }
5. For each active employee:
   a. Compute effectiveAllocation (pro-rated if dateOfJoining is within the leave year)
   b. withTransaction:
      - Update users.leaveBalances.*.currentYear = effectiveAllocation
      - Insert LeaveYearAllocation document
      - Insert LeaveTransaction { type: 'annual-allocation' or 'pro-rated-allocation' }
6. Update systemEvent { status: 'success' }
```

### Cron: `carry-forward-expiry`

```
Trigger: daily at 02:00 UTC

1. Find users where any leaveBalances.*.carryForwardExpiry < today AND carriedForward > 0
2. For each:
   withTransaction:
     - Zero out carriedForward, clear carryForwardExpiry
     - Insert LeaveTransaction { type: 'carry-forward-expiry', days: -expiredAmount }
3. Audit log
```

---

## 6. Security Policies

### 6.1 CSRF Protection (F-008)

Admin portal authenticates via httpOnly cookie. Three-layer CSRF strategy — no external library required.

**Layer 1 — `SameSite=Strict` cookie:**
```typescript
// lib/utils/jwt.ts
export function buildAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,   // blocks all cross-origin requests
    path: '/',
    maxAge: 15 * 60,               // 15 min access token
  };
}
```

**Layer 2 — `Origin` header validation in Edge Middleware:**
```typescript
// middleware.ts (Edge) — admin cookie-auth requests only
const origin  = request.headers.get('origin');
const appUrl  = process.env.NEXT_PUBLIC_APP_URL;
const hasCookie = request.cookies.has('session');
const hasBearer = request.headers.get('authorization')?.startsWith('Bearer ');

if (hasCookie && !hasBearer && origin && origin !== appUrl) {
  return NextResponse.json({ success: false, error: { code: 'AUTH_006', message: 'CSRF rejected' } }, { status: 403 });
}
```

**Layer 3 — Flutter is not affected:** Flutter sends `Authorization: Bearer` header. Browsers cannot set custom `Authorization` headers cross-origin without a CORS preflight, which is already restricted to known origins.

---

### 6.2 JWT Secret Rotation (SEC-004)

`JWT_SECRET_PREVIOUS` holds the prior secret during a rotation window. Verification tries current secret first, falls back to previous — zero user disruption.

> **Correction (2026-11-08, docs/84):** `JWT_SECRET_PREVIOUS` is honoured only while `JWT_SECRET_PREVIOUS_EXPIRES_AT` is set to a time at most 24 hours ahead, never for expired tokens, and **must never contain a compromised key**. The 7-day window described in this document no longer applies.


```typescript
// lib/utils/jwt.ts
const CURRENT  = new TextEncoder().encode(process.env.JWT_SECRET!);
const PREVIOUS = process.env.JWT_SECRET_PREVIOUS
  ? new TextEncoder().encode(process.env.JWT_SECRET_PREVIOUS)
  : null;

export async function verifyAccessToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, CURRENT);
    return payload;
  } catch {
    if (PREVIOUS) {
      const { payload } = await jwtVerify(token, PREVIOUS);
      return payload;
    }
    throw new AppError('TOKEN_INVALID', 'AUTH_003');
  }
}
// Same pattern: JWT_REFRESH_SECRET / JWT_REFRESH_SECRET_PREVIOUS
```

**Rotation procedure (zero-downtime):**
```
1. JWT_SECRET_PREVIOUS = current JWT_SECRET   (Vercel env update)
2. JWT_SECRET          = new 64-char secret   (Vercel env update)
3. Redeploy (~30s)
4. Old tokens still verify via PREVIOUS
5. After 7 days (max refresh token TTL): remove JWT_SECRET_PREVIOUS
```

---

### 6.3 IP Address Privacy Policy (SEC-003)

| Collection | Field | Storage | Legal Basis |
|---|---|---|---|
| `auditLogs` | `metadata.ipAddress` | Raw IP | Fraud investigation / operational security (legitimate interest; 7-year retention) |
| `deviceSessions` | `ipAddressHash` | HMAC-SHA256 truncated to 16 hex chars | Session correlation for security incidents |

```typescript
// lib/utils/hash.ts
import crypto from 'crypto';

export function hashIpAddress(ip: string): string {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET!)
    .update(ip)
    .digest('hex')
    .slice(0, 16);
}
```

Call `hashIpAddress(clientIp)` in `authService.login()` / `authService.refresh()` before storing in `deviceSessions`.

---

### 6.4 Password Reset Rate Limiting (SEC-002)

Separate rate limiter; always returns HTTP 200 (prevents email enumeration).

```typescript
// lib/utils/rateLimit.ts
import { Ratelimit } from '@upstash/ratelimit';
import { redis } from './redis';

export const passwordResetLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, '1h'),
  prefix: 'ratelimit:pwd-reset',
});

// POST /api/v1/auth/password-reset/request handler:
const [byEmail, byIp] = await Promise.all([
  passwordResetLimiter.limit(`email:${normalizedEmail}`),
  passwordResetLimiter.limit(`ip:${clientIp}`),
]);
// Whether limited or not — return identical 200 response:
return ApiResponse.ok({ message: 'If that email exists, a reset link has been sent.' });
// Never return 429 on this endpoint — would confirm the email exists + that it's being targeted
```

---

### 6.5 FCM Token Lifecycle (I-006)

**Reactive cleanup** — on FCM error in `notificationService`:
```typescript
try {
  await firebaseAdmin.messaging().send(message);
} catch (err: any) {
  if (err.code === 'messaging/registration-token-not-registered') {
    await FcmToken.findOneAndUpdate({ token: message.token }, { isActive: false });
  }
  // notification failure must NOT propagate — never throw here
}
```

**Proactive cleanup** — TTL index on `fcmTokens.lastRefreshedAt` (90 days). Flutter must refresh the FCM token on app launch:
```
POST /api/v1/notifications/fcm-token
Body: { token: string, deviceFingerprint: string, platform: 'android' | 'ios' }
→ Upserts FcmToken, updates lastRefreshedAt
```

---

## 7. API Contracts

### 7.1 Attendance Status Endpoint (A-002)

```typescript
// GET /api/v1/attendance/status
// Response type: AttendanceStatusResponse

export interface AttendanceStatusResponse {
  isCheckedIn: boolean;
  currentSession?: {
    sessionId: string;
    checkInTimestamp: string;     // ISO 8601 — Flutter rebuilds elapsed timer from this
    dateString: string;
    totalMinutesToday: number;    // sum of durationMinutes from all prior closed sessions today
  };
  todaySummary: {
    status: AttendanceDayStatus;  // 'present' | 'absent' | 'half-day' | 'leave' | etc.
    totalMinutes: number;         // cumulative across all sessions today
    requiredMinutes: number;
    overtimeMinutes: number;
  };
}
```

**Flutter behaviour on app launch:**
```
1. GET /api/v1/attendance/status
2. isCheckedIn = true  → set timer anchor = currentSession.checkInTimestamp
                         display elapsed = now() − checkInTimestamp
                         add totalMinutesToday for cumulative display
3. isCheckedIn = false → show "Not checked in"
                         display todaySummary.totalMinutes as today's recorded time
```

---

### 7.2 API Error Code Catalogue (M-003)

All Route Handlers return errors in a uniform envelope:
```json
{ "success": false, "error": { "code": "LVE_001", "message": "...", "details": {} } }
```

```typescript
// src/lib/utils/apiResponse.ts
export enum ApiErrorCode {
  // Auth
  INVALID_CREDENTIALS              = 'AUTH_001',
  TOKEN_EXPIRED                    = 'AUTH_002',
  TOKEN_INVALID                    = 'AUTH_003',
  DEVICE_NOT_REGISTERED            = 'AUTH_004',
  DEVICE_FINGERPRINT_MISMATCH      = 'AUTH_005',
  INSUFFICIENT_PERMISSIONS         = 'AUTH_006',
  ACCOUNT_DEACTIVATED              = 'AUTH_007',
  PASSWORD_RESET_TOKEN_INVALID     = 'AUTH_008',
  PASSWORD_RESET_TOKEN_EXPIRED     = 'AUTH_009',

  // Attendance
  OUTSIDE_GEOFENCE                 = 'ATT_001',
  GPS_ACCURACY_LOW                 = 'ATT_002',
  SESSION_ALREADY_ACTIVE           = 'ATT_003',
  NONCE_REPLAYED                   = 'ATT_004',
  NO_ACTIVE_SESSION                = 'ATT_005',
  ATTENDANCE_DAY_LOCKED            = 'ATT_006',
  OUTSIDE_TIMESTAMP_WINDOW         = 'ATT_007',

  // Leave
  LEAVE_BALANCE_INSUFFICIENT       = 'LVE_001',
  LEAVE_DATE_CONFLICT              = 'LVE_002',
  LEAVE_ON_HOLIDAY                 = 'LVE_003',
  LEAVE_ON_WEEKEND                 = 'LVE_004',
  LEAVE_STATUS_TRANSITION_INVALID  = 'LVE_005',
  LEAVE_REVOCATION_NOT_ALLOWED     = 'LVE_006',
  LEAVE_CANCELLATION_NOT_ALLOWED   = 'LVE_007',

  // Regularization
  REGULARIZATION_LOOKBACK_EXCEEDED = 'REG_001',
  REGULARIZATION_DUPLICATE         = 'REG_002',
  REGULARIZATION_STATUS_INVALID    = 'REG_003',

  // Payroll
  PAYROLL_ALREADY_FINALISED        = 'PAY_001',
  PAYROLL_PERIOD_NOT_CLOSED        = 'PAY_002',
  PAYROLL_ALREADY_EXISTS           = 'PAY_003',

  // Settings
  SETTINGS_VALIDATION_FAILED       = 'SET_001',

  // General
  NOT_FOUND                        = 'GEN_001',
  VALIDATION_ERROR                 = 'GEN_002',
  RATE_LIMITED                     = 'GEN_003',
  INTERNAL_ERROR                   = 'GEN_004',
  RESOURCE_CONFLICT                = 'GEN_005',
  OPERATION_NOT_ALLOWED            = 'GEN_006',
}

export class ApiResponse {
  static ok<T>(data: T, status = 200): Response {
    return Response.json({ success: true, data }, { status });
  }
  static error(code: ApiErrorCode, message: string, status: number, details?: unknown): Response {
    return Response.json({ success: false, error: { code, message, details } }, { status });
  }
}

export const notFound    = (msg = 'Not found') => ApiResponse.error(ApiErrorCode.NOT_FOUND, msg, 404);
export const forbidden   = (msg = 'Forbidden') => ApiResponse.error(ApiErrorCode.INSUFFICIENT_PERMISSIONS, msg, 403);
export const rateLimit   = ()                  => ApiResponse.error(ApiErrorCode.RATE_LIMITED, 'Too many requests', 429);
export const serverError = ()                  => ApiResponse.error(ApiErrorCode.INTERNAL_ERROR, 'Internal error', 500);
export const badRequest  = (code: ApiErrorCode, msg: string, details?: unknown) => ApiResponse.error(code, msg, 400, details);
```

Flutter maps `error.code` to a localised user-facing string. `error.message` is English and developer-facing.

---

### 7.3 Payroll Engine Rounding Contract (P-001)

```typescript
// lib/engines/payrollEngine.ts — canonical computation order
function computePayroll(input: PayrollInput): PayrollOutput {
  // All intermediates at FULL float precision — never round early
  const perDaySalary   = input.monthlySalary / input.effectiveWorkingDays;
  const deductibleDays = input.effectiveLwpDays + input.absentDays;
  const deductions     = deductibleDays * perDaySalary;

  // perDaySalary stored at 4dp for display; engine always recomputes from source values
  const perDaySalaryStored = Math.round(perDaySalary * 10_000) / 10_000;

  // payableAmount is the ONLY rounded-at-storage value
  const payableAmount = Math.round(Math.max(0, input.monthlySalary - deductions) * 100) / 100;

  return { perDaySalary: perDaySalaryStored, deductions, payableAmount };
}
// Rule: deductions stored at full float. payableAmount is the legal amount — rounded 2dp.
```

---

## 8. Technology Stack Validation

### Core Stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Framework | Next.js | 16.2.9 | App Router, Route Handlers, versioned under `/api/v1/`. **Read `node_modules/next/dist/docs/` before coding.** |
| UI | React | 19.2.4 | Server Components default. Client Components via `'use client'`. |
| Styling | Tailwind CSS | 4.x | CSS-first config. No `tailwind.config.js`. |
| Language | TypeScript | 5.x | Migrate from current JS setup on project start. |
| Database ORM | Mongoose | 8.x | Connection cached via singleton. Transactions via `session.withTransaction()` — requires Atlas replica set (always true on Atlas). |
| Database | MongoDB Atlas | 8.x | M0 free tier for dev. M10+ (replica set, transactions) for production. |

### Auth & Security

| Package | Purpose | Notes |
|---|---|---|
| `jose` | JWT sign/verify | Use `jose`, not `jsonwebtoken` — Edge Middleware compat (Web Crypto API). |
| `bcryptjs` | Password + token hashing | Use `bcryptjs`, not `bcrypt` — no native bindings, works on Vercel. |
| `zod` | Request validation | Schema-first for all Route Handler inputs. `affectedDates` never accepted from client. |

### Infrastructure Services

| Service | SDK / Method | Notes |
|---|---|---|
| MongoDB Atlas | `mongoose` | Singleton connection. `maxPoolSize: 10`. Transactions require replica set — use M10+ in production. |
| Firebase FCM | `firebase-admin` | Server-only. Singleton init. Service account JSON in env (base64). |
| Brevo | REST API via `fetch` | `POST https://api.brevo.com/v3/smtp/email`. |
| Rate Limiting | `@upstash/ratelimit` + `@upstash/redis` | Stateless serverless — in-memory rate limiting does not work. Limits: auth (10/min), attendance (60/min), password-reset (3/hr per email AND 3/hr per IP, dual-keyed). Password reset always returns HTTP 200 regardless of limit — prevents email enumeration. |

### Report Generation

| Package | Purpose | Notes |
|---|---|---|
| `exceljs` | Excel (.xlsx) | Pure JS, works on Vercel. Stream buffer in Route Handler response. |
| Built-in | CSV | No library. Construct CSV string in `reportEngine.ts`. |

### Admin Portal UI

| Package | Purpose |
|---|---|
| `shadcn/ui` | Component library (CLI install) |
| `@tanstack/react-table` | Data tables |
| `recharts` | Charts |
| `date-fns` | Date utilities + leave year boundary computation |
| `react-hook-form` + `zod` | Forms |

---

## 9. Dependency List

### Runtime Dependencies

```json
{
  "dependencies": {
    "next": "16.2.9",
    "react": "19.2.4",
    "react-dom": "19.2.4",

    "mongoose": "^8.0.0",

    "jose": "^5.0.0",
    "bcryptjs": "^2.4.3",
    "zod": "^3.22.0",

    "firebase-admin": "^12.0.0",

    "exceljs": "^4.4.0",
    "date-fns": "^3.6.0",

    "@upstash/ratelimit": "^2.0.0",
    "@upstash/redis": "^1.28.0",

    "@tanstack/react-table": "^8.17.0",
    "recharts": "^2.12.0",
    "react-hook-form": "^7.51.0",
    "@hookform/resolvers": "^3.3.0"
  }
}
```

### Dev Dependencies

```json
{
  "devDependencies": {
    "@tailwindcss/postcss": "^4",
    "tailwindcss": "^4",

    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/bcryptjs": "^2.4.6",

    "eslint": "^9",
    "eslint-config-next": "16.2.9",

    "babel-plugin-react-compiler": "1.0.0"
  }
}
```

### Environment Variables

```bash
# MongoDB
MONGODB_URI=mongodb+srv://...

# JWT
JWT_SECRET=<64-char random string>
JWT_SECRET_PREVIOUS=<previous secret for rotation — empty on first deploy>
JWT_REFRESH_SECRET=<64-char random string>

# Firebase Admin
FIREBASE_SERVICE_ACCOUNT_BASE64=...

# Brevo
BREVO_API_KEY=...
BREVO_SENDER_EMAIL=hr@company.com
BREVO_SENDER_NAME=Company HR

# Upstash (rate limiting)
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...

# Cron protection
CRON_SECRET=<32-char random string>

# App
NEXT_PUBLIC_APP_URL=https://company.vercel.app
NEXT_PUBLIC_API_VERSION=v1

# JWT rotation (previous secret — empty on first deploy; set during rotation; remove after 7 days)
JWT_SECRET_PREVIOUS=
JWT_REFRESH_SECRET_PREVIOUS=

# Seed script only (not runtime — exclude from Vercel env)
# SEED_ADMIN_EMAIL=admin@company.com
# SEED_COMPANY_NAME=Acme Corp
```

---

## 10. Deployment & Initialization

### First-Deployment Checklist (per client)

1. Create MongoDB Atlas M10+ cluster (replica set required for transactions)
2. Create Vercel project, link to this repo
3. Set all environment variables in Vercel dashboard (see env var list in Section 9)
4. Deploy
5. Run seed script:
   ```bash
   MONGODB_URI=<prod-uri> SEED_ADMIN_EMAIL=admin@company.com SEED_COMPANY_NAME="Acme Corp" npx tsx src/scripts/seed.ts
   ```
   Script is **idempotent** — safe to run multiple times. Actions:
   - Validates all required env vars present
   - Upserts `companySettings` singleton (`_id: 'company-settings'`) via `$setOnInsert` — never overwrites existing
   - Creates initial admin user if none exists; prints temporary password to stdout only — never logged or stored
   - Default settings: 15 PL / 10 SL / 5 CL allocation, 5-day work week, IST timezone, geo-fence disabled
6. Admin logs in, updates: `workStartTime`, `workEndTime`, `gracePeriodMinutes`, `leaveYearStartMonth`, geo-fence coordinates, leave type configs, company name/logo
7. Admin creates employee records
8. Trigger `leave-year-allocation` cron manually via `POST /api/v1/cron/leave-year-allocation` with `Authorization: Bearer <CRON_SECRET>` for current year

### JWT Secret Rotation (post-deployment)

See Section 6.2 for full procedure. Summary:
```
1. Set JWT_SECRET_PREVIOUS = current JWT_SECRET
2. Set JWT_SECRET = new secret
3. Redeploy
4. After 7 days: clear JWT_SECRET_PREVIOUS
```

### API Versioning

All Flutter app requests target `/api/v1/`. When breaking API changes are needed:
- Add `/api/v2/` routes alongside `/api/v1/`
- Keep `/api/v1/` operational until all mobile clients update
- Deprecation notice via app update + `Sunset` response header on old routes

---

## 11. Open Questions

| # | Question | Impact |
|---|---|---|
| 1 | Admin portal: Server Components for data fetching vs client-side fetch? | Performance + security boundary |
| 2 | Company logo / branding for email templates? | Brevo template design |
| 3 | Max GPS accuracy threshold for blocking checkin? (proposed: 100m) | geoFenceEngine config |
| 4 | Do deactivated employees retain historical data permanently? | Data retention policy |
| 5 | Is Upstash acceptable as additional service for rate limiting? | Infrastructure decision |
| 6 | Should payroll computation run on a monthly cron in addition to manual trigger? | vercel.json cron config |
| 7 | Should half-day leave specify morning or afternoon period? | LeaveRequest schema (MEDIUM L-003) |

---

## 12. Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| v1.0 | 2026-06-14 | Initial Design | Original architecture: layered service architecture on Next.js 16, MongoDB Atlas, Flutter mobile, Vercel deployment |
| v1.2 | 2026-06-14 | Medium Severity Remediation | Security Policies section added (CSRF 3-layer strategy, JWT rotation procedure, IP PII policy, password reset rate limiting); API Contracts section added (attendance status response, ApiErrorCode enum, payroll rounding contract); `SystemEvent.ts` + `systemEventRepository.ts` added; `systemEventRepository.ts` in cron tracking module; `rateLimit.ts` `hashIpAddress()` added to utils; `JWT_REFRESH_SECRET_PREVIOUS` env var added; seed script fully specified; sections renumbered 6→8 12→12 |
| v1.1 | 2026-06-14 | High Severity Remediation | API routes versioned to `/api/v1/`; `withTransaction.ts` added; transaction strategy (Tier 1/2) defined; `settingsService.ts` added; `src/scripts/seed.ts` added; 4 new model files (LeaveTransaction, LeaveYearAllocation, PasswordResetToken, UsedNonce); 4 new repository files; cron jobs section added (midnight-session-close, leave-year-allocation, carry-forward-expiry); `JWT_SECRET_PREVIOUS` and `CRON_SECRET` env vars added; deployment checklist added |
