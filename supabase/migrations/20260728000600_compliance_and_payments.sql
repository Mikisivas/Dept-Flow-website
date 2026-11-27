-- Dept-Flow — the compliance state machine and Paystack payments

-- ---------------------------------------------------------------------------
-- Compliance status — system doc §4, one row per student per academic session
-- ---------------------------------------------------------------------------

--   UNCLEARED ──(payment verified OR HOD clearance)──> CLEARED
--       │
--       └─ Day 31 still uncleared ──> PENDING_VERIFICATION (6–12h buffer)
--                                          ├─ clears in buffer ──> CLEARED
--                                          └─ buffer expires ────> LOCKED
--                                                                    │
--                                            HOD grace + student clears ──> CLEARED
create table compliance_statuses (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  state               compliance_state not null default 'uncleared',
  cleared_at          timestamptz,
  cleared_via         clearance_route,
  cleared_by          uuid references profiles (id),
  pending_since       timestamptz,
  locked_at           timestamptz,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (student_id, academic_session_id),
  constraint compliance_cleared_complete check (
    (state = 'cleared' and cleared_at is not null and cleared_via is not null) or
    (state <> 'cleared' and cleared_at is null and cleared_via is null and cleared_by is null)
  ),
  constraint compliance_pending_has_timestamp check (
    state <> 'pending_verification' or pending_since is not null
  ),
  constraint compliance_locked_has_timestamp check (
    state <> 'locked' or locked_at is not null
  ),
  -- A clearance granted by a person must name that person.
  constraint compliance_manual_route_has_actor check (
    cleared_via is null
    or cleared_via = 'payment'
    or cleared_by is not null
  )
);

create index compliance_state_idx on compliance_statuses (academic_session_id, state);
create index compliance_student_idx on compliance_statuses (student_id);

create trigger compliance_statuses_updated_at
  before update on compliance_statuses
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

-- A verified Paystack transaction is the only thing that flips a student to
-- CLEARED by the payment route. The webhook is a notification, not evidence:
-- the backend verifies the signature against the raw request bytes and then
-- calls the transaction/verify endpoint before writing `verified_at` here.
create table payments (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  paystack_reference  text not null unique,
  channel             payment_channel,
  status              payment_status not null default 'pending',
  -- Kobo, stored as double precision by project decision. Cast to an integer
  -- when calling Paystack, which requires an integer amount.
  amount_kobo         double precision not null,
  initialized_at      timestamptz not null default now(),
  verified_at         timestamptz,
  last_checked_at     timestamptz,
  verification_payload jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payment_amount_positive check (amount_kobo > 0),
  constraint payment_amount_whole_kobo check (amount_kobo = trunc(amount_kobo)),
  -- `verified_at` is written only after the verify call succeeds, never from
  -- the webhook payload alone.
  constraint payment_success_is_verified check (
    (status = 'success' and verified_at is not null and channel is not null) or
    (status <> 'success' and verified_at is null)
  )
);

create index payments_student_idx on payments (student_id, created_at desc);
create index payments_status_idx on payments (status);
-- The nightly re-verification job reads this.
create index payments_unresolved_idx on payments (initialized_at)
  where status = 'pending';

create trigger payments_updated_at
  before update on payments
  for each row execute function set_updated_at();

comment on column payments.verification_payload is
  'Response body from transaction/verify, kept for reconciliation and disputes.';

-- Amounts are held as floats, so reconciliation compares within a tolerance
-- rather than with `=`. One kobo is the tolerance: a genuine underpayment is
-- never a fraction of a kobo, and float representation error is never a whole
-- one.
create or replace function payment_matches_dues(
  paid_kobo double precision,
  due_kobo double precision
)
returns boolean
language sql
immutable
as $$
  select abs(paid_kobo - due_kobo) < 1.0;
$$;

comment on function payment_matches_dues(double precision, double precision) is
  'Float-safe amount comparison. Exists because amounts are double precision rather than numeric.';
