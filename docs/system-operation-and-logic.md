# Dept-Flow — System Operation and Logic Summary

The functional reference: roles, entities, states, workflows and formulas, in a form
that translates directly into the schema and the API.

**This document was rewritten in August 2026** to match the supervisor's revision
(`operational-flow.md`), which reversed three of the original premises. Where it
disagrees with `decisions.md`, this document and the running software win.

| Was | Is |
|---|---|
| Two checkpoints, token + GPS, geo-fence and anti-spoof | **Trust-based.** One short-lived code per lecture. No location of any kind. |
| Dues compliance decides whether a lecture *counts* | **Decoupled.** A lecture counts regardless. Dues and attendance meet once: the exam permit needs both. |
| Nothing gates attendance | **Semester registration gates it.** Past the deadline, an unconfirmed student cannot log attendance. |

The shift is from *enforcement* to *awareness*. The old design spent its complexity
on making attendance hard to fake; this one spends it on making sure no student
reaches exam week surprised.

## 0. Technology stack, as actually built

| Layer | Choice | Role |
|---|---|---|
| Frontend | **Next.js 16 / React 19 (TypeScript)** | Mobile-first UI, App Router |
| Styling | **Tailwind CSS 4** | Utility-first styling |
| Components | **shadcn/ui on Radix** | Accessible primitives, source copied into the repo |
| API | **Next.js route handlers** | Server-side enforcement, colocated with the UI |
| Database | **Supabase (PostgreSQL)** | Persistence, row-level security, pg_cron |
| Sessions | **Self-signed JWT (jose)** | Not Supabase Auth — students log in with a matric number |
| Payments | **Paystack** | Card + Pay with Transfer, webhook-verified |
| Notifications | **WhatsApp Business API, Web Push, SMS** | In that order of preference |
| Delivery shell | **PWA** | Manifest and a service worker, for push and an offline page |

Two things named in the original stack are **not** in the build, and the honest
version of this table says so rather than listing aspirations:

- **FastAPI.** There is no Python service. Enforcement lives in Next.js route
  handlers and, more importantly, in the database — the rules that matter are
  constraints and functions, which is why a second application server would only be
  a second place for them to be restated inconsistently.
- **Redis.** It was in the original stack to keep compliance lookups off the database
  during token bursts. Compliance is no longer consulted during a submission at all —
  payment does not gate attendance — so the hot path it was for does not exist.
- **scikit-learn.** The advisory signal is a computed rule in SQL. See §11.

## 1. System purpose, in one sentence

Dept-Flow projects where each student will finish the semester in each of their
courses, warns them early enough and specifically enough to act, and produces the
exam permit at the end — which needs both dues paid in full and 75% attendance.

## 2. Actors and their permitted actions

| Role | Can do | Cannot do |
|---|---|---|
| **Student** | Register (register match + OTP), confirm semester registration, pay dues in full or instalments, submit attendance codes, see own attendance, forecast and permit | See other students' data, alter payment records, see a code before the lecturer issues it |
| **Lecturer** | Open and close lectures, issue the code, create makeup/reschedule/cancel instances for own courses, submit paper batches | Grant exceptions, deactivate students, alter dues |
| **HOD** | Grant registration exceptions, approve waivers, see individual academic risk, message students at four scopes, resolve disputes, authorize the final eligibility list | Edit dues amount or the register |
| **Admin** | Manage the register, revoke/reclaim registrations, deactivate students, run level rollover, configure dues and the registration window, record manual payments | Grant exceptions, **see any individual student's academic risk** |

The last cell is a role boundary, not a screen layout. `risk_predictions` is readable
by the student it concerns and by the HOD; asking for it as the admin returns nothing.

Separation of duties is enforced server-side on every endpoint. The UI hiding a
button is a courtesy, never the control.

## 3. Core entities

```
Student           { id, matric_no (unique), surname, first_name, other_names, phone,
                    whatsapp_phone (optional, separate SIM), level,
                    programme (derived: MTH | CMP | STA), status, deactivation_reason }
RegisterEntry     { matric_no, surname, level, session_id, claimed }
Course            { id, code, title, level, lecturer_id, kind, credit_units, semester }
RegistrationPeriod{ session_id, semester, opens_on, deadline }
CourseRegistration{ student_id, session_id, semester, status (draft|confirmed|
                    confirmed_late), registered_at (server-stamped) }
Timetable         { id, course_id, day_of_week, start_time, end_time, venue_id }
SessionInstance   { id, course_id, held_on, timetable_entry_id, type, status, closed_at }
Checkpoint        { id, session_instance_id, token, issued_at, expires_at }
AttendanceMark    { id, student_id, checkpoint_id, submitted_at, accepted, reject_reason }
SessionScore      { id, student_id, session_instance_id, score (0 | 1), source }
DuesPeriod        { session_id, resumption_date, dues_amount_kobo }
Payment           { id, student_id, paystack_ref, channel, status, verified_at, amount_kobo }
PaymentEvent      { provider_event_id (unique) }            // against double-crediting
RiskPrediction    { student_id, course_id, predicted_pct, tier, trend,
                    lectures_held, lectures_expected, must_attend, can_still_miss }
Notification      { id, recipient_id, kind, title, body, link, read_at }
NotificationDelivery { notification_id, channel, status, destination, provider_ref }
PushSubscription  { profile_id, endpoint (unique), subscription }
HodMessage        { sent_by, scope (student|level|course|programme_level), target,
                    programme (MTH|CMP|STA, with level, for programme_level),
                    subject, body, recipients }
ExamPermit        { student_id, session_id, reference (unique), issued_at }
AuditLog          { actor_id, actor_role, action, target_id, reason, metadata, timestamp }
```

**`AttendanceMark` carries no coordinates, no accuracy and no device id.** The columns
were dropped, not left null. There is no `SessionScore.status` either — provisional
was the mechanism by which payment gated attendance, and payment no longer does.

## 4. What gates attendance: semester registration

The gate is registration, and it has a server-stamped clock:

```
Admin sets the window     { opens_on, deadline } for the session and semester
Student confirms          draft → confirmed
```

`confirm_registration()` returns `confirmed` or `confirmed_late` to say which side of
the deadline it happened on, and the row itself is simply `confirmed` either way. The
lateness is not a second kind of registration — it is a fact about `registered_at`,
and the backfill below is what it costs.

```
function attendanceEligibility(student, course):
    if student.status == DEACTIVATED:              return 'account_locked'
    if registrationOpen(session, semester):        return 'ok'        # no deadline yet
    if not confirmed(student, session, semester):  return 'not_registered'
    if not enrolled(student, course):              return 'not_registered'
    return 'ok'
```

**A window that was never configured is open**, not expired. The other way round bars
a whole department from recording attendance because nobody inserted a row.

Confirming late does not forgive the gap. `confirm_registration()` stamps
`registered_at` server-side and **backfills an absence for every lecture held between
the deadline and that moment** — routed through `resolveSessionScore` rather than
writing rows directly, so the scoring rule exists in exactly one place.

The HOD can grant an individual registration exception, with a reason and an audit
row. This is the old grace-period mechanism repointed: same table, same audit trail,
now pointing at registration instead of dues.

## 5. Attendance capture

One code per lecture, valid for a few minutes. The lecturer issues it, the student
enters it.

```
function submitCode(student, checkpoint, token):
    if eligibility(student, course) != ok: reject(eligibility)   # locked, not registered
    if alreadySubmitted(student, cp):      reject('already_submitted')
    if checkpoint.expires_at <= now():     reject('invalid_or_expired_token')
    if token != checkpoint.token:          reject('wrong_code')
    record AttendanceMark(accepted = true)
```

Expiry is judged against the **server's** clock and the stored expiry, never against
the client's. A replayed offline submission carries its original timestamp for the
record; it does not get to reopen a lapsed code.

`wrong_code` is a distinction the interface makes and the database does not: both it
and a lapsed code are stored as `invalid_or_expired_token`, because "you typed it
wrong" and "you were too slow" are the same fact about the mark and completely
different things to tell someone standing in a hall.

No geo-fence, no distance, no anti-spoof, no device fingerprint. That is the
supervisor's decision and it is worth stating why it is defensible rather than
apologising for it: the enforcement it replaced could be defeated by standing outside
the door, cost every student a location permission prompt, and produced a class of
rejection — "outside geofence" — that a student in the third row could not argue
with. What is left is a code on a board, which a lecturer can see being read out.

```
function resolveSessionScore(student, session_instance):
    score = 1 if acceptedMark(student, session_instance) else 0
    save SessionScore(student, session_instance, score, source)
```

Binary. There is no second checkpoint for a half mark to be half of, and the database
rejects any score that is not 0 or 1.

## 6. Attendance percentage — the one formula everything reduces to

```
attendance_% = ( Σ SessionScore.score ) / ( SessionInstances held while enrolled ) × 100
```

The denominator counts lectures held **while the student was enrolled** — a student
who joined a course in week four is not measured against weeks one to three.

Paper batches feed this identically; the `manually_entered` tag exists for governance
queries ("how often does Lecturer X use manual batches"), never for the arithmetic.

## 7. Payment — independent of attendance

```
Student initiates payment → Paystack Checkout (Card or Transfer)
Paystack sends webhook  → verify HMAC-SHA512 over the RAW body
                        → store provider event id; a repeat is a no-op
                        → call transaction/verify (never trust the payload alone)
                        → apply_payment(): reduce the balance
Nightly job             → re-verify anything pending or ambiguous
```

`apply_payment()` returns `part_paid` or `cleared`. **Instalments are first-class**:
a payment that does not match the dues amount reduces the balance rather than being
rejected, and `dues_balance_kobo()` is the fact worth reading, never a paid/unpaid
flag. A student who has paid half is not a student who has not paid.

Reversals re-lock, **with notice** — a student whose payment was charged back is told,
rather than discovering it at the permit screen.

Manual payments (a student who paid at the bursary, a receipt uploaded) are recorded
by the admin with a reason and an audit row, and flagged as manually verified so the
reconciliation report can tell them from Paystack's own.

**None of this touches attendance.** No score changes state, because scores have no
state to change.

## 8. Registration flow (account creation)

```
Admin uploads register rows (matric_no, surname, level) for the session
Student submits (matric_no, surname, level) → match against an UNCLAIMED row
    → OTP to the primary phone; a second OTP if a separate WhatsApp number is given
    → both confirmed → create account, mark the row claimed
```

The primary phone is both the SMS destination and the identity check. The WhatsApp
number is optional and separate, because a student whose WhatsApp runs on a second
SIM is common and a system that assumes otherwise silently loses its main channel.

The registration endpoint is rate-limited and CAPTCHA-protected. Without that, the
register is a list of matric numbers and surnames that a script can walk.

Dispute path: the admin can `revokeRegistration(matric_no, reason)`, which unclaims
the row **and** freezes the claiming account — the real student cannot register while
their own number is marked claimed.

## 9. Timetable & lecturer scheduling

- The timetable is versioned per session, and it is what tells the forecast how many
  lectures a course still has to hold.
- Lecturers create `makeup` or `reschedule` instances for their own courses without
  pre-approval, and can `cancel` one — removing it from the denominator.
- **Every schedule change notifies every enrolled student**, through the same
  notification layer as everything else.

## 10. Level rollover & lifecycle

```
Admin runs SessionRollover(new_session_id):
    every active student not Graduating/Deactivated: level += 1
    students at terminal level: status = GRADUATING
Admin.deactivate(student, reason ∈ {Expelled, Withdrawn, Graduated, Other}, note)
    → soft delete: login disabled, history retained, matric number stays retired
```

## 11. The predictive warning system — the core of the product

Not a scoreboard. A **forecast**: where the student will finish, per course, if they
carry on as they have been.

```
From week 5–6 onward (held >= 5 lectures):
    recent_rate  = mean attendance over the last 5 lectures
    overall_rate = mean attendance over the whole term
    forward_rate = (recent_rate + overall_rate) / 2
    remaining    = lectures the timetable says the course still has to hold
    predicted_%  = (attended + remaining × forward_rate) / (held + remaining) × 100
```

**Not the regression slope extrapolated.** Projecting the slope lecture by lecture
put a student who attended nine of ten at 54% projected, which is a warning system
that cries wolf in week six and is ignored in week eleven. The least-squares slope is
still computed and kept as `trend`, because it is what distinguishes a student who
has always been at 70% from one who was at 95% and is falling — the same projection,
two different conversations — and it selects the wording. It never decides the number.

| Tier | Projection | Channels |
|---|---|---|
| **Safe** | ≥ 80% | In-app only |
| **Watch** | 75–80% | In-app + Web Push |
| **Critical** | < 75% | In-app + Web Push + WhatsApp |
| **Final** | < 75% with no slack, or unreachable | …and SMS |

The ladder is about scarcity, not technology. SMS costs money and is the only channel
that needs no data connection, so it is held for the message that has to arrive. A
student who gets a text in week six has nothing louder waiting in week eleven.

One alert per student, per course, per tier change. An alert that repeats nightly is
an alert a student mutes, and a muted channel cannot warn them later.

**The copy names the course and the exact number of classes**, always:

> CMP 301 is projected to finish at 66.5%. Attend 13 of the 17 lectures left and you
> reach 75%. You can miss 4.

And where the threshold is out of reach it says so, rather than asking for something
that will not work:

> Even attending all 17 remaining lectures finishes below 75%. Attendance alone
> cannot fix this now — speak to the department office about a waiver or a dispute.

A **what-if calculator** answers "what if I miss the next two?" — computed on the
server, by the same arithmetic that decides permits, so the answer a student explores
and the answer that bars them from a hall can never disagree.

This is explicitly advisory. The authoritative 75% determination is always computed
from `SessionScore` rows, never from the model. `attendance_pct()` has never been
allowed to read `risk_predictions`, and neither has the permit's eligibility panel —
`lectures_needed()` is deterministic arithmetic on the threshold, and a schema test
deletes every prediction and asserts the panel does not move.

**Why a rule and not scikit-learn.** The department has one session of history. A
classifier trained on three students has memorised them. The rule also has a property
a first-deployment model could not: a student flagged by it can be told exactly why.
`risk_predictions` is the seam — swap the writer, change no reader.

## 12. Reminders and reports

- **Pre-lecture reminders.** pg_cron runs every few minutes and messages students
  enrolled in a lecture starting within the hour. Deduplicated per student per
  lecture — the job runs often, the reminder goes once.
- **Weekly, monthly and semester reports.** Three windows on the same term. The
  Monday digest goes out at a lower urgency than a warning: it is a summary, and
  dressing it as an alert would devalue the alerts.
- **One generator.** The semester report and the exam permit read the same function,
  so they cannot disagree about who may sit.

## 13. The exam permit

Both conditions, each gating what it governs:

- **Dues paid in full gates the document.** An outstanding balance means no permit,
  for any paper. Checked before a reference is allocated: a reference is permanent,
  and one issued for a document that was never rendered would verify against nothing.
- **75% gates each paper.** A student clear of dues and above the line in four courses
  of five is issued a permit for the four, with the fifth named on it as excluded.

A **live eligibility panel** replaces the flat yes/no, saying exactly what is
outstanding per course and in naira. "STA 204: 68%, attend 3 more classes; dues:
₦4,500 outstanding" is something a student can act on this afternoon; "not eligible"
is a verdict.

The document carries a **QR code** to a verification endpoint. The QR is not what
makes it hard to forge — anyone can generate one. What makes it hard is that it
carries a reference the database has to recognise, and the page it opens reads the
record from the server rather than from the paper: edit a name on a screenshot and
the code still opens the real record, under the real name. The reference is printed
beside it in full, because a check that only works with a working camera fails at the
one door it was built for.

## 14. Resilience — outage handling

Dept-Flow is a **website first**. It is now installable — a manifest and a service
worker — but every screen works without either, and the service worker exists for two
things only: receiving pushes, and serving an offline page that carries no data.

It never caches a page. Every screen is somebody's record, and phones get shared and
resold; a cached dashboard is one student's attendance served from disk to whoever
picks the phone up next, with no session to check it against.

It never replays an attendance submission either. A POST replayed from the background,
against a code window measured in minutes and with nobody watching the answer, is how
a student ends up believing they were counted.

```
Brief blip:   the page retries with backoff. If the network is gone, the submission is
              HELD and sent when it returns, carrying the ORIGINAL timestamp — a code
              answered in the hall and delivered from the car park is a record of the
              hall. The screen reads "Waiting for a connection — you are not recorded
              yet", and says to leave the tab open.
Full outage:  the lecturer runs a paper sign-in, then submits a ManualAttendanceBatch
              with a justification. Each row resolves through the SAME
              resolveSessionScore logic, tagged source = manually_entered.
```

**The interface must never confirm attendance before the server acknowledges it.** A
student who sees "Recorded ✓" and walks away uncounted is the worst failure this
system can produce, and the submission hook has no client-reachable state that says
recorded.

## 15. Cross-cutting constraints

- **RBAC server-side on every endpoint**, not hidden in the UI. This closes the
  classic IDOR gap: a subscription, a report or a message is scoped by the session,
  never by an id in the request body.
- **Rate limiting** on registration, code submission and login. The code is four
  digits, so ten thousand guesses is a short script, and a signed-in student is
  exactly who would run it.
- **Uniqueness at the database level**: `(student_id, checkpoint_id)`, the Paystack
  reference, the provider event id, the push endpoint. Each is the cheapest defence
  against a duplicate at the only level where it cannot be raced.
- **Audit everywhere sensitive**, with a mandatory reason — grace, waiver,
  deactivation, registration revoke, manual payment, level rollover, eligibility
  authorization, and every HOD message. Reaching four hundred phones is an authority
  action, and the person who did it should be recoverable a year later.
- **Data minimisation (NDPA).** No coordinates, no biometrics, no device
  fingerprinting, no continuous tracking. Nothing is retained that the system does
  not use, which is why the GPS retention job was deleted rather than reconfigured:
  there is nothing left for it to purge.

## Explicitly dropped ideas (do not reintroduce)

Dedicated virtual accounts; biometric, fingerprint or selfie-liveness auth; Wi-Fi or
SSID cross-check; CGPA-tied promotion; a system-fixed recheck window.

And, from August 2026: **GPS, geo-fencing, anti-spoof heuristics, device binding, the
two-checkpoint pair, half marks, and provisional scores.** These are not deferred.
They were removed, with their columns.
