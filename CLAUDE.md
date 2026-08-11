# Project instructions — Dept-Flow

Dept-Flow gates a student's ability to accumulate *counted* attendance behind
departmental dues compliance, using a two-checkpoint token+GPS mechanism, and
warns students before they fall below the 75% exam-eligibility threshold.

## Read these first

| File | What it is |
|---|---|
| `docs/decisions.md` | **The current specification.** Decisions agreed before any code was written. Where it disagrees with anything below, it wins. |
| `docs/system-operation-and-logic.md` | Functional reference: roles, entities, the compliance state machine, attendance logic, payment and registration flows. |
| `docs/ui-build-specification.md` | Screen-by-screen build spec: every route, its role, contents and required states. |
| `docs/dept-flow-design-skill.md` | Design system: palette, typography, the checkpoint motif, per-role patterns, pre-ship checklist. |
| `design/*.dc.html` | The design mockups — six groups covering shared components and all forty routes. Open in a browser. |
| `supabase/README.md` | The schema, what it enforces, and how to run its tests. |
| `docs/demo.md` | The walkthrough: logins, the order of screens, and the numbers that will appear. |

## Naming

**Computer Science is `CMP` in this department, not `CSC`.** Programme prefixes
are `MTH | CMP | STA` — in matric numbers (`CMP/2021/047`) and course codes
(`CMP 301`). The database rejects `CSC` in both positions.

The department is the **Department of Mathematics and Computer Science**.
SAMACOSS, the association whose crest this borrows from, carries Statistics in
its own name. Don't add Statistics to the department; don't correct the crest.

Registration identity is **matric number + surname + level**. No date of birth.
Full name — surname, first name, other names — is collected at registration;
only the surname is matched against the register.

## Hard rules

- Compliance states are only: provisional, confirmed, pending verification,
  locked, cleared. **Never invent one.**
- Orange surfaces carry **black** text. White on `#FF9935` is 2.13:1 — never.
  Orange as text on white darkens to `#A85E0A`.
- Orange is the brand, never a status. Provisional has no colour — dashed
  border, muted text, no fill.
- Never encode a state by colour alone.
- Never show raw GPS coordinates. No biometric, selfie or fingerprint UI
  anywhere.
- Authority actions — deactivate, revoke registration, grace period, manual
  batch, level rollover, eligibility authorization — confirm, require a reason,
  and write an audit log row.
- **Never confirm attendance in the UI before the server acknowledges it.** A
  student who sees "Recorded ✓" and walks away uncounted is the worst failure
  this system can produce.
- Mobile-first. Students only use phones.

## This is a website, not an app

Every role reaches it through a browser at a URL. No app store, no native
build, no installation step. The student bottom bar is a sticky nav of real
links to real routes. No service worker, no web manifest, no install prompt —
which also bounds what "offline" can mean, so a queued submission survives only
while the tab is open.

## Visual-style precedence

**SAMACOSS governs.** Dept-Flow's palette and typography win over any bound
design system, including Modernist. Do not substitute red, Archivo, or
Modernist components into product screens.

## Brand orange — eyedropped from the crest

The shield fill samples as **`#FF9935`**, not the `#F0952B` the older docs carry
as a visual estimate. These are the confirmed tokens:

```css
--brand:         #FF9935;  /* crest orange, sampled. BLACK text: 9.30:1 AAA */
--brand-hover:   #E58419;  /* black text 7.21:1 */
--brand-pressed: #C96E10;  /* black text 5.39:1 */
--brand-text:    #A85E0A;  /* the only orange as text on white: 4.92:1 */
--brand-tint:    #FFF4E8;
--brand-tint-2:  #FFE7CE;
```

`#FF9935` on white is 2.13:1, so the black-text rule is harder than the older
docs suggest, not softer.

## Crest vs. site mark

**Full crest** — login page, landing page, printed reports. Nowhere else.

**Simplified mark** (shield + monitor, no ribbons, no banner text) — site
header, favicon, home-screen icon, small buttons.

Never place the full crest at header or favicon size, never recolour or stretch
it, never put it on an orange fill. The supplied file is a raster on opaque
white and needs cutting out before it sits on a tinted panel or in dark mode.

## Where the work is

The branch is `claude/shared-components-review-995lls`. Schema first, then
screens — that order has held throughout.

**Working end to end against a real Supabase project:**

| Path | What runs |
|---|---|
| Login | Matric number or staff ID + password. Self-signed JWT, no Supabase Auth. |
| Registration | Register match → phone OTP → password → account → core enrolment. |
| Attendance | Lecturer opens a lecture, issues checkpoint codes, closes it; the student submits a code with a position; `resolve_session_score()` scores everyone. |
| Dues | Paystack redirect → verify → `clear_student()` flips compliance and confirms every provisional score. |
| Course registration | Admin uploads the list; students pick electives and carry-overs against a 24-unit cap. |
| HOD | Overview, at-risk list, exam eligibility (authorizing snapshots and freezes the list), grace periods, waivers, disputes, the per-student record and lecturer oversight. |
| Admin | Overview, students (deactivate and reverse it), payments, the register and the timetable (both preview-then-commit uploads), courses, registration disputes, configuration, audit log, level rollover. |
| Lecturer | Dashboard, schedule (cancel, reschedule, add a makeup — each notifies every enrolled student), course list, paper register. |
| Student | Dashboard, course detail, notifications, the printable exam permit, password reset, and changing their own password or phone number. |

**Nothing is on fixtures any more.** `src/lib/data/queries.ts` is deleted and
`fixtures.ts` holds only type definitions — two sources for one screen is how a
demo quietly shows invented data.

**The advisory signal is a computed rule, not scikit-learn.**
`compute_risk_predictions()` carries a student's own attendance rate forward,
per course, and the nightly job refreshes it. It is a rule because there is no
history to train on — one session and three students is a training set to
memorise, not learn from — and because a rule can tell a student *why* they were
flagged. The table is the seam: swap the writer, change no reader. Advisory
only, and `attendance_pct()` has never been allowed to consult it.

**Not built:** SMS delivery (the OTP seam throws in production), deployment.

**Checks:** `npm test` (12 Paystack + 33 account + 28 timetable assertions, no
network) and `supabase/tests/schema_test.sql` (230 assertions, run in the SQL
Editor).
`/api/health` is the first thing to open when something misbehaves: it reports
**which migrations are missing by name**, which tables the signed-in user can
read, whether Paystack answers, and whether pg_cron is installed. A
half-applied migration set explains more failures than anything else.

**Applying migrations to a project that already has data** needs care: a
default that is right for new rows can be wrong for old ones. See
`supabase/backfill_course_registration.sql` and the section in `docs/setup.md`.

## Stack

Next.js / React (TypeScript) · Tailwind · shadcn/ui on Radix · FastAPI ·
Supabase (Postgres) · Redis · Paystack · scikit-learn.

Build order: **schema first**, then screens.
