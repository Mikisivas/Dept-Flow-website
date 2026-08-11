# Dept-Flow — database

Postgres schema for Supabase: nine migrations, a development seed, and a test
suite that asserts the rules the rest of the system depends on.

## Layout

```
supabase/
  migrations/
    ..._extensions_and_enums.sql     types, and the vocabulary of states
    ..._reference.sql                academic sessions, venues, config, dues
    ..._identity.sql                 profiles, the register, students, OTP
    ..._academics.sql                courses, enrolment, timetable, checkpoints
    ..._attendance.sql               marks, paper batches, session scores
    ..._compliance_and_payments.sql  the state machine, Paystack
    ..._governance.sql               grace, waivers, disputes, eligibility, audit
    ..._functions.sql                the attendance formula and transitions
    ..._rls.sql                      row-level security
    ..._credentials.sql              password digests on profiles, login lookup
    ..._function_grants.sql          stop PostgREST publishing the functions
    ..._venue_directory.sql          venue names without venue coordinates
    ..._course_registration.sql      core/elective/carry-over, and the credit cap
    ..._grace_periods.sql            opening and revoking, with the audit trail
    ..._payment_window.sql           the portal closes with the lock
    ..._compliance_schedule.sql      what actually drives the day-31 transition
  seed.sql                           development data
  seed_today.sql                     a class on today's weekday, for testing
  tests/schema_test.sql              230 assertions
```

## Running it

With the Supabase CLI. There is no `config.toml` in the repo yet — run
`supabase init` once and let the CLI generate one for its own version rather
than inheriting a stale one:

```bash
supabase init            # first time only; keeps migrations/ and seed.sql
supabase start
supabase db reset          # applies every migration, then seed.sql
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -v ON_ERROR_STOP=1 -f supabase/tests/schema_test.sql
```

Against any Postgres 15+ without the CLI, the migrations need the pieces of a
Supabase project they reference — the `auth` schema, `auth.uid()`, and the
`anon` / `authenticated` / `service_role` roles. Create those first, then apply
`migrations/*.sql` in filename order.

The test suite runs inside a transaction and rolls back, so it is re-runnable
against a seeded database. Every assertion prints; silence at the end means a
failure aborted the run.

## What the schema is enforcing

Things that are checked here rather than trusted to application code:

- **`(student_id, checkpoint_id)` is unique.** The cheapest defence against
  duplicate submissions, at the only level where it cannot be raced.
- **A single-checkpoint lecture cannot hold a half mark.** Half marks only mean
  something when there were two checkpoints to catch one of.
- **`CSC` is rejected** as a matric prefix and as a course code.
- **A payment cannot be `success` without a verification timestamp**, so the
  webhook payload alone can never clear a student.
- **The audit log cannot be updated or deleted from** — by trigger, not
  convention.
- **An authorized eligibility list is frozen.** A correction is a new list.
- **Deactivation, cancellation, grace, waivers and paper batches all require a
  reason**, and `other` requires a note.
- **A purged attendance mark cannot still hold coordinates.**
- **Only one academic session is active at a time.**

## Row-level security

`authenticated` has SELECT only, scoped by role. Every write of consequence goes
through the API's service role.

Three denials worth knowing about, because they are easy to undo by accident:

- **Students cannot read `checkpoints`.** The token is what makes being in the
  hall necessary. Handing it to the client leaves only the geo-fence between a
  student and a mark submitted from the car park.
- **Admin cannot read `risk_predictions`.** Individual student risk is HOD
  scope; surfacing it to the operations role breaks separation of duties.
- **HOD cannot read `venues`.** Geo-fence coordinates are admin configuration.

Students read their attendance marks through `my_attendance_marks`, a view with
no coordinate columns at all — so "never show raw GPS" survives a careless
query as well as a careless screen.

## Retention

`purge_expired_coordinates()` drops raw latitude and longitude after
`app_config.gps_retention_days` (default 14, bounded 7–30) and keeps the derived
distance and the accept/reject outcome. Run it nightly alongside the payment
re-verification job.

## A note on money

Amounts are kobo in `double precision`, by project decision. Paystack requires
an integer, so the value is cast at the request boundary; reconciliation uses
`payment_matches_dues()` rather than `=`. See `docs/decisions.md`.
