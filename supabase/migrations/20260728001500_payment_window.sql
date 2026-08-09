-- Dept-Flow — the payment window closes with the lock
--
-- Department decision: after the provisional window, an unpaid student is
-- locked out of recording attendance AND out of paying. The portal is not open
-- all session.
--
-- The reasoning is behavioural rather than technical. A deadline that can be
-- ignored indefinitely is not a deadline; if the portal stays open all year,
-- "pay within 30 days" is advice and the money arrives in month three. Closing
-- it makes the date real.
--
-- The cost is equally real and is accepted deliberately: a student who finds
-- the money on day 35 cannot hand it over until the HOD opens a window. That
-- is the compulsion working, not a gap in it.

-- ---------------------------------------------------------------------------
-- One rule, not two
-- ---------------------------------------------------------------------------

-- Deliberately defined as the inverse of the attendance lock rather than as a
-- second window with its own dates.
--
-- A separate payment calendar would need its own open and close dates, its own
-- grace mechanism, and its own answer for every student the two disagreed
-- about. Being locked already means "the provisional window ran out and you did
-- not clear", which is exactly the condition the department wants to gate
-- payment on — and `is_attendance_locked()` already consults grace periods, so
-- a grace period reopens payment without another line being written.
create or replace function is_payment_open(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns boolean
language sql
stable
as $$
  select not is_attendance_locked(p_student_id, p_academic_session_id);
$$;

comment on function is_payment_open(uuid, uuid) is
  'False once a student is locked. The same grace period that restores attendance recording reopens payment, because it is the same lock.';

revoke all on function is_payment_open(uuid, uuid) from public, anon;
grant execute on function is_payment_open(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What this deliberately does NOT gate
-- ---------------------------------------------------------------------------

-- Verification is not gated, and must never be. A transfer begun on day 29 can
-- settle on day 32, and a bank does not care about our window. Refusing to
-- verify money that has already left a student's account would take the
-- payment and withhold the clearance — the single worst outcome this system
-- can produce.
--
-- So `startDuesPayment` checks this function and `settlePayment` does not.
-- That asymmetry is the point and is asserted in the schema tests.
