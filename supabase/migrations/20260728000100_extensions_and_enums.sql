-- Dept-Flow — extensions, enum types, shared trigger helpers
--
-- Naming note: an *academic session* (2025/2026) and a *lecture session* are
-- different things. Academic sessions live in `academic_sessions`; a single
-- lecture lives in `session_instances`. The word "session" alone is never used
-- as a table name.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Roles and identity
-- ---------------------------------------------------------------------------

-- The four actors from the system doc §2. Separation of duties is a first-class
-- constraint: admin manages the system, HOD manages students, neither does the
-- other's job.
create type app_role as enum ('student', 'lecturer', 'hod', 'admin');

-- Programme is encoded in the matric number prefix and is never asked for at
-- registration. Computer Science is CMP in this department, not CSC.
create type programme_code as enum ('MTH', 'CMP', 'STA');

-- Student lifecycle, from the system doc §3. Distinct from compliance state:
-- this is "does this account exist and is it in the register", not "have the
-- dues been cleared".
create type student_lifecycle as enum (
  'active',
  'provisional',
  'graduating',
  'deactivated'
);

create type deactivation_reason as enum (
  'expelled',
  'withdrawn',
  'graduated',
  'other'
);

-- ---------------------------------------------------------------------------
-- Compliance — the state machine in system doc §4
-- ---------------------------------------------------------------------------

-- These four states, and no others. The UI vocabulary adds "provisional" and
-- "confirmed", which belong to a *score*, not to a student — see score_status.
create type compliance_state as enum (
  'uncleared',
  'cleared',
  'pending_verification',
  'locked'
);

create type clearance_route as enum (
  'payment',
  'hod_clearance',
  'waiver',
  'grace_period'
);

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------

create type score_status as enum ('provisional', 'confirmed');

-- The tag exists purely for governance queries ("how often does this lecturer
-- use paper batches"). It never changes the attendance arithmetic.
create type score_source as enum ('digital', 'manually_entered');

create type session_instance_type as enum ('recurring', 'makeup', 'reschedule');

create type session_instance_status as enum ('scheduled', 'open', 'closed', 'cancelled');

-- Resolved when the lecture closes. A session where the lecturer only ever
-- issued one token is scored 1.0/0 and renders as one wide cell — never as a
-- faked pair.
create type checkpoint_mode as enum ('pair', 'single');

-- Every rejection the student can see has its own message in the UI, so every
-- rejection needs its own reason here. A generic failure generates disputes.
create type mark_reject_reason as enum (
  'invalid_or_expired_token',
  'account_locked',
  'outside_geofence',
  'failed_anti_spoof',
  'already_submitted'
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------

-- Card and Pay with Transfer only. Dedicated virtual accounts are explicitly
-- dropped and must not be reintroduced.
create type payment_channel as enum ('card', 'transfer');

create type payment_status as enum (
  'pending',
  'success',
  'failed',
  'abandoned',
  'reversed'
);

-- ---------------------------------------------------------------------------
-- Governance
-- ---------------------------------------------------------------------------

create type grace_scope as enum ('department', 'level');

create type waiver_status as enum ('pending', 'granted', 'declined');

create type dispute_status as enum ('open', 'upheld', 'corrected');

create type eligibility_status as enum ('draft', 'authorized');

create type otp_purpose as enum ('registration', 'password_reset', 'phone_change');

-- Advisory only. The authoritative 75% determination is always computed from
-- confirmed session scores, never from the model.
create type risk_pattern as enum ('disengagement', 'partial_attendance');

create type notification_kind as enum (
  'payment_reminder',
  'payment_confirmed',
  'risk_nudge',
  'grace_period',
  'schedule_change',
  'clearance_granted'
);

-- ---------------------------------------------------------------------------
-- Shared trigger helpers
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function set_updated_at() is
  'Generic updated_at maintenance trigger.';
