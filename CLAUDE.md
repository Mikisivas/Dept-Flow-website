# Project instructions — Examination-Eligibility Alert System

**The thesis title, fixed by the supervisor:** "Development of an
Examination-Eligibility Alert System for Rev. Fr. Moses Orshio Adasu
University, Makurdi". **Scope:** the Department of Mathematics and Computer
Science, Faculty of Science. On screens the system is the
*Examination-Eligibility Alert System*, **EEAS** where space is short. The repo,
the package and the internal identifiers (`dept_flow_schema_report`, the
service-worker cache name) keep the old name "Dept-Flow"; nothing a user sees
does, and nothing new should. It is not an agent and has never been one —
don't describe it as "agentic".

The system warns students before they fall below the 75% exam-eligibility
threshold, and does it early enough to be worth acting on — a forecast of where
a student will finish, per course, not a tally of where they are.

**The August 2026 supervisor revision reversed three of the original premises.**
Where anything below still describes the old system, the new one wins:

| Was | Is |
|---|---|
| Two checkpoints, token + GPS, distance and proxy checks | **Trust-based.** One short-lived code. No GPS, no distance, no spoofing detection. |
| Dues compliance gates whether attendance *counts* | **Decoupled.** A lecture counts whether or not a naira has been paid. Dues and attendance meet in exactly one place: the exam permit needs both. |
| Nothing gates attendance | **Semester registration does.** Past the deadline an unconfirmed student cannot log attendance, and confirming late backfills an absence for every lecture they missed in between. |

## Read these first

| File | What it is |
|---|---|
| `docs/operational-flow.md` | **The current specification.** The supervisor's August 2026 revision. Where it disagrees with anything else — including `decisions.md` and every design mockup — it wins. |
| `docs/decisions.md` | The decisions agreed before any code was written. Still the reference for everything the revision did not touch; superseded on GPS, on dues gating attendance, and on the checkpoint pair. |
| `docs/system-operation-and-logic.md` | Functional reference: roles, entities, the compliance state machine, attendance logic, payment and registration flows. |
| `docs/system-reference.md` | What the system actually does and **why**, read out of the code rather than recalled: the revision's three reversals, the forecast's real formula, the design decisions with their rationale, and what is verified versus assumed. Written for the thesis; useful to anyone asking why something is the way it is. |
| `docs/ui-build-specification.md` | Screen-by-screen build spec: every route, its role, contents and required states. |
| `docs/dept-flow-design-skill.md` | Design system: palette, typography, the checkpoint motif, per-role patterns, pre-ship checklist. |
| `design/*.dc.html` | The design mockups — six groups, drawn before the revision and **superseded** by it. Each carries a banner saying what changed. Open in a browser; the running app is the current reference. |
| `supabase/README.md` | The schema, what it enforces, and how to run its tests. |
| `docs/demo.md` | The walkthrough: logins, the order of screens, and the numbers that will appear. |

## Naming

**Computer Science is `CMP` in this department, not `CSC`.** Programme prefixes
are `MTH | CMP | STA` — in matric numbers (`CMP/2021/047`) and course codes
(`CMP 301`). The database rejects `CSC` in both positions.

The department is the **Department of Mathematics and Computer Science**, in
the **Faculty of Science**, of **Rev. Fr. Moses Orshio Adasu University,
Makurdi**. All three come from `src/lib/institution.ts`; never hardcode them.
Don't add Statistics to the department's name.

**The faculty directory is data, not a tenancy.** `faculties` and `departments`
(migration `20261004000100`) list the whole university for the landing page,
and exactly one department is `is_active` — a unique index enforces it.
Nothing operational references those tables: students, courses, attendance,
dues and permits are still one department's, and the `MTH | CMP | STA` checks
stay. Activating a second department means scoping all of that first. They are
the only tables the `anon` role can read. Departments the student's source
named only loosely are not invented — their faculty shows "Departments not yet
listed".

Registration identity is **matric number + surname + level**. No date of birth.
Full name — surname, first name, other names — is collected at registration;
only the surname is matched against the register.

## Hard rules

- Two separate enumerations, and merging them produces a state machine that
  does not exist. Compliance states are only: uncleared, cleared, pending
  verification, locked. Score statuses are only: provisional, confirmed.
  **Never invent a value in either.**
- Brand-blue surfaces carry **black** text. White on `#2CAAE1` is 2.64:1 —
  never. Brand blue as text on white darkens to `#0B6F9C`.
- Blue is the brand, never a status. Provisional has no colour — dashed
  border, muted text, no fill. "Pending" is violet, not blue, for exactly this
  reason.
- Never encode a state by colour alone.
- No location UI of any kind, and no biometric, selfie or fingerprint UI
  anywhere. Attendance is trust-based: the code on the board is the whole
  mechanism, and a request that carried coordinates would be recording
  something this system has undertaken not to keep.
- Authority actions — deactivate, revoke registration, grace period, manual
  batch, level rollover, eligibility authorization — confirm, require a reason,
  and write an audit log row.
- **Never confirm attendance in the UI before the server acknowledges it.** A
  student who sees "Recorded ✓" and walks away uncounted is the worst failure
  this system can produce.
- Mobile-first. Students only use phones.

## A website first, installable second

Every role reaches it through a browser at a URL. No app store, no native
build. The student bottom bar is a sticky nav of real links to real routes, and
every screen works with no service worker at all.

It is now a PWA on top of that, which the supervisor's August 2026 flow asks
for. The manifest buys a home-screen icon and a window without browser chrome;
the service worker exists for **two things only**:

1. **Web Push.** A push cannot be delivered to a page that is not open, so
   something has to be listening when it is not. This is the whole reason the
   file exists.
2. **An honest offline page.** `/offline` carries no data of any kind, which is
   what makes it the only page safe to cache.

**The service worker must never cache a page.** Every screen is somebody's
record, and phones get shared and resold — a cached dashboard is one student's
attendance served from disk to whoever picks the phone up next, with no session
to check it against. Navigations are network-only.

**It must never replay an attendance submission either.** The offline queue
lives in the page, so it can only send while somebody is watching the result. A
POST replayed from the background, against a code window measured in minutes,
is how a student ends up believing they were counted. So a queued submission
still survives only while the tab is open — the queue now waits for the
connection to return and replays with the **original timestamp**, but closing
the tab still loses it, and the screen says so in those words.

## Visual-style precedence

**The university's identity governs.** This palette and typography win over
any bound design system, including Modernist. Do not substitute Archivo or
Modernist components into product screens. The SAMACOSS crest and orange are
retired; older docs and the design mockups still show them.

## Brand blue — sampled from the university logo

The logo carries red `#EC1C22`, near-black, blue `#2CAAE1` and green
`#0EA44F`. The brand is the **blue**, sampled from the T. Not the red, though
the logo is mostly red: the most important thing this system shows is a red
"Critical", and a red button on every screen teaches students to stop seeing
it. Red stays inside the logo.

```css
--brand:         #2CAAE1;  /* logo blue. BLACK text: 7.49:1 AAA */
--brand-hover:   #1B97CD;  /* black text 5.99:1 */
--brand-pressed: #1583B3;  /* black text 4.65:1 — a fill only, never text */
--brand-text:    #0B6F9C;  /* the only brand blue as text on white: 5.57:1 */
--brand-tint:    #EAF7FC;
--brand-tint-2:  #D3EEF9;
```

No blue carries black text above 4.5:1 *and* reads as text on white above
4.5:1, so links hover to ink, not to a darker blue.

## The university logo

`public/university-logo.png` (transparent, 640px), through
`<UniversityLogo>`. One mark at every size — landing page, login, permit,
header, favicon, home-screen icon (`npm run build:icons`). It is the
university's: never crop, redraw, recolour or stretch it, and never put it on a
brand-blue fill, where the T disappears. In dark mode it sits on a white tile,
because its outer ring is black. Small uses are accepted because every page
that shows it small also names the university in text.

## Where the work is

The branch is `claude/supervisor-adjustments-c8e5ac`. Schema first, then
screens — that order has held throughout.

**Working end to end against a real Supabase project:**

| Path | What runs |
|---|---|
| Login | Matric number or staff ID + password. Self-signed JWT, no Supabase Auth. |
| Registration | Register match → phone OTP → password → account → core enrolment. |
| Semester registration | Admin sets the window; the student confirms; `confirm_registration()` stamps it server-side and backfills absences for anyone confirming late. Attendance is gated on it. |
| Attendance | Lecturer opens a lecture, issues one code, closes it; the student submits the code; `resolve_session_score()` scores everyone. No location, either end. |
| Dues | Paystack redirect → verify → `apply_payment()`. Instalments run a balance down; nothing about attendance changes. Reversals re-lock, with notice. |
| Forecast | `compute_risk_predictions()` projects where each student finishes per course; Safe / Watch / Critical; alerts escalate in-app → push → WhatsApp → SMS, one rung per tier. |
| Reminders and reports | pg_cron fires pre-lecture reminders and the Monday digest; weekly, monthly and semester reports share one generator with the permit. |
| Exam permit | Needs dues paid in full AND ≥75% per course. A live panel says what is outstanding; the document carries a QR to `/check/permit`. |
| Course registration | Admin uploads the list; students pick electives and carry-overs against a 24-unit cap. |
| HOD | Overview, drillable at-risk list, exam eligibility (authorizing snapshots and freezes the list), payment compliance, messaging students at four scopes (including one level of one programme), registration exceptions, disputes, the per-student record and lecturer oversight. |
| Admin | Overview, students (deactivate and reverse it), payments, the register and the timetable (both preview-then-commit uploads), courses, registration disputes, configuration, audit log, level rollover. |
| Lecturer | Dashboard, schedule (cancel, reschedule, add a makeup — each notifies every enrolled student), course list, paper register. |
| Student | Dashboard, course detail, notifications, the printable exam permit, password reset, and changing their own password or phone number. |

**Nothing is on fixtures any more.** `src/lib/data/queries.ts` is deleted and
`fixtures.ts` holds only type definitions — two sources for one screen is how a
demo quietly shows invented data.

**The advisory signal is a computed rule, not scikit-learn.**
`compute_risk_predictions()` projects a student's own attendance forward, per
course, from week five onward — half what they have been doing lately, half
what they have done all term — and the nightly job refreshes it. Not the
regression slope extrapolated: that turns one missed lecture in ten into a
projected failure. It is a rule because there is no
history to train on — one session and three students is a training set to
memorise, not learn from — and because a rule can tell a student *why* they were
flagged. The table is the seam: swap the writer, change no reader. Advisory
only, and `attendance_pct()` has never been allowed to consult it. Nor does the
permit panel: `lectures_needed()` is deterministic arithmetic on the threshold,
and a test deletes every prediction and checks the panel does not move.

**Not built:** SMS delivery (the seam reports failure in production rather
than pretending), deployment. **WhatsApp is wired** to Meta's Cloud API
(template sends only; `tests/whatsapp.mts` pins the request against a fake
Meta) but has not been run against Meta itself from here — the first live
send is the rehearsal in `docs/deploy-demo.md` §3b. Web Push **is** wired end to
end and needs only VAPID keys — `npx web-push generate-vapid-keys`.

**Demo deployment for the defence** — `docs/deploy-demo.md`. With
`DEMO_DEPLOYMENT=true` and no SMS provider, `sendOtp` returns the code as
`shown` and registration, password reset and phone change display it on
screen; a banner on every page says so. It refuses to engage next to a live
Paystack key (`src/lib/demo.ts`, tested in `tests/demo-mode.mts`). That is the
only behaviour it changes: SMS alerts, and WhatsApp ones unless it is
connected, still fail and say why.
All three OTP flows go through the one `sendOtp` seam; password reset used to
have its own stub.

**Checks:** `npm test` (24 Paystack + 32 account + 28 timetable assertions, no
network) and `./scripts/schema-test.sh` (437 assertions against a local
Postgres, which also verifies the whole schema applies inside ONE transaction —
the Supabase SQL Editor runs it that way, so a migration that only works
outside one is a migration that cannot be deployed).
`/api/health` is the first thing to open when something misbehaves: it reports
**which migrations are missing by name**, which tables the signed-in user can
read, whether Paystack answers, and whether pg_cron is installed. A
half-applied migration set explains more failures than anything else.

**Applying migrations to a project that already has data** needs care: a
default that is right for new rows can be wrong for old ones. See
`supabase/backfill_course_registration.sql` and the section in `docs/setup.md`.

## Stack

Next.js 16 / React 19 (TypeScript) · Tailwind 4 · shadcn/ui on Radix ·
Supabase (Postgres) with row-level security · self-signed JWT, not Supabase
Auth · Paystack · web-push · PWA.

**There is no separate backend service.** Server code runs inside Next.js —
server components read, route handlers write — and the business logic lives in
Postgres, in 84 functions. FastAPI, Redis and scikit-learn were in the original
plan and none of them is in the build; the forecast is a Postgres function.
Don't reintroduce them from an older document.

Build order: **schema first**, then screens.
