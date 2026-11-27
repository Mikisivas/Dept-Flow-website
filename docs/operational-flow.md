# Dept-Flow — Complete Operational Flow

*Last updated: August 2026*

Reflects the updated design direction: an alert-driven, registration-gated system built on trust-based attendance, following the shift away from GPS/anti-proxy enforcement toward keeping students proactively aware of their 75% requirement.

## Roles at a Glance

- **Student** — registers once, registers for courses each semester, logs attendance, receives alerts/reminders/reports, pays dues, prints permit when eligible.
- **Lecturer** — generates the attendance code each session.
- **HOD** — views attendance and payment compliance reports, communicates with students (individual / class / course-group), grants registration exceptions.
- **Admin** — maintains the roster whitelist, sets the registration window, configures the technical layer (timetable, deadlines), manages accounts, oversees payment reconciliation and system health. No visibility into individual academic risk data.

**Flow at a glance:** Account Registration → Semester Registration (gate) → Attendance Logging + Reminders + Predictive Alerts → Reporting → Payment (runs in parallel) → Exam Permit Eligibility.

---

## 1. Account Registration (one-time per student)

1. Admin/HOD uploads the official roster each intake — Matric No, Full Name, Level — pulled from school records.
2. Student registers with Matric No + Name (matched against the roster) + a **primary phone number** (used for SMS and as the account identity number).
3. If the student's WhatsApp runs on a different number — e.g. a data-only SIM not currently loaded in their phone — they can optionally add a **separate WhatsApp number**. Most students won't need this and can leave it blank, in which case WhatsApp alerts just go to the primary number.
4. System sends an OTP to each number provided: an SMS OTP to the primary number, and a WhatsApp OTP to the WhatsApp number if it differs — confirming both are real and reachable before either is trusted.
5. On verification, the matric number is permanently bound to the phone number(s)/account.
6. The registration endpoint is rate-limited/CAPTCHA-protected to stop scripted claiming of the whole roster.
7. Disputes (wrong person claimed a matric number) go through an Admin-managed unbind/reset flow, gated by a secondary identity check.

## 2. Semester Registration (every semester — gates attendance)

1. Admin sets the registration window (e.g., 7 days from resumption).
2. Returning students see: core courses auto-populated, carryovers surfaced from their own registration history, electives to be explicitly selected.

   *Amended after the revision.* "Auto-flagged from their academic record" is not something this system can do: it stores no grades, so nothing in it knows which courses a student failed, and the admin does not know either. What it does know is what each student was enrolled in. So every course a student sat in an earlier session is listed first among the ones they can add, marked with the session they sat it in, and the student — who knows which they must repeat — chooses. A course they sat that this session does not offer at all is named separately, because there is no row to add and silence would read as "nothing to repeat".
3. Registration is a deliberate, final action — status moves `draft → confirmed`, and the system stamps `registered_at` server-side at confirmation, never client-supplied time.
4. As the deadline approaches, WhatsApp reminders go to anyone not yet confirmed.
5. After the deadline, unregistered students cannot log attendance for any course.
6. **Backfill rule:** once a student does confirm (even late), for each newly registered course the system checks the timetable and inserts an ABSENT record for every session that occurred between the deadline and their actual `registered_at`.
7. HOD can grant an individual registration exception (the old payment Grace Period mechanism, repointed at registration) for genuine cases.

## 3. Attendance Logging (trust-based, no location check)

1. Lecturer generates a short-lived code at the start of the session (still shown on the whiteboard).
2. Student enters the code on their device.
3. System checks: is the student registered for this course, and is the code still valid? If yes, logs PRESENT — no GPS, no distance calculation, no spoofing detection.
4. Attendance status updates propagate in real time via Supabase.

## 4. Pre-Lecture Reminders

1. A scheduled job (Supabase pg_cron, or a cron process on the Express service) checks every few minutes for lectures starting in the next ~60 minutes, using the same timetable data as the registration/backfill logic.
2. For each upcoming lecture, the system pulls the students registered for that course and sends a WhatsApp reminder via a pre-approved message template.

## 5. Predictive Warning System (Risk Monitoring & Alerts)

This is the core of Dept-Flow: a **forecast**, not a scoreboard. The model asks "where is this student headed?" rather than just reporting "where are they now?" — that's what makes it a warning system instead of a passive tracker.

1. The Scikit-learn regression model forecasts each student's **projected end-of-semester attendance %** per course, from around week 5–6 onward, based on their trend so far — not just a snapshot of the current percentage.
2. That forecast maps to a tier:

   | Tier | Rule | Meaning |
   |---|---|---|
   | 🟢 Safe | Projected ≥ 80% | On track, comfortable buffer — no alert |
   | 🟡 Watch | Projected 75–80% | On track to land right on the line, no buffer left |
   | 🔴 Critical | Projected < 75% | On track to fail the requirement unless behavior changes now |

3. Channel intensity scales with severity: in-app always; Web Push added at Watch (direct in-browser on Android; requires the PWA added to the home screen first on iOS); WhatsApp added at Critical, sent to the student's WhatsApp number (same as their primary number unless they registered a separate one); SMS reserved for the final, most severe warning since it needs no data connection at all, sent to the primary number. If a WhatsApp send fails to deliver, the system falls back to SMS immediately rather than waiting for the next scheduled alert.
4. Alert copy is specific and actionable — the exact course and the exact number of classes the student can still miss or must attend — never a generic "your attendance is low."
5. An interactive what-if calculator on the student dashboard shows the effect of missing upcoming classes before it happens.

## 6. Reporting

1. Students can pull **weekly** (this week's count, running %, delta from last week), **monthly** (trend across the month, pace needed to hit 75%), and **semester** (full per-course breakdown, eligibility status) reports.
2. Reports are also pushed automatically on a schedule (e.g., a Monday digest) through the same notification system used for alerts, at lower urgency.
3. The semester report shares its generation logic with the exam permit document — built once, reused.

## 7. HOD Oversight & Communication

1. HOD sees an attendance report that includes a live, drillable at-risk list (individual visibility preserved, just pulled via the report rather than pushed per student) alongside department-wide and per-course views.
2. HOD sees a payment compliance report.
3. HOD can message students at four scopes: an individual student, a whole class/level, a course group (everyone currently registered for a given course), or **one level of one programme** — 400 level Computer Science, 100 level Statistics, 300 level Mathematics. The registration data already provides the course mapping; the programme comes from the matric-number prefix. Messages route through the same notification channels as alerts.

   *The fourth scope was added after the August 2026 revision, at the HOD's request.* It is not a convenience over the other two — neither reaches that audience. A whole level spans MTH, CMP and STA together, so a CMP notice sent that way reaches mathematicians as well. A course group reaches only those registered for one course, which coincides with "400L CMP" only if every 400L CMP student happens to take it; electives and carry-overs guarantee they do not, and the student carrying a 300-level paper instead is exactly the one a 400L notice needs to reach. Sending to a course and believing the level was addressed is a silent under-delivery.

## 8. Payment Processing (independent of attendance)

Runs in parallel to everything above — paying dues no longer affects whether a student can log attendance.

1. Paystack handles the transaction; webhook payloads are verified with HMAC-SHA512.
2. Before marking anything paid, the system re-confirms the transaction directly against Paystack's verify-transaction endpoint — defense in depth against a forged or replayed webhook.
3. Processed reference/event IDs are stored to prevent a resent webhook from double-crediting an account.
4. A reconciliation job polls Paystack periodically for anything still "pending," to catch webhooks that never arrive.
5. Partial/installment payments are supported with a running balance rather than a flat paid/unpaid flag.
6. A Payment Integrity check flags anomalies: duplicate references, one card funding several different matric numbers, amounts that don't match the fixed dues figure.
7. Reversed/charged-back payments trigger reconciliation and re-lock (with notice) rather than a silent revoke.
8. Every manual "mark as paid" by an Admin is logged with a mandatory reason field.
9. A manual fallback (receipt upload + Admin approval, explicitly flagged as "manually verified") exists for total gateway or connectivity failure.

## 9. Exam Permit Eligibility

1. Printing the permit requires **both** conditions: dues paid in full **and** ≥75% attendance in each registered course.
2. A live eligibility panel shows exactly what's outstanding per student — e.g., "STA204: 68%, need 3 more classes; dues: ₦4,500 outstanding" — instead of a flat yes/no.
3. The permit itself is a PDF carrying a QR code linking to a verification endpoint, so it can't be screenshotted and edited into a fake.

---

## Cross-Cutting Safeguards

- **RBAC enforced server-side** on every endpoint, not just hidden in the UI — closes the classic IDOR gap.
- **Rate limiting** on registration, code submission, and login endpoints.
- **Audit logging** on every manual override (payments, registration exceptions) with a mandatory reason field.
- **Data minimization / NDPA compliance** — encrypt sensitive fields at rest, don't retain raw data longer than needed, log who accessed what and when.
- **Offline resilience** — failed attendance submissions queue locally and retry on reconnect, keeping the original timestamp.
- **ML stays advisory** — the regression model drives alerts and nudges; actual eligibility is always the deterministic 75% rule, never the model's prediction.

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js / React (TypeScript), built as a PWA — website, not a native app |
| Backend | Node.js/Express (core API, auth, payments) + Python/FastAPI (predictive model, anomaly scoring) |
| Database / real-time | Supabase (PostgreSQL) — also runs pg_cron scheduling for reminders |
| Payments | Paystack, HMAC-SHA512 webhook verification |
| ML | Scikit-learn regression |
| Notifications | WhatsApp Business API (primary), Web Push (secondary, PWA/Android-first), SMS (last-resort/critical only) |
