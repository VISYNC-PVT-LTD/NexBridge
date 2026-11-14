# 86 — Attendance: Open Business-Policy Questions (2026-11-14)

Status: **questions only — no decision has been made and no behaviour was changed
for them.** Code comments that say "see docs/86 open rules" point here. Each
section records what the code does today (verified by reading the code at
branch `feature/bug-fix-and-optimization`), why it is ambiguous, and what the
business owner needs to decide. The options are listed so the decision is quick;
none is a recommendation to implement without sign-off.

Who should answer: HR / payroll owner (Q2, Q3) and operations owner (Q1).

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

## What was verified, and how

| Item | Evidence |
|---|---|
| Q1 settings validation (overnight allowed, cut-off rule) | `settings-validation.test.ts` |
| Q1 check-in-date attribution across midnight | `attendance-e2e.test.ts` ("month boundary") |
| Q2 both-times path derives status; overlap → REG_008 | `regularization-forgot-checkin.test.ts` (real DB) |
| Q2 check-in-only path forces `present` | code reading (`RegularizationService.approve`); existing unit test |
| Q3 unconditional `present` on approval | code reading (`RegularizationService.approve`, final `else` branch) |
| Q3 protected statuses on the other paths | `missed-checkout.test.ts`, `reconcileForSession` |

Nothing in this document has been deployed or tested against the production
database.
