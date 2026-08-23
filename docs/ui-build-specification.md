# Dept-Flow — UI Build Specification

Specifies **screens, contents, and states only** — no backend logic.

**Revised August 2026** for the supervisor's operational flow. The core mechanic
changed underneath this document: no GPS, no checkpoint pair, and dues no longer
decide whether a lecture counts. Where anything here still reads as though they do,
`operational-flow.md` and `system-operation-and-logic.md` win.

---

## 0. CONTEXT

**What Dept-Flow is:** an attendance and eligibility website for a Nigerian university department (SAMACOSS — Student Association of Mathematics, Computer Science & Statistics). Its job is to make sure no student reaches exam week surprised: it forecasts where each of them will finish, per course, and warns them early enough and specifically enough to act.

**Delivery model:** a responsive **website** in a browser, installable as a PWA on top of that. No app store, no native build; every screen works with no service worker at all. Students use phones almost exclusively; HOD and admin may use desktop. Must load fast on Nigerian cellular data inside lecture halls.

**Four roles:** Student, Lecturer, HOD, Admin. Strict separation — admin manages the system, HOD manages students. Neither can do the other's job, and **admin sees no individual student's academic risk at all**.

**Core mechanic (must be understood to design correctly):**
- A lecture = one **session**. The lecturer issues **one** short-lived 4-digit code.
- A student enters it. That is the whole mechanism — **no location, ever.**
- Score is binary: present = **1**, absent = **0**. There are no half marks.
- Attendance % = (sum of session scores ÷ lectures held while enrolled) × 100.
- **Semester registration gates attendance.** Past the deadline an unconfirmed student cannot record it, and confirming late backfills an absence for every lecture missed in between.
- **Dues gate nothing here.** A lecture counts whether or not a naira has been paid.
- Dues and attendance meet in exactly one place: **the exam permit needs both** — paid in full, and 75% in the course.

**The product is the forecast, not the tally.** A student on 76.92% today who has missed the last three lectures is projected to finish at 66% — a scoreboard calls that green. Every screen that shows a percentage should be asked whether it ought to be showing the projection beside it.

---

## 1. DESIGN SYSTEM (do not substitute)

### Colors
```
--brand         #FF9935   Crest orange, EYEDROPPED. Fills, primary buttons.
--brand-hover   #E58419
--brand-pressed #C96E10
--brand-text    #A85E0A   The ONLY orange allowed as text on white. 4.92:1
--brand-tint    #FFF4E8   Subtle panel background
--brand-tint-2  #FFE7CE   Selected rows

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

**CRITICAL RULE: never put white text on orange.** Orange is a fill that carries **BLACK** text (9.30:1, AAA). White on `#FF9935` is **2.13:1** — worse than the older `#F0952B` estimate suggested, so the rule is harder than it looks, not softer. Orange as text on white must darken to `#A85E0A`.

These values are sampled from the crest rather than estimated. Earlier drafts of this
document carried `#F0952B`, which is close enough to look right beside the real thing
and wrong enough to be visibly off on a printed permit.

**Orange is the brand, not a warning.** Never use orange, amber, or yellow to signal a status. Status colors are green / blue / red / neutral only.

### Status treatments
| State | Treatment | Label |
|---|---|---|
| Counted | Green fill | "Counted" |
| Absent | Outline, no fill | "Absent" |
| Pending verification | Blue | "Checking payment…" |
| Locked | Red fill | "Attendance locked" |
| At risk | Red **outline** (not filled) | "At risk" |

Never signal state by color alone — always pair with an icon and a text label.

**The forecast tiers are not a fourth colour scheme.** Safe is green, Critical is the
at-risk outline, and **Watch carries no alarm colour at all** — neutral border, muted
text. Watch means "you have no room left", not "you are failing, but less"; dressing
it in red leaves nothing louder for the students who actually are.

The `provisional` treatment is gone. It existed to render a score that had been
recorded but did not count, and there is no longer such a thing.

### Typography
- One family (Inter or system stack). 16px base, never below 14px.
- Scale: 12 / 14 / 16 / 20 / 24 / 32.
- **`font-variant-numeric: tabular-nums`** on all stacked numbers.

### Visual signature — the attendance strip
Every lecture renders as one cell:
```
▮  Present (1)    ▯  Absent (0)
```
Orange fill = present. Outline = missed.

The strip is the one thing on a screen that a percentage cannot say. Two students on
76.92% can be in completely different trouble — one missed three lectures at the
start and has been perfect since, the other attended ten straight and then stopped —
and the shape is what tells them apart. It is why the at-risk list is a table and not
a list of numbers.

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

**AttendanceStrip** — the signature component. Renders a term as a row of one-cell-per-lecture. Each cell needs an accessible label.

**StatusBadge** — icon + label + color. Variants: counted, pending, locked, at-risk.

**AttendanceMeter** — horizontal bar with orange fill AND a hard tick mark at 75% with a label. Below it, the actionable sentence: "You need 4 more lectures to reach 75%." A percentage without the 75% line is a failed design.

**ForecastPanel** — the projection for one course: where they are headed, the number of lectures that would fix it, and the what-if slider. Two rules its copy keeps. Every sentence names the course and a count — never "your attendance is low", which a student cannot act on. And the good case gets a sentence too: a panel that only appears when something is wrong is one students dread and then avoid.

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
1. **Registration banner** — if the window is open and unconfirmed, or the deadline has passed and they never confirmed. This is the one that stops attendance working, so it outranks everything.
   - Open: "Confirm your registration for this semester." + "Confirm"
   - Missed: "You can't record attendance until you confirm. Lectures held since the deadline will be marked absent." — say the cost before they click, not after.
2. **Dues banner** — only if something is outstanding, and it must say what it does NOT affect: "Your dues don't affect whether a lecture counts. They're needed for your exam permit." A student who thinks their attendance is at stake will be quietly wrong about their standing for a term.
3. **Forecast, per course** — the ForecastPanel. Where they are headed, and the number of lectures that would fix it.
4. **Overall attendance summary** — AttendanceMeter across all courses, with 75% line
5. **Per-course cards** — course code + name, AttendanceMeter, AttendanceStrip, lectures attended / lectures held
6. **Today's classes** — from the timetable, with an "Enter code" action when a session is live
**States:** loading (skeleton) · empty ("No classes recorded yet. Your attendance appears here after your first lecture.") · not registered · normal

**The forecast outranks the meter.** The meter answers "where am I", which the student
usually already knows; the panel answers "where am I going", which is the thing they
came for and the only one they can still change.

### 4.2 Attendance code entry
**Route:** `/attend` (also a bottom sheet from the dashboard) · **Role:** student
**Purpose:** highest-frequency, most time-pressured interaction. Noisy hall, 3–5 minute window.
**Contents:**
- Course + lecturer name, so they know which lecture they're marking
- Large 4-digit input, `inputmode="numeric"`, big touch targets, **paste must work**, auto-advance
- Countdown to code expiry, visible
- Primary button: "Submit"
- **No location step, no permission prompt, no note about either.** The screen asks for one thing and asks for it once.
**States:**
- idle
- **submitting: "Sending…" — NEVER "Recorded"** until the server confirms
- accepted: green, "Attendance recorded. You're counted for this lecture of CMP 301."
- **queued (offline): the state to be most careful with.** It looks like success — the student did everything asked of them — and it is not: nothing has reached the server. No tick, no green. "Waiting for a connection — you are not recorded yet", with "leave this tab open" and "if the lecture ends first, tell your lecturer".
- rejected — **each with its own specific message, never a generic error:**
  - expired code: "This code has expired. Ask your lecturer for the new one."
  - wrong code: "That code isn't right. Check the board."
  - not registered: "You aren't registered for this course." + where to fix it
  - locked account: "Your account is not active for this session."
  - already submitted: "You've already recorded this lecture."
- failed: loud failure while they're still in the hall, with retry

**Rejections a student cannot act on lose the retry button.** Offering "Try again"
against an unregistered course teaches them to distrust the screen; the button becomes
a link to the thing that would actually help.

### 4.3 Course detail
**Route:** `/courses/[code]` · **Role:** student
**Contents:**
- Course header, lecturer, schedule
- AttendanceMeter with 75% line
- Full lecture history table: date, present/absent, source (digital / recorded from paper register)
- The ForecastPanel for this course, including the what-if slider
**States:** loading · empty · normal

### 4.4 Dues & payment
**Route:** `/dues` · **Role:** student
**Contents:**
- Amount due, **balance outstanding**, deadline date, days remaining
- **What paying is for, said plainly** — "Your dues don't affect whether a lecture counts. They're needed for your exam permit." The old screen promised that paying would count waiting sessions; it no longer does, and a student left believing it would be wrong about their standing all term.
- **Instalments are first class.** A part payment reduces the balance rather than being refused for not matching. Show paid-of-total, not a paid/unpaid flag.
- Payment method choice: **Card** or **Pay with Transfer** (no other methods)
- Primary button: "Pay ₦X,XXX"
- Payment history table: date, amount, method, reference, status
**States:** unpaid · part paid (balance running down) · **pending verification** (blue, "Checking payment…") · paid in full (green, with receipt link) · waived (HOD granted) · **reversed** — a charged-back payment re-locks, and the student is told, rather than discovering it at the permit screen

### 4.5 Payment result
**Route:** `/dues/result` · **Role:** student
**Contents:** outcome, amount, reference number, and what changed — which is the dues balance and the permit, never the attendance. "Paid in full. Your exam permit is available once the department authorizes the eligibility list."
**States:** success · pending (still verifying) · failed (with retry)

### 4.6 Notifications
**Route:** `/notifications` · **Role:** student
**Contents:**
- **Push toggle, above the list.** Asked once, from behind a button, next to a sentence saying what will arrive — a permission prompt fired on page load gets denied, and a denied prompt cannot be asked again. When it is blocked or unsupported, say what still covers them: warnings escalate to WhatsApp regardless, which is what makes declining a real choice.
- Chronological list — attendance warnings, pre-lecture reminders, payment notices, registration announcements, HOD messages, schedule changes. Unread indicator.
**States:** empty · list

The list is usually empty at the moment it matters most, which is the point of the
toggle: a warning read three days later, on a visit made for some other reason, is a
warning that arrived too late to change anything.

### 4.7 Profile & settings
**Route:** `/profile` · **Role:** student
**Contents:** name, matric number, level (all read-only), primary phone number and the optional separate WhatsApp number (both editable, each re-verified by OTP), change password, link to privacy notice, log out.
**There is no location history to display, and no screen anywhere that could show one.**

### 4.8 Semester registration
**Route:** `/courses/register` · **Role:** student
**Purpose:** the screen that decides whether attendance works at all.
**Contents:**
- The window and its deadline, stated plainly
- Core courses, already enrolled; electives and carry-overs to choose, against a 24-unit cap with a live running total
- **Confirm**, with the cost of being late stated BEFORE the click, not after: "Lectures held since the deadline will be marked absent."
**States:** window not open · open and unconfirmed · confirmed · **past the deadline and unconfirmed** (the state that blocks attendance, with what to do about it) · confirmed late (showing what was backfilled)

### 4.9 Reports
**Route:** `/reports` · **Role:** student
**Contents:** three windows on the same term — this week, this month, the semester. Each shows lectures held, attended, the percentage, and the change from the previous window. The semester view is per course and shares its generator with the exam permit, so the two cannot disagree.
**States:** loading · empty (no lectures in the window — which is not the same as zero attended, and must not be shown as zero) · normal

### 4.10 Exam permit
**Route:** `/permit` · **Role:** student
**Purpose:** the end of every path in the system.
**Contents:**
- **The live eligibility panel, above everything and in every state.** Per course: the percentage, and either "above the line" or "attend 3 more classes of the 9 left" or "attending all 9 still finishes below 75%". Plus the dues line, in naira. Whatever the outcome, the question the student came to ask is "what do I still have to do", and a verdict without an answer to that is a door with no handle.
- The document itself, once both conditions are met: crest, name, matric number, papers covered, papers excluded and why, reference, and a **QR code** to the verification endpoint with the reference printed beside it in full.
**States, all four distinct and never collapsed:**
- **not authorized** — the department has not decided
- **not eligible** — the department decided against them
- **dues outstanding** — the one they can clear themselves, this afternoon
- **issued** — with print/save-as-PDF

### 4.11 Offline
**Route:** `/offline` · **Role:** anyone
**Purpose:** what the service worker serves when a navigation cannot reach the server.
**Contents:** no data of any kind — which is what makes it the only page safe to cache. It says that nothing of theirs is stored on the phone, and, critically, that an attendance code they were entering has **not** been recorded and the tab must stay open.

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
- **"Issue the code"** — single prominent button
- When issued: the **4-digit code displayed VERY LARGE** (it gets written on a whiteboard), with an expiry countdown
- Live submission counter, updating: "34 students recorded"
- Live list of who has submitted (searchable)
- "End session" button
**States:** session open, no code yet · code live (countdown) · code expired · ending

**One code per lecture.** There is no pair to be half of, no "checkpoint 1 of 2", and
no rejected-submission panel — the rejections that remain are a mistyped code and an
unregistered student, neither of which is a lecturer's problem to watch in real time.

### 5.3 Session detail (closed)
**Route:** `/lecturer/session/[id]/review` · **Role:** lecturer
**Contents:** full roster with each student present or absent; counts of present/absent.
**Action:** "Enter paper register" (only if the session had no or partial digital capture).

### 5.4 Manual attendance batch (paper fallback)
**Route:** `/lecturer/session/[id]/manual` · **Role:** lecturer
**Purpose:** transcribe a paper sign-in sheet after a network outage.
**This screen must feel heavier than the normal flow** — it is the one path with no code behind it, and it is the one an HOD's oversight screen counts.
**Contents:**
- Prominent warning explaining that entries are recorded as manually entered and are reviewable by the HOD
- Roster with **one checkbox per student** — present or absent, mirroring a sign-in sheet
- Live count of the roster marked present
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
- Count of students below 75% now, and **the count projected to finish below** — the second number is the one that can still be acted on
- Compliance summary (cleared / uncleared / pending / locked counts)
- Active registration exception (if any) with expiry
- Pending items: dispute count, waiver requests
**States:** loading · normal

### 6.2 At-risk students
**Route:** `/hod/risk` · **Role:** HOD
**Contents:** table sorted by severity — student, matric, level, course, current %, projected final %, tier, AttendanceStrip (so the pattern is readable at a glance), risk pattern label (disengagement vs partial attendance), and **what would fix it** ("13 of the 17 remaining"). Filter by level/course.

**Every row is a link to the student's record.** A row here starts a conversation, it
does not end one: "Chidera is projected at 66.5% in CMP 301" is not enough to act on,
and an HOD about to call a student in needs to see whether they stopped coming in
week four or have been at half marks all term — the same number on this screen, and
two different meetings.

**Filtered to Watch and Critical.** The forecast table holds a row for every
enrolment, Safe ones included, because the student's own dashboard needs the good
news too. A list headed "at-risk students" that read it unfiltered would put the whole
department on it, which is the same as putting nobody on it.
**States:** empty ("No students currently at risk.") · list

### 6.3 Student detail
**Route:** `/hod/students/[matric]` · **Role:** HOD
**Contents:** profile summary, per-course attendance meters, full lecture history with AttendanceStrips, dues balance, audit trail of any decision applied to this record.
**Actions:** grant clearance/waiver, resolve a dispute.

### 6.4 Registration exceptions
**Route:** `/hod/grace` · **Role:** HOD
**Purpose:** the highest-consequence control on the site. Same mechanism as the old
grace period, repointed: it used to restore attendance to students locked out by
dues, and it now restores it to students shut out by the registration deadline.
**Contents:**
- Current state: active exception (with expiry) or none
- Form: new expiry date, scope (whole department, a level, or one student), **mandatory reason**
- **Impact preview before confirming: "This will let 143 students who missed the registration deadline record attendance until 12 May."**
- Confirm dialog
- History of previous exceptions with who granted them and why
**States:** none active · active · creating · confirming

### 6.5 Waivers & clearances
**Route:** `/hod/waivers` · **Role:** HOD
**Contents:** list of hardship/waiver requests and manually cleared students.
**Action:** grant clearance with mandatory reason — states the effect on the dues balance and the permit, never on attendance, which a waiver does not touch.
**States:** empty · pending list · history

### 6.6 Attendance disputes
**Route:** `/hod/disputes` · **Role:** HOD
**Contents:** student-raised disputes ("I was present but was marked absent"), each showing the lecture, the rejection reason recorded if there was a submission at all, and whether the lecture was scored digitally or from a paper batch.
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
**Contents:** per lecturer — lectures held, **manual/paper batch usage rate** (a lecturer who "loses network" weekly is worth a conversation), cancelled sessions. This turns the paper fallback into a monitored path rather than a silent backdoor.

### 6.9 Message students
**Route:** `/hod/messages` · **Role:** HOD
**Purpose:** one message, three audiences — an individual, a whole level, or everyone currently registered for a course.
**Contents:**
- Scope picker, then the field that scope needs (matric number / level / course)
- **Live audience count, above the message box and repeated in the confirmation.** "Message 412 students" is a different decision from "message 12", and an HOD should be making the one they think they are making. Fetched from the server on every scope change — counted in the browser it would be a guess.
- Subject and body, with a floor on the body: a message reaching four hundred phones that says "see me" is a summons nobody can act on
- Recently sent, with audience and recipient count
- The screen states where messages arrive: the same channels as an attendance warning, **never SMS**
**States:** composing · confirming · sent · error

### 6.10 Payment compliance
**Route:** `/hod/payments` · **Role:** HOD
**Purpose:** exists BECAUSE payment was decoupled. Dues used to be readable off the attendance screens as a side effect of gating them; they gate nothing now, so the department's money is invisible unless there is somewhere to look.
**Contents:** by level — students, paid in full, **part paid**, nothing paid, outstanding total. Three columns rather than paid/unpaid, because instalments made "has not paid" stop being one fact.
**States:** empty (no dues configured) · normal

---

## 7. ADMIN PAGES

*Operations and infrastructure. Aggregate signals only — **no individual student risk data of any kind** (that is HOD scope; showing it here breaks separation of duties). This is a role boundary rather than a screen layout: `risk_predictions` is unreadable as the admin, so the data is absent rather than hidden.*

### 7.1 Admin dashboard
**Route:** `/admin` · **Role:** admin
**Contents:**
- Aggregate compliance: % cleared, % part paid, % locked, by level
- Payment reconciliation health: failed webhooks, unverified transactions, **payment-integrity anomalies** (one card fingerprint paying for many students, a reference verified twice)
- Registration queue: pending disputes, unclaimed register rows, semester registration confirmations against the window
- Days remaining in the current dues window
**States:** loading · normal · alert (anomaly detected)

There is no GPS rejection rate, because there are no GPS rejections. The anomaly
signal that replaced it is about money, which is the thing this role is actually
responsible for.

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
**Flag automatically:** the same phone number claiming multiple matric numbers. (Not device — there is no device id to flag on, and there will not be one.)
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
- **Semester registration window** — opens_on and deadline, per semester. The control that decides who can record attendance, so it belongs to the operations role and not the academic one.
- Grace window length (default 30 days)
- Pending-verification buffer length (6–12h)
- Attendance code lifetime
**Every change requires confirmation and is audit-logged.**

There is no geo-fence editor and no GPS retention setting. Both were removed with
location enforcement, along with the venue coordinate columns they edited — venues are
now names.
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
**Actions:** manually re-verify a transaction against the payment gateway; **record a manual payment** (a student who paid at the bursary, or uploaded a receipt) with a mandatory reason and an audit row, flagged as manually verified so reconciliation can tell it from Paystack's own; **reverse a payment**, which re-locks the student and notifies them.
**States:** list · re-verifying · recording · confirming · resolved

### 7.9 Courses & lecturers
**Route:** `/admin/courses` · **Role:** admin
**Contents:** course catalogue (code, title, level, assigned lecturer), lecturer accounts, course-to-student enrolment.
**Actions:** create/edit course, assign lecturer, manage enrolment.

### 7.10 Audit log
**Route:** `/admin/audit` · **Role:** admin
**Contents:** immutable chronological record — actor, role, action, target, reason, timestamp. Filterable by actor, action type, date range.
**Covers:** registration exceptions, waivers, clearances, deactivations, registration revokes, config changes, manual attendance batches, manual and reversed payments, eligibility authorizations, level rollovers, and **every HOD message** — reaching four hundred phones is an authority action and leaves a record like one.
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

**Confirmation required** (with a reason field where noted) for: registration exceptions, waiver/clearance, student deactivation, registration revoke, level rollover, manual attendance batch, session cancellation, eligibility authorization, manual and reversed payments, HOD messages, config changes.

**Never in the UI:**
- White text on orange
- **Any location interface at all** — no coordinates, no map, no distance, no permission prompt. There is nothing to show, and a request that carried coordinates would be recording something this system has undertaken not to keep.
- Any biometric/fingerprint/selfie interface (not part of this system)
- Stock photography or generic illustrations
- **"Recorded ✓" before the server has confirmed.** This now has a second, subtler form: the offline queue's held state must not read as success either. No tick, no green, and the words "you are not recorded yet".
- Invented states — the only compliance states are: provisional, confirmed, pending verification, locked, cleared

**Never cached by the service worker:** any page. Every screen is somebody's record and
phones get shared and resold; a cached dashboard is one student's attendance served
from disk to whoever picks the phone up next. Navigations are network-only, and
`/offline` — which carries no data — is the only exception.
