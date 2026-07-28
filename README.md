# Dept-Flow

Dept-Flow gates a student's ability to accumulate *counted* attendance behind
departmental dues compliance, using a two-checkpoint token+GPS mechanism to make
attendance hard to fake, and an advisory regression model to warn students
before they fall below the 75% exam-eligibility threshold.

A responsive website for a Nigerian university department — the Department of
Mathematics and Computer Science, whose student association is SAMACOSS.
Students use phones almost exclusively; HOD and admin may use a desktop.

## How it works

A lecture is one **session**. The lecturer triggers **two checkpoints** during
it, each a 4-digit token written on the board. A student submits the token,
verified against a geo-fence around the hall.

```
▮▮  both checkpoints → 1.0        ▮▯  one → 0.5        ▯▯  none → 0

attendance % = (Σ confirmed scores) ÷ (lectures held) × 100
```

For the first 30 days, scores are recorded but **provisional** — they do not
count. Paying departmental dues, or an HOD clearance, converts every provisional
score to **confirmed** in one transaction. On day 31 an uncleared student enters
a 6–12 hour verification buffer, and then **locks**: no new attendance is
recorded until they clear.

## Current state

The database schema is built and tested. Screens are not started.

```
supabase/     Postgres schema, seed, and 61 schema assertions
docs/         the specification — start with docs/decisions.md
design/       design mockups: shared components and all forty routes
```

Run the schema tests with `supabase db reset` followed by the psql command in
[`supabase/README.md`](supabase/README.md).

## Stack

Next.js / React (TypeScript) · Tailwind CSS · shadcn/ui on Radix UI · FastAPI ·
Supabase (PostgreSQL) · Redis · Paystack · scikit-learn

## Documentation

| File | |
|---|---|
| [`docs/decisions.md`](docs/decisions.md) | The current specification — decisions agreed before any code was written |
| [`docs/system-operation-and-logic.md`](docs/system-operation-and-logic.md) | Roles, entities, state machine, attendance and payment logic |
| [`docs/ui-build-specification.md`](docs/ui-build-specification.md) | Every route, its role, contents and required states |
| [`docs/dept-flow-design-skill.md`](docs/dept-flow-design-skill.md) | Palette, typography, the checkpoint motif, pre-ship checklist |
| [`supabase/README.md`](supabase/README.md) | What the schema enforces and how to run its tests |
