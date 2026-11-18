# 86 — Attendance: Open Business-Policy Questions (2026-11-14)

Status: **questions only — no decision has been made and no behaviour was changed
for them.** Code comments that say "see docs/86 open rules" point here. Each
section records what the code does today (verified by reading the code at
branch `feature/bug-fix-and-optimization`), why it is ambiguous, and what the
business owner needs to decide. The options are listed so the decision is quick;
none is a recommendation to implement without sign-off.

Who should answer: HR / payroll owner (Q2, Q3, Q6) and operations owner (Q1).

---

## Q1. Are overnight shifts required?

**Today**

- Settings accept a shift whose end is earlier than its start (for example
  22:00 → 06:00). `workStartTime === workEndTime` is rejected.
  (`SettingsService.updateSettings`)
- The half-day late check-in cut-off is compared as minutes of the *same*
  calendar day. For an overnight shift the settings validation therefore
  requires the cut-off to be after the start and before midnight. Otherwise
  every check-in would be capped to half-day.
- A session belongs to the date of its **check-in** in company time. A
  22:00 → 06:00 session stays on the first date (covered by the "month
  boundary" end-to-end test).
- Required daily minutes are derived from the shift times. For a shift that
  crosses midnight, the subtraction is negative and falls back to the stored
  value (doc 71, "Overnight shifts").
- The 24-hour missed check-out rule and the late-arrival calculation were
  designed and tested for day shifts only. Late arrival, early leaving and
  reminders have **not** been verified for a shift that crosses midnight.

**Why it matters:** if overnight shifts are real, several calculations need a
"shift day" concept instead of the calendar day. If they are not, allowing them
in settings is a trap: an admin could save a shift that the rest of the system
does not handle correctly.

**Decision needed**

1. Not needed → reject `end < start` in settings (simplest, safest).
2. Needed → specify: which date the shift belongs to, late/half-day rules, how
   required minutes are counted, reminder times, and the missed check-out
   window. Then implement and test it as a separate piece of work.

---

## Q2. Forgot check-in **without** a check-out time

**Today**

- The API requires `requestedCheckIn` for `forgotCheckIn`; `requestedCheckOut`
  is optional (`validators/regularization.ts`).
- The mobile app always asks for both times for this type. The admin portal and
  direct API callers can still send a check-in time only.
- With both times, approval creates a closed session with the real duration and
  derives the day status from it, the same way as any other day (REG_008
  rejects overlaps).
- With a check-in time only, approval creates a synthetic session **without**
  a check-out (`durationMinutes: null`) and **forces the day to `present`**,
  whatever hours were actually worked. This is legacy behaviour, kept
  unchanged (`RegularizationService.approve`, "forgotCheckIn" branch).
- The API spec (doc 04, BR-REG-07) says "recompute day status". The code
  forces `present` instead, so the spec and the code disagree.

**Why it matters:** an employee who forgot to check in, then left after two
hours, is recorded as a full present day with 0 minutes. Payroll and reports
count that day as present, and the overtime and short-hours figures are
missing.

**Decision needed**

1. Require a check-out time for `forgotCheckIn` (API + portal), so the day is
   always derived from real hours.
2. Keep check-in-only requests but mark the day differently (for example
   `half-day`, or `present` with a "hours unknown" flag that the admin must
   resolve).
3. Keep today's behaviour (forced `present`) and update the spec to match.

---

## Q3. Work-away / official travel / client visit on a weekend, holiday or leave day

**Today**

- Creating these requests does not check whether the date is a weekly off, a
  holiday or an approved-leave day.
- Approval sets the day to `present` **unconditionally** (no session is created;
  BR-REG-07). That overwrites `weekend`, `holiday`, and also `leave` / `lwp`.
- This is inconsistent with the rest of the system. Recorded work on a protected
  day (live check-out, the 24-hour missed check-out rule, and approved
  forgot-check-in/out regularizations via `reconcileForSession`) keeps the day's
  `weekend` / `holiday` / `leave` status and only updates the minutes.
- If a leave day is overwritten to `present`, the leave record and the leave
  balance are not adjusted. The balance stays deducted while attendance shows
  present.

**Why it matters:** working on a Sunday or a holiday for a client is a real
case. Whether it is a normal present day, a compensatory-off credit, or overtime
changes payroll. The silent leave overwrite can produce a day that is both
"on leave" and "present".

**Decision needed** (per day type: weekend, holiday, approved leave)

1. Keep the protected status, record the request as approved and flag the day
   (for example `isRegularized` + reason), matching the other paths. Optionally
   credit compensatory off.
2. Allow it to become `present` (today's behaviour). Then decide whether this
   also earns overtime or comp-off, and what happens to an overlapping approved
   leave (refuse the request, or withdraw the leave and restore the balance).
3. Refuse such requests at creation with a clear message.

---

## Q4. Which "required daily minutes" is authoritative? (added 2026-11-17)

Two different numbers are in use today:

| Where | Value used | Source |
|---|---|---|
| Day status (present / half-day / absent), overtime, payroll, leave revert | stored `requiredDailyMinutes` (seed default 480 = 8 h) | `AttendanceService`, `LeaveService` |
| Mobile Home card "Required: … today" | shift span `workEndTime − workStartTime` (09:00–18:00 = 540 = 9 h) | `GET /attendance/shift` (comment: "stored value is not authoritative") |

So an employee can be told 9 h is required while 8 h already counts as
present. Options: (a) the shift endpoint returns the stored value; (b) status
and payroll use the shift span; (c) keep both but label the card "Shift
length". **Not changed** — it decides who is present and paid.

## Q5. Half-day leave from the mobile app (added 2026-11-17)

The API supports half-day leave (`duration: "half"` + `halfDayPeriod`,
`totalDays` 0.5) and the app now *displays* 0.5-day leaves and fractional
balances correctly, but the app has **no way to request** a half day. Whether
employees should be able to is a product decision (a new input, not a fix).
The app's date-range preview is labelled as calendar days ("weekends and
holidays are not deducted"); the server computes the working days charged.

## Q6. Should a payroll lock or finalisation stop leave/regularization changes? (added 2026-11-18)

Measured on a disposable local database with fake accounts (API calls; one
month in each state). "Warn" = request succeeds and returns a `warnings` entry.

| Operation (for a date in the month) | Draft payroll | Finalised (that employee) | Locked month (record still draft) |
|---|---|---|---|
| Leave apply | allowed | allowed | allowed |
| Leave approve | allowed | allowed, **no warning** | allowed, no warning |
| Leave revoke | allowed | allowed, **warning** (BR-LVE-22) | allowed, no warning |
| Regularization apply | allowed | allowed | allowed |
| Regularization approve | allowed | allowed, **warning** | allowed, no warning (warns only if that employee is also finalised) |
| Payroll recompute | allowed | **blocked** `PAY_001` | **blocked** `PAY_006` |

The stored payroll record is never updated by these changes: it stays stale
until someone recomputes (draft) — e.g. a regularization moved "present" from
2.5 to 3.5 only after a manual recompute — and a finalised or locked month
cannot be recomputed without first unfinalising/unlocking.

The written rule (BR-LVE-22) covers only leave *revocation* in a *finalised*
month (warn, do not block). Leave approval in a finalised month and every
change in a locked month are silent today. Options: (a) keep as is and rely on
manual review; (b) warn on every leave/regularization change that touches a
finalised or locked month (no blocking); (c) block such changes until the month
is unlocked/unfinalised (admin must unlock first); (d) block only for locked
months and warn for finalised ones. **Not changed.**

## What was verified, and how

| Item | Evidence |
|---|---|
| Q1 settings validation (overnight allowed, cut-off rule) | `settings-validation.test.ts` |
| Q1 check-in-date attribution across midnight | `attendance-e2e.test.ts` ("month boundary") |
| Q2 both-times path derives status; overlap → REG_008 | `regularization-forgot-checkin.test.ts` (real DB) |
| Q2 check-in-only path forces `present` | code reading (`RegularizationService.approve`); existing unit test |
| Q3 unconditional `present` on approval | code reading (`RegularizationService.approve`, final `else` branch) |
| Q3 protected statuses on the other paths | `missed-checkout.test.ts`, `reconcileForSession` |
| Q6 lock/finalise matrix above | API calls on a disposable local DB (2026-11-18); payroll records read directly |

## Related verified behaviour and test limitations (2026-11-18)

All on a disposable local MongoDB (127.0.0.1) with fake test-domain accounts;
mocked email (local outbox) and no Firebase/Redis/network beyond loopback.

- **24-hour missed check-out on a phone — simulation, not a real 24-hour wait.**
  An open session was created through the real `AttendanceService.checkIn`
  in a one-off process whose clock was shifted back by ~24 h, so the phone and
  server kept their real clocks. Observed on the phone: the timer counted to
  23:59:46, reset to 00:00:00 at the deadline, the status re-synced (three
  calls, then stopped), and a "Missed check-out" banner named the date. The day
  stayed `absent` with `checkOut: null` (nothing fabricated). Reopening the app
  after the cutoff showed the same state. Regularization (phone → admin
  approval) and leave (phone → admin approval) each resolved a separate missed
  day; the banner cleared. Automated: `missed-checkout.test.ts` (real DB,
  controlled `Date`).
- **Home vs History wording.** Home previously said "Partial Day" while History
  showed the server status "Absent" for the same day. Home now says "Checked
  Out · N recorded today · Status so far: <server status>", and History marks
  today's row "So far". No threshold was changed (see Q4 for 8 h vs 9 h).
- **Access tokens after logout.** Logout revokes the session's refresh token
  immediately (a copied refresh cookie gets 401). The access token is a
  stateless 15-minute JWT without a session id: a copy of it (Bearer header or
  `__session` cookie) keeps working on API routes and pages until it expires,
  then gets 401 / redirect to login (verified with a +16 min server clock).
  Immediate revocation would need an architecture change (see the report).
- **Push start-up failure on a phone.** A build copy with an injected Firebase
  failure (throw) and an injected hang both started the app (the hang after the
  10 s limit), restored the session, signed out and signed in without a false
  "No connection" error. Real push delivery remains untested (BLOCKED).

Nothing in this document has been deployed or tested against the production
database.
