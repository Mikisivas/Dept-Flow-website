# Dept-Flow — System Operation and Logic Summary

This document is the functional reference for building the software phase of Dept-Flow.
It captures the finalized design decisions (roles, states, workflows, formulas) in a
form meant to translate directly into a database schema and API design. Where the
thesis instructions and this document ever disagree, treat this document — and the
actual running software — as the source of truth going forward.

## 0. Technology stack

| Layer | Choice | Role |
|---|---|---|
| Frontend | **Next.js / React (TypeScript)** | Mobile-first UI |
| Styling | **Tailwind CSS** | Utility-first styling |
| Components | **shadcn/ui** | Accessible component source, copied into the repo |
| Primitives | **Radix UI** | Unstyled accessible primitives underneath shadcn — keyboard, focus, ARIA |
| Backend API | **FastAPI (Python)** | Application and enforcement logic |
| Database | **Supabase (PostgreSQL)** | Persistence, auth, realtime, row-level security |
| Cache | **Redis** | Hot-path compliance lookups during checkpoint bursts |
| Payments | **Paystack** | Card + Pay with Transfer, webhook-verified |
| ML | **scikit-learn** | Advisory regression for the predictive engine |

Tailwind CSS, shadcn/ui, Radix UI, and Redis were added to the original five-part
stack. Tailwind, shadcn, and Radix sit inside the existing Next.js/React choice and
replace nothing: Tailwind handles styling utility-first, shadcn copies component source
into the repo, and Radix supplies the unstyled primitives beneath it — keyboard and
ARIA behavior, which reduces hand-written accessibility code. Redis addresses the burst-concurrency pattern described in §13 —
it keeps the compliance-status lookup off the database during token windows. Postgres
alone is sufficient for a demonstration; Redis is what makes the 5,000-student
scalability claim defensible.

State versions for all of these in Chapter 3 (Research Instruments/Tools).

## 1. System purpose, in one sentence

Dept-Flow gates a student's ability to accumulate *counted* attendance behind
departmental dues compliance, using a two-checkpoint token+GPS mechanism to make
attendance hard to fake, and an advisory regression model to warn students before
they fall below the 75% exam-eligibility threshold.

## 2. Actors and their permitted actions

| Role | Can do | Cannot do |
|---|---|---|
| **Student** | Register (whitelist+OTP), pay dues, submit checkpoint tokens, view own attendance %/risk | Grant grace, see other students' data, alter payment records |
| **Lecturer** | Start/end sessions, trigger both checkpoints, create makeup/reschedule/cancel sessions for own courses, submit manual (paper) batches | Grant grace, deactivate students, alter dues/geo-fence config |
| **HOD** | Grant grace periods (any time, incl. post-Day-30), approve waivers, view individual student risk, resolve disputes, authorize final eligibility list | Edit dues amount, geo-fence coordinates, or the whitelist |
| **Admin** | Manage whitelist, revoke/reclaim registrations, deactivate students, run level rollover, configure dues/resumption date/geo-fence, view aggregate/system risk signals | Grant grace, see individual student risk alerts |

This separation is a first-class design constraint — enforce it at the API
authorization layer, not just the UI.

## 3. Core entities (a starting data model)

```
Student        { id, matric_no (unique), surname, phone, level, programme (derived from matric_no), status (active/provisional/graduating/deactivated), deactivation_reason, device_id }
Whitelist      { matric_no, surname, level, session_id, claimed (bool) }   // programme parsed from matric_no prefix: MTH | CMP | STA
Course         { id, code, name, lecturer_id }
Timetable      { id, course_id, day_of_week, start_time, end_time, venue_polygon, session_id }  // versioned per session
SessionInstance{ id, course_id, date, timetable_id (nullable if makeup), type (recurring/makeup/reschedule), status (open/closed), created_by }
Checkpoint     { id, session_instance_id, index (1 or 2), token, issued_at, expires_at }
AttendanceMark { id, student_id, checkpoint_id, gps_lat, gps_lng, gps_accuracy, device_id, accepted (bool), reject_reason }
SessionScore   { id, student_id, session_instance_id, score (0 / 0.5 / 1.0), status (provisional/confirmed), source (digital/manually_entered) }
DuesPeriod     { id, session_id, resumption_date, dues_amount, grace_period_end (HOD-set, nullable) }
Payment        { id, student_id, paystack_ref, channel (card/transfer), status, verified_at, amount }
AuditLog       { id, actor_id, actor_role, action, target_id, reason, timestamp }
```

## 4. The compliance state machine (per student, per session/semester)

```
UNCLEARED ──(payment confirmed OR HOD clearance)──> CLEARED
    │                                                    │
    │ (session scores logged as PROVISIONAL)            │ (all provisional scores → CONFIRMED, batch)
    ▼                                                    ▼
Day 31 reached, still UNCLEARED
    │
    ▼
PENDING_VERIFICATION (6–12h buffer, re-check Paystack directly)
    │
    ├──(clears within buffer)──> CLEARED (batch-confirm)
    │
    └──(buffer expires)──> LOCKED (no new attendance; provisional scores stay unconfirmed)
                                │
                                └──(HOD opens grace period, student clears)──> CLEARED (batch-confirm)
```

Implementation note: this is naturally a **status field + a scheduled job**. The
Day-31 check and the buffer expiry are both cron-style jobs; the CLEARED transition
itself should be a single transaction that flips every PROVISIONAL `SessionScore` row
for that student to CONFIRMED.

## 5. Attendance capture — the core decision procedure

For each `SessionInstance`, two `Checkpoint`s get created over its lifetime
(lecturer-triggered, no fixed timing). For each checkpoint, the accept/reject logic
per submission is:

```
function submitCheckpoint(student, checkpoint, gps_samples, device_id):
    if not checkpoint.is_valid():                       # expired or already used by student
        reject("invalid or expired token")
    if student.status == LOCKED:
        reject("account locked — dues not cleared")
    if not withinGeofence(gps_samples, checkpoint.session.venue_polygon):
        reject("outside geofence")
    if isSpoofed(gps_samples):                           # jitter + impossible-jump checks
        reject("failed anti-spoof check")
    if deviceUsedByOtherStudentRecently(device_id):
        flag_for_review()                                 # accept but flag, don't hard-block
    record AttendanceMark(accepted=true)
    return accept
```

Once a `SessionInstance` closes (both checkpoints resolved or timed out), compute the
score:

```
function resolveSessionScore(student, session_instance):
    marks = acceptedCheckpoints(student, session_instance)
    if len(marks) == 2: score = 1.0
    elif len(marks) == 1: score = 0.5
    else: score = 0.0
    status = CONFIRMED if student.status == CLEARED else PROVISIONAL
    save SessionScore(student, session_instance, score, status)
```

If the lecturer only ever issued one checkpoint for that session, treat it as a
single-checkpoint session: score is binary (1.0 or 0), tagged distinctly.

## 6. Attendance percentage — the one formula everything reduces to

```
attendance_% = ( Σ confirmed SessionScore.score for student ) / ( total SessionInstances held for that course/student ) × 100
```

This same formula consumes digital sessions, single-checkpoint sessions, and
manual/paper `manually_entered` batches identically — the tag exists purely for
governance queries (e.g. "how often does Lecturer X use manual batches"), never for
the math.

## 7. Payment flow (Paystack — Card + Pay with Transfer)

```
Student initiates payment → Paystack Checkout (Card or Transfer)
Paystack sends webhook → verify HMAC signature
    → call Paystack transaction/verify API (never trust webhook payload alone)
    → if success: create Payment(verified), trigger student.status = CLEARED
Nightly job: re-verify any Payment in a pending/ambiguous state directly against Paystack
```

For the build phase: start entirely in **Paystack test mode** — test keys need no
business KYC, test cards/transfer-simulation exist, and webhooks fire identically to
production, so the whole verification pipeline is demoable without real money.

## 8. Registration flow

```
Admin uploads Whitelist rows (matric_no, surname, level) for the session
Student submits (matric_no, surname, level) → match against an UNCLAIMED whitelist row
    → send OTP to entered phone number
    → OTP confirmed → create Student account, mark whitelist row claimed
```

Dispute path: admin has a `revokeRegistration(matric_no, reason)` action that
unclaims the row and freezes the disputed account, logged to `AuditLog`, so the real
student can re-register.

## 9. Timetable & lecturer scheduling

- `Timetable` is versioned per session — token generation for a `SessionInstance`
  matches against the *active* session's timetable only, with a ±15 min tolerance
  window.
- Lecturers can create a `SessionInstance` of type `makeup` or `reschedule` for their
  own `Course`, which is immediately valid for checkpoint generation (no pre-approval
  needed) — just logged for HOD visibility.
- Lecturers can also `cancel` a scheduled instance, removing it from the attendance
  denominator for that week.

## 10. Level rollover & lifecycle

```
Admin runs SessionRollover(new_session_id):
    for each active Student not in {Graduating, Deactivated}:
        student.level += 1
    for each Student at terminal level:
        student.status = GRADUATING
    // no CGPA check, no exceptions — unconditional
New intake: fresh Whitelist upload for entry-level, unrelated to rollover
Admin.deactivate(student, reason ∈ {Expelled, Withdrawn, Graduated, Other}, note)
    → soft-delete: student.status = DEACTIVATED, login disabled, history retained
```

## 11. Predictive engine (advisory only)

```
Feature: weighted session-score history (0/0.5/1.0), computed velocity over recent sessions
Model: regression → predicted end-of-semester attendance %
Threshold: predicted_% >= 75 ? "on track" : "at risk" (applied AFTER regression, not baked into it)
Trigger: differently-worded nudge depending on pattern —
    trending toward 0s → disengagement nudge
    trending toward 0.5s → partial-attendance nudge (arriving late / leaving early)
```

This is explicitly a **second-order signal** — the real, authoritative 75%
eligibility determination is always computed directly from confirmed `SessionScore`
rows, never from the model's prediction.

## 12. Resilience — outage handling

Dept-Flow is a **website accessed in a browser**, not an installed application, which
bounds what "offline" can mean. Without a service worker there is no background sync:
a queued submission survives only while the tab is open (and a page reload, if
persisted to `localStorage`). Therefore the interface must **never confirm attendance
before the server acknowledges it** — a student who sees "Recorded ✓" and walks away
uncounted is the worst failure mode in the system.

```
Brief network blip: client retries while the page is open; pending submission
                    persisted to localStorage so a reload recovers it.
                    UI shows "Sending…" — never "Recorded" — until acknowledged.
Full outage: lecturer runs paper sign-in (two columns: Checkpoint 1, Checkpoint 2)
    → once online: lecturer submits ManualAttendanceBatch(session_instance, [(student, cp1, cp2)...], justification_note)
    → each row resolves through the SAME resolveSessionScore logic, tagged source=manually_entered
```

## 13. Cross-cutting technical constraints to design around from day one

- **Concurrency**: expect bursts within each 3–5 min checkpoint token window across
  parallel classes — design the attendance-submission endpoint to be async/stateless
  with DB connection pooling from the start, not bolted on later.
- **Uniqueness constraints**: `(student_id, checkpoint_id)` must be unique at the DB
  level — this is your cheapest defense against duplicate submissions, not
  application logic.
- **Audit everywhere sensitive**: every HOD/admin action that changes a student's
  status (grace, waiver, deactivation, registration revoke) writes an `AuditLog` row
  — build this as a shared helper/middleware from the first sensitive endpoint, not
  retrofitted.
- **No biometrics, no continuous GPS tracking**: purge raw GPS coordinates on a
  schedule (e.g., 7–30 days), keep only the derived pass/fail + distance once that
  window passes.

## Explicitly dropped ideas (do not reintroduce during implementation)

Dedicated Virtual Accounts; biometric/fingerprint or selfie-liveness auth; Wi-Fi/router
SSID cross-check; CGPA-tied promotion or repeat-of-level; a system-fixed recheck time
window.
