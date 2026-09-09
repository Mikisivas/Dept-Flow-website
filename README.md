# Dept-Flow

Dept-Flow warns students before they fall below the 75% exam-eligibility
threshold, and does it early enough to be worth acting on — a forecast of where
a student will finish, per course, rather than a tally of where they are.

A responsive website for a Nigerian university department — the Department of
Mathematics and Computer Science, whose student association is SAMACOSS.
Students use phones almost exclusively; HOD and admin may use a desktop.

> **This document was rewritten in August 2026.** The supervisor's revision
> reversed three of the original premises, and the description that stood here
> before — dues gating counted attendance, a two-checkpoint token+GPS mechanism,
> half marks and provisional scores — describes a system that no longer exists.
> `docs/operational-flow.md` is the current specification.

## How it works

**Semester registration is the gate.** An admin opens a window; the student
confirms; `confirm_registration()` stamps the time server-side. Past the
deadline an unconfirmed student cannot log attendance, and confirming late
backfills an absence for every lecture held in between. A window nobody
configured is open, not expired — the other way round bars a whole department
because a row was never inserted.

**Attendance is trust-based.** A lecture is one session. The lecturer opens it,
issues one short-lived code, and closes it; the student types the code in. The
server checks that the student is registered for the course and that the code is
still live, against its own clock. There is no GPS, no distance check and no
proxy detection — the code on the board is the whole mechanism.

```
score = 1 if an accepted mark exists, else 0     — binary; there is no half mark

attendance % = (Σ scores) ÷ (lectures held while enrolled) × 100
```

**Dues are decoupled.** A lecture counts whether or not a naira has been paid.
Paystack handles the transaction, instalments run a balance down rather than
tripping a paid/unpaid flag, and reversals re-lock with notice. Dues and
attendance meet in exactly one place: the exam permit needs both.

**The forecast is the point.** From week five, `compute_risk_predictions()`
projects where each student finishes in each course — half what they have been
doing lately, half what they have done all term — and sorts them into Safe,
Watch and Critical. Alerts escalate one rung per tier: in-app, then Web Push,
then WhatsApp, then SMS. The copy names the course and the exact number of
classes, and says so plainly when the threshold has gone out of reach. It is
advisory: eligibility is always computed from the recorded scores, never from
the projection.

**The permit needs both conditions.** Dues paid in full gates the document;
75% gates each paper. A live panel says what is outstanding per course and in
naira, and the document carries a QR code to a verification endpoint that reads
the record from the server rather than from the paper.

## Current state

Working end to end against a real Supabase project — 45 screens and 36 API
routes, with no fixtures behind any of them.

```
src/          Next.js App Router — student, lecturer, HOD and admin
supabase/     Postgres schema, generated setup.sql, seed, and 425 assertions
docs/         the specification — start with docs/operational-flow.md
design/       mockups, drawn before the revision and superseded by it
```

Not built: SMS and WhatsApp delivery, and deployment. Both messaging seams
report failure in production rather than pretending to have sent. Web Push is
wired end to end and needs only VAPID keys
(`npx web-push generate-vapid-keys`).

## Checks

```
npm test                 24 Paystack + 32 account + 28 timetable assertions, no network
./scripts/schema-test.sh 425 assertions against a throwaway local Postgres
```

The schema suite also verifies that the whole schema applies inside one
transaction, because the Supabase SQL Editor runs it that way — a migration that
only works outside one cannot be deployed.

`/api/health` is the first thing to open when something misbehaves: it names the
migrations that are missing, the tables the signed-in user can read, whether
Paystack answers and whether pg_cron is installed. A half-applied migration set
explains more failures than anything else.

## Stack

Next.js 16 / React 19 (TypeScript) · Tailwind CSS 4 · shadcn/ui on Radix ·
Next.js route handlers · Supabase (PostgreSQL) · Paystack · Web Push · PWA

Three names from the original stack are deliberately absent. There is no
FastAPI service — enforcement lives in route handlers and, where it matters, in
database constraints and functions, and a second application server would only
be a second place to restate them inconsistently. There is no Redis, because the
compliance lookup it was meant to keep off the database no longer happens during
a submission at all. And the advisory signal is a computed rule in SQL rather
than scikit-learn: the department has one session of history, and a rule can
tell a student why they were flagged.

## Documentation

| File | |
|---|---|
| [`docs/operational-flow.md`](docs/operational-flow.md) | **The current specification** — the supervisor's August 2026 revision |
| [`docs/system-operation-and-logic.md`](docs/system-operation-and-logic.md) | Roles, entities, states, attendance and payment logic |
| [`docs/decisions.md`](docs/decisions.md) | Decisions agreed before any code was written; superseded where the revision touched them |
| [`docs/ui-build-specification.md`](docs/ui-build-specification.md) | Every route, its role, contents and required states |
| [`docs/dept-flow-design-skill.md`](docs/dept-flow-design-skill.md) | Palette, typography, per-role patterns, pre-ship checklist |
| [`docs/setup.md`](docs/setup.md) | Standing the project up against a Supabase project |
| [`docs/demo.md`](docs/demo.md) | The walkthrough: logins, the order of screens, the numbers that appear |
| [`supabase/README.md`](supabase/README.md) | What the schema enforces and how to run its tests |
