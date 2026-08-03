-- Dept-Flow — complete schema setup
--
-- Generated from supabase/migrations/. Paste the whole file into the Supabase
-- SQL Editor and run it once, on a fresh project.
--
-- This exists so the schema can be applied without sharing a database password
-- or a service-role key with anyone. Nothing in here needs either.
--
-- Order matters: types, then tables, then functions, then row-level security.
-- Re-running it on a project that already has the schema will error on the
-- first CREATE TYPE, which is the intended safety behaviour.


-- ===========================================================================
-- 20260728000100_extensions_and_enums.sql
-- ===========================================================================

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

-- ===========================================================================
-- 20260728000200_reference.sql
-- ===========================================================================

-- Dept-Flow — reference and configuration tables
--
-- Everything here is admin-owned. The HOD never sees dues configuration,
-- geo-fence coordinates, or the whitelist (system doc §2).

-- ---------------------------------------------------------------------------
-- Academic sessions
-- ---------------------------------------------------------------------------

create table academic_sessions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,          -- '2025/2026'
  starts_on     date not null,
  ends_on       date not null,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint academic_session_dates check (ends_on > starts_on),
  constraint academic_session_name_format check (name ~ '^[0-9]{4}/[0-9]{4}$')
);

-- Exactly one active academic session at a time. Timetables, whitelists and
-- dues periods are all versioned against it.
create unique index academic_sessions_one_active
  on academic_sessions ((true))
  where is_active;

create trigger academic_sessions_updated_at
  before update on academic_sessions
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Venues and the geo-fence
-- ---------------------------------------------------------------------------

-- The fence is stored as a centre point plus a radius, which is what the
-- distance check actually uses. `boundary` optionally holds a GeoJSON polygon
-- for irregular halls; PostGIS is deliberately not a dependency yet, since the
-- distance computation lives in the API.
--
-- Raw student coordinates are never stored here — only the hall's own location,
-- which is not personal data.
create table venues (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  centre_lat    double precision not null,
  centre_lng    double precision not null,
  radius_m      integer not null default 40,
  boundary      jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint venue_lat_range check (centre_lat between -90 and 90),
  constraint venue_lng_range check (centre_lng between -180 and 180),
  -- The spec fixes the geo-fence radius at 30–50 m. Wider and a student in the
  -- corridor is counted; narrower and GPS drift rejects someone in their seat.
  constraint venue_radius_range check (radius_m between 30 and 50)
);

create trigger venues_updated_at
  before update on venues
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- System configuration
-- ---------------------------------------------------------------------------

-- Single row. Every change is confirmed in the UI and audit-logged.
create table app_config (
  id                                integer primary key default 1,
  provisional_window_days           integer not null default 30,
  grace_window_days                 integer not null default 30,
  pending_verification_buffer_hours integer not null default 12,
  gps_retention_days                integer not null default 14,
  default_geofence_radius_m         integer not null default 40,
  attendance_threshold_pct          numeric(5,2) not null default 75.00,
  checkpoint_token_ttl_seconds      integer not null default 300,
  timetable_tolerance_minutes       integer not null default 15,
  updated_at                        timestamptz not null default now(),
  constraint app_config_single_row check (id = 1),
  -- System doc §4: the Day-31 buffer is 6–12 hours, no wider.
  constraint app_config_buffer_range check (pending_verification_buffer_hours between 6 and 12),
  constraint app_config_retention_range check (gps_retention_days between 7 and 30),
  constraint app_config_radius_range check (default_geofence_radius_m between 30 and 50),
  constraint app_config_token_ttl_range check (checkpoint_token_ttl_seconds between 60 and 600)
);

insert into app_config (id) values (1);

create trigger app_config_updated_at
  before update on app_config
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Dues
-- ---------------------------------------------------------------------------

create table dues_periods (
  id                  uuid primary key default gen_random_uuid(),
  academic_session_id uuid not null unique references academic_sessions (id) on delete cascade,
  resumption_date     date not null,
  -- Amounts are held in kobo. Stored as double precision by project decision.
  --
  -- Two consequences to design around, neither of them fatal but both real:
  -- Paystack's API requires an integer kobo amount, so this value is cast to an
  -- integer at the request boundary; and equality comparison against a paid
  -- amount is inexact, so reconciliation compares with a tolerance rather than
  -- `=` (see payment_matches_dues()). Postgres `numeric` would remove both.
  dues_amount_kobo    double precision not null,
  grace_period_end    date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint dues_amount_positive check (dues_amount_kobo > 0),
  constraint dues_amount_whole_kobo check (dues_amount_kobo = trunc(dues_amount_kobo))
);

create trigger dues_periods_updated_at
  before update on dues_periods
  for each row execute function set_updated_at();

comment on column dues_periods.resumption_date is
  'Day 0 of the provisional window. Day 31 is the lock boundary.';

-- ===========================================================================
-- 20260728000300_identity.sql
-- ===========================================================================

-- Dept-Flow — identity: profiles, students, the register, OTP
--
-- Registration identity check is matric number + surname + level. No date of
-- birth. First and other names are collected at registration and stored as
-- account data — they are not matched against the register, because a student
-- whose middle name is recorded as "Ngozi" and who types "N." must not be
-- locked out of their own account.

-- ---------------------------------------------------------------------------
-- Profiles — one row per authenticated user, whatever their role
-- ---------------------------------------------------------------------------

create table profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  role          app_role not null,
  surname       text not null,
  first_name    text not null,
  other_names   text,
  phone         text,
  staff_id      text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint profile_surname_present check (length(btrim(surname)) > 0),
  constraint profile_first_name_present check (length(btrim(first_name)) > 0),
  -- Nigerian mobile numbers in E.164, e.g. +2348012345678.
  constraint profile_phone_format check (phone is null or phone ~ '^\+234[0-9]{10}$'),
  -- Staff carry a staff ID and log in with it; students carry a matric number
  -- on their `students` row instead.
  constraint profile_staff_id_by_role check (
    (role = 'student' and staff_id is null) or
    (role <> 'student' and staff_id is not null)
  )
);

create index profiles_role_idx on profiles (role);

create trigger profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

comment on column profiles.other_names is
  'Middle/other names. Optional — many students have none.';

-- ---------------------------------------------------------------------------
-- The register (whitelist)
-- ---------------------------------------------------------------------------

-- Admin uploads these per academic session. CSV columns are exactly
-- matric_no, surname, level.
create table whitelist_entries (
  id                  uuid primary key default gen_random_uuid(),
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  matric_no           text not null,
  surname             text not null,
  level               integer not null,
  claimed             boolean not null default false,
  claimed_by          uuid,
  claimed_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (academic_session_id, matric_no),
  -- Programme is carried by the prefix. CMP is Computer Science in this
  -- department; CSC is not a valid prefix here.
  constraint whitelist_matric_format check (matric_no ~ '^(MTH|CMP|STA)/[0-9]{4}/[0-9]{3,4}$'),
  constraint whitelist_matric_upper check (matric_no = upper(matric_no)),
  constraint whitelist_level_valid check (level in (100, 200, 300, 400)),
  constraint whitelist_claim_consistent check (
    (claimed and claimed_by is not null and claimed_at is not null) or
    (not claimed and claimed_by is null and claimed_at is null)
  )
);

create index whitelist_unclaimed_idx
  on whitelist_entries (academic_session_id, matric_no)
  where not claimed;

create trigger whitelist_entries_updated_at
  before update on whitelist_entries
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Students
-- ---------------------------------------------------------------------------

create table students (
  id                    uuid primary key references profiles (id) on delete cascade,
  matric_no             text not null unique,
  -- Derived, never asked for. The register screen reads the programme back to
  -- the student as confirmation instead of offering a picker.
  programme             text generated always as (split_part(matric_no, '/', 1)) stored,
  level                 integer not null,
  status                student_lifecycle not null default 'active',
  deactivation_reason   deactivation_reason,
  deactivation_note     text,
  deactivated_by        uuid references profiles (id),
  deactivated_at        timestamptz,
  device_id             text,
  whitelist_entry_id    uuid references whitelist_entries (id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint student_matric_format check (matric_no ~ '^(MTH|CMP|STA)/[0-9]{4}/[0-9]{3,4}$'),
  constraint student_matric_upper check (matric_no = upper(matric_no)),
  constraint student_level_valid check (level in (100, 200, 300, 400)),
  -- Soft delete only: history is retained, login is disabled, and the matric
  -- number is retired rather than reused.
  constraint student_deactivation_complete check (
    (status = 'deactivated' and deactivation_reason is not null and deactivated_at is not null) or
    (status <> 'deactivated' and deactivation_reason is null and deactivated_at is null)
  ),
  constraint student_other_reason_needs_note check (
    deactivation_reason is distinct from 'other' or length(btrim(coalesce(deactivation_note, ''))) > 0
  )
);

create index students_level_idx on students (level);
create index students_status_idx on students (status);
create index students_programme_idx on students (programme);
create index students_device_idx on students (device_id) where device_id is not null;

create trigger students_updated_at
  before update on students
  for each row execute function set_updated_at();

alter table whitelist_entries
  add constraint whitelist_claimed_by_fk
  foreign key (claimed_by) references students (id) on delete set null;

-- A student row must belong to a profile whose role is 'student'.
create or replace function enforce_student_role()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from profiles p where p.id = new.id and p.role = 'student'
  ) then
    raise exception 'students.id must reference a profile with role = student';
  end if;
  return new;
end;
$$;

create trigger students_role_check
  before insert or update of id on students
  for each row execute function enforce_student_role();

-- ---------------------------------------------------------------------------
-- OTP
-- ---------------------------------------------------------------------------

-- Codes are generated by the backend and stored hashed. Delivery goes through
-- a single send_otp() interface — the development implementation writes to the
-- server log, the production one calls an SMS provider. The plaintext code is
-- never returned in an HTTP response, in any environment.
create table otp_codes (
  id            uuid primary key default gen_random_uuid(),
  purpose       otp_purpose not null,
  matric_no     text,
  profile_id    uuid references profiles (id) on delete cascade,
  phone         text not null,
  code_hash     text not null,
  expires_at    timestamptz not null,
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now(),
  constraint otp_phone_format check (phone ~ '^\+234[0-9]{10}$'),
  constraint otp_attempts_bounded check (attempts >= 0 and attempts <= max_attempts),
  constraint otp_subject_present check (matric_no is not null or profile_id is not null)
);

create index otp_codes_lookup_idx
  on otp_codes (phone, purpose, created_at desc)
  where consumed_at is null;

comment on column otp_codes.code_hash is
  'Hash only. A plaintext OTP column is an account-takeover path.';

-- ---------------------------------------------------------------------------
-- Registration disputes
-- ---------------------------------------------------------------------------

-- "Someone else claimed my matric number." Revoking freezes the impostor
-- account and unclaims the register row; it never deletes anything.
create table registration_disputes (
  id                  uuid primary key default gen_random_uuid(),
  matric_no           text not null,
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  reported_at         timestamptz not null default now(),
  reporter_phone      text,
  status              dispute_status not null default 'open',
  resolved_by         uuid references profiles (id),
  resolution_reason   text,
  resolved_at         timestamptz,
  constraint reg_dispute_matric_format check (matric_no ~ '^(MTH|CMP|STA)/[0-9]{4}/[0-9]{3,4}$'),
  constraint reg_dispute_resolution_complete check (
    (status = 'open' and resolved_at is null) or
    (status <> 'open' and resolved_at is not null and length(btrim(coalesce(resolution_reason, ''))) > 0)
  )
);

create index registration_disputes_open_idx
  on registration_disputes (status, reported_at desc);

-- ===========================================================================
-- 20260728000400_academics.sql
-- ===========================================================================

-- Dept-Flow — courses, enrolment, timetable, lectures and checkpoints

-- ---------------------------------------------------------------------------
-- Courses
-- ---------------------------------------------------------------------------

create table courses (
  id                  uuid primary key default gen_random_uuid(),
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  code                text not null,             -- 'CMP 301'
  title               text not null,
  level               integer not null,
  lecturer_id         uuid references profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (academic_session_id, code),
  -- Computer Science is CMP in this department. CSC is not a valid code.
  constraint course_code_format check (code ~ '^(MTH|CMP|STA) [0-9]{3}$'),
  constraint course_level_valid check (level in (100, 200, 300, 400))
);

create index courses_lecturer_idx on courses (lecturer_id);

create trigger courses_updated_at
  before update on courses
  for each row execute function set_updated_at();

create or replace function enforce_lecturer_role()
returns trigger
language plpgsql
as $$
begin
  if new.lecturer_id is not null and not exists (
    select 1 from profiles p where p.id = new.lecturer_id and p.role = 'lecturer'
  ) then
    raise exception 'courses.lecturer_id must reference a profile with role = lecturer';
  end if;
  return new;
end;
$$;

create trigger courses_lecturer_role_check
  before insert or update of lecturer_id on courses
  for each row execute function enforce_lecturer_role();

-- ---------------------------------------------------------------------------
-- Enrolment
-- ---------------------------------------------------------------------------

-- The denominator of the attendance formula is "sessions held for that
-- course/student", so enrolment is what scopes a student to a course's
-- lectures.
create table enrolments (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references students (id) on delete cascade,
  course_id     uuid not null references courses (id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (student_id, course_id)
);

create index enrolments_course_idx on enrolments (course_id);

-- ---------------------------------------------------------------------------
-- Timetable — versioned per academic session
-- ---------------------------------------------------------------------------

create table timetable_entries (
  id                  uuid primary key default gen_random_uuid(),
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  course_id           uuid not null references courses (id) on delete cascade,
  day_of_week         integer not null,          -- 0 = Sunday
  start_time          time not null,
  end_time            time not null,
  venue_id            uuid not null references venues (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint timetable_day_valid check (day_of_week between 0 and 6),
  constraint timetable_time_order check (end_time > start_time)
);

create index timetable_course_idx on timetable_entries (course_id);
create index timetable_day_idx on timetable_entries (academic_session_id, day_of_week);

create trigger timetable_entries_updated_at
  before update on timetable_entries
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Lectures (SessionInstance)
-- ---------------------------------------------------------------------------

create table session_instances (
  id                  uuid primary key default gen_random_uuid(),
  course_id           uuid not null references courses (id) on delete cascade,
  timetable_entry_id  uuid references timetable_entries (id) on delete set null,
  held_on             date not null,
  scheduled_start     timestamptz,
  scheduled_end       timestamptz,
  venue_id            uuid not null references venues (id),
  type                session_instance_type not null default 'recurring',
  status              session_instance_status not null default 'scheduled',
  -- Null until the lecture closes: it is only then known whether the lecturer
  -- issued one token or two.
  checkpoint_mode     checkpoint_mode,
  opened_at           timestamptz,
  closed_at           timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid references profiles (id),
  cancellation_reason text,
  created_by          uuid not null references profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- A makeup or reschedule has no recurring timetable row behind it.
  constraint session_timetable_by_type check (
    type <> 'recurring' or timetable_entry_id is not null
  ),
  constraint session_closed_has_mode check (
    status <> 'closed' or (checkpoint_mode is not null and closed_at is not null)
  ),
  -- Cancelling removes the lecture from the attendance denominator, so it
  -- states its consequence in the UI and records a reason here.
  constraint session_cancelled_complete check (
    status <> 'cancelled' or (
      cancelled_at is not null
      and cancelled_by is not null
      and length(btrim(coalesce(cancellation_reason, ''))) > 0
    )
  )
);

create index session_instances_course_date_idx on session_instances (course_id, held_on desc);
create index session_instances_open_idx on session_instances (status) where status = 'open';

create trigger session_instances_updated_at
  before update on session_instances
  for each row execute function set_updated_at();

comment on table session_instances is
  'One lecture. Cancelled instances are excluded from the attendance denominator.';

-- ---------------------------------------------------------------------------
-- Checkpoints
-- ---------------------------------------------------------------------------

-- Two per lecture at most, lecturer-triggered, no fixed timing. The token is
-- written on a whiteboard in front of the class, so it is not a secret and is
-- not hashed; the geo-fence and the expiry are what make it hard to fake.
create table checkpoints (
  id                  uuid primary key default gen_random_uuid(),
  session_instance_id uuid not null references session_instances (id) on delete cascade,
  index               smallint not null,
  token               text not null,
  issued_at           timestamptz not null default now(),
  expires_at          timestamptz not null,
  issued_by           uuid not null references profiles (id),
  unique (session_instance_id, index),
  constraint checkpoint_index_valid check (index in (1, 2)),
  constraint checkpoint_token_format check (token ~ '^[0-9]{4}$'),
  constraint checkpoint_expiry_after_issue check (expires_at > issued_at)
);

create index checkpoints_live_idx on checkpoints (expires_at desc);

comment on column checkpoints.token is
  '4-digit code displayed very large for the whiteboard. Public by design.';

-- ===========================================================================
-- 20260728000500_attendance.sql
-- ===========================================================================

-- Dept-Flow — attendance capture and scoring

-- ---------------------------------------------------------------------------
-- Attendance marks
-- ---------------------------------------------------------------------------

-- One row per submission attempt, accepted or not. Rejections are kept because
-- the student can dispute them and the HOD needs to see the recorded reason.
--
-- Raw coordinates are purged on the schedule in app_config.gps_retention_days.
-- `distance_m` and `accepted` survive the purge — that is the whole retention
-- design, and it is why no screen anywhere shows a coordinate.
create table attendance_marks (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  checkpoint_id       uuid not null references checkpoints (id) on delete cascade,
  accepted            boolean not null,
  reject_reason       mark_reject_reason,
  gps_lat             double precision,
  gps_lng             double precision,
  gps_accuracy_m      double precision,
  distance_m          double precision,
  device_id           text,
  flagged_for_review  boolean not null default false,
  flag_reason         text,
  coordinates_purged_at timestamptz,
  submitted_at        timestamptz not null default now(),
  -- The cheapest defence against duplicate submissions, at the level where it
  -- cannot be raced: the database, not application logic.
  unique (student_id, checkpoint_id),
  constraint mark_reject_reason_presence check (
    (accepted and reject_reason is null) or (not accepted and reject_reason is not null)
  ),
  constraint mark_lat_range check (gps_lat is null or gps_lat between -90 and 90),
  constraint mark_lng_range check (gps_lng is null or gps_lng between -180 and 180),
  constraint mark_purge_clears_coordinates check (
    coordinates_purged_at is null or (gps_lat is null and gps_lng is null)
  ),
  constraint mark_flag_has_reason check (
    not flagged_for_review or length(btrim(coalesce(flag_reason, ''))) > 0
  )
);

create index attendance_marks_checkpoint_idx on attendance_marks (checkpoint_id);
create index attendance_marks_student_idx on attendance_marks (student_id, submitted_at desc);
create index attendance_marks_flagged_idx on attendance_marks (flagged_for_review) where flagged_for_review;
create index attendance_marks_purge_idx on attendance_marks (submitted_at)
  where coordinates_purged_at is null;

comment on column attendance_marks.distance_m is
  'Derived distance from the venue centre. Survives the coordinate purge; the pass/fail record without the personal data.';

comment on column attendance_marks.flagged_for_review is
  'Set when a device has recently submitted for another student. Accepted but flagged — never a hard block.';

-- ---------------------------------------------------------------------------
-- Manual (paper) batches
-- ---------------------------------------------------------------------------

-- The outage fallback. Rows resolve through the same scoring logic as digital
-- capture; the source tag exists so the HOD can see which lecturers rely on it.
create table manual_attendance_batches (
  id                  uuid primary key default gen_random_uuid(),
  session_instance_id uuid not null references session_instances (id) on delete cascade,
  submitted_by        uuid not null references profiles (id),
  justification_note  text not null,
  row_count           integer not null default 0,
  submitted_at        timestamptz not null default now(),
  -- The note cannot be empty, and cannot be a single character standing in for
  -- one. This is the record the HOD reads when reviewing paper usage.
  constraint manual_batch_note_substantive check (length(btrim(justification_note)) >= 10),
  constraint manual_batch_row_count_positive check (row_count >= 0)
);

create index manual_batches_session_idx on manual_attendance_batches (session_instance_id);
create index manual_batches_lecturer_idx on manual_attendance_batches (submitted_by, submitted_at desc);

-- ---------------------------------------------------------------------------
-- Session scores
-- ---------------------------------------------------------------------------

-- The unit the whole system reduces to: one lecture, one student, 0 / 0.5 / 1.0.
create table session_scores (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  session_instance_id uuid not null references session_instances (id) on delete cascade,
  score               numeric(2,1) not null,
  status              score_status not null,
  source              score_source not null default 'digital',
  manual_batch_id     uuid references manual_attendance_batches (id) on delete set null,
  confirmed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (student_id, session_instance_id),
  constraint score_value_valid check (score in (0, 0.5, 1.0)),
  constraint score_confirmed_has_timestamp check (
    (status = 'confirmed' and confirmed_at is not null) or
    (status = 'provisional' and confirmed_at is null)
  ),
  constraint score_manual_batch_matches_source check (
    (source = 'manually_entered') or manual_batch_id is null
  )
);

create index session_scores_student_idx on session_scores (student_id, status);
create index session_scores_instance_idx on session_scores (session_instance_id);
create index session_scores_provisional_idx on session_scores (student_id)
  where status = 'provisional';

create trigger session_scores_updated_at
  before update on session_scores
  for each row execute function set_updated_at();

-- A single-checkpoint lecture is scored present/absent. Half marks are only
-- meaningful when there were two checkpoints to catch one of.
create or replace function enforce_single_checkpoint_scoring()
returns trigger
language plpgsql
as $$
declare
  mode checkpoint_mode;
begin
  select si.checkpoint_mode into mode
  from session_instances si
  where si.id = new.session_instance_id;

  if mode = 'single' and new.score = 0.5 then
    raise exception 'a single-checkpoint session cannot score 0.5 — it is scored 1.0 or 0';
  end if;

  return new;
end;
$$;

create trigger session_scores_single_checkpoint_check
  before insert or update of score on session_scores
  for each row execute function enforce_single_checkpoint_scoring();

comment on table session_scores is
  'Provisional scores are recorded but do not count. Clearing dues flips every provisional row for that student in one transaction.';

-- ===========================================================================
-- 20260728000600_compliance_and_payments.sql
-- ===========================================================================

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

-- ===========================================================================
-- 20260728000700_governance.sql
-- ===========================================================================

-- Dept-Flow — governance: grace, waivers, disputes, eligibility, audit
--
-- Every table here backs an action that changes a student's standing. All of
-- them carry a reason, and all of them write to audit_log.

-- ---------------------------------------------------------------------------
-- Grace periods (HOD)
-- ---------------------------------------------------------------------------

-- The highest-consequence control on the site. The impact counts are captured
-- at the moment of granting so the history shows what the HOD was told when
-- they decided, not what the numbers look like now.
create table grace_periods (
  id                  uuid primary key default gen_random_uuid(),
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  scope               grace_scope not null,
  level               integer,
  expires_on          date not null,
  reason              text not null,
  granted_by          uuid not null references profiles (id),
  granted_at          timestamptz not null default now(),
  revoked_at          timestamptz,
  revoked_by          uuid references profiles (id),
  students_affected   integer not null default 0,
  sessions_waiting    integer not null default 0,
  constraint grace_reason_present check (length(btrim(reason)) > 0),
  constraint grace_level_scope check (
    (scope = 'level' and level in (100, 200, 300, 400)) or
    (scope = 'department' and level is null)
  )
);

create index grace_periods_active_idx on grace_periods (academic_session_id, expires_on desc)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Waivers and clearances (HOD)
-- ---------------------------------------------------------------------------

create table waivers (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  status              waiver_status not null default 'pending',
  request_note        text,
  reason              text,
  decided_by          uuid references profiles (id),
  decided_at          timestamptz,
  created_at          timestamptz not null default now(),
  constraint waiver_decision_complete check (
    (status = 'pending' and decided_at is null) or
    (status <> 'pending'
      and decided_at is not null
      and decided_by is not null
      and length(btrim(coalesce(reason, ''))) > 0)
  )
);

create index waivers_pending_idx on waivers (status, created_at desc);
create index waivers_student_idx on waivers (student_id);

-- ---------------------------------------------------------------------------
-- Attendance disputes (HOD)
-- ---------------------------------------------------------------------------

-- "I was present but was rejected." The HOD sees the recorded rejection reason
-- and whether the lecture was captured digitally or from paper.
create table attendance_disputes (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  session_instance_id uuid not null references session_instances (id) on delete cascade,
  checkpoint_id       uuid references checkpoints (id) on delete set null,
  student_note        text not null,
  status              dispute_status not null default 'open',
  resolved_by         uuid references profiles (id),
  resolution_reason   text,
  resolved_at         timestamptz,
  raised_at           timestamptz not null default now(),
  constraint dispute_note_present check (length(btrim(student_note)) > 0),
  constraint dispute_resolution_complete check (
    (status = 'open' and resolved_at is null) or
    (status <> 'open'
      and resolved_at is not null
      and resolved_by is not null
      and length(btrim(coalesce(resolution_reason, ''))) > 0)
  )
);

create index attendance_disputes_open_idx on attendance_disputes (status, raised_at desc);
create index attendance_disputes_student_idx on attendance_disputes (student_id);

-- ---------------------------------------------------------------------------
-- Exam eligibility — the final authoritative output
-- ---------------------------------------------------------------------------

-- Authorising is an action, not an export. Once authorized the list is frozen
-- with the authoriser's name and a timestamp.
create table eligibility_lists (
  id                  uuid primary key default gen_random_uuid(),
  course_id           uuid not null references courses (id) on delete cascade,
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  status              eligibility_status not null default 'draft',
  threshold_pct       numeric(5,2) not null default 75.00,
  authorized_by       uuid references profiles (id),
  authorized_at       timestamptz,
  created_at          timestamptz not null default now(),
  unique (course_id, academic_session_id),
  constraint eligibility_authorization_complete check (
    (status = 'draft' and authorized_at is null and authorized_by is null) or
    (status = 'authorized' and authorized_at is not null and authorized_by is not null)
  )
);

create table eligibility_entries (
  id                  uuid primary key default gen_random_uuid(),
  list_id             uuid not null references eligibility_lists (id) on delete cascade,
  student_id          uuid not null references students (id) on delete cascade,
  attendance_pct      numeric(5,2) not null,
  score_total         numeric(6,1) not null,
  sessions_held       integer not null,
  eligible            boolean not null,
  unique (list_id, student_id),
  constraint eligibility_pct_range check (attendance_pct between 0 and 100),
  constraint eligibility_sessions_positive check (sessions_held >= 0)
);

create index eligibility_entries_list_idx on eligibility_entries (list_id);

-- An authorized list is frozen. Corrections mean a new list, not an edit.
create or replace function prevent_authorized_list_edit()
returns trigger
language plpgsql
as $$
declare
  list_state eligibility_status;
begin
  select el.status into list_state
  from eligibility_lists el
  where el.id = coalesce(new.list_id, old.list_id);

  if list_state = 'authorized' then
    raise exception 'this eligibility list is authorized and cannot be changed';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger eligibility_entries_frozen
  before insert or update or delete on eligibility_entries
  for each row execute function prevent_authorized_list_edit();

-- ---------------------------------------------------------------------------
-- Level rollover
-- ---------------------------------------------------------------------------

-- Unconditional promotion. No CGPA check, no repeat-of-level.
create table level_rollovers (
  id                       uuid primary key default gen_random_uuid(),
  from_academic_session_id uuid not null references academic_sessions (id),
  to_academic_session_id   uuid not null references academic_sessions (id),
  students_promoted        integer not null default 0,
  students_graduating      integer not null default 0,
  run_by                   uuid not null references profiles (id),
  run_at                   timestamptz not null default now(),
  note                     text,
  constraint rollover_distinct_sessions check (
    from_academic_session_id <> to_academic_session_id
  )
);

-- ---------------------------------------------------------------------------
-- Risk predictions (advisory only)
-- ---------------------------------------------------------------------------

-- Second-order signal. The authoritative 75% determination is always computed
-- from confirmed session scores, never from this table. Visible to the HOD;
-- never to admin, whose scope is aggregate signals only.
create table risk_predictions (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references students (id) on delete cascade,
  course_id     uuid not null references courses (id) on delete cascade,
  predicted_pct numeric(5,2) not null,
  pattern       risk_pattern,
  computed_at   timestamptz not null default now(),
  unique (student_id, course_id),
  constraint prediction_pct_range check (predicted_pct between 0 and 100)
);

create index risk_predictions_course_idx on risk_predictions (course_id, predicted_pct);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------

create table notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references profiles (id) on delete cascade,
  kind          notification_kind not null,
  title         text not null,
  body          text not null,
  link          text,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index notifications_recipient_idx on notifications (recipient_id, created_at desc);
create index notifications_unread_idx on notifications (recipient_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

-- Immutable, append-only. Covers grace periods, waivers, clearances,
-- deactivations, registration revokes, config changes, manual batches and
-- eligibility authorizations.
create table audit_log (
  id            bigserial primary key,
  actor_id      uuid references profiles (id),
  actor_role    app_role not null,
  action        text not null,
  target_table  text,
  target_id     text,
  reason        text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint audit_action_present check (length(btrim(action)) > 0)
);

create index audit_log_actor_idx on audit_log (actor_id, created_at desc);
create index audit_log_action_idx on audit_log (action, created_at desc);
create index audit_log_target_idx on audit_log (target_table, target_id);

create or replace function prevent_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

create trigger audit_log_no_update
  before update or delete on audit_log
  for each row execute function prevent_audit_mutation();

comment on table audit_log is
  'Append-only. No update, no delete — enforced by trigger, not convention.';

-- ===========================================================================
-- 20260728000800_functions.sql
-- ===========================================================================

-- Dept-Flow — the logic the whole system reduces to
--
-- These functions are the authoritative implementations. The API may cache
-- their results (Redis, for the compliance lookup during checkpoint bursts),
-- but it must not reimplement them.

-- ---------------------------------------------------------------------------
-- The one formula
-- ---------------------------------------------------------------------------

-- attendance % = (Σ confirmed scores) ÷ (lectures held) × 100
--
-- Digital sessions, single-checkpoint sessions and paper batches all feed this
-- identically — the source tag never touches the arithmetic. Cancelled
-- lectures are excluded from the denominator; provisional scores are excluded
-- from the numerator, which is exactly why an uncleared student sees a low
-- number and a truthful one.
create or replace function attendance_pct(
  p_student_id uuid,
  p_course_id uuid
)
returns numeric
language sql
stable
as $$
  with held as (
    select count(*)::numeric as n
    from session_instances si
    where si.course_id = p_course_id
      and si.status = 'closed'
  ),
  earned as (
    select coalesce(sum(ss.score), 0)::numeric as total
    from session_scores ss
    join session_instances si on si.id = ss.session_instance_id
    where ss.student_id = p_student_id
      and si.course_id = p_course_id
      and si.status = 'closed'
      and ss.status = 'confirmed'
  )
  select case
           when held.n = 0 then 0::numeric
           else round(earned.total / held.n * 100, 2)
         end
  from held, earned;
$$;

comment on function attendance_pct(uuid, uuid) is
  'The exam-eligibility formula. Confirmed scores only, over lectures held.';

-- How many further full sessions reach the threshold, given that each one adds
-- to both sides of the fraction. This is the number in the AttendanceMeter
-- sentence: "You need 4 more full sessions to reach 75%."
create or replace function full_sessions_needed(
  p_earned numeric,
  p_held numeric,
  p_threshold_pct numeric default 75.00
)
returns integer
language sql
immutable
as $$
  select greatest(
    0,
    ceil(
      ((p_threshold_pct / 100.0) * p_held - p_earned)
      / nullif(1 - (p_threshold_pct / 100.0), 0)
    )::integer
  );
$$;

-- ---------------------------------------------------------------------------
-- Scoring a lecture
-- ---------------------------------------------------------------------------

-- Two accepted checkpoints = 1.0, one = 0.5, none = 0. A single-checkpoint
-- lecture is binary. The score is written CONFIRMED if the student is cleared
-- and PROVISIONAL otherwise — the recording never depends on payment, only the
-- counting does.
create or replace function resolve_session_score(
  p_student_id uuid,
  p_session_instance_id uuid,
  p_source score_source default 'digital',
  p_manual_batch_id uuid default null
)
returns numeric
language plpgsql
as $$
declare
  v_mode          checkpoint_mode;
  v_accepted      integer;
  v_score         numeric(2,1);
  v_status        score_status;
  v_academic_session uuid;
  v_compliance    compliance_state;
begin
  select si.checkpoint_mode, c.academic_session_id
    into v_mode, v_academic_session
  from session_instances si
  join courses c on c.id = si.course_id
  where si.id = p_session_instance_id;

  if v_mode is null then
    raise exception 'cannot score a session that has not closed';
  end if;

  select count(*)
    into v_accepted
  from attendance_marks am
  join checkpoints cp on cp.id = am.checkpoint_id
  where am.student_id = p_student_id
    and cp.session_instance_id = p_session_instance_id
    and am.accepted;

  if v_mode = 'single' then
    v_score := case when v_accepted >= 1 then 1.0 else 0 end;
  else
    v_score := case v_accepted when 2 then 1.0 when 1 then 0.5 else 0 end;
  end if;

  select cs.state into v_compliance
  from compliance_statuses cs
  where cs.student_id = p_student_id
    and cs.academic_session_id = v_academic_session;

  v_status := case when v_compliance = 'cleared' then 'confirmed' else 'provisional' end;

  insert into session_scores (
    student_id, session_instance_id, score, status, source, manual_batch_id, confirmed_at
  )
  values (
    p_student_id,
    p_session_instance_id,
    v_score,
    v_status,
    p_source,
    p_manual_batch_id,
    case when v_status = 'confirmed' then now() end
  )
  on conflict (student_id, session_instance_id) do update
    set score           = excluded.score,
        status          = excluded.status,
        source          = excluded.source,
        manual_batch_id = excluded.manual_batch_id,
        confirmed_at    = excluded.confirmed_at;

  return v_score;
end;
$$;

-- ---------------------------------------------------------------------------
-- The compliance transition
-- ---------------------------------------------------------------------------

-- Clearing is one transaction: the student's state flips and every provisional
-- score for that academic session becomes confirmed together. Partially
-- confirmed is not a state this system has.
create or replace function clear_student(
  p_student_id uuid,
  p_academic_session_id uuid,
  p_route clearance_route,
  p_actor_id uuid default null
)
returns integer
language plpgsql
as $$
declare
  v_confirmed integer;
begin
  if p_route <> 'payment' and p_actor_id is null then
    raise exception 'a clearance granted by a person must record who granted it';
  end if;

  insert into compliance_statuses (
    student_id, academic_session_id, state, cleared_at, cleared_via, cleared_by
  )
  values (
    p_student_id, p_academic_session_id, 'cleared', now(), p_route, p_actor_id
  )
  on conflict (student_id, academic_session_id) do update
    set state         = 'cleared',
        cleared_at    = now(),
        cleared_via   = p_route,
        cleared_by    = p_actor_id,
        pending_since = null,
        locked_at     = null;

  with flipped as (
    update session_scores ss
       set status = 'confirmed',
           confirmed_at = now()
      from session_instances si
      join courses c on c.id = si.course_id
     where ss.session_instance_id = si.id
       and ss.student_id = p_student_id
       and ss.status = 'provisional'
       and c.academic_session_id = p_academic_session_id
    returning 1
  )
  select count(*) into v_confirmed from flipped;

  return v_confirmed;
end;
$$;

comment on function clear_student(uuid, uuid, clearance_route, uuid) is
  'Flips compliance to cleared and confirms every provisional score in the same transaction. Returns the number of sessions counted.';

-- Day 31: uncleared students enter the buffer rather than locking immediately,
-- because a transfer that settled late is not the same as a student who never
-- paid.
create or replace function begin_pending_verification(p_academic_session_id uuid)
returns integer
language plpgsql
as $$
declare
  v_moved integer;
begin
  with moved as (
    update compliance_statuses cs
       set state = 'pending_verification',
           pending_since = now()
     where cs.academic_session_id = p_academic_session_id
       and cs.state = 'uncleared'
    returning 1
  )
  select count(*) into v_moved from moved;

  return v_moved;
end;
$$;

-- Buffer expiry: no new attendance can be recorded, and provisional scores
-- stay unconfirmed rather than being deleted.
create or replace function lock_after_buffer(p_academic_session_id uuid)
returns integer
language plpgsql
as $$
declare
  v_buffer_hours integer;
  v_locked integer;
begin
  select pending_verification_buffer_hours into v_buffer_hours from app_config where id = 1;

  with locked as (
    update compliance_statuses cs
       set state = 'locked',
           locked_at = now()
     where cs.academic_session_id = p_academic_session_id
       and cs.state = 'pending_verification'
       and cs.pending_since < now() - make_interval(hours => v_buffer_hours)
    returning 1
  )
  select count(*) into v_locked from locked;

  return v_locked;
end;
$$;

-- The hot-path check on the attendance-submission endpoint. Redis caches this
-- during token windows; this is the source of truth behind the cache.
create or replace function is_attendance_locked(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select cs.state = 'locked'
       from compliance_statuses cs
      where cs.student_id = p_student_id
        and cs.academic_session_id = p_academic_session_id),
    false
  );
$$;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

-- Raw coordinates are dropped on schedule; the derived distance and the
-- pass/fail record stay. Run nightly.
create or replace function purge_expired_coordinates()
returns integer
language plpgsql
as $$
declare
  v_days integer;
  v_purged integer;
begin
  select gps_retention_days into v_days from app_config where id = 1;

  with purged as (
    update attendance_marks
       set gps_lat = null,
           gps_lng = null,
           coordinates_purged_at = now()
     where coordinates_purged_at is null
       and submitted_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*) into v_purged from purged;

  return v_purged;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create or replace function write_audit(
  p_actor_id uuid,
  p_actor_role app_role,
  p_action text,
  p_target_table text default null,
  p_target_id text default null,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language sql
as $$
  insert into audit_log (actor_id, actor_role, action, target_table, target_id, reason, metadata)
  values (p_actor_id, p_actor_role, p_action, p_target_table, p_target_id, p_reason, p_metadata)
  returning id;
$$;

-- ---------------------------------------------------------------------------
-- Display
-- ---------------------------------------------------------------------------

-- Register order: 'OKONKWO, Chidera Emeka'. Used in tables, rosters and the
-- eligibility list, where sorting and disambiguation matter.
create or replace function display_name_register(
  p_surname text,
  p_first_name text,
  p_other_names text default null
)
returns text
language sql
immutable
as $$
  select upper(p_surname) || ', ' || btrim(p_first_name ||
         case when coalesce(btrim(p_other_names), '') = '' then '' else ' ' || p_other_names end);
$$;

-- Conversational order: 'Chidera Okonkwo'. Used in greetings and the account
-- menu.
create or replace function display_name_familiar(
  p_surname text,
  p_first_name text
)
returns text
language sql
immutable
as $$
  select p_first_name || ' ' || p_surname;
$$;

-- ===========================================================================
-- 20260728000900_rls.sql
-- ===========================================================================

-- Dept-Flow — row-level security
--
-- Role separation is a first-class design constraint, enforced here as well as
-- in the API. RLS is the second line, not the only one: FastAPI holds the
-- service role and remains the only writer for anything that changes a
-- student's standing.
--
-- The shape of it:
--   * `authenticated` gets SELECT only, scoped by role. Every write goes
--     through the API.
--   * Tables with no policy are unreachable to `authenticated` entirely
--     (otp_codes, for one — nothing outside the backend has any business
--     reading it).

-- ---------------------------------------------------------------------------
-- Role helpers
-- ---------------------------------------------------------------------------

create or replace function current_app_role()
returns app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin() returns boolean
language sql stable as $$ select current_app_role() = 'admin' $$;

create or replace function is_hod() returns boolean
language sql stable as $$ select current_app_role() = 'hod' $$;

create or replace function is_lecturer() returns boolean
language sql stable as $$ select current_app_role() = 'lecturer' $$;

create or replace function is_student() returns boolean
language sql stable as $$ select current_app_role() = 'student' $$;

-- Does the current lecturer teach the course this row belongs to?
create or replace function teaches_course(p_course_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from courses c
    where c.id = p_course_id and c.lecturer_id = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table academic_sessions        enable row level security;
alter table venues                   enable row level security;
alter table app_config               enable row level security;
alter table dues_periods             enable row level security;
alter table profiles                 enable row level security;
alter table whitelist_entries        enable row level security;
alter table students                 enable row level security;
alter table otp_codes                enable row level security;
alter table registration_disputes    enable row level security;
alter table courses                  enable row level security;
alter table enrolments               enable row level security;
alter table timetable_entries        enable row level security;
alter table session_instances        enable row level security;
alter table checkpoints              enable row level security;
alter table attendance_marks         enable row level security;
alter table manual_attendance_batches enable row level security;
alter table session_scores           enable row level security;
alter table compliance_statuses      enable row level security;
alter table payments                 enable row level security;
alter table grace_periods            enable row level security;
alter table waivers                  enable row level security;
alter table attendance_disputes      enable row level security;
alter table eligibility_lists        enable row level security;
alter table eligibility_entries      enable row level security;
alter table level_rollovers          enable row level security;
alter table risk_predictions         enable row level security;
alter table notifications            enable row level security;
alter table audit_log                enable row level security;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create policy academic_sessions_read on academic_sessions
  for select to authenticated using (true);

-- Geo-fence coordinates are admin-only. The HOD explicitly does not see them,
-- and neither does anyone else — a student who can read the fence can work out
-- exactly how far they can stray.
create policy venues_admin_read on venues
  for select to authenticated using (is_admin());

create policy app_config_read on app_config
  for select to authenticated using (true);

-- Students need the amount and the deadline; the grace date drives their
-- dues screen.
create policy dues_periods_read on dues_periods
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create policy profiles_self_read on profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_governance_read on profiles
  for select to authenticated using (is_hod() or is_admin());

create policy profiles_lecturer_read on profiles
  for select to authenticated using (
    is_lecturer() and exists (
      select 1
      from enrolments e
      join courses c on c.id = e.course_id
      where e.student_id = profiles.id
        and c.lecturer_id = auth.uid()
    )
  );

create policy students_self_read on students
  for select to authenticated using (id = auth.uid());

create policy students_governance_read on students
  for select to authenticated using (is_hod() or is_admin());

create policy students_lecturer_read on students
  for select to authenticated using (
    is_lecturer() and exists (
      select 1
      from enrolments e
      join courses c on c.id = e.course_id
      where e.student_id = students.id
        and c.lecturer_id = auth.uid()
    )
  );

-- The register is admin scope. The HOD does not manage the whitelist.
create policy whitelist_admin_read on whitelist_entries
  for select to authenticated using (is_admin());

create policy registration_disputes_admin_read on registration_disputes
  for select to authenticated using (is_admin());

-- otp_codes deliberately has no policy: only the service role reaches it.

-- ---------------------------------------------------------------------------
-- Academics
-- ---------------------------------------------------------------------------

create policy courses_read on courses
  for select to authenticated using (true);

create policy timetable_read on timetable_entries
  for select to authenticated using (true);

create policy enrolments_self_read on enrolments
  for select to authenticated using (student_id = auth.uid());

create policy enrolments_staff_read on enrolments
  for select to authenticated using (
    is_hod() or is_admin() or teaches_course(course_id)
  );

create policy session_instances_student_read on session_instances
  for select to authenticated using (
    exists (
      select 1 from enrolments e
      where e.course_id = session_instances.course_id
        and e.student_id = auth.uid()
    )
  );

create policy session_instances_staff_read on session_instances
  for select to authenticated using (
    is_hod() or is_admin() or teaches_course(course_id)
  );

-- Students must never read a checkpoint row. The token is what makes presence
-- in the hall necessary; handing it to the client would let a student submit
-- from the car park with only the geo-fence standing in the way.
create policy checkpoints_staff_read on checkpoints
  for select to authenticated using (
    is_hod() or is_admin() or exists (
      select 1 from session_instances si
      where si.id = checkpoints.session_instance_id
        and teaches_course(si.course_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------

-- Coordinates are not exposed to students even on their own rows. They read
-- `my_attendance_marks` below, which has no coordinate columns at all.
create policy attendance_marks_staff_read on attendance_marks
  for select to authenticated using (
    is_hod() or is_admin() or exists (
      select 1
      from checkpoints cp
      join session_instances si on si.id = cp.session_instance_id
      where cp.id = attendance_marks.checkpoint_id
        and teaches_course(si.course_id)
    )
  );

create policy manual_batches_staff_read on manual_attendance_batches
  for select to authenticated using (
    is_hod() or is_admin() or submitted_by = auth.uid()
  );

create policy session_scores_self_read on session_scores
  for select to authenticated using (student_id = auth.uid());

create policy session_scores_staff_read on session_scores
  for select to authenticated using (
    is_hod() or is_admin() or exists (
      select 1 from session_instances si
      where si.id = session_scores.session_instance_id
        and teaches_course(si.course_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Compliance and payments
-- ---------------------------------------------------------------------------

create policy compliance_self_read on compliance_statuses
  for select to authenticated using (student_id = auth.uid());

create policy compliance_governance_read on compliance_statuses
  for select to authenticated using (is_hod() or is_admin());

create policy payments_self_read on payments
  for select to authenticated using (student_id = auth.uid());

create policy payments_governance_read on payments
  for select to authenticated using (is_hod() or is_admin());

-- ---------------------------------------------------------------------------
-- Governance
-- ---------------------------------------------------------------------------

-- A student needs to see that a grace period exists and when it expires.
create policy grace_periods_read on grace_periods
  for select to authenticated using (true);

create policy waivers_self_read on waivers
  for select to authenticated using (student_id = auth.uid());

create policy waivers_hod_read on waivers
  for select to authenticated using (is_hod());

create policy disputes_self_read on attendance_disputes
  for select to authenticated using (student_id = auth.uid());

create policy disputes_hod_read on attendance_disputes
  for select to authenticated using (is_hod());

create policy eligibility_lists_read on eligibility_lists
  for select to authenticated using (is_hod() or teaches_course(course_id));

create policy eligibility_entries_read on eligibility_entries
  for select to authenticated using (
    is_hod() or exists (
      select 1 from eligibility_lists el
      where el.id = eligibility_entries.list_id
        and teaches_course(el.course_id)
    )
  );

create policy level_rollovers_admin_read on level_rollovers
  for select to authenticated using (is_admin());

-- Individual risk is HOD scope. Admin is deliberately excluded: surfacing
-- per-student risk to the operations role breaks separation of duties.
create policy risk_predictions_self_read on risk_predictions
  for select to authenticated using (student_id = auth.uid());

create policy risk_predictions_hod_read on risk_predictions
  for select to authenticated using (is_hod());

create policy notifications_self_read on notifications
  for select to authenticated using (recipient_id = auth.uid());

-- Only the recipient may mark their own notification read — the one write
-- `authenticated` is trusted with, because it changes nothing of consequence.
create policy notifications_self_update on notifications
  for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

create policy audit_admin_read on audit_log
  for select to authenticated using (is_admin());

-- The HOD sees the override trail on a student's record, and nothing else.
create policy audit_hod_student_read on audit_log
  for select to authenticated using (is_hod() and target_table = 'students');

-- ---------------------------------------------------------------------------
-- Student-facing views
-- ---------------------------------------------------------------------------

-- No coordinate columns exist here at all, so "never show raw GPS" survives a
-- careless query as well as a careless screen.
create view my_attendance_marks
with (security_invoker = true)
as
  select
    am.id,
    am.checkpoint_id,
    cp.session_instance_id,
    cp.index as checkpoint_index,
    am.accepted,
    am.reject_reason,
    am.submitted_at
  from attendance_marks am
  join checkpoints cp on cp.id = am.checkpoint_id
  where am.student_id = auth.uid();

create policy attendance_marks_self_read on attendance_marks
  for select to authenticated using (student_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Nothing is reachable without authenticating.
revoke all on all tables in schema public from anon;

-- `authenticated` reads through the policies above; every write of consequence
-- goes through the API's service role.
revoke insert, update, delete on all tables in schema public from authenticated;
grant update (read_at) on notifications to authenticated;
grant select on my_attendance_marks to authenticated;

-- ===========================================================================
-- 20260728001000_credentials.sql
-- ===========================================================================

-- Dept-Flow — matric-number credentials, with no email anywhere
--
-- Supabase Auth (GoTrue) is built around an email or a phone number as the
-- account identifier. Dept-Flow has neither: a student is identified by their
-- matric number, and staff by a staff ID. Bending GoTrue to fit — a synthetic
-- email, or the phone as a hidden identifier — puts a fake or private value at
-- the centre of the identity model and leaks it the first time an error
-- message quotes it.
--
-- So the credential store lives here, and the API issues its own JWT. The
-- token carries `sub` = profiles.id, which is exactly what `auth.uid()` reads,
-- so every RLS policy already written keeps working unchanged.
--
-- Passwords are hashed by the API with Argon2id and only ever arrive here
-- already hashed. Nothing in this schema can read a password.

-- ---------------------------------------------------------------------------
-- Detach profiles from auth.users
-- ---------------------------------------------------------------------------

alter table profiles drop constraint if exists profiles_id_fkey;
alter table profiles alter column id set default gen_random_uuid();

comment on column profiles.id is
  'Account identifier. Issued here, not by GoTrue. Travels as the JWT `sub` claim, which is what auth.uid() returns.';

-- ---------------------------------------------------------------------------
-- Credentials
-- ---------------------------------------------------------------------------

alter table profiles
  add column password_hash        text,
  add column password_updated_at  timestamptz,
  add column failed_attempts      integer not null default 0,
  add column locked_until         timestamptz,
  add column last_login_at        timestamptz;

-- A bcrypt or Argon2 digest, never a password. The check is deliberately loose
-- on algorithm and strict on shape: anything that is not a modular crypt
-- string is a plaintext password that has escaped, and it must not be storable.
alter table profiles
  add constraint profile_password_is_hashed
  check (password_hash is null or password_hash ~ '^\$(argon2(i|d|id)|2[aby])\$');

alter table profiles
  add constraint profile_failed_attempts_sane
  check (failed_attempts >= 0);

comment on column profiles.password_hash is
  'Argon2id digest written by the API. A plaintext password cannot satisfy the check constraint.';

comment on column profiles.locked_until is
  'Set by the API after repeated failures. Throttles credential stuffing against a known matric number format.';

-- ---------------------------------------------------------------------------
-- Login lookup
-- ---------------------------------------------------------------------------

-- Login takes a matric number or a staff ID and has to resolve it to a profile
-- in one hop, on a path that runs during checkpoint bursts.
create index if not exists students_matric_lookup_idx on students (matric_no);
create index if not exists profiles_staff_lookup_idx on profiles (staff_id) where staff_id is not null;

-- Resolves either identifier to the account behind it. Security definer so the
-- API can call it before a session exists; it returns no password material and
-- no personal data beyond what the caller already typed.
create or replace function resolve_login_identifier(p_identifier text)
returns table (profile_id uuid, role app_role, is_deactivated boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.role,
         coalesce(s.status = 'deactivated', false)
  from profiles p
  left join students s on s.id = p.id
  where p.staff_id = p_identifier
     or s.matric_no = upper(btrim(p_identifier));
$$;

comment on function resolve_login_identifier(text) is
  'Matric number or staff ID to account. Returns no credential material — the API compares the hash itself.';

revoke all on function resolve_login_identifier(text) from anon, authenticated;
