-- Dept-Flow — complete schema setup
--
-- Generated from supabase/migrations/. Paste the whole file into the Supabase
-- SQL Editor and run it once, on a fresh project.
--
-- This exists so the schema can be applied without sharing a database password
-- or a service-role key with anyone. Nothing in here needs either.
--
-- Order matters: types, then tables, then functions, then row-level security,
-- then the function grants that keep PostgREST from publishing them all.

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

-- ===========================================================================
-- 20260728001100_function_grants.sql
-- ===========================================================================

-- Dept-Flow — lock down function execution
--
-- Postgres grants EXECUTE on every new function to PUBLIC, and PostgREST
-- publishes everything in the `public` schema as an RPC endpoint. Together
-- that means a function is callable by anyone holding the anon key — which is
-- in the browser bundle by design — unless PUBLIC is revoked explicitly.
--
-- Revoking from `anon` and `authenticated` by name does NOT do this. Those
-- roles inherit PUBLIC's grant, so the named revoke removes a permission they
-- were never relying on and leaves the real one in place. It has to be
-- `revoke ... from public`.
--
-- The write functions were already protected by accident rather than design:
-- none of them are SECURITY DEFINER, so they run with the caller's privileges
-- and hit the table-level revoke. That is defence in depth doing its job, but
-- it is not a reason to leave the endpoints exposed.

-- ---------------------------------------------------------------------------
-- The one that was actually exploitable
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, so it runs as the owner and sails past every table grant.
-- Exposed to PUBLIC it let anyone POST /rest/v1/rpc/resolve_login_identifier
-- and walk the register: matric numbers are sequential, so a few hundred
-- requests enumerate who has an account, their role, and whether they have
-- been deactivated.
--
-- Only the API needs it, and the API holds the service role.
revoke all on function resolve_login_identifier(text) from public, anon, authenticated;
grant execute on function resolve_login_identifier(text) to service_role;

-- ---------------------------------------------------------------------------
-- Functions the RLS policies call
-- ---------------------------------------------------------------------------

-- These are evaluated as the caller inside a policy, so `authenticated` must
-- keep EXECUTE or every policy that references them fails closed and the
-- product stops working. `anon` has no policies and needs none of them.
revoke all on function current_app_role() from public, anon;
revoke all on function is_admin() from public, anon;
revoke all on function is_hod() from public, anon;
revoke all on function is_lecturer() from public, anon;
revoke all on function is_student() from public, anon;
revoke all on function teaches_course(uuid) from public, anon;

grant execute on function current_app_role() to authenticated, service_role;
grant execute on function is_admin() to authenticated, service_role;
grant execute on function is_hod() to authenticated, service_role;
grant execute on function is_lecturer() to authenticated, service_role;
grant execute on function is_student() to authenticated, service_role;
grant execute on function teaches_course(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Anything that writes, or that a scheduled job runs
-- ---------------------------------------------------------------------------

-- The API owns every one of these. None should be reachable as an RPC.
revoke all on function clear_student(uuid, uuid, clearance_route, uuid) from public, anon, authenticated;
revoke all on function resolve_session_score(uuid, uuid, score_source, uuid) from public, anon, authenticated;
revoke all on function begin_pending_verification(uuid) from public, anon, authenticated;
revoke all on function lock_after_buffer(uuid) from public, anon, authenticated;
revoke all on function purge_expired_coordinates() from public, anon, authenticated;
revoke all on function write_audit(uuid, app_role, text, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function clear_student(uuid, uuid, clearance_route, uuid) to service_role;
grant execute on function resolve_session_score(uuid, uuid, score_source, uuid) to service_role;
grant execute on function begin_pending_verification(uuid) to service_role;
grant execute on function lock_after_buffer(uuid) to service_role;
grant execute on function purge_expired_coordinates() to service_role;
grant execute on function write_audit(uuid, app_role, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Pure calculation, safe to expose
-- ---------------------------------------------------------------------------

-- These read nothing a signed-in user cannot already read under RLS, or take
-- all their inputs as arguments and touch no table at all. A student computing
-- their own percentage client-side is a feature, not a leak.
revoke all on function attendance_pct(uuid, uuid) from public, anon;
revoke all on function is_attendance_locked(uuid, uuid) from public, anon;
revoke all on function full_sessions_needed(numeric, numeric, numeric) from public, anon;
revoke all on function payment_matches_dues(double precision, double precision) from public, anon;
revoke all on function display_name_register(text, text, text) from public, anon;
revoke all on function display_name_familiar(text, text) from public, anon;

grant execute on function attendance_pct(uuid, uuid) to authenticated, service_role;
grant execute on function is_attendance_locked(uuid, uuid) to authenticated, service_role;
grant execute on function full_sessions_needed(numeric, numeric, numeric) to authenticated, service_role;
grant execute on function payment_matches_dues(double precision, double precision) to authenticated, service_role;
grant execute on function display_name_register(text, text, text) to authenticated, service_role;
grant execute on function display_name_familiar(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- And for everything added later
-- ---------------------------------------------------------------------------

-- New functions in this schema default to PUBLIC EXECUTE, which is how this
-- hole appeared in the first place. Stop it happening again.
alter default privileges in schema public revoke execute on functions from public;

-- ===========================================================================
-- 20260728001200_venue_directory.sql
-- ===========================================================================

-- Dept-Flow — venue names without venue coordinates
--
-- `venues_admin_read` is correct and stays: a student who can read the fence
-- centre and radius knows exactly how far from the hall they can stand, which
-- defeats the geo-fence. But it also hides the venue *name*, and the name is
-- not a secret — it is printed on the timetable, said aloud in class, and has
-- to appear on the lecturer's session screen and the student's checkpoint
-- screen.
--
-- Splitting them is the fix. This view has no coordinate columns at all, so
-- "the fence is admin-only" survives a careless query as well as a careless
-- screen — the same reasoning as `my_attendance_marks`.

-- Deliberately NOT security_invoker. The view runs as its owner and so is not
-- filtered by venues' row policy; what protects the coordinates is that they
-- are not selectable here at any privilege level.
create view venue_directory as
  select id, name from venues;

grant select on venue_directory to authenticated;

comment on view venue_directory is
  'Venue id and name only. The geo-fence centre and radius stay admin-only on venues.';

-- ===========================================================================
-- 20260728001300_course_registration.sql
-- ===========================================================================

-- Dept-Flow — course registration
--
-- Until now a student was connected to courses by whatever put rows in
-- `enrolments`, and nothing did. That list is not administrative tidiness: it
-- is the DENOMINATOR of the attendance formula, so it decides which lectures
-- count against a student and therefore who sits an exam.
--
-- Three ways in, agreed with the department:
--
--   core       the admin uploads them per level; every student at that level
--              is enrolled automatically and cannot opt out
--   elective   the admin uploads them per level; the student opts in
--   carry-over a course from a LOWER level that the student is repeating, and
--              adds themselves
--
-- Total load is capped at 24 credit units per semester, counting all three.

-- ---------------------------------------------------------------------------
-- What a course is
-- ---------------------------------------------------------------------------

create type course_kind as enum ('core', 'elective');

-- How a student came to be on a course. Not decoration: it is what decides
-- whether they may remove it, and it is the first thing the HOD looks at when
-- a percentage is disputed.
create type enrolment_source as enum ('core', 'elective', 'carry_over');

alter table courses
  add column kind         course_kind not null default 'core',
  add column credit_units smallint    not null default 3,
  -- The 24-unit cap is per semester, which the schema previously had no way of
  -- expressing — every course sat in an academic session and nothing smaller.
  add column semester     smallint    not null default 1;

alter table courses
  add constraint course_credit_units_range check (credit_units between 1 and 6),
  add constraint course_semester_valid check (semester in (1, 2));

comment on column courses.kind is
  'Core courses enrol every student at their level automatically. Electives are opt-in.';

-- ---------------------------------------------------------------------------
-- What an enrolment is
-- ---------------------------------------------------------------------------

alter table enrolments
  add column source      enrolment_source not null default 'core',
  -- Deliberately NOT created_at. A student registering in week 8 has a row
  -- created in week 8, but a seeded or back-filled enrolment must be able to
  -- say "from the start of the session" — and the difference is every lecture
  -- held before the row existed.
  add column enrolled_on date not null default current_date,
  -- Dropping records rather than deletes. Deleting would take the join date
  -- with it, and a student could then drop and re-add a course to erase every
  -- absence on it.
  add column dropped_at  timestamptz;

create index enrolments_active_idx on enrolments (student_id) where dropped_at is null;

comment on column enrolments.enrolled_on is
  'Lectures held before this date are outside the student''s denominator. A carry-over added in week 8 does not inherit seven absences.';

-- ---------------------------------------------------------------------------
-- The cap
-- ---------------------------------------------------------------------------

alter table app_config
  add column max_credit_units_per_semester integer not null default 24;

alter table app_config
  add constraint app_config_credit_cap_range check (max_credit_units_per_semester between 12 and 36);

-- ---------------------------------------------------------------------------
-- The attendance formula, corrected for join dates
-- ---------------------------------------------------------------------------

-- Replaces the version in ..._functions.sql. The numerator is unchanged; the
-- denominator is now "lectures held while this student was on the course"
-- rather than "lectures held".
--
-- Without this, a student who adds a carry-over in week 8 is marked absent for
-- the seven lectures held before they joined, which is both wrong and the kind
-- of wrong that ends in someone being barred from an exam.
create or replace function attendance_pct(
  p_student_id uuid,
  p_course_id uuid
)
returns numeric
language sql
stable
as $$
  with window_of as (
    select e.enrolled_on, e.dropped_at
    from enrolments e
    where e.student_id = p_student_id
      and e.course_id = p_course_id
    order by e.enrolled_on
    limit 1
  ),
  held as (
    select count(*)::numeric as n
    from session_instances si, window_of w
    where si.course_id = p_course_id
      and si.status = 'closed'
      and si.held_on >= w.enrolled_on
      and (w.dropped_at is null or si.held_on < w.dropped_at::date)
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
  'The exam-eligibility formula. Confirmed scores over lectures held while the student was enrolled.';

-- ---------------------------------------------------------------------------
-- Registering for courses
-- ---------------------------------------------------------------------------

-- What a student is carrying this semester. Counts core, electives and
-- carry-overs alike: 24 units is a total load, not an allowance on top of one.
create or replace function student_credit_units(
  p_student_id uuid,
  p_academic_session_id uuid,
  p_semester smallint
)
returns integer
language sql
stable
as $$
  select coalesce(sum(c.credit_units), 0)::integer
  from enrolments e
  join courses c on c.id = e.course_id
  where e.student_id = p_student_id
    and e.dropped_at is null
    and c.academic_session_id = p_academic_session_id
    and c.semester = p_semester;
$$;

-- Every core course at the student's level, enrolled in one call. Run at
-- registration, and again by the admin after uploading a new course list.
--
-- Idempotent: a student already on a course is left alone, so re-running after
-- an upload adds only what is new and never resets a join date.
create or replace function enrol_in_core_courses(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns integer
language plpgsql
as $$
declare
  v_level integer;
  v_added integer;
begin
  select level into v_level from students where id = p_student_id;
  if v_level is null then
    raise exception 'no such student';
  end if;

  with added as (
    insert into enrolments (student_id, course_id, source, enrolled_on)
    select p_student_id, c.id, 'core', current_date
    from courses c
    where c.academic_session_id = p_academic_session_id
      and c.level = v_level
      and c.kind = 'core'
    on conflict (student_id, course_id) do nothing
    returning 1
  )
  select count(*) into v_added from added;

  return v_added;
end;
$$;

comment on function enrol_in_core_courses(uuid, uuid) is
  'Core courses are compulsory, so they are not offered as a choice. Idempotent.';

-- A student adding an elective at their own level, or a carry-over from a
-- lower one. Every rule is enforced here rather than in the API, because the
-- API is not the only thing that will ever write this table.
create or replace function add_optional_course(
  p_student_id uuid,
  p_course_id uuid
)
returns text
language plpgsql
as $$
declare
  v_level        integer;
  v_course       courses%rowtype;
  v_cap          integer;
  v_current      integer;
  v_source       enrolment_source;
  v_existing     enrolments%rowtype;
begin
  select level into v_level from students where id = p_student_id;
  select * into v_course from courses where id = p_course_id;

  if v_level is null or v_course.id is null then
    return 'not_found';
  end if;

  -- A core course at the student's own level is not a choice; they are already
  -- on it. A core course at a lower level is a legitimate carry-over.
  if v_course.level > v_level then
    return 'above_level';
  end if;

  if v_course.level = v_level then
    if v_course.kind = 'core' then
      return 'core_not_optional';
    end if;
    v_source := 'elective';
  else
    v_source := 'carry_over';
  end if;

  select * into v_existing
  from enrolments
  where student_id = p_student_id and course_id = p_course_id;

  if v_existing.id is not null and v_existing.dropped_at is null then
    return 'already_enrolled';
  end if;

  select max_credit_units_per_semester into v_cap from app_config where id = 1;
  v_current := student_credit_units(p_student_id, v_course.academic_session_id, v_course.semester);

  if v_current + v_course.credit_units > v_cap then
    return 'over_credit_limit';
  end if;

  if v_existing.id is not null then
    -- Re-adding a dropped course. The original join date is kept on purpose:
    -- otherwise dropping and re-adding is a way to wipe an absence record.
    update enrolments set dropped_at = null where id = v_existing.id;
  else
    insert into enrolments (student_id, course_id, source, enrolled_on)
    values (p_student_id, p_course_id, v_source, current_date);
  end if;

  return 'added';
end;
$$;

create or replace function drop_optional_course(
  p_student_id uuid,
  p_course_id uuid
)
returns text
language plpgsql
as $$
declare
  v_row enrolments%rowtype;
begin
  select * into v_row
  from enrolments
  where student_id = p_student_id and course_id = p_course_id and dropped_at is null;

  if v_row.id is null then
    return 'not_found';
  end if;

  -- Core is compulsory. A student who could remove it would simply stop being
  -- tracked for a course they still have to pass.
  if v_row.source = 'core' then
    return 'core_not_optional';
  end if;

  update enrolments set dropped_at = now() where id = v_row.id;

  return 'dropped';
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Same reasoning as ..._function_grants.sql: PostgREST publishes everything in
-- this schema, and Postgres grants EXECUTE to PUBLIC by default. These write,
-- so only the API may call them.
revoke all on function enrol_in_core_courses(uuid, uuid) from public, anon, authenticated;
revoke all on function add_optional_course(uuid, uuid) from public, anon, authenticated;
revoke all on function drop_optional_course(uuid, uuid) from public, anon, authenticated;

grant execute on function enrol_in_core_courses(uuid, uuid) to service_role;
grant execute on function add_optional_course(uuid, uuid) to service_role;
grant execute on function drop_optional_course(uuid, uuid) to service_role;

-- Reads nothing a student cannot already see about themselves under RLS.
revoke all on function student_credit_units(uuid, uuid, smallint) from public, anon;
grant execute on function student_credit_units(uuid, uuid, smallint) to authenticated, service_role;

-- ===========================================================================
-- 20260728001400_grace_periods.sql
-- ===========================================================================

-- Dept-Flow — opening and revoking a grace period
--
-- A grace period is the HOD saying: for these students, start recording
-- attendance again until this date, even though they have not paid.
--
-- It exists because locking is blunt and the cause is often not the student's.
-- A bursary disburses late, a bank is down for three days, a scholarship batch
-- does not land. Those lectures cannot be attended retroactively, so locking a
-- whole level out of them punishes the wrong people.

-- ---------------------------------------------------------------------------
-- Grace suspends the consequence; it does not change the state
-- ---------------------------------------------------------------------------

-- The obvious implementation — flip every locked student back to `uncleared` —
-- is wrong twice over. It destroys the fact that they were locked, so revoking
-- the grace period would have to guess who to re-lock. And it makes a student
-- under grace indistinguishable from one who never reached day 31, which is
-- exactly the distinction the HOD needs when the period expires.
--
-- So the state stays `locked` and the lock CHECK consults the grace period.
-- Revoking is then immediate and needs no compensating update, because nothing
-- was ever written to undo.
create or replace function is_attendance_locked(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns boolean
language sql
stable
as $$
  select
    coalesce(
      (select cs.state = 'locked'
         from compliance_statuses cs
        where cs.student_id = p_student_id
          and cs.academic_session_id = p_academic_session_id),
      false
    )
    and not exists (
      select 1
      from grace_periods g
      join students s on s.id = p_student_id
      where g.academic_session_id = p_academic_session_id
        and g.revoked_at is null
        and g.expires_on >= current_date
        and (g.scope = 'department' or g.level = s.level)
    );
$$;

comment on function is_attendance_locked(uuid, uuid) is
  'True when the student is locked AND no active grace period covers them. Grace suspends the consequence rather than rewriting the state.';

-- ---------------------------------------------------------------------------
-- Who a grace period would reach
-- ---------------------------------------------------------------------------

-- Shown on the confirmation before it is opened, and stored on the row so the
-- history says what it did at the time rather than what it would do today.
create or replace function grace_period_impact(
  p_academic_session_id uuid,
  p_scope grace_scope,
  p_level integer default null
)
returns table (students_affected integer, sessions_waiting numeric)
language sql
stable
as $$
  with covered as (
    select cs.student_id
    from compliance_statuses cs
    join students s on s.id = cs.student_id
    where cs.academic_session_id = p_academic_session_id
      and cs.state = 'locked'
      and (p_scope = 'department' or s.level = p_level)
  )
  select
    (select count(*)::integer from covered),
    -- Marks already recorded and waiting on payment. The number the HOD is
    -- weighing: what these students stand to lose if nothing changes.
    coalesce((
      select sum(ss.score)
      from session_scores ss
      where ss.student_id in (select student_id from covered)
        and ss.status = 'provisional'
    ), 0);
$$;

-- ---------------------------------------------------------------------------
-- Opening one
-- ---------------------------------------------------------------------------

create or replace function open_grace_period(
  p_academic_session_id uuid,
  p_scope grace_scope,
  p_level integer,
  p_expires_on date,
  p_reason text,
  p_actor_id uuid
)
returns uuid
language plpgsql
as $$
declare
  v_id       uuid;
  v_students integer;
  v_waiting  numeric;
begin
  if p_actor_id is null then
    raise exception 'a grace period must record who opened it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a grace period must record why it was opened';
  end if;

  -- A date in the past would read as an active period that unlocks nobody.
  if p_expires_on <= current_date then
    raise exception 'a grace period must expire in the future';
  end if;

  -- One at a time per scope. Two overlapping periods make "when does this end"
  -- unanswerable, which is the only question a student in one will ask.
  if exists (
    select 1 from grace_periods g
    where g.academic_session_id = p_academic_session_id
      and g.revoked_at is null
      and g.expires_on >= current_date
      and (g.scope = 'department' or p_scope = 'department' or g.level = p_level)
  ) then
    raise exception 'a grace period covering these students is already open';
  end if;

  select students_affected, sessions_waiting
    into v_students, v_waiting
  from grace_period_impact(p_academic_session_id, p_scope, p_level);

  insert into grace_periods (
    academic_session_id, scope, level, expires_on, reason,
    granted_by, students_affected, sessions_waiting
  )
  values (
    p_academic_session_id, p_scope,
    case when p_scope = 'level' then p_level end,
    p_expires_on, btrim(p_reason),
    p_actor_id, coalesce(v_students, 0), coalesce(round(v_waiting), 0)
  )
  returning id into v_id;

  perform write_audit(
    p_actor_id, 'hod', 'grace_period.opened', 'grace_periods', v_id::text, btrim(p_reason),
    jsonb_build_object(
      'scope', p_scope,
      'level', p_level,
      'expires_on', p_expires_on,
      'students_affected', coalesce(v_students, 0)
    )
  );

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ending one early
-- ---------------------------------------------------------------------------

-- Takes effect immediately, because the lock check reads `revoked_at` live.
-- Nothing has to be re-locked: nobody was ever unlocked.
create or replace function revoke_grace_period(
  p_grace_id uuid,
  p_actor_id uuid,
  p_reason text
)
returns boolean
language plpgsql
as $$
declare
  v_row grace_periods%rowtype;
begin
  if p_actor_id is null then
    raise exception 'revoking a grace period must record who did it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'revoking a grace period must record why';
  end if;

  select * into v_row from grace_periods where id = p_grace_id;

  if v_row.id is null then return false; end if;
  if v_row.revoked_at is not null then return false; end if;

  update grace_periods
     set revoked_at = now(), revoked_by = p_actor_id
   where id = p_grace_id;

  perform write_audit(
    p_actor_id, 'hod', 'grace_period.revoked', 'grace_periods', p_grace_id::text, btrim(p_reason),
    jsonb_build_object('students_affected', v_row.students_affected)
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function open_grace_period(uuid, grace_scope, integer, date, text, uuid)
  from public, anon, authenticated;
revoke all on function revoke_grace_period(uuid, uuid, text) from public, anon, authenticated;
grant execute on function open_grace_period(uuid, grace_scope, integer, date, text, uuid) to service_role;
grant execute on function revoke_grace_period(uuid, uuid, text) to service_role;

-- Read-only, and the HOD's own screen needs it before confirming.
revoke all on function grace_period_impact(uuid, grace_scope, integer) from public, anon;
grant execute on function grace_period_impact(uuid, grace_scope, integer) to authenticated, service_role;

-- ===========================================================================
-- 20260728001500_payment_window.sql
-- ===========================================================================

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

-- ===========================================================================
-- 20260728001600_compliance_schedule.sql
-- ===========================================================================

-- Dept-Flow — making the deadline actually arrive
--
-- Two functions have existed since the first migration and nothing has ever
-- called them: `begin_pending_verification` and `lock_after_buffer`. The whole
-- compliance ladder — uncleared → pending verification → locked — was inert.
--
-- That was survivable while locking only affected attendance recording, since
-- the seed sets a locked student by hand. It stopped being survivable when the
-- payment window was tied to the lock: with nothing to drive the transition, no
-- student is ever locked, the portal never closes, and the deadline the
-- department asked for does not exist.

-- ---------------------------------------------------------------------------
-- The deadline belongs in the function, not in the caller
-- ---------------------------------------------------------------------------

-- The original moved EVERY uncleared student into the buffer whenever it was
-- called. The day-30 rule lived entirely in the assumption that somebody would
-- call it on day 31 and never a day sooner — so a scheduler misfire, a manual
-- run, or a retry would lock a whole department early, and the students would
-- have no way to pay their way out of it.
--
-- The rule now lives here: resumption date plus the configured provisional
-- window. Running this on day 3 does nothing at all.
create or replace function begin_pending_verification(p_academic_session_id uuid)
returns integer
language plpgsql
as $$
declare
  v_days     integer;
  v_deadline date;
  v_moved    integer;
begin
  select provisional_window_days into v_days from app_config where id = 1;

  select dp.resumption_date + v_days
    into v_deadline
  from dues_periods dp
  where dp.academic_session_id = p_academic_session_id;

  -- No dues period means no deadline to have passed.
  if v_deadline is null or current_date <= v_deadline then
    return 0;
  end if;

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

comment on function begin_pending_verification(uuid) is
  'Day 31 onwards. Safe to run any day: before the deadline it moves nobody.';

-- ---------------------------------------------------------------------------
-- One call for the scheduler
-- ---------------------------------------------------------------------------

-- Both steps in order, for the active session. Separate functions would mean a
-- scheduler that ran one and not the other leaves students in the buffer for
-- ever, which is the state where they can neither record attendance nor be
-- chased about it.
create or replace function advance_compliance_states()
returns table (moved_to_pending integer, locked integer)
language plpgsql
as $$
declare
  v_session uuid;
  v_pending integer;
  v_locked  integer;
begin
  select id into v_session from academic_sessions where is_active limit 1;

  if v_session is null then
    return query select 0, 0;
    return;
  end if;

  v_pending := begin_pending_verification(v_session);
  v_locked  := lock_after_buffer(v_session);

  -- Audited only when something actually changed. A nightly no-op writing a
  -- row every night would bury the nights that mattered.
  if v_pending > 0 or v_locked > 0 then
    perform write_audit(
      null, 'admin', 'compliance.advanced', 'compliance_statuses', v_session::text,
      'Scheduled compliance transition',
      jsonb_build_object('moved_to_pending', v_pending, 'locked', v_locked)
    );
  end if;

  return query select v_pending, v_locked;
end;
$$;

revoke all on function advance_compliance_states() from public, anon, authenticated;
grant execute on function advance_compliance_states() to service_role;

-- ---------------------------------------------------------------------------
-- Scheduling it
-- ---------------------------------------------------------------------------

-- Supabase ships pg_cron. Enable it under Database → Extensions, then run:
--
--   select cron.schedule(
--     'dept-flow-compliance',
--     '0 1 * * *',                       -- 01:00 UTC, i.e. 02:00 in Lagos
--     $$select advance_compliance_states()$$
--   );
--
-- Running it inside the database is preferable to an HTTP cron hitting the app:
-- one less moving part, no shared secret to leak, and it keeps working when the
-- web deployment is down or being redeployed.
--
-- `/api/cron/compliance` exists as well, for hosts without pg_cron. Both call
-- the same function, and both are safe to run repeatedly — the transitions are
-- idempotent by their own conditions rather than by remembering they ran.

-- Dept-Flow — deciding waivers and resolving disputes
--
-- Both are authority actions in the same shape as a grace period: an actor, a
-- written reason, an audit row. What differs is the consequence.
--
--   A granted waiver clears the student, which confirms every provisional score
--   they hold — identical in effect to a payment, because that is what a waiver
--   IS: the department deciding the money is not owed.
--
--   A corrected dispute changes an attendance percentage after the fact. That
--   is the most consequential write in the system that is not a payment, and it
--   is why the trail matters more here than anywhere else.

-- ---------------------------------------------------------------------------
-- Waivers
-- ---------------------------------------------------------------------------

create or replace function decide_waiver(
  p_waiver_id uuid,
  p_actor_id  uuid,
  p_grant     boolean,
  p_reason    text
)
returns text
language plpgsql
as $$
declare
  v_row       waivers%rowtype;
  v_confirmed integer := 0;
begin
  if p_actor_id is null then
    raise exception 'a waiver decision must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a waiver decision must record why';
  end if;

  select * into v_row from waivers where id = p_waiver_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'pending' then return 'already_decided'; end if;

  update waivers
     set status      = (case when p_grant then 'granted' else 'declined' end)::waiver_status,
         reason      = btrim(p_reason),
         decided_by  = p_actor_id,
         decided_at  = now()
   where id = p_waiver_id;

  -- Granting is not a note on a record: it clears the student, which confirms
  -- every provisional score in one transaction. A waiver that left the marks
  -- provisional would be a kindness that changed nothing.
  if p_grant then
    v_confirmed := clear_student(v_row.student_id, v_row.academic_session_id, 'waiver', p_actor_id);
  end if;

  perform write_audit(
    p_actor_id, 'hod',
    case when p_grant then 'waiver.granted' else 'waiver.declined' end,
    'waivers', p_waiver_id::text, btrim(p_reason),
    jsonb_build_object('student_id', v_row.student_id, 'sessions_confirmed', v_confirmed)
  );

  return case when p_grant then 'granted' else 'declined' end;
end;
$$;

comment on function decide_waiver(uuid, uuid, boolean, text) is
  'Granting clears the student through the same path a payment takes. Declining records the reason and changes nothing else.';

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------

create or replace function resolve_dispute(
  p_dispute_id uuid,
  p_actor_id   uuid,
  p_uphold     boolean,
  p_reason     text
)
returns text
language plpgsql
as $$
declare
  v_row     attendance_disputes%rowtype;
  v_score   numeric;
  v_before  numeric;
begin
  if p_actor_id is null then
    raise exception 'a dispute resolution must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a dispute resolution must record why';
  end if;

  select * into v_row from attendance_disputes where id = p_dispute_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'open' then return 'already_resolved'; end if;

  select score into v_before
  from session_scores
  where student_id = v_row.student_id and session_instance_id = v_row.session_instance_id;

  if not p_uphold then
    -- Correcting means the HOD has decided the student was present. The named
    -- checkpoint is accepted; with no checkpoint named the student disputed the
    -- whole lecture, so every checkpoint of it is.
    --
    -- Upserted rather than inserted: a dispute usually follows a REJECTED
    -- submission, so the row already exists and carries the rejection.
    insert into attendance_marks (student_id, checkpoint_id, accepted, reject_reason, submitted_at)
    select v_row.student_id, cp.id, true, null, now()
    from checkpoints cp
    where cp.session_instance_id = v_row.session_instance_id
      and (v_row.checkpoint_id is null or cp.id = v_row.checkpoint_id)
    on conflict (student_id, checkpoint_id) do update
      set accepted = true, reject_reason = null;

    -- Re-scored through the same function the lecturer's close uses, so a
    -- corrected lecture is scored by the same rules as every other one.
    v_score := resolve_session_score(v_row.student_id, v_row.session_instance_id);
  end if;

  update attendance_disputes
     set status            = (case when p_uphold then 'upheld' else 'corrected' end)::dispute_status,
         resolution_reason = btrim(p_reason),
         resolved_by       = p_actor_id,
         resolved_at       = now()
   where id = p_dispute_id;

  -- The before and after are both recorded. "The score changed" is not a
  -- defensible answer six months later; "it went from 0.5 to 1.0, on this date,
  -- by this person, for this reason" is.
  perform write_audit(
    p_actor_id, 'hod',
    case when p_uphold then 'dispute.upheld' else 'dispute.corrected' end,
    'attendance_disputes', p_dispute_id::text, btrim(p_reason),
    jsonb_build_object(
      'student_id', v_row.student_id,
      'session_instance_id', v_row.session_instance_id,
      'score_before', v_before,
      'score_after', coalesce(v_score, v_before)
    )
  );

  return case when p_uphold then 'upheld' else 'corrected' end;
end;
$$;

comment on function resolve_dispute(uuid, uuid, boolean, text) is
  'Correcting accepts the marks and re-scores through resolve_session_score. Both scores are written to the audit row.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function decide_waiver(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function resolve_dispute(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function decide_waiver(uuid, uuid, boolean, text) to service_role;
grant execute on function resolve_dispute(uuid, uuid, boolean, text) to service_role;
