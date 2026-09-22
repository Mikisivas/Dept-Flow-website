# Dept-Flow — System Reference for Thesis Writing

**Status of this document.** Written directly from the codebase at commit `3a08f5f` on
branch `claude/supervisor-adjustments-c8e5ac`. Every algorithm, threshold and design
decision below was read out of the migrations and source files rather than recalled.
Where the project's own older documents contradict this, the code is authoritative and
the contradiction is flagged.

**Purpose.** Reference material for writing the thesis. It covers what the system does,
how each mechanism works, and — most usefully for Chapters One, Three and Five — *why*
each design decision was taken, since those rationales are what a committee will probe.

---

## 1. Identity and purpose

Dept-Flow is a web-based attendance and examination-eligibility system for a single
university department. Its governing purpose is stated in one line in the project's own
instructions:

> Dept-Flow warns students before they fall below the 75% exam-eligibility threshold,
> and does it early enough to be worth acting on — a forecast of where a student will
> finish, per course, not a tally of where they are.

That distinction is the thesis. Almost every attendance system in the literature
improves the *accuracy of a retrospective record*. Dept-Flow's contribution is the
*projection*: it computes where each student will end the semester in each course, from
around week five, while there is still time for the answer to change.

Four roles reach it through a browser at a URL: student, lecturer, Head of Department
(HOD), administrator.

---

## 2. The problem addressed

1. **The register is a gate, not just a record.** A student below the attendance
   threshold in a course may be refused permission to sit that course's examination.
2. **A tally arrives too late.** A student told in week eleven that attendance stands at
   62% has been told something true and arithmetically irreversible: the lectures needed
   to recover no longer remain in the semester.
3. **Automated alternatives buy accuracy with surveillance.** Biometric terminals,
   facial recognition and location-verified check-in raise fidelity by acquiring
   personal data the institution must then hold, secure and justify, and by placing
   hardware in every teaching venue.
4. **Coupling fees to attendance corrupts the academic record.** Where a system makes
   the *recording* of attendance conditional on payment, the register stops describing
   who attended and begins describing who has paid, and the two cannot afterwards be
   separated.

Dept-Flow's position is the intersection: forecast early, do not surveil, and keep the
attendance record independent of fee status.

---

## 3. Design history — the August 2026 supervisor revision

**This section matters more than any other for the thesis**, because it explains why the
system looks the way it does, and because most of the project's earlier documents and
all six design mockups describe the superseded design.

The revision reversed three original premises:

| Original design | Current design |
|---|---|
| Two checkpoints per lecture, a token plus GPS, distance and proxy checks | **Trust-based.** One short-lived code per lecture. No GPS, no distance check, no spoofing detection. |
| Dues compliance gated whether attendance *counted* | **Decoupled.** A lecture counts whether or not a naira has been paid. Dues and attendance meet in exactly one place: the exam permit needs both. |
| Nothing gated attendance | **Semester registration does.** Past the deadline an unconfirmed student cannot log attendance, and confirming late backfills an absence for every lecture missed in between. |

### 3.1 How the decoupling is implemented

This is worth stating precisely, because it is checkable and a committee may check it.

The migration `20260823000300_payment_decoupled.sql` rewrote `attendance_pct()`. The
earlier version summed only scores whose status was `confirmed`, and a score was only
confirmed if the student's compliance state was `cleared` — that is, if dues were
settled. The current version removes that filter entirely and sums **every** score in
the enrolment window:

```sql
earned as (
  select coalesce(sum(ss.score), 0)::numeric as total
  from session_scores ss
  join session_instances si on si.id = ss.session_instance_id
  where ss.student_id = p_student_id
    and si.course_id = p_course_id
    and si.status = 'closed'          -- note: no status = 'confirmed' filter
)
```

The provisional/confirmed distinction still exists on the score row, so the system
retains a record of whether the student was cleared at the time of the lecture. It no
longer affects the attendance percentage.

---

## 4. Roles and what each can do

**Student.** Dashboard, per-course detail, submit the attendance code, notifications,
dues payment, elective and carry-over course registration, printable exam permit,
password reset, change own password or phone number.

**Lecturer.** Daily dashboard, open a lecture and issue its code, close it, schedule
(cancel, reschedule, add a makeup — each notifies every enrolled student), course list,
paper register, manual attendance batch.

**HOD.** Departmental overview, drillable at-risk list, exam eligibility (authorising a
list snapshots and freezes it), payment compliance, messaging students at four scopes
(whole department, one course, one level, or one level of one programme), registration
exceptions, disputes, the per-student record, lecturer oversight.

**Administrator.** Overview, students (deactivate and reverse it), payments, the
register and the timetable (both preview-then-commit uploads), courses, registration
disputes, per-session configuration (registration window and dues), audit log, level
rollover.

---

## 5. Architecture

**There is no separate backend service.** This is an architectural claim worth defending
explicitly, because the older documents describe a FastAPI service that does not exist.

- **Presentation and server layer:** Next.js 16 App Router. Server components read data
  directly; route handlers under `src/app/api/` accept writes. 44 page routes, 37 API
  endpoints.
- **Business logic layer:** PostgreSQL. 84 PL/pgSQL functions hold the attendance
  scoring, the forecast, the eligibility arithmetic, the payment application, the
  permit conditions, the audit rules and the notification queueing. 40 forward-only
  migrations.
- **Data layer:** the same PostgreSQL instance, with row-level security policies
  enforcing per-role access on individual rows.

Placing the logic in the database rather than the application is deliberate. Every rule
that matters is then enforced regardless of which client calls it, and a bug in a screen
cannot produce a record the schema would refuse.

**Authentication** does not use Supabase Auth. Login resolves a matric number or staff
ID and password, and the server issues a JSON Web Token signed with the project's own
JWT secret. Because it is signed with the secret the database already trusts, PostgREST
accepts it, `auth.uid()` resolves inside it, and every row-level security policy applies
to a login that never involved an email address.

**Delivery** is a website first and installable second. The service worker exists for
exactly two things: receiving web push when no page is open, and serving an honest
offline page. It never caches a page, because every screen is somebody's record and
phones get shared and resold.

---

## 6. Core mechanisms, with their actual logic

### 6.1 Attendance capture

The lecturer opens a lecture, the system issues **one** short-lived code, the lecturer
reads it out, students submit it, the lecturer closes the lecture, and
`resolve_session_score()` scores everyone enrolled.

The score is binary. The revision removed the two-checkpoint pair and with it the
half-mark:

```sql
alter table session_scores
  add constraint score_value_valid check (score in (0, 1.0));
```

A score row also carries a status, derived from the student's compliance state at the
time:

```sql
v_status := case when v_compliance = 'cleared' then 'confirmed' else 'provisional' end;
```

This status is now a record only. It does not affect the percentage (see §3.1).

**No location, biometric, facial or fingerprint data is captured at any point.** The
project instructions state the reason directly: a request that carried coordinates
"would be recording something this system has undertaken not to keep". The residual
proxy-attendance risk is accepted knowingly, and that trade-off is defensible ground for
the thesis rather than a weakness to conceal.

### 6.2 Attendance percentage

`attendance_pct(student, course)` divides scores earned by lectures held, both scoped to
the student's enrolment window so that a student who joined late is not penalised for
lectures held before they enrolled:

```
attendance_pct = round( sum(scores in window) / count(closed lectures in window) * 100, 2 )
```

Only lectures whose status is `closed` count. An open or cancelled lecture is not in the
denominator.

### 6.3 The forecast — `compute_risk_predictions()`

This is the intellectual core of the system and should be described carefully.

**It is a deterministic rule, not machine learning.** Two reasons are recorded in the
code and both are defensible at a viva:

1. There is no history to train on. One session and three students is a training set to
   memorise, not to learn from.
2. A rule can tell a student *why* they were flagged. A classifier cannot.

**The projection.** For each student and course with at least five closed lectures:

```
recent_rate   = mean attendance over the last 5 lectures
rate          = mean attendance over the whole enrolment window
forward_rate  = (recent_rate + rate) / 2

predicted_pct = (attended_total + remaining × forward_rate) / (held + remaining) × 100
```

**Why not the regression slope.** The code computes an ordinary-least-squares slope with
Postgres's `regr_slope()`, but deliberately does **not** extrapolate it to produce the
projection. Extrapolating the slope "turns one missed lecture in ten into a projected
failure". The slope is used only to label the pattern and to report a trend figure.

**The week-five floor.** Below five held lectures no prediction is written at all: "one
missed lecture out of three is a rate that says almost nothing, and a warning system that
fires in week two is one nobody reads in week nine."

**Tiers** (threshold read from `app_config`, default 75):

| Tier | Condition |
|---|---|
| `critical` | predicted_pct < threshold |
| `watch` | threshold ≤ predicted_pct < 80 |
| `safe` | predicted_pct ≥ 80 |

**Patterns**, which decide what the warning says:

| Pattern | Condition | Meaning |
|---|---|---|
| `disengagement` | slope < −0.01, **or** rate < 0.4 | Was attending and stopped, or never started. Needs a different conversation. |
| `partial_attendance` | otherwise | Turning up sometimes, steadily, and not enough. |

**Actionable figures.** Each prediction also carries `must_attend` (how many of the
remaining lectures are needed to finish at the threshold, capped at what remains, so a
student who cannot reach it is told that rather than handed an impossible number) and
`can_still_miss` (the other half of the same sentence, and the half a student on track
actually reads).

**The table is rebuilt wholesale** on each run, not updated incrementally: "a stale row
for a student who has since turned things around is worse than no row."

**The forecast is advisory and structurally isolated.** `attendance_pct()` has never been
allowed to consult it. The permit's `lectures_needed()` is deterministic arithmetic on
the threshold. A test deletes every prediction and asserts the permit panel does not
move. The `risk_predictions` table is described as the seam: swap the writer, change no
reader — so a trained model could replace the rule later without touching anything that
reads it.

### 6.4 Examination eligibility and the permit

The permit requires **two independent conditions**, and this is the single place where
dues and attendance meet:

1. Dues paid in full for the session.
2. Attendance at or above the threshold in **every** registered course.

`permit_eligibility()` returns, per course, the attendance percentage, lectures held,
lectures remaining, how many the student must still attend, whether the threshold is
still **reachable**, and whether they are currently eligible. A live panel tells the
student what is outstanding; the issued document carries a QR code to a public
verification route.

Authorising an eligibility list **snapshots and freezes** it, so that a grace period
opened the following week cannot silently rewrite a list an examination board has
already sat with.

### 6.5 Dues and payment

Paystack redirect, then verification, then `apply_payment()`. Instalments run a balance
down. Reversals re-lock with notice. Nothing about attendance changes at any point.

A self-healing sweep exists because the Paystack webhook is a fast path and not a
guaranteed one: a deployment mid-flight loses it, and the student's money then sits
uncredited until somebody notices — and nobody notices except the student, at the
permit. The sweep re-asks on a widening schedule and gives up after two days of
"pending", at which point the checkout is called abandoned. A late webhook still
resolves it.

### 6.6 Semester registration

The administrator sets a window. The student confirms within it.
`confirm_registration()` stamps it server-side. Attendance logging is gated on it, and
a student who confirms after the deadline has an absence backfilled for every lecture
held in between. An unconfigured window reads as open, deliberately, so that nothing
breaks and the gate simply never engages.

### 6.7 Notifications and escalation

Alerts escalate **one rung per tier**: in-app, then web push, then WhatsApp, then SMS.
Reserving the paid channel for the most serious tier is the whole point of the ladder.

The queue is drained separately from the writing of notifications, on purpose:
`queue_notification()` runs inside whatever transaction produced the event, and a
provider call there would hold that transaction open for as long as the provider felt
like taking.

Delivery marked `sent` means a provider accepted the message. Whether a student read it
is not knowable and is never claimed.

---

## 7. Data model — principal entities

| Entity | Role |
|---|---|
| `academic_sessions` | The year. One active at a time. |
| `whitelist_entries` | The departmental register; identity is matched against it at sign-up. |
| `profiles` / `students` | Account and student record. |
| `courses`, `enrolments` | Offered courses per session; who is taking what, with enrolment and drop dates. |
| `timetable_entries` | The recurring weekly slots. |
| `session_instances` | One actual lecture. Status: scheduled, open, closed, cancelled. |
| `session_scores` | One student's outcome for one lecture. Score 0 or 1; status provisional or confirmed. |
| `compliance_statuses` | Fee-compliance state per student per session. |
| `dues_periods`, `payments` | The charge for a session, and payments against it. |
| `risk_predictions` | The forecast. Advisory; the seam for a future model. |
| `notifications`, `notification_deliveries` | What to say, and each attempt to say it. |
| `eligibility_lists`, `eligibility_entries` | The frozen snapshot an examination board sits with. |
| `audit_log` | Every authority action, with actor and reason. |

### 7.1 Two state enumerations, often confused

There are **two** enumerations here, and merging them produces a state machine with no
counterpart in the schema:

```sql
create type compliance_state as enum ('uncleared', 'cleared', 'pending_verification', 'locked');
create type score_status     as enum ('provisional', 'confirmed');
```

`compliance_state` is fee status for a student in a session. `score_status` is a property
of one attendance row, derived from the compliance state at the time of that lecture (see
§6.1), and since the decoupling it is a record only.

They are easy to conflate, and `CLAUDE.md` did conflate them, listing five values as one
enumeration; that was corrected in commit `3a08f5f`. Draw the state diagram in Chapter
Three from the schema above.

---

## 8. Design decisions and their rationale

These are the defensible positions. Each has a reason, not just a preference.

| Decision | Rationale |
|---|---|
| Trust-based code, no GPS or biometrics | Location and biometric data are a liability acquired in exchange for a tick in a register. The department would have to hold and secure them. The residual proxy risk is accepted knowingly. |
| A rule, not a trained model | No history to train on, and a rule can explain itself to the student it flags. |
| Projection, not slope extrapolation | Extrapolating the trend turns one missed lecture in ten into a projected failure. |
| Forecast advisory, never consulted by eligibility | A student's eligibility must rest on what was recorded, not on what was predicted. Enforced by test. |
| Dues decoupled from attendance recording | An academic record must not be corrupted for an administrative reason. |
| Business logic in the database | Every rule holds regardless of which client calls it. |
| Service worker never caches a page | Phones are shared and resold. A cached dashboard is one student's record served from disk to whoever picks the phone up next. |
| Attendance never confirmed before the server acknowledges | "A student who sees 'Recorded ✓' and walks away uncounted is the worst failure this system can produce." |
| Authority actions confirm, require a reason, write an audit row | The audit row is part of the action, not a note about it. |
| Never encode a state by colour alone | Accessibility. Orange is the brand, never a status. |
| Query errors throw rather than render empty | PostgREST returns `data: null` beside an error, so a failed query and an empty table arrive identically. An empty list asserts "there is nothing here", and a failed query has not earned that claim. |

---

## 9. Security and privacy posture

- Passwords hashed with Argon2, with bcrypt retained only to verify older seeded digests.
- Session is a self-signed JWT; no email address is involved in login.
- Row-level security enforces per-row access, so a compromised client cannot read
  another student's record.
- The service-role key, which bypasses row-level security entirely, is server-side only.
- No location, biometric, facial or fingerprint data is collected anywhere. A function
  named `purge_expired_coordinates()` survives from the superseded design and has nothing
  to purge.
- Rate limiting on expensive steps, which **fails open** on a database error: a throttle
  that cannot reach its counter should not lock out the whole department.
- Login does not reveal whether an account exists: verification runs against a dummy
  digest when there is none, so a wrong matric number takes the same time as a wrong
  password.

---

## 10. Verification and evaluation

| Check | Scale |
|---|---|
| Schema assertions against a local PostgreSQL | 430 |
| Select-column checks (every column any query asks for exists) | 510 |
| Application test suites (Paystack, account, timetable, query-result) | 4 suites, 99 assertions |

The schema test also verifies that the entire schema applies **inside one transaction**,
because the Supabase SQL Editor runs it that way, and a migration that only works outside
one is a migration that cannot be deployed.

`/api/health` reports which migrations are missing by name, which tables the signed-in
user can read, whether Paystack answers, whether pg_cron is installed, whether the
notification queue is draining and whether payments are reconciling. The last two are the
failures that look like health from every other angle.

**Evaluation limitation to state plainly in the thesis:** the system has never been
deployed to a live cohort. It is verified for correctness against seeded data and
automated tests. It demonstrates that the mechanism works; it does not demonstrate that
the warnings change student behaviour. That claim would require a longitudinal trial and
belongs in future work.

---

## 11. Not built, and why

- **SMS and WhatsApp delivery.** The queue, the channel policy, the fallback and the
  delivery record are real and tested. What is missing is one HTTP call per provider,
  and its shape depends on which number the department registers. Both seams report
  failure in production rather than pretending to have sent — a stub that silently
  succeeds is the worst possible failure mode for a warning system, because every
  delivery row reads `sent` and nobody finds out until an examination board.
- **Deployment.**
- **Web Push is wired end to end** and needs only VAPID keys.

---

## 12. Technology stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.12 (App Router), React 19.2.4 |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4; Radix UI primitives with class-variance-authority, clsx, tailwind-merge |
| Icons | lucide-react |
| Runtime | Node 22 |
| Database | Supabase (PostgreSQL) with row-level security; 84 PL/pgSQL functions |
| Extensions | pgcrypto (in migrations); pg_cron and pg_net enabled by the operator |
| Auth | Self-signed JWT via `jose`; Argon2 and bcrypt password hashing |
| Payments | Paystack, called directly over HTTPS; no SDK |
| Push | web-push with VAPID |
| Other | qrcode for the permit QR; progressive web app manifest and service worker |

**Not present:** FastAPI, Python, Redis, scikit-learn. They were in the original plan,
none of them reached the build, and the forecast is a PostgreSQL function. `CLAUDE.md`
listed them in its stack line until commit `3a08f5f`; `decisions.md` and the design
mockups still predate the revision generally, so treat any stack claim in them as
superseded by this section.

---

## 13. Glossary

**Attendance percentage** — scores earned divided by closed lectures held, within the
student's enrolment window.

**Examination eligibility threshold** — the minimum attendance percentage required to sit
a course's examination; 75% by default, configurable.

**Departmental dues** — the charge levied for a session. One condition of the permit.

**Examination permit** — the document confirming both conditions are met.

**Semester registration** — confirmation, within an administrator-set window, that the
student is in attendance for the semester. Attendance logging is gated on it.

**Trust-based attendance** — attendance recorded on the strength of a short-lived
lecturer-issued code, with no independent verification of location or identity.

**Proxy attendance** — recording attendance for an absent student, by another person.

**Forecast / predicted percentage** — the attendance percentage a student is projected to
hold at the end of the semester in a course. Advisory; does not affect eligibility.

**Risk tier** — safe, watch or critical, by the projection's distance from the threshold.

**Risk pattern** — disengagement or partial attendance; decides what the warning says.

**Compliance state** — uncleared, cleared, pending verification or locked. Fee status.

**Score status** — provisional or confirmed. A record of fee status at the time of the
lecture; does not affect the attendance percentage.

**Row-level security** — database enforcement of access rules on individual rows.

**Progressive web application** — a website installable to a device home screen and able
to receive notifications when not open, without an application store.

---

## 14. Naming conventions to get right

- Computer Science is **CMP** in this department, **not CSC**. Programme prefixes are
  `MTH | CMP | STA`, in matric numbers (`CMP/2021/047`) and course codes (`CMP 301`).
  The database rejects `CSC` in both positions.
- The department is the **Department of Mathematics and Computer Science**.
- Registration identity is **matric number + surname + level**. No date of birth.
- An *academic session* (`2025/2026`) and a *lecture session* are different things;
  keep the terms distinct in writing.
