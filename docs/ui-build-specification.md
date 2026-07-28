# Dept-Flow — UI Build Specification

Specifies **screens, contents, and states only** — no backend logic.

---

## 0. CONTEXT

**What Dept-Flow is:** a departmental compliance and attendance website for a Nigerian university department (SAMACOSS — Student Association of Mathematics, Computer Science & Statistics). It links payment of departmental dues to whether a student's lecture attendance counts toward the 75% exam-eligibility threshold.

**Delivery model:** a responsive **website** in a browser. No installed app, no app store. Students use phones almost exclusively; HOD and admin may use desktop. Must load fast on Nigerian cellular data inside lecture halls.

**Four roles:** Student, Lecturer, HOD, Admin. Strict separation — admin manages the system, HOD manages students. Neither can do the other's job.

**Core mechanic (must be understood to design correctly):**
- A lecture = one **session**. The lecturer triggers **two checkpoints** during it.
- A student submits a 4-digit token at each checkpoint, verified by GPS geo-fence.
- Score: both checkpoints = **1.0**, one = **0.5**, none = **0**.
- Attendance % = (sum of session scores ÷ total sessions held) × 100.
- For the first 30 days, scores are stored **PROVISIONAL** — recorded but NOT counted.
- Paying dues (or HOD clearance) converts all provisional scores to **CONFIRMED**.
- On Day 31, unpaid students are **LOCKED** out of recording new attendance.

---

## 1. DESIGN SYSTEM (do not substitute)

### Colors
```
--brand         #F0952B   Crest orange. Fills, primary buttons, checkpoint motif.
--brand-hover   #D67A0F
--brand-pressed #BF6D0D
--brand-text    #A75F0C   The ONLY orange allowed as text on white.
--brand-tint    #FDF3E7   Subtle panel background
--brand-tint-2  #FCE7CF   Selected rows

--ink           #0A0A0A   Primary text
--slate         #525252   Secondary text
--muted         #737373   Captions, timestamps
--line          #E5E5E5   Borders
--surface       #FFFFFF
--surface-sunken #FAFAFA  Page background, table stripes

--ok            #15803D   Confirmed / Cleared / Paid
--info          #1D4ED8   Pending verification
--danger        #B91C1C   Locked / Error
```

**CRITICAL RULE: never put white text on orange.** Orange is a fill that carries **BLACK** text (8.52:1 contrast). White on orange is 2.32:1 and fails accessibility. Orange as text on white must use `#A75F0C`.

**Orange is the brand, not a warning.** Never use orange, amber, or yellow to signal a status. Status colors are green / blue / red / neutral only.

### Status treatments
| State | Treatment | Label |
|---|---|---|
| Confirmed | Green fill | "Counted" |
| Provisional | **Neutral, dashed outline, no fill** | "Not yet counted" |
| Pending verification | Blue | "Checking payment…" |
| Locked | Red fill | "Attendance locked" |
| At risk | Red **outline** (not filled) | "At risk" |

Never signal state by color alone — always pair with an icon and a text label.

### Typography
- One family (Inter or system stack). 16px base, never below 14px.
- Scale: 12 / 14 / 16 / 20 / 24 / 32.
- **`font-variant-numeric: tabular-nums`** on all stacked numbers.

### Visual signature — the checkpoint pair
Every session renders as two cells:
```
▮▮  Full (1.0)    ▮▯  Half (0.5)    ▯▯  Absent (0)    ⌐⌐  Provisional (dashed)
```
Orange fill = checkpoint captured. Outline = missed. Dashed = provisional.
A single-checkpoint session renders as ONE WIDE CELL so it is visibly not a pair.

### Imagery
**No stock photos. No generic illustrations.** Only: the SAMACOSS crest (login/landing), a simplified shield+monitor mark (header, favicon), and `lucide-react` icons. Empty states are typographic + one icon.

### Tone
Plain, second person, active voice, never apologetic or punitive.
- ✅ "Your dues aren't cleared yet. 12 sessions are waiting to be counted."
- ❌ "Payment compliance violation detected."
- Errors always state the fix. Empty states always state the next action.

### Layout
- **Mobile-first.** Design phone layouts first; desktop is secondary (HOD/admin).
- Tables collapse to stacked cards below `md`. Never horizontal-scroll a table on mobile.
- Sticky primary action on mobile. Bottom sheets for token entry and confirmations.
- Minimum 44×44px tap targets.

---

## 2. SHARED COMPONENTS

**AppShell** — header with site mark + role-appropriate nav + account menu. Bottom tab bar on mobile for students; sidebar on desktop for HOD/admin.

**CheckpointStrip** — the signature component. Renders one session as a checkpoint pair, or a semester as a row of pairs. Each cell needs an accessible label.

**StatusBadge** — icon + label + color. Variants: confirmed, provisional, pending, locked, at-risk.

**AttendanceMeter** — horizontal bar with orange fill AND a hard tick mark at 75% with a label. Provisional sessions shown as a dashed segment beyond the solid fill. Below it, the actionable sentence: "You need 4 more full sessions to reach 75%." A percentage without the 75% line is a failed design.

**ConfirmDialog** — for all destructive/authority actions. Must state exactly what will happen, how many records are affected, and require a typed reason where noted.

**DataTable** — sortable, paginated, filterable. Collapses to cards on mobile. Virtualized above 50 rows.

**EmptyState** — icon + headline + one-sentence explanation + primary action.

**Toast** — success/error notifications.

**PageHeader** — title, optional subtitle, optional primary action.

---

## 3. PUBLIC PAGES (unauthenticated)

### 3.1 Landing page
**Route:** `/` · **Role:** public
**Purpose:** explain what Dept-Flow is and route people to login/register.
**Contents:**
- Full SAMACOSS crest, department name
- One-sentence explanation of the system
- Three short cards: record attendance, pay dues, track exam eligibility
- Primary buttons: "Log in" / "Create account"
- Link: "Check if my matric number is registered"
- Footer: department contact, privacy note
**States:** static only.
*(Optional — can be dropped if the URL should go straight to login.)*

### 3.2 Login
**Route:** `/login` · **Role:** public
**Contents:**
- Crest, "Log in to Dept-Flow"
- Matric number OR staff ID field
- Password field with show/hide toggle
- "Remember me" checkbox
- Primary button: "Log in"
- Links: "Forgot password?", "Create account"
**States:** idle · submitting ("Logging in…") · error (wrong credentials — inline, not a toast) · **account deactivated** (distinct: "This account is no longer active. Contact the department office.")

### 3.3 Register — Step 1: Identity check
**Route:** `/register` · **Role:** public
**Purpose:** match the student against the admin-uploaded whitelist. Identity is **matric number + surname + level** — no date of birth.
**Programme is never asked for.** The department teaches Mathematics, Computer Science and Statistics, and the programme is encoded in the matric number (`CMP/2021/047`). Read it from the number and display it back as confirmation in Step 2; a programme picker is a redundant question the student can get wrong. Level is the third identity field because it is the one fact the matric number does not carry.
**Contents:**
- Progress indicator (Step 1 of 3)
- Explanation: "Only students on the department's register can create an account."
- Fields: Matric number, Surname, Level (select, 100–400)
- Button: "Continue"
**States:** idle · checking · **no match** ("We couldn't find you on the register. Check your details or visit the department office.") · **already claimed** ("An account already exists for this matric number." + link to dispute flow)

### 3.4 Register — Step 2: Phone & OTP
**Route:** `/register/verify` · **Role:** public
**Contents:**
- Step 2 of 3
- Confirmed name shown read-only (so they know the right record matched)
- Phone number field (Nigerian format)
- Button: "Send code"
- Then: 6-digit OTP input — `inputmode="numeric"`, `autocomplete="one-time-code"`, **paste must not be blocked**, auto-advance between digits
- Resend link with countdown timer
**States:** entering phone · sending · awaiting OTP · wrong code · expired code · resend cooldown

### 3.5 Register — Step 3: Set password
**Route:** `/register/password` · **Role:** public
**Contents:**
- Step 3 of 3
- Password + confirm password, strength indicator
- **Consent checkbox** (required, not pre-ticked): explains that location is captured only at the moment attendance is submitted, is not continuous tracking, and is deleted after a short period. Link to the privacy notice.
- Button: "Create account"
**States:** idle · submitting · success → redirect to student dashboard

### 3.6 Matric availability check
**Route:** `/check` · **Role:** public
**Purpose:** let a student discover early if someone has claimed their matric number.
**Contents:**
- Single field: matric number
- Result: "Available — you can register" OR "Already claimed"
- If claimed: **never show the claimant's name.** Show guidance: "If this is your matric number, visit the department office with your ID to reclaim it."
**States:** idle · checking · available · claimed

### 3.7 Forgot / reset password
**Routes:** `/forgot`, `/reset` · **Role:** public
**Contents:** matric number → OTP to registered phone → new password.
**States:** mirrors 3.4 / 3.5.

### 3.8 Privacy notice
**Route:** `/privacy` · **Role:** public
**Contents:** plain-language explanation of what data is collected (identity, attendance, payment references, momentary location), why, how long it is kept, and the retention/deletion policy. References Nigeria Data Protection Act 2023.

### 3.9 Error pages
**Routes:** `/404`, `/500` · Typographic, crest mark, link home. No illustrations.

---

## 4. STUDENT PAGES

### 4.1 Student dashboard
**Route:** `/dashboard` · **Role:** student
**Purpose:** the most-used screen in the system. Answer "am I on track?" instantly.
**Contents, in this priority order:**
1. **Compliance banner** — ONLY if locked, provisional, or pending. First thing on screen with the fix action attached. Never bury it under a greeting.
   - Locked: red, "Attendance locked — your dues aren't cleared." + "Pay dues"
   - Provisional: neutral dashed, "12 sessions recorded but not yet counted." + "Pay dues"
   - Pending: blue, "Checking your payment… this can take a few hours."
2. **Overall attendance summary** — AttendanceMeter across all courses, with 75% line
3. **Per-course cards** — course code + name, AttendanceMeter, CheckpointStrip, sessions attended / sessions held
4. **Risk nudge** (if any) — worded by pattern:
   - trending 0s: "You've missed 3 full classes. Attend the next 4 to reach 75%."
   - trending 0.5s: "You're only catching one checkpoint. Try to stay till the end."
5. **Today's classes** — from the timetable, with an "Enter code" action when a session is live
**States:** loading (skeleton) · empty ("No classes recorded yet. Your attendance appears here after your first lecture.") · locked · normal

### 4.2 Attendance code entry
**Route:** `/attend` (also a bottom sheet from the dashboard) · **Role:** student
**Purpose:** highest-frequency, most time-pressured interaction. Noisy hall, 3–5 minute window.
**Contents:**
- Course + lecturer name, so they know which session they're marking
- **Which checkpoint this is** (1st or 2nd) — clearly stated
- Large 4-digit input, `inputmode="numeric"`, big touch targets, **paste must work**, auto-advance
- Countdown to token expiry, visible
- Primary button: "Submit"
- Small note: "Your location is checked once, now."
**States:**
- idle
- **submitting: "Sending…" — NEVER "Recorded"** until the server confirms
- accepted: green, states which checkpoint was captured and what the session is currently worth ("Checkpoint 1 captured. Attend the second to earn a full mark.")
- rejected — **each with its own specific message, never a generic error:**
  - outside geo-fence: "You're not in the lecture hall. Move closer and try again."
  - expired token: "This code has expired. Ask your lecturer for the new one."
  - wrong code: "That code isn't right. Check the board."
  - locked account: "Your attendance is locked until your dues are cleared."
  - location blocked in browser: "Allow location access to record attendance." + instructions to enable it
  - already submitted: "You've already recorded this checkpoint."
- offline/failed: loud failure while they're still in the hall, with retry

### 4.3 Course detail
**Route:** `/courses/[code]` · **Role:** student
**Contents:**
- Course header, lecturer, schedule
- AttendanceMeter with 75% line
- Full session history table: date, checkpoint pair, score, status (confirmed/provisional), source (digital / recorded from paper register)
- Projection: "At your current rate you'll finish at 68%."
**States:** loading · empty · normal

### 4.4 Dues & payment
**Route:** `/dues` · **Role:** student
**Contents:**
- Amount due, deadline date, days remaining (prominent countdown before Day 30)
- **What clearing unlocks** — "This will count your 12 waiting sessions."
- Payment method choice: **Card** or **Pay with Transfer** (no other methods)
- Primary button: "Pay ₦X,XXX"
- Payment history table: date, amount, method, reference, status
**States:** unpaid · **pending verification** (blue, "Checking payment…") · paid (green, with receipt link) · waived (HOD granted) · locked + grace period active (show grace expiry date)

### 4.5 Payment result
**Route:** `/dues/result` · **Role:** student
**Contents:** outcome, amount, reference number, and — critically — what changed: "12 sessions are now counted. Your attendance is 78%."
**States:** success · pending (still verifying) · failed (with retry)

### 4.6 Notifications
**Route:** `/notifications` · **Role:** student
**Contents:** chronological list — payment reminders, risk nudges, grace period announcements, schedule changes (makeup/cancelled classes). Unread indicator.
**States:** empty · list

### 4.7 Profile & settings
**Route:** `/profile` · **Role:** student
**Contents:** name, matric number, level (all read-only), phone number (editable, re-verified by OTP), change password, notification preferences, link to privacy notice, log out.
**Never displays raw GPS coordinates or location history.**

---

## 5. LECTURER PAGES

### 5.1 Lecturer dashboard
**Route:** `/lecturer` · **Role:** lecturer
**Contents:**
- Today's scheduled classes, each with a "Start session" action
- Any currently open session, prominently, with a "Resume" action
- Recent sessions with attendance counts
- Quick links: my courses, schedule a makeup class
**States:** no classes today · classes scheduled · session in progress

### 5.2 Session control (live)
**Route:** `/lecturer/session/[id]` · **Role:** lecturer
**Purpose:** operated while standing in front of a class. One primary action at a time, very large touch targets.
**Contents:**
- Course, venue, start time, elapsed timer
- **"Generate checkpoint code"** — single prominent button
- When generated: the **4-digit code displayed VERY LARGE** (it gets written on a whiteboard), with an expiry countdown
- Clear indicator: "Checkpoint 1 of 2" / "Checkpoint 2 of 2"
- Live submission counter, updating: "34 students recorded"
- Live list of who has submitted (searchable)
- Rejected-submission counter with reasons (flags possible spoofing)
- "End session" button
**States:** session open, no checkpoint yet · checkpoint live (countdown) · checkpoint expired, awaiting next · both checkpoints done · ending
**Special:** ending with only ONE checkpoint issued must confirm: "This session will be scored present/absent, not out of two checkpoints. Continue?"

### 5.3 Session detail (closed)
**Route:** `/lecturer/session/[id]/review` · **Role:** lecturer
**Contents:** full roster with each student's checkpoint pair and resulting score; counts of full/half/absent; flagged submissions listed for review.
**Action:** "Enter paper register" (only if the session had no or partial digital capture).

### 5.4 Manual attendance batch (paper fallback)
**Route:** `/lecturer/session/[id]/manual` · **Role:** lecturer
**Purpose:** transcribe a paper sign-in sheet after a network outage.
**This screen must feel heavier than the normal flow** — it bypasses the anti-proxy checks.
**Contents:**
- Prominent warning explaining that entries are flagged and reviewable by the HOD
- Roster with **two checkboxes per student** (Checkpoint 1, Checkpoint 2), mirroring the paper sheet's two columns
- Live preview of the resulting score per student (1.0 / 0.5 / 0)
- **Mandatory justification note** (textarea, cannot submit empty)
- Confirm dialog before submitting
**States:** editing · confirming · submitted

### 5.5 Schedule management
**Route:** `/lecturer/schedule` · **Role:** lecturer
**Contents:** calendar/list of the lecturer's own sessions.
**Actions:**
- **Reschedule** — move a session (new date/time/venue)
- **Makeup class** — add a one-off extra session
- **Cancel** — remove a session; confirm dialog must state the consequence: "This session won't count toward anyone's total."
All three notify enrolled students automatically. Must be created BEFORE the session starts (no backdating).
**States:** list · creating · confirming

### 5.6 My courses
**Route:** `/lecturer/courses` · **Role:** lecturer
**Contents:** courses taught, enrolled student count, sessions held, average attendance, link to each course roster.

---

## 6. HOD PAGES

*Academic governance. Individual students visible. No system configuration.*

### 6.1 HOD dashboard
**Route:** `/hod` · **Role:** HOD
**Contents:**
- Department-wide attendance distribution
- Count of students below 75% and trending below
- Compliance summary (cleared / provisional / locked counts)
- Active grace period status (if any) with expiry
- Pending items: dispute count, waiver requests
**States:** loading · normal

### 6.2 At-risk students
**Route:** `/hod/risk` · **Role:** HOD
**Contents:** table sorted by severity — student, matric, level, course, current %, predicted final %, CheckpointStrip (so the pattern is readable at a glance), risk pattern label (disengagement vs partial attendance). Filter by level/course. Export action.
**States:** empty ("No students currently at risk.") · list

### 6.3 Student detail
**Route:** `/hod/students/[matric]` · **Role:** HOD
**Contents:** profile summary, per-course attendance meters, full session history with CheckpointStrips, payment/clearance status, audit trail of any overrides applied to this student.
**Actions:** grant clearance/waiver, resolve a dispute.
**Never shows raw GPS coordinates.**

### 6.4 Grace period control
**Route:** `/hod/grace` · **Role:** HOD
**Purpose:** the highest-consequence control on the site.
**Contents:**
- Current state: active grace period (with expiry) or none
- Form: new expiry date, scope (whole department or a level), **mandatory reason**
- **Impact preview before confirming: "This will restore attendance access for 143 locked students until 12 May."**
- Confirm dialog
- History of previous grace periods with who granted them and why
**States:** none active · active · creating · confirming

### 6.5 Waivers & clearances
**Route:** `/hod/waivers` · **Role:** HOD
**Contents:** list of hardship/waiver requests and manually cleared students.
**Action:** grant clearance with mandatory reason — states the effect: "This will count this student's 9 provisional sessions."
**States:** empty · pending list · history

### 6.6 Attendance disputes
**Route:** `/hod/disputes` · **Role:** HOD
**Contents:** student-raised disputes ("I was present but was rejected"), each showing the session, the rejection reason recorded, and whether the session was digital or a paper batch.
**Actions:** uphold or correct the record (correction requires a reason, writes to the audit log).
**States:** empty · open · resolved

### 6.7 Exam eligibility list
**Route:** `/hod/eligibility` · **Role:** HOD
**Purpose:** the final authoritative output of the whole system.
**Contents:**
- Per course: every student, final attendance %, eligible/not eligible
- Summary counts
- **This is an authorization action, not an export.** "Authorize list" requires a confirm dialog and is recorded in the audit log. Print/PDF after authorizing.
**States:** draft · authorized (locked, timestamped, with authorizer name)

### 6.8 Lecturer oversight
**Route:** `/hod/lecturers` · **Role:** HOD
**Contents:** per lecturer — sessions held, **manual/paper batch usage rate** (a lecturer who "loses network" weekly is worth a conversation), single-checkpoint session rate, cancelled sessions. This turns the paper fallback into a monitored path rather than a silent backdoor.

---

## 7. ADMIN PAGES

*Operations and infrastructure. Aggregate signals only — **no individual student risk alerts** (that is HOD scope; showing it here breaks separation of duties).*

### 7.1 Admin dashboard
**Route:** `/admin` · **Role:** admin
**Contents:**
- Aggregate compliance: % cleared, % provisional, % locked, by level
- Payment reconciliation health: failed webhooks, unverified transactions
- **GPS rejection rate** with spike detection (possible spoofing attempts)
- Registration queue: pending disputes, unclaimed whitelist rows
- Days remaining in the current dues window
**States:** loading · normal · alert (anomaly detected)

### 7.2 Whitelist management
**Route:** `/admin/whitelist` · **Role:** admin
**Contents:**
- Upload CSV (matric no, surname, level) for a session
- **Preview/diff before committing** — how many rows added, changed, already claimed. Never commit an upload blind.
- Table of whitelist rows with claimed/unclaimed status, searchable
- Manual single-row add for late registrations
**States:** empty · uploading · preview/diff · committed · validation errors (show which rows failed and why)

### 7.3 Registration disputes
**Route:** `/admin/disputes` · **Role:** admin
**Contents:** reported impostor claims. Each shows the matric number, when it was claimed, and the phone number on the account (partially masked).
**Action: revoke registration** — freezes the existing account (does NOT delete it), unclaims the whitelist row, requires a reason, writes to the audit log. Confirm dialog explains both effects.
**Flag automatically:** the same phone number or device claiming multiple matric numbers.
**States:** empty · open · resolved

### 7.4 Student management
**Route:** `/admin/students` · **Role:** admin
**Contents:** searchable, filterable table — matric, name, level, status, clearance state. Bulk selection.
**Action: deactivate** — reason required (Expelled / Withdrawn / Graduated / Other + note). **Soft delete only**: history retained, login disabled, matric number retired and never reused. Confirm dialog states this.
**States:** list · confirming deactivation

### 7.5 Level rollover
**Route:** `/admin/rollover` · **Role:** admin
**Purpose:** promote every continuing student one level at the start of a session.
**Contents:**
- New session selector
- **Impact preview: "412 students will move up one level. 87 final-year students will be marked Graduating."** Breakdown by level.
- Strong confirm dialog — this is irreversible in practice
- History of previous rollovers
**Note:** promotion is unconditional. No CGPA check, no repeat-of-level option.
**States:** idle · preview · confirming · complete

### 7.6 System configuration
**Route:** `/admin/config` · **Role:** admin
**Contents:**
- Dues amount
- Resumption date (starts the 30-day window)
- Grace window length (default 30 days)
- Pending-verification buffer length (6–12h)
- **Geo-fence editor** — venue coordinates/polygon per lecture hall, with a radius setting (30–50m) and a map preview
- GPS retention period (days before raw coordinates are purged)
**Every change requires confirmation and is audit-logged.**
**States:** viewing · editing · confirming

### 7.7 Timetable management
**Route:** `/admin/timetable` · **Role:** admin
**Contents:** the baseline recurring timetable for the active session — course, day, time, venue, lecturer. Versioned per session; previous sessions archived read-only.
**Actions:** add/edit/remove entries; bulk import; copy from a previous session.
**States:** empty · list · editing

### 7.8 Payment reconciliation
**Route:** `/admin/payments` · **Role:** admin
**Contents:** all transactions — student, amount, channel (card/transfer), reference, status, timestamp. Filter by status.
**Highlight:** pending/failed/unverified transactions needing attention.
**Action:** manually re-verify a transaction against the payment gateway.
**States:** list · re-verifying · resolved

### 7.9 Courses & lecturers
**Route:** `/admin/courses` · **Role:** admin
**Contents:** course catalogue (code, title, level, assigned lecturer), lecturer accounts, course-to-student enrolment.
**Actions:** create/edit course, assign lecturer, manage enrolment.

### 7.10 Audit log
**Route:** `/admin/audit` · **Role:** admin
**Contents:** immutable chronological record — actor, role, action, target, reason, timestamp. Filterable by actor, action type, date range.
**Covers:** grace periods, waivers, clearances, deactivations, registration revokes, config changes, manual attendance batches, eligibility authorizations.
**Read-only. No delete, no edit.** Export action.
**States:** list · filtered · empty

---

## 8. GLOBAL REQUIREMENTS FOR EVERY PAGE

**Every page needs all four states designed:** loading (skeleton, not spinner) · empty (with a next action) · error (with a fix) · populated.

**Accessibility:**
- Visible keyboard focus on every interactive element
- Icon-only buttons need accessible labels
- Status never conveyed by color alone
- Semantic headings in order; skip link
- Async updates announced to screen readers

**Confirmation required** (with a reason field where noted) for: grace period, waiver/clearance, student deactivation, registration revoke, level rollover, manual attendance batch, session cancellation, eligibility authorization, config changes.

**Never in the UI:**
- White text on orange
- Raw GPS coordinates shown to any user
- Any biometric/fingerprint/selfie interface (not part of this system)
- Stock photography or generic illustrations
- "Recorded ✓" before the server has confirmed
- Invented states — the only compliance states are: provisional, confirmed, pending verification, locked, cleared
