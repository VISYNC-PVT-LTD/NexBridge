# 85 — 24-Hour Missed Check-out Rule & Manual Acceptance Readiness (2026-11-08)

Status: **local, uncommitted, undeployed.** Verified with unit tests, route tests
and an isolated real MongoDB replica set (controlled clock). Not yet verified on
a phone, a deployed Vercel instance or the real database.

---

## 1. The rule

| | Behaviour |
|---|---|
| Deadline | `checkIn + 24 h`. Boundary inclusive: **at** the deadline the session is missed. |
| Before the deadline | Session is open. Timer runs. Check-out is accepted (it is a real punch, even if long). A second check-in is refused (`ATT_003`) — the open session must be checked out first, even on the next calendar day. |
| At / after the deadline | The session becomes a **missed check-out**: `isActive:false`, `closedBySystem:true`, `systemCloseReason:'missed-checkout'`, `checkOut:null`, `durationMinutes:0`, `missedCheckoutDeadline`, `missedCheckoutDetectedAt`. The original check-in is untouched. An `ATTENDANCE_MISSED_CHECKOUT` audit entry is written. |
| Timer | Resets to **00:00:00** (mobile resets locally at the deadline using `currentSession.checkoutDeadline` and re-syncs; the server never reports the session as checked in). It never shows 24:00:00 or more. |
| Punch-out display | None. Mobile shows "Out: — missed (no check-out within 24 h)"; admin web shows "Missed (unresolved)". No checkout time and no worked minutes are invented. |
| Day status | The check-in day becomes **absent** with `hasUnresolvedMissedCheckout:true` — unless that day is already `leave`, `lwp`, `holiday`, `weekend` or regularized (never overwritten). Minutes from *other* completed sessions that day remain recorded but the status is absent (see §6 decision 1). |
| Check-out after the deadline | `422 ATT_011` "The 24-hour check-out window … has passed …". |
| New day | Allowed immediately once the deadline has passed. |
| Resolution | **Regularization** `forgotCheckOut` with the employee's actual check-out time (must be after the check-in and within 24 h of it, else `REG_007`), approved by an HR admin → session corrected (attributed `admin-force-close`), day recomputed from the approved time, flag cleared. **Or leave** for that date: back-dated leave is now accepted *only* for working days that carry an unresolved missed check-out, within `regularizationLookbackDays`; approval sets the day to leave and clears the flag; revoking that leave restores absent + unresolved. |
| Payroll | No payroll rule was added. An unresolved missed check-out day is simply an `absent` day under the **existing** payroll rules. Payroll compute applies the 24-hour rule first, so an overdue open session never counts as worked time. |

### What changed from before (and why)
Previously a forgotten session was **closed with a fabricated punch-out** at the
company work-end time (capped at 16 h) and those minutes were credited — and a
check-in on a new calendar day auto-closed a session that was only a few hours
old. That contradicts the requirement (no fabricated punch-out / hours). The
earlier "work-end crediting" (docs/84 §3 "Forgotten checkouts") is **removed**.
Legacy sessions already closed that way keep `systemCloseReason:'midnight-rollover'`;
they are not rewritten.

---

## 2. Enforcement and timing

* `reconcileMissedCheckouts()` applies the rule to overdue sessions. It is called
  at the start of: check-in, check-out, status, history, weekly, monthly, admin
  today, admin list, regularization create, payroll compute and the attendance /
  summary / dashboard reports. So users and admins **always see the rule applied
  on time**, regardless of the cron.
* The nightly cron (`/admin/cron/session-auto-close`, GET+POST, `CRON_SECRET`)
  sweeps everything once a day and is idempotent: late, repeated or concurrent
  runs are harmless. It is no longer skipped after its first run of the day.
* Every transition is conditional (`isActive:true` and still overdue) inside a
  transaction → concurrent check-out vs. sweep vs. read produce one consistent
  outcome; the audit entry is written once.
* No in-memory timers: everything is derived from the stored check-in time, so
  app or server restarts do not matter.
* **Remaining delay:** the stored database state for an employee nobody looks at
  changes at the next read or the next cron run (Vercel Hobby crons are daily).
  Every API response is still correct. Anything reading the database directly
  (exports by hand, BI tools) may see a still-open session for up to ~24 h after
  the deadline. Hourly crons need a paid Vercel plan (owner decision).

---

## 3. Admin attendance settings inventory

| Setting | API | Validation | Used by |
|---|---|---|---|
| timezone | `PATCH /settings`, `/settings/company` | **IANA zone (new)** | all date/day computations |
| workStartTime / workEndTime | `/settings`, `/settings/shift` | **00:00–23:59 (new)**, start ≠ end (new) | late arrival; work-end no longer used for closing sessions |
| lateArrivalGraceMinutes | both | 0–120 | late flag (e2e-tested) |
| halfDayLateCheckInTime | `/settings/shift` | HH:MM | half-day cap (e2e-tested) |
| requiredDailyMinutes / halfDayThresholdMinutes | `/settings/shift` | ranges; **threshold ≤ required (new)** | present/half-day/absent (e2e-tested) |
| workingDays | both | 1–7 valid days | weekend status, leave dates (e2e-tested) |
| geoFence (lat, lng, radius, enabled) | both | ranges | check-in/out location (e2e-tested) |
| gpsAccuracyThresholdMeters | `/settings/company` | 10–5000 | check-in/out (e2e-tested) |
| checkinTimestampWindowMinutes | `/settings/company` | 1–60 | clock-skew window |
| attendanceValidationMode / allowedOfficeIps | `PATCH /settings` | enum / IPv4 list | office-IP mode (e2e-tested) |
| regularizationLookbackDays | `/settings/company` | 1–90 | regularization window, missed-checkout leave window, status banner |
| holidays | `/settings/holidays` | date/name/type | holiday status (e2e-tested) |
| **sessionAutoClosePaddingMinutes, attendanceReminderEnabled, attendanceReminderTime, payrollCutoffDay** | `/settings/shift`, `/settings/company` | ranges | **Stored but not used by any attendance/payroll code.** Not shown in the admin settings UI. |

---

## 4. Client behaviour notes (mobile)
* Offline / slow network: check-in/out show the existing network sheet; buttons
  are disabled while submitting; each tap sends a new nonce, the server allows only
  one active session (duplicate tap → `ATT_003`), a retried identical request →
  `ATT_004`; pull-to-refresh/reconcile shows the server truth.
* Refresh failures other than 401/403 (429, 5xx, no signal) keep the session.
* Employee **web** check-in/out does not exist (not built). Background location
  tracking does not exist; remote snapshots are foreground-only.

---

## 5. Manual simulation of 24 hours (no waiting, no production endpoint)
`apps/admin/scripts/dev/shift-open-session.ts` moves **one test account's open
session** back by N hours on a **test database** (refuses production, Vercel,
"prod" DB names, non-test e-mail domains, missing opt-in). It writes a
`TEST_CLOCK_SHIFT` audit entry. See the manual checklist in the session report.

---

## 6. Owner decisions / blockers
1. **Multi-session day:** if an employee completed one session (e.g. 09–13) and the
   next session is missed, the whole day is marked absent (literal rule). Alternative:
   derive status from the completed minutes. Decide.
2. **Back-dated leave** is now allowed only to resolve a missed check-out (narrow
   exception to "no past-date leave"). Confirm this is acceptable HR policy.
3. Whether payroll finalisation should be **blocked or warned** while unresolved
   missed check-outs exist in the month (currently: they count as absent).
4. Whether a missed check-out older than `regularizationLookbackDays` needs another
   resolution path (currently: none — stays absent).
5. A real check-out between work-end and 24 h is accepted as worked time (e.g. a
   23 h session if the employee checks out the next morning). Consider an admin
   review flag for unusually long sessions.
6. Cron frequency (daily on Hobby) — see §2.
