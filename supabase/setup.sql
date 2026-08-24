-- Dept-Flow — complete schema setup
--
-- Generated from supabase/migrations/. Paste the whole file into the Supabase
-- SQL Editor and run it once, on a fresh project.
--
-- Do not edit by hand: run `npm run build:setup` instead.
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

-- ===========================================================================
-- 20260728001700_waivers_and_disputes.sql
-- ===========================================================================

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

-- ===========================================================================
-- 20260728001800_admin_actions.sql
-- ===========================================================================

-- Dept-Flow — the administrator's authority actions
--
-- Four writes that only the registry side performs. All four follow the shape
-- every other authority action in this schema follows: an actor, a written
-- reason, an audit row, and the rule enforced here rather than in the API, so
-- it holds for anything that ever writes these tables.
--
-- The screens for all four already existed. None of them called anything: the
-- deactivate dialog changed a row in the browser's memory and the student could
-- still log in.

-- ---------------------------------------------------------------------------
-- Deactivating a student
-- ---------------------------------------------------------------------------

-- A soft delete, and the word "delete" is wrong for it in both directions.
-- Nothing is removed — attendance, payments and audit rows all survive, because
-- the commonest reason to look up a withdrawn student is a dispute about the
-- term they were still here for. What stops is the login.
create or replace function deactivate_student(
  p_student_id uuid,
  p_actor_id   uuid,
  p_reason     deactivation_reason,
  p_note       text
)
returns text
language plpgsql
as $$
declare
  v_row students%rowtype;
begin
  if p_actor_id is null then
    raise exception 'a deactivation must record who made it';
  end if;

  -- 'other' already demands a note at the table level. Demanding one for every
  -- reason is the difference between a log that explains itself and a log of
  -- the word "Withdrawn" four hundred times.
  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'a deactivation must record why';
  end if;

  select * into v_row from students where id = p_student_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status = 'deactivated' then return 'already_deactivated'; end if;

  update students
     set status              = 'deactivated',
         deactivation_reason = p_reason,
         deactivation_note   = btrim(p_note),
         deactivated_by      = p_actor_id,
         deactivated_at      = now()
   where id = p_student_id;

  perform write_audit(
    p_actor_id, 'admin', 'student.deactivate', 'students', p_student_id::text, btrim(p_note),
    jsonb_build_object('matric_no', v_row.matric_no, 'reason', p_reason, 'level', v_row.level)
  );

  return 'deactivated';
end;
$$;

comment on function deactivate_student(uuid, uuid, deactivation_reason, text) is
  'Stops the login. Keeps every row. The matric number stays retired rather than being freed for reuse.';

-- Reversible, because the commonest cause of a deactivation is a clerical
-- error and the second commonest is a withdrawal the student then reversed.
create or replace function reactivate_student(
  p_student_id uuid,
  p_actor_id   uuid,
  p_note       text
)
returns text
language plpgsql
as $$
declare
  v_row students%rowtype;
begin
  if p_actor_id is null then
    raise exception 'a reactivation must record who made it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'a reactivation must record why';
  end if;

  select * into v_row from students where id = p_student_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'deactivated' then return 'not_deactivated'; end if;

  update students
     set status              = 'active',
         deactivation_reason = null,
         deactivation_note   = null,
         deactivated_by      = null,
         deactivated_at      = null
   where id = p_student_id;

  -- The old reason is carried into the audit row before it is cleared, so
  -- reactivating does not erase the record of what was undone.
  perform write_audit(
    p_actor_id, 'admin', 'student.reactivate', 'students', p_student_id::text, btrim(p_note),
    jsonb_build_object(
      'matric_no', v_row.matric_no,
      'previous_reason', v_row.deactivation_reason,
      'previous_note', v_row.deactivation_note
    )
  );

  return 'reactivated';
end;
$$;

-- ---------------------------------------------------------------------------
-- Registration disputes
-- ---------------------------------------------------------------------------

-- Someone reports that their matric number was claimed by another person. Two
-- outcomes: the claim was fraudulent and the account is revoked, or it was not
-- and the report is dismissed. Both are decisions and both are written down —
-- a dismissal with no record is how the same student is asked to prove the
-- same thing three times.
create or replace function resolve_registration_dispute(
  p_dispute_id uuid,
  p_actor_id   uuid,
  p_revoke     boolean,
  p_reason     text
)
returns text
language plpgsql
as $$
declare
  v_row      registration_disputes%rowtype;
  v_student  students%rowtype;
  v_revoked  boolean := false;
begin
  if p_actor_id is null then
    raise exception 'a dispute resolution must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a dispute resolution must record why';
  end if;

  select * into v_row from registration_disputes where id = p_dispute_id;

  if v_row.id is null then return 'not_found'; end if;
  if v_row.status <> 'open' then return 'already_resolved'; end if;

  if p_revoke then
    select * into v_student from students where matric_no = v_row.matric_no;

    -- Through deactivate_student rather than by hand. One code path for "how a
    -- student stops being able to log in" means the table's own invariants
    -- cannot drift apart between the two callers, and it writes its own audit
    -- row — so someone asking "why is this account closed?" finds the answer
    -- under `student.deactivate`, where they would look, rather than having to
    -- know that registration revocations record it somewhere else.
    if v_student.id is not null then
      v_revoked := deactivate_student(v_student.id, p_actor_id, 'other', btrim(p_reason)) = 'deactivated';
    end if;

    -- Releasing the register row is the point of revoking. The real student
    -- has to be able to register afterwards, and they cannot while their own
    -- matric number is still marked claimed.
    update whitelist_entries
       set claimed    = false,
           claimed_by = null,
           claimed_at = null
     where matric_no = v_row.matric_no
       and academic_session_id = v_row.academic_session_id;
  end if;

  update registration_disputes
     set status            = (case when p_revoke then 'corrected' else 'upheld' end)::dispute_status,
         resolution_reason = btrim(p_reason),
         resolved_by       = p_actor_id,
         resolved_at       = now()
   where id = p_dispute_id;

  perform write_audit(
    p_actor_id, 'admin',
    case when p_revoke then 'registration.revoke' else 'registration.dispute_dismissed' end,
    'registration_disputes', p_dispute_id::text, btrim(p_reason),
    jsonb_build_object(
      'matric_no', v_row.matric_no,
      'account_revoked', v_revoked,
      'register_row_released', p_revoke
    )
  );

  return case when p_revoke then 'revoked' else 'dismissed' end;
end;
$$;

comment on function resolve_registration_dispute(uuid, uuid, boolean, text) is
  'Revoking deactivates the claiming account AND frees the register row, so the real student can register.';

-- ---------------------------------------------------------------------------
-- Level rollover
-- ---------------------------------------------------------------------------

-- The single most destructive write in the system: it changes the level of
-- every student in the department at once, and level is what decides which
-- courses they are enrolled in.
--
-- Three protections, in order of how much each has to be relied on:
--   1. It refuses to run twice for the same pair of sessions.
--   2. Graduands are marked BEFORE anyone is promoted, so the 400s that leave
--      are the 400s that were there when it started, not the 300s that just
--      arrived. Doing it in the other order graduates the wrong cohort — an
--      error nobody would catch until final results.
--   3. It is one transaction, so a failure halfway leaves no half-promoted
--      department.
create or replace function run_level_rollover(
  p_to_session_id uuid,
  p_actor_id      uuid,
  p_note          text
)
returns table (promoted integer, graduating integer)
language plpgsql
as $$
declare
  v_from       uuid;
  v_promoted   integer;
  v_graduating integer;
begin
  if p_actor_id is null then
    raise exception 'a level rollover must record who ran it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'a level rollover must record why';
  end if;

  select id into v_from from academic_sessions where is_active limit 1;

  if v_from is null then
    raise exception 'there is no active session to roll over from';
  end if;

  if p_to_session_id = v_from then
    raise exception 'a session cannot be rolled over into itself';
  end if;

  if not exists (select 1 from academic_sessions where id = p_to_session_id) then
    raise exception 'the session being rolled into does not exist';
  end if;

  if exists (
    select 1 from level_rollovers
    where from_academic_session_id = v_from and to_academic_session_id = p_to_session_id
  ) then
    raise exception 'this rollover has already been run';
  end if;

  -- Step 1: the leaving cohort, identified before anything moves.
  with graduands as (
    update students
       set status = 'graduating'
     where status = 'active' and level = 400
    returning 1
  )
  select count(*) into v_graduating from graduands;

  -- Step 2: everybody else moves up one level.
  with promotions as (
    update students
       set level = level + 100
     where status = 'active' and level < 400
    returning 1
  )
  select count(*) into v_promoted from promotions;

  -- Step 3: a new session means dues are owed again, so every continuing
  -- student starts it uncleared. Without this they carry no compliance row at
  -- all, and a student with no row is indistinguishable from one who has paid
  -- on any screen that reads the state directly.
  insert into compliance_statuses (student_id, academic_session_id, state)
  select s.id, p_to_session_id, 'uncleared'
  from students s
  where s.status = 'active'
  on conflict (student_id, academic_session_id) do nothing;

  -- Step 4: the new session becomes the current one. Deliberately part of the
  -- same transaction — promoting everyone and then forgetting to switch over
  -- leaves the department at the right levels in the wrong year, which is
  -- harder to detect than either half failing outright.
  update academic_sessions set is_active = false where id = v_from;
  update academic_sessions set is_active = true  where id = p_to_session_id;

  insert into level_rollovers (
    from_academic_session_id, to_academic_session_id,
    students_promoted, students_graduating, run_by, note
  )
  values (v_from, p_to_session_id, v_promoted, v_graduating, p_actor_id, btrim(p_note));

  perform write_audit(
    p_actor_id, 'admin', 'level.rollover', 'academic_sessions', p_to_session_id::text, btrim(p_note),
    jsonb_build_object(
      'from_session', v_from,
      'to_session', p_to_session_id,
      'promoted', v_promoted,
      'graduating', v_graduating
    )
  );

  return query select v_promoted, v_graduating;
end;
$$;

comment on function run_level_rollover(uuid, uuid, text) is
  'Marks graduands first, then promotes, then opens the new session uncleared. Refuses a second run for the same pair.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function deactivate_student(uuid, uuid, deactivation_reason, text) from public, anon, authenticated;
revoke all on function reactivate_student(uuid, uuid, text) from public, anon, authenticated;
revoke all on function resolve_registration_dispute(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function run_level_rollover(uuid, uuid, text) from public, anon, authenticated;

grant execute on function deactivate_student(uuid, uuid, deactivation_reason, text) to service_role;
grant execute on function reactivate_student(uuid, uuid, text) to service_role;
grant execute on function resolve_registration_dispute(uuid, uuid, boolean, text) to service_role;
grant execute on function run_level_rollover(uuid, uuid, text) to service_role;

-- ===========================================================================
-- 20260728001900_schedule_changes.sql
-- ===========================================================================

-- Dept-Flow — cancelling a lecture and scheduling a makeup
--
-- The timetable says a class is *meant* to happen. A `session_instances` row
-- says one *did*. Everything here lives in the gap between those two, which is
-- why cancelling cannot be a delete: there is usually nothing to delete yet.
--
-- Cancelling a future occurrence writes a row that records the absence. That
-- row is what stops the lecture appearing on a student's schedule, and it is
-- also what proves later that the lecture did not go untaught by accident.

-- ---------------------------------------------------------------------------
-- Telling the students
-- ---------------------------------------------------------------------------

-- The schedule screen promises "every enrolled student is notified straight
-- away". Notifying from the database rather than the API keeps that promise
-- attached to the write itself: a caller that cancels a lecture cannot forget
-- the half that students actually experience.
create or replace function notify_enrolled(
  p_course_id uuid,
  p_kind      notification_kind,
  p_title     text,
  p_body      text,
  p_link      text default null
)
returns integer
language plpgsql
as $$
declare
  v_sent integer;
begin
  with sent as (
    insert into notifications (recipient_id, kind, title, body, link)
    select e.student_id, p_kind, p_title, p_body, p_link
    from enrolments e
    where e.course_id = p_course_id
      and e.dropped_at is null
    returning 1
  )
  select count(*) into v_sent from sent;

  return v_sent;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancelling
-- ---------------------------------------------------------------------------

create or replace function cancel_session(
  p_course_id          uuid,
  p_timetable_entry_id uuid,
  p_held_on            date,
  p_actor_id           uuid,
  p_reason             text
)
returns text
language plpgsql
as $$
declare
  v_existing session_instances%rowtype;
  v_entry    timetable_entries%rowtype;
  v_course   courses%rowtype;
  v_id       uuid;
begin
  if p_actor_id is null then
    raise exception 'a cancellation must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a cancellation must record why — students are shown this';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then return 'not_found'; end if;

  -- The service role has bypassed RLS to get here, so ownership is checked
  -- explicitly, exactly as the policy would have.
  if v_course.lecturer_id is distinct from p_actor_id then
    return 'not_your_course';
  end if;

  select * into v_existing
  from session_instances
  where course_id = p_course_id
    and held_on = p_held_on
    and (p_timetable_entry_id is null or timetable_entry_id = p_timetable_entry_id)
  limit 1;

  -- A lecture that was held cannot be un-held. Cancelling it would drop it out
  -- of every enrolled student's denominator and silently move their attendance
  -- percentage — including students who were there.
  if v_existing.id is not null and v_existing.status = 'closed' then
    return 'already_held';
  end if;

  if v_existing.id is not null and v_existing.status = 'open' then
    return 'in_progress';
  end if;

  if v_existing.id is not null and v_existing.status = 'cancelled' then
    return 'already_cancelled';
  end if;

  if v_existing.id is not null then
    update session_instances
       set status              = 'cancelled',
           cancelled_at        = now(),
           cancelled_by        = p_actor_id,
           cancellation_reason = btrim(p_reason)
     where id = v_existing.id
    returning id into v_id;
  else
    -- Nothing exists yet, which is the normal case: instances are created when
    -- a lecturer starts a lecture, so a future occurrence is only a timetable
    -- entry. The venue comes from that entry, since the column is not null and
    -- a cancelled lecture still had a room booked.
    select * into v_entry from timetable_entries where id = p_timetable_entry_id;
    if v_entry.id is null then return 'not_found'; end if;

    insert into session_instances (
      course_id, timetable_entry_id, held_on, scheduled_start, scheduled_end,
      venue_id, type, status, cancelled_at, cancelled_by, cancellation_reason, created_by
    )
    values (
      p_course_id, v_entry.id, p_held_on,
      (p_held_on + v_entry.start_time) at time zone 'Africa/Lagos',
      (p_held_on + v_entry.end_time) at time zone 'Africa/Lagos',
      v_entry.venue_id, 'recurring', 'cancelled', now(), p_actor_id, btrim(p_reason), p_actor_id
    )
    returning id into v_id;
  end if;

  perform notify_enrolled(
    p_course_id, 'schedule_change',
    v_course.code || ' on ' || to_char(p_held_on, 'DD Mon') || ' is cancelled',
    btrim(p_reason),
    '/schedule'
  );

  perform write_audit(
    p_actor_id, 'lecturer', 'session.cancel', 'session_instances', v_id::text, btrim(p_reason),
    jsonb_build_object('course_id', p_course_id, 'held_on', p_held_on)
  );

  return 'cancelled';
end;
$$;

comment on function cancel_session(uuid, uuid, date, uuid, text) is
  'Writes a cancelled instance rather than deleting one. Refuses a lecture that was already held — that would move every student''s percentage.';

-- ---------------------------------------------------------------------------
-- Makeup classes
-- ---------------------------------------------------------------------------

-- A makeup has no timetable entry, which is why `session_timetable_by_type`
-- only demands one for `recurring`. It is a real lecture in every other
-- respect: it counts, it is attended the same way, and it enters the
-- denominator when it is closed.
create or replace function schedule_makeup(
  p_course_id uuid,
  p_held_on   date,
  p_starts    time,
  p_ends      time,
  p_venue_id  uuid,
  p_actor_id  uuid,
  p_note      text
)
returns text
language plpgsql
as $$
declare
  v_course courses%rowtype;
  v_id     uuid;
begin
  if p_actor_id is null then
    raise exception 'a makeup class must record who scheduled it';
  end if;

  if p_held_on < current_date then
    raise exception 'a makeup class cannot be scheduled in the past';
  end if;

  if p_ends <= p_starts then
    raise exception 'a makeup class must end after it starts';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then return 'not_found'; end if;
  if v_course.lecturer_id is distinct from p_actor_id then return 'not_your_course'; end if;

  if not exists (select 1 from venues where id = p_venue_id) then
    return 'no_such_venue';
  end if;

  -- Two lectures for one course in one day is almost always a double-tap on a
  -- phone, not a genuine intention.
  if exists (
    select 1 from session_instances
    where course_id = p_course_id and held_on = p_held_on and status <> 'cancelled'
  ) then
    return 'already_scheduled';
  end if;

  insert into session_instances (
    course_id, held_on, scheduled_start, scheduled_end, venue_id, type, status, created_by
  )
  values (
    p_course_id, p_held_on,
    (p_held_on + p_starts) at time zone 'Africa/Lagos',
    (p_held_on + p_ends) at time zone 'Africa/Lagos',
    p_venue_id, 'makeup', 'scheduled', p_actor_id
  )
  returning id into v_id;

  perform notify_enrolled(
    p_course_id, 'schedule_change',
    'Makeup class for ' || v_course.code,
    to_char(p_held_on, 'Day DD Mon') || ', ' || to_char(p_starts, 'HH24:MI')
      || '–' || to_char(p_ends, 'HH24:MI')
      || coalesce('. ' || nullif(btrim(p_note), ''), ''),
    '/schedule'
  );

  perform write_audit(
    p_actor_id, 'lecturer', 'session.makeup', 'session_instances', v_id::text,
    nullif(btrim(coalesce(p_note, '')), ''),
    jsonb_build_object('course_id', p_course_id, 'held_on', p_held_on)
  );

  return 'scheduled';
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function notify_enrolled(uuid, notification_kind, text, text, text) from public, anon, authenticated;
revoke all on function cancel_session(uuid, uuid, date, uuid, text) from public, anon, authenticated;
revoke all on function schedule_makeup(uuid, date, time, time, uuid, uuid, text) from public, anon, authenticated;

grant execute on function notify_enrolled(uuid, notification_kind, text, text, text) to service_role;
grant execute on function cancel_session(uuid, uuid, date, uuid, text) to service_role;
grant execute on function schedule_makeup(uuid, date, time, time, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Rescheduling
-- ---------------------------------------------------------------------------

-- Cancel-and-replace, in one transaction and with one notification.
--
-- A lecturer could do this in two steps, and the two steps would be correct.
-- What they would not be is atomic: a cancellation that lands while the makeup
-- fails leaves students told a lecture is off with no replacement, and two
-- notifications for one change reads as two changes.
create or replace function reschedule_session(
  p_course_id          uuid,
  p_timetable_entry_id uuid,
  p_from               date,
  p_to                 date,
  p_starts             time,
  p_ends               time,
  p_venue_id           uuid,
  p_actor_id           uuid,
  p_reason             text
)
returns text
language plpgsql
as $$
declare
  v_course   courses%rowtype;
  v_entry    timetable_entries%rowtype;
  v_existing session_instances%rowtype;
  v_id       uuid;
begin
  if p_actor_id is null then
    raise exception 'a reschedule must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reschedule must record why — students are shown this';
  end if;

  if p_to < current_date then
    raise exception 'a lecture cannot be moved into the past';
  end if;

  if p_ends <= p_starts then
    raise exception 'a lecture must end after it starts';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then return 'not_found'; end if;
  if v_course.lecturer_id is distinct from p_actor_id then return 'not_your_course'; end if;

  if not exists (select 1 from venues where id = p_venue_id) then
    return 'no_such_venue';
  end if;

  select * into v_existing
  from session_instances
  where course_id = p_course_id and held_on = p_from
  limit 1;

  if v_existing.id is not null and v_existing.status = 'closed' then
    return 'already_held';
  end if;
  if v_existing.id is not null and v_existing.status = 'open' then
    return 'in_progress';
  end if;

  if exists (
    select 1 from session_instances
    where course_id = p_course_id and held_on = p_to and status <> 'cancelled'
  ) then
    return 'already_scheduled';
  end if;

  -- The original slot is marked cancelled so it disappears from the student's
  -- schedule and cannot be attended. Nothing is deleted: the move stays legible
  -- afterwards, which matters when a student says they went to the old room.
  if v_existing.id is not null then
    update session_instances
       set status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_id,
           cancellation_reason = btrim(p_reason)
     where id = v_existing.id;
  else
    select * into v_entry from timetable_entries where id = p_timetable_entry_id;
    if v_entry.id is null then return 'not_found'; end if;

    insert into session_instances (
      course_id, timetable_entry_id, held_on, scheduled_start, scheduled_end,
      venue_id, type, status, cancelled_at, cancelled_by, cancellation_reason, created_by
    )
    values (
      p_course_id, v_entry.id, p_from,
      (p_from + v_entry.start_time) at time zone 'Africa/Lagos',
      (p_from + v_entry.end_time) at time zone 'Africa/Lagos',
      v_entry.venue_id, 'recurring', 'cancelled', now(), p_actor_id, btrim(p_reason), p_actor_id
    );
  end if;

  insert into session_instances (
    course_id, held_on, scheduled_start, scheduled_end, venue_id, type, status, created_by
  )
  values (
    p_course_id, p_to,
    (p_to + p_starts) at time zone 'Africa/Lagos',
    (p_to + p_ends) at time zone 'Africa/Lagos',
    p_venue_id, 'reschedule', 'scheduled', p_actor_id
  )
  returning id into v_id;

  perform notify_enrolled(
    p_course_id, 'schedule_change',
    v_course.code || ' has moved to ' || to_char(p_to, 'DD Mon'),
    'Was ' || to_char(p_from, 'DD Mon') || '. Now ' || to_char(p_to, 'Day DD Mon')
      || ', ' || to_char(p_starts, 'HH24:MI') || '–' || to_char(p_ends, 'HH24:MI')
      || '. ' || btrim(p_reason),
    '/schedule'
  );

  perform write_audit(
    p_actor_id, 'lecturer', 'session.reschedule', 'session_instances', v_id::text, btrim(p_reason),
    jsonb_build_object('course_id', p_course_id, 'from', p_from, 'to', p_to)
  );

  return 'rescheduled';
end;
$$;

comment on function reschedule_session(uuid, uuid, date, date, time, time, uuid, uuid, text) is
  'Cancel-and-replace in one transaction, with one notification. Two steps would not be atomic.';

revoke all on function reschedule_session(uuid, uuid, date, date, time, time, uuid, uuid, text) from public, anon, authenticated;
grant execute on function reschedule_session(uuid, uuid, date, date, time, time, uuid, uuid, text) to service_role;

-- ===========================================================================
-- 20260728002000_authorize_eligibility.sql
-- ===========================================================================

-- Dept-Flow — authorizing an exam eligibility list
--
-- The department's formal record of who may sit a paper. The screen for it has
-- existed since the first build and did nothing at all: "Authorize list"
-- flipped a variable in the browser and the page went on recomputing from live
-- data, so the "authorized" list changed every time anybody's attendance did.
--
-- Authorizing has to SNAPSHOT. That is the entire point of freezing one: a
-- grace period opened next week, or a dispute corrected next month, must not
-- retroactively alter the list an exam board already sat with. The numbers are
-- copied into eligibility_entries at the moment of authorization and the
-- existing `eligibility_entries_frozen` trigger stops anything touching them
-- afterwards.

create or replace function authorize_eligibility_list(
  p_course_id uuid,
  p_actor_id  uuid,
  p_note      text
)
returns table (eligible integer, not_eligible integer)
language plpgsql
as $$
declare
  v_course    courses%rowtype;
  v_list_id   uuid;
  v_status    eligibility_status;
  v_threshold numeric;
  v_eligible  integer;
  v_total     integer;
begin
  if p_actor_id is null then
    raise exception 'an authorization must record who made it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'an authorization must record why';
  end if;

  if not exists (select 1 from profiles where id = p_actor_id and role = 'hod') then
    raise exception 'only the head of department can authorize an eligibility list';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then
    raise exception 'that course does not exist';
  end if;

  select el.id, el.status, el.threshold_pct
    into v_list_id, v_status, v_threshold
  from eligibility_lists el
  where el.course_id = p_course_id
    and el.academic_session_id = v_course.academic_session_id;

  -- Frozen means frozen. A correction is a NEW list, not an edit to this one,
  -- so that the version the board saw stays recoverable.
  if v_status = 'authorized' then
    return query select 0, 0;
    return;
  end if;

  if v_list_id is null then
    select attendance_threshold_pct into v_threshold from app_config where id = 1;

    insert into eligibility_lists (course_id, academic_session_id, status, threshold_pct)
    values (p_course_id, v_course.academic_session_id, 'draft', coalesce(v_threshold, 75))
    returning id into v_list_id;
  end if;

  -- Any earlier draft rows are replaced rather than added to. A list built
  -- twice must not contain a student twice, and the draft has no standing to
  -- preserve — only the authorized snapshot does.
  delete from eligibility_entries where list_id = v_list_id;

  -- The snapshot, computed through attendance_pct() so the frozen number is
  -- the same number every other screen showed. Dropped enrolments are excluded
  -- but their rows survive, exactly as they do everywhere else.
  insert into eligibility_entries (
    list_id, student_id, attendance_pct, score_total, sessions_held, eligible
  )
  select
    v_list_id,
    e.student_id,
    attendance_pct(e.student_id, p_course_id),
    coalesce((
      select sum(ss.score)
      from session_scores ss
      join session_instances si on si.id = ss.session_instance_id
      where ss.student_id = e.student_id
        and si.course_id = p_course_id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
        and ss.status = 'confirmed'
    ), 0),
    (
      select count(*)
      from session_instances si
      where si.course_id = p_course_id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ),
    -- A course that has held nothing makes nobody eligible and nobody
    -- ineligible; 0 of 0 is not a failure to attend. The list records them as
    -- not eligible rather than inventing a pass, and the count on the screen
    -- says how many lectures it was computed from.
    attendance_pct(e.student_id, p_course_id) >= v_threshold
      and exists (
        select 1 from session_instances si
        where si.course_id = p_course_id and si.status = 'closed'
      )
  from enrolments e
  where e.course_id = p_course_id
    and e.dropped_at is null;

  update eligibility_lists
     set status        = 'authorized',
         authorized_by = p_actor_id,
         authorized_at = now()
   where id = v_list_id;

  select count(*) filter (where ee.eligible), count(*)
    into v_eligible, v_total
  from eligibility_entries ee
  where ee.list_id = v_list_id;

  perform write_audit(
    p_actor_id, 'hod', 'eligibility.authorize', 'eligibility_lists', v_list_id::text, btrim(p_note),
    jsonb_build_object(
      'course_id', p_course_id,
      'course_code', v_course.code,
      'threshold_pct', v_threshold,
      'eligible', v_eligible,
      'not_eligible', v_total - v_eligible
    )
  );

  return query select v_eligible, v_total - v_eligible;
end;
$$;

comment on function authorize_eligibility_list(uuid, uuid, text) is
  'Snapshots every enrolled student''s percentage into eligibility_entries and freezes the list. A correction is a new list, never an edit.';

revoke all on function authorize_eligibility_list(uuid, uuid, text) from public, anon, authenticated;
grant execute on function authorize_eligibility_list(uuid, uuid, text) to service_role;

-- ===========================================================================
-- 20260728002100_schema_report.sql
-- ===========================================================================

-- Dept-Flow — is this database actually up to date?
--
-- The migrations are applied by hand, in the SQL Editor, one file at a time.
-- Missing one is the likeliest way this project breaks, and the symptom is
-- unhelpful: PostgREST answers a call to a function that does not exist with
-- `PGRST202: Could not find the function`, surfaced on screen as "That did not
-- go through."
--
-- This reports what is present so the answer is "you have not run
-- 20260728002000_authorize_eligibility.sql" rather than a shrug.
--
-- SECURITY DEFINER because it reads pg_proc and pg_class, and INVOKER would
-- report only what the caller can see. It is revoked from everyone except
-- service_role, and it takes no arguments — there is nothing to point at
-- another user's data. The schema test asserts that no function reachable by
-- `authenticated` is DEFINER; this one stays out of that set by being granted
-- only to the API.

create or replace function dept_flow_schema_report()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_expected constant text[] := array[
    -- migration → the function it introduced, in the order they must be run
    'attendance_pct', 'clear_student', 'resolve_session_score', 'write_audit',
    'begin_pending_verification', 'lock_after_buffer', 'full_sessions_needed',
    'open_grace_period', 'revoke_grace_period', 'grace_period_impact',
    'is_payment_open', 'advance_compliance_states',
    'decide_waiver', 'resolve_dispute',
    'deactivate_student', 'reactivate_student', 'resolve_registration_dispute',
    'run_level_rollover',
    'cancel_session', 'schedule_makeup', 'reschedule_session', 'notify_enrolled',
    'authorize_eligibility_list',
    'enrol_in_core_courses', 'add_optional_course', 'drop_optional_course',
    'student_credit_units'
  ];
  v_missing_functions text[];
  v_missing_tables    text[];
begin
  select coalesce(array_agg(wanted), '{}')
    into v_missing_functions
  from unnest(v_expected) as wanted
  where not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = wanted
  );

  select coalesce(array_agg(wanted), '{}')
    into v_missing_tables
  from unnest(array[
    'profiles', 'students', 'whitelist_entries', 'academic_sessions', 'courses',
    'enrolments', 'timetable_entries', 'venues', 'session_instances',
    'checkpoints', 'attendance_marks', 'session_scores', 'compliance_statuses',
    'dues_periods', 'payments', 'waivers', 'attendance_disputes',
    'registration_disputes', 'grace_periods', 'eligibility_lists',
    'eligibility_entries', 'notifications', 'audit_log', 'otp_codes',
    'level_rollovers', 'app_config', 'risk_predictions',
    'manual_attendance_batches'
  ]) as wanted
  where to_regclass('public.' || wanted) is null;

  return jsonb_build_object(
    'up_to_date', cardinality(v_missing_functions) = 0 and cardinality(v_missing_tables) = 0,
    'missing_functions', to_jsonb(v_missing_functions),
    'missing_tables', to_jsonb(v_missing_tables),
    'has_venue_directory', to_regclass('public.venue_directory') is not null,
    -- Nothing locks on schedule without this, so a demo that expects a locked
    -- student silently gets none.
    'pg_cron_installed', exists (select 1 from pg_extension where extname = 'pg_cron'),
    'active_session', (select name from academic_sessions where is_active limit 1),
    'dues_period_set', exists (
      select 1 from dues_periods dp
      join academic_sessions s on s.id = dp.academic_session_id
      where s.is_active
    )
  );
end;
$$;

comment on function dept_flow_schema_report() is
  'What /api/health reports. Names the missing pieces so a half-applied migration set is diagnosable.';

revoke all on function dept_flow_schema_report() from public, anon, authenticated;
grant execute on function dept_flow_schema_report() to service_role;

-- ===========================================================================
-- 20260728002200_correction_never_lowers.sql
-- ===========================================================================

-- Dept-Flow — a correction must never lower a score
--
-- Found by rehearsing the demo rather than by reading the code: correcting a
-- dispute took a student from 0.5 to 0.0.
--
-- `resolve_dispute` accepts the disputed marks and then re-scores through
-- `resolve_session_score`, which is right — a corrected lecture should be
-- scored by the same rules as every other one. But the accept step only has
-- something to do when the lecture has `checkpoints` rows. A lecture recorded
-- from a paper register has none, so nothing was accepted, and the re-score
-- computed the student's mark from an empty set of marks: zero.
--
-- The HOD clicked "correct", meaning the student was present. Ending up with
-- less than they started with is the opposite of the instruction, and it is
-- the kind of failure nobody would report because the screen says it worked.

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
  v_row         attendance_disputes%rowtype;
  v_score       numeric;
  v_before      numeric;
  v_checkpoints integer;
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
    select count(*) into v_checkpoints
    from checkpoints where session_instance_id = v_row.session_instance_id;

    if v_checkpoints = 0 then
      -- Nothing to accept and nothing to re-score from — a paper-register
      -- lecture, or one whose checkpoints were never issued. The HOD has said
      -- the student was there for it, and with no checkpoint structure to
      -- apportion, "there" means the whole lecture.
      insert into session_scores (student_id, session_instance_id, score, status, source)
      values (v_row.student_id, v_row.session_instance_id, 1.0, 'provisional', 'manually_entered')
      on conflict (student_id, session_instance_id) do update
        set score = 1.0, source = 'manually_entered';

      v_score := 1.0;
    else
      -- The named checkpoint is accepted; with no checkpoint named the student
      -- disputed the whole lecture, so every checkpoint of it is.
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

      -- The floor. Re-scoring can only be trusted to the extent the marks it
      -- reads are complete, and a correction is an instruction to credit the
      -- student, never to dock them. If the recomputation comes out lower than
      -- what was already recorded, the recomputation is what is wrong.
      if v_before is not null and v_score < v_before then
        update session_scores
           set score = v_before
         where student_id = v_row.student_id
           and session_instance_id = v_row.session_instance_id;

        v_score := v_before;
      end if;
    end if;
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
  'Correcting accepts the marks and re-scores, and can never lower the score. Both figures go to the audit row.';

revoke all on function resolve_dispute(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function resolve_dispute(uuid, uuid, boolean, text) to service_role;

-- ===========================================================================
-- 20260728002300_risk_baseline.sql
-- ===========================================================================

-- Dept-Flow — the advisory signal, computed
--
-- `risk_predictions` has been read by two screens since the first build — the
-- HOD's at-risk list and the student's nudge — and written by nothing except
-- `seed.sql`. Both screens have been showing two numbers somebody typed in by
-- hand. That is the same failure the rest of this branch spent its time
-- removing, one layer further down.
--
-- WHY THIS IS A RULE AND NOT scikit-learn
--
-- The stack names scikit-learn, and the seam for it is real — everything here
-- writes to the same table a model would write to, and every reader is already
-- indifferent to which produced the row. What does not exist is data to train
-- on. At the point this is written the department has one academic session,
-- three students and thirty-one marks. A classifier fitted to that is not a
-- model; it is the training set, memorised.
--
-- So the baseline is a rule, and it is a rule chosen to be explicable to the
-- student it is about: "at the rate you have been attending, you will finish
-- around here." A student who is told they are at risk can be told exactly why,
-- which a fitted model could not have done for its first several years.
--
-- Replace it when there is history to learn from. The contract is this table.
--
-- WHAT IT PREDICTS, AND WHAT IT DELIBERATELY IGNORES
--
-- Attendance behaviour, not compliance. An unpaid student's counted attendance
-- is zero and no prediction is needed to say so — the dashboard banner already
-- does, in plainer words. The useful question is whether they are turning up
-- often enough, which is why every mark counts here regardless of whether it
-- has been paid for.

create or replace function compute_risk_predictions()
returns integer
language plpgsql
as $$
declare
  v_written   integer;
  v_threshold numeric;
begin
  select attendance_threshold_pct into v_threshold from app_config where id = 1;
  v_threshold := coalesce(v_threshold, 75);

  -- Wholesale rather than incremental. A prediction is only ever a statement
  -- about the present, and a stale row for a student who has since turned
  -- things around is worse than no row.
  delete from risk_predictions;

  with attendance as (
    select
      e.student_id,
      e.course_id,
      count(si.id)                                            as held,
      count(ss.id) filter (where ss.score > 0)                as attended,
      count(ss.id) filter (where ss.score = 0.5)              as halves,
      coalesce(sum(ss.score), 0)                              as earned
    from enrolments e
    join session_instances si
      on si.course_id = e.course_id
     and si.status = 'closed'
     and si.held_on >= e.enrolled_on
    left join session_scores ss
      on ss.session_instance_id = si.id
     and ss.student_id = e.student_id
    where e.dropped_at is null
    group by e.student_id, e.course_id
  ),
  scored as (
    select
      student_id,
      course_id,
      held,
      halves,
      held - attended as absent,
      -- "At your current rate." Their rate so far, carried forward — which is
      -- the sentence the screen actually shows, so the number behind it should
      -- be the one that sentence describes.
      round((earned / held) * 100, 2) as predicted_pct
    from attendance
    -- Three lectures is the least that can distinguish a pattern from a bad
    -- morning. Below it the honest output is no prediction at all, which is
    -- why the screens are built to show nothing rather than a placeholder.
    where held >= 3
  )
  insert into risk_predictions (student_id, course_id, predicted_pct, pattern)
  select
    student_id,
    course_id,
    predicted_pct,
    case
      -- A pattern exists to explain why a student is falling short, so a
      -- student who is not falling short does not get one. Labelling somebody
      -- at 75% as "disengaged" because one lecture went badly is the kind of
      -- confident nonsense that teaches people to ignore the screen.
      when predicted_pct >= v_threshold then null
      -- Two ways to fall short, and they need different conversations. A
      -- student who comes and leaves at half time needs telling that the
      -- second checkpoint is half their mark. A student who is not coming at
      -- all needs something else entirely.
      when halves > absent then 'partial_attendance'::risk_pattern
      else 'disengagement'::risk_pattern
    end
  from scored;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

comment on function compute_risk_predictions() is
  'The advisory baseline: attendance rate carried forward. Advisory only — attendance_pct() decides eligibility and never consults this.';

-- ---------------------------------------------------------------------------
-- Refreshed by the same nightly job
-- ---------------------------------------------------------------------------

-- Folded into the existing scheduled call rather than given its own, so there
-- is one thing to schedule and one thing that can fail to be scheduled.
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

  -- Advisory, and deliberately last: a failure to refresh predictions must not
  -- stop the compliance ladder, which is the part with consequences.
  perform compute_risk_predictions();

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

revoke all on function compute_risk_predictions() from public, anon, authenticated;
grant execute on function compute_risk_predictions() to service_role;

-- ===========================================================================
-- 20260728002400_manual_batch.sql
-- ===========================================================================

-- Dept-Flow — the paper register
--
-- The one route into attendance that bypasses every anti-proxy check the
-- system has: no token, no geo-fence, no device heuristic. A lecturer
-- transcribing a sign-in sheet can mark anybody present.
--
-- The screen for it has existed since the first build, complete with its
-- warning and its mandatory justification, and its confirm button closed the
-- dialog and wrote nothing. So the fallback for a network outage did not
-- exist, and the HOD's lecturer-oversight screen — which exists precisely to
-- watch how often this is used — could only ever report zero.
--
-- What makes this a monitored path rather than a silent backdoor is that the
-- batch is a row. `manual_attendance_batches` records who, when, how many and
-- why, and every score it produces carries `manual_batch_id` and
-- `source = 'manually_entered'`, so a mark entered from paper can always be
-- told apart from one a student submitted. None of that is optional here: the
-- batch is created first and the scores are written through it.


-- ---------------------------------------------------------------------------
-- One place decides how a score row is written
-- ---------------------------------------------------------------------------

-- `resolve_session_score` counts accepted checkpoint marks. A paper batch has
-- none — the sheet is the record — so the transcribed score has to be supplied
-- rather than derived.
--
-- Given as an override on the existing function rather than a second function
-- that writes `session_scores` itself. The rule that decides whether a score
-- lands confirmed or provisional lives here, and a paper mark must obey it
-- identically: a transcription for an unpaid student stays provisional,
-- because the fallback is for the network and not for the money. Two functions
-- would be two copies of that rule, and they would drift.
-- Dropped first, and this matters: adding a parameter to a function that has
-- defaults does not replace it, it creates an overload. Both would then match
-- `resolve_session_score(student, session)` and every existing two-argument
-- call — of which there are several, including inside resolve_dispute — would
-- fail with "function is not unique".
drop function if exists resolve_session_score(uuid, uuid, score_source, uuid);

create or replace function resolve_session_score(
  p_student_id uuid,
  p_session_instance_id uuid,
  p_source score_source default 'digital',
  p_manual_batch_id uuid default null,
  p_override_score numeric default null
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

  if p_override_score is not null then
    if p_override_score not in (0, 0.5, 1.0) then
      raise exception 'a score is 0, 0.5 or 1.0 — never anything between';
    end if;
    if v_mode = 'single' and p_override_score = 0.5 then
      raise exception 'a single-checkpoint session cannot score 0.5';
    end if;
    v_score := p_override_score;
  else
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
    p_student_id, p_session_instance_id, v_score, v_status, p_source, p_manual_batch_id,
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

revoke all on function resolve_session_score(uuid, uuid, score_source, uuid, numeric) from public, anon, authenticated;
grant execute on function resolve_session_score(uuid, uuid, score_source, uuid, numeric) to service_role;

create or replace function submit_manual_batch(
  p_session_instance_id uuid,
  p_actor_id            uuid,
  p_justification       text,
  -- [{ "student_id": "...", "score": 1.0 }, ...]
  p_marks               jsonb
)
returns table (recorded integer, batch_id uuid)
language plpgsql
as $$
declare
  v_instance session_instances%rowtype;
  v_course   courses%rowtype;
  v_batch    uuid;
  v_count    integer;
  v_bad      integer;
begin
  if p_actor_id is null then
    raise exception 'a paper batch must record who entered it';
  end if;

  -- Longer than the ten characters every other action asks for. This one is
  -- read by the HOD while deciding whether a lecturer is leaning on the paper
  -- route, and "network" is not an account of anything.
  if length(btrim(coalesce(p_justification, ''))) < 20 then
    raise exception 'a paper batch must explain why the normal route could not be used';
  end if;

  select * into v_instance from session_instances where id = p_session_instance_id;
  if v_instance.id is null then return query select 0, null::uuid; return; end if;

  select * into v_course from courses where id = v_instance.course_id;
  if v_course.lecturer_id is distinct from p_actor_id then
    raise exception 'that is not your course';
  end if;

  if v_instance.status = 'cancelled' then
    raise exception 'that lecture was cancelled';
  end if;

  -- Every student in the batch must actually be on the course. Without this a
  -- mistyped id silently awards attendance on a course the student never took,
  -- and it would be discovered at the exam board.
  select count(*) into v_bad
  from jsonb_array_elements(p_marks) as m
  where not exists (
    select 1 from enrolments e
    where e.student_id = (m->>'student_id')::uuid
      and e.course_id = v_instance.course_id
      and e.dropped_at is null
  );

  if v_bad > 0 then
    raise exception 'the batch names % students who are not enrolled in this course', v_bad;
  end if;

  -- The batch row first, so nothing can be written that is not attributable to
  -- it. A score tagged `manually_entered` with no batch behind it would be an
  -- untraceable mark, which is the exact thing this table exists to prevent.
  insert into manual_attendance_batches (
    session_instance_id, submitted_by, justification_note, row_count
  )
  values (
    p_session_instance_id, p_actor_id, btrim(p_justification),
    (select count(*) from jsonb_array_elements(p_marks) as m where (m->>'score')::numeric > 0)
  )
  returning id into v_batch;

  -- Through resolve_session_score, so a paper mark is scored, confirmed and
  -- gated on dues by exactly the same rules as a digital one. A paper entry for
  -- an unpaid student stays provisional — the fallback is for the network, not
  -- for the money.
  select count(*) into v_count
  from jsonb_array_elements(p_marks) as m,
  lateral (
    select resolve_session_score(
      (m->>'student_id')::uuid,
      p_session_instance_id,
      'manually_entered'::score_source,
      v_batch,
      (m->>'score')::numeric
    )
  ) as scored
  where (m->>'score')::numeric > 0;

  -- A lecture recorded on paper is closed by that act. Leaving it open would
  -- let the digital path overwrite the transcription afterwards.
  if v_instance.status <> 'closed' then
    update session_instances
       set status = 'closed',
           closed_at = now(),
           checkpoint_mode = coalesce(checkpoint_mode, 'pair')
     where id = p_session_instance_id;
  end if;

  perform write_audit(
    p_actor_id, 'lecturer', 'manual_batch.submit',
    'manual_attendance_batches', v_batch::text, btrim(p_justification),
    jsonb_build_object(
      'session_instance_id', p_session_instance_id,
      'course_code', v_course.code,
      'held_on', v_instance.held_on,
      'students_marked', v_count
    )
  );

  return query select v_count, v_batch;
end;
$$;

comment on function submit_manual_batch(uuid, uuid, text, jsonb) is
  'The paper fallback. Creates the batch first so no manually-entered score can exist without one, and scores through resolve_session_score so paper marks obey the same rules.';

revoke all on function submit_manual_batch(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function submit_manual_batch(uuid, uuid, text, jsonb) to service_role;

-- ===========================================================================
-- 20260728002500_exam_permits.sql
-- ===========================================================================

-- Dept-Flow — the exam permit
--
-- The document a student carries into the hall. It is the end of every path in
-- this system: dues cleared, attendance counted, the list authorized.
--
-- IT READS THE AUTHORIZED LIST, NEVER LIVE ATTENDANCE
--
-- This is the whole design. A permit computed from current attendance could
-- disagree with the list the exam board sat with — a student who clears their
-- dues the week after authorization would print a permit saying they may sit a
-- paper the department's own record says they may not. The system would have
-- forged it itself.
--
-- So a course appears on a permit only when its eligibility list is
-- `authorized` and the snapshot inside it marks the student eligible. Before
-- the HOD authorizes, there is no permit — not an empty one, and not a
-- provisional one. The department has not decided yet, and saying otherwise on
-- a printed document is worse than saying nothing.

create table exam_permits (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  -- Printed on the document and typed into the public check page by whoever is
  -- holding it. Unguessable, because holding the reference is what stands in
  -- for holding the permit.
  reference           text not null unique,
  issued_at           timestamptz not null default now(),

  unique (student_id, academic_session_id),
  constraint permit_reference_format check (reference ~ '^DF-[0-9]{4}-[A-Z0-9]{6}$')
);

create index exam_permits_student_idx on exam_permits (student_id);

alter table exam_permits enable row level security;

-- A student reads their own; governance reads all. Nobody writes through the
-- policy — issuing goes through the function below.
create policy exam_permits_self_read on exam_permits
  for select to authenticated
  using (student_id = auth.uid());

create policy exam_permits_governance_read on exam_permits
  for select to authenticated
  using (is_hod() or is_admin());

-- ---------------------------------------------------------------------------
-- Issuing
-- ---------------------------------------------------------------------------

-- Idempotent: a student who downloads the permit three times gets one
-- reference, because the reference is the identity of the permit rather than
-- of the download. Re-issuing a new one each time would make every previously
-- printed copy unverifiable.
create or replace function issue_exam_permit(
  p_student_id          uuid,
  p_academic_session_id uuid
)
returns text
language plpgsql
as $$
declare
  v_reference text;
  v_eligible  integer;
  v_year      text;
begin
  select reference into v_reference
  from exam_permits
  where student_id = p_student_id and academic_session_id = p_academic_session_id;

  if v_reference is not null then
    return v_reference;
  end if;

  -- No authorized list marking them eligible for anything means no permit.
  select count(*) into v_eligible
  from eligibility_entries ee
  join eligibility_lists el on el.id = ee.list_id
  where ee.student_id = p_student_id
    and el.academic_session_id = p_academic_session_id
    and el.status = 'authorized'
    and ee.eligible;

  if v_eligible = 0 then
    return null;
  end if;

  select left(regexp_replace(name, '[^0-9]', '', 'g'), 4)
    into v_year
  from academic_sessions where id = p_academic_session_id;

  -- Retried rather than trusted: six characters from a 32-symbol alphabet is
  -- ample, but a collision must fail the download rather than hand two
  -- students one reference.
  for i in 1..10 loop
    v_reference := 'DF-' || coalesce(nullif(v_year, ''), '0000') || '-' ||
      upper(
        translate(
          substr(encode(gen_random_bytes(8), 'base64'), 1, 6),
          -- Removing the characters a person copying by hand confuses.
          '+/OIL01', 'XYZWVUT'
        )
      );

    begin
      insert into exam_permits (student_id, academic_session_id, reference)
      values (p_student_id, p_academic_session_id, v_reference);
      return v_reference;
    exception when unique_violation then
      -- Another download of the same permit won the race: return theirs.
      select reference into v_reference
      from exam_permits
      where student_id = p_student_id and academic_session_id = p_academic_session_id;
      if v_reference is not null then return v_reference; end if;
    end;
  end loop;

  raise exception 'could not allocate a permit reference';
end;
$$;

comment on function issue_exam_permit(uuid, uuid) is
  'One reference per student per session, allocated once. Returns null when no authorized list marks them eligible for anything.';

-- ---------------------------------------------------------------------------
-- Verifying
-- ---------------------------------------------------------------------------

-- For whoever is holding the paper — an invigilator at the hall door. Returns
-- the least that answers "is this real and what does it entitle them to":
-- the name, the matric number, and the papers. No attendance percentages, no
-- dues history, no phone number. A permit check is not a records request.
create or replace function verify_exam_permit(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_permit exam_permits%rowtype;
  v_result jsonb;
begin
  select * into v_permit from exam_permits where reference = upper(btrim(p_reference));

  if v_permit.id is null then
    return jsonb_build_object('found', false);
  end if;

  select jsonb_build_object(
    'found', true,
    'reference', v_permit.reference,
    'issued_at', v_permit.issued_at,
    'matric_no', s.matric_no,
    'name', display_name_register(p.surname, p.first_name, p.other_names),
    'level', s.level,
    'session', a.name,
    -- Deactivated after the permit was issued: the document is genuine and the
    -- account is not. An invigilator needs to be told, rather than shown a
    -- valid-looking permit.
    'account_active', s.status <> 'deactivated',
    'courses', coalesce((
      select jsonb_agg(c.code order by c.code)
      from eligibility_entries ee
      join eligibility_lists el on el.id = ee.list_id
      join courses c on c.id = el.course_id
      where ee.student_id = v_permit.student_id
        and el.academic_session_id = v_permit.academic_session_id
        and el.status = 'authorized'
        and ee.eligible
    ), '[]'::jsonb)
  )
  into v_result
  from students s
  join profiles p on p.id = s.id
  join academic_sessions a on a.id = v_permit.academic_session_id
  where s.id = v_permit.student_id;

  return v_result;
end;
$$;

comment on function verify_exam_permit(text) is
  'Public permit check. Returns the name, matric number and papers — never percentages or dues history.';

revoke all on function issue_exam_permit(uuid, uuid) from public, anon, authenticated;
revoke all on function verify_exam_permit(text) from public, anon, authenticated;
grant execute on function issue_exam_permit(uuid, uuid) to service_role;
grant execute on function verify_exam_permit(text) to service_role;

-- ===========================================================================
-- 20260823000100_trust_based_attendance.sql
-- ===========================================================================

-- Dept-Flow — attendance becomes trust-based
--
-- The supervisor's revised operational flow drops location enforcement
-- entirely: "logs PRESENT — no GPS, no distance calculation, no spoofing
-- detection". What replaces it as the thing that makes attendance mean
-- something is not a better fence but a different question — the system stops
-- trying to catch the student who is lying about being in the hall and starts
-- making sure the student who is not in the hall knows what it is costing
-- them. That is migration ..._risk_forecast, not this one. This one takes the
-- enforcement out.
--
-- What goes, and why each one goes rather than being left inert:
--
--   the geo-fence          venues.centre_lat/lng/radius_m, attendance_marks'
--                          coordinates and derived distance, the retention
--                          window and the purge job that served them. Dead
--                          columns holding real students' coordinates are
--                          worse than no columns: the retention promise in
--                          docs/decisions.md is enforced by a job, and a job
--                          nobody runs any more is a promise nobody keeps.
--
--   the anti-proxy         students.device_id and the flagged_for_review pair
--                          on a mark. Device correlation is spoofing detection
--                          by another name.
--
--   the checkpoint pair    two tokens per lecture, and with it the 0.5 score.
--                          The new flow issues one code at the start of the
--                          session, so a lecture is present or absent. Marks
--                          already sitting at 0.5 are rounded UP: the student
--                          answered one of the two codes, which under the new
--                          rule is a student who was there.
--
-- `checkpoints` keeps its table name. It now holds exactly one row per
-- lecture — the attendance code — and renaming it would touch two hundred
-- references across the app, the seed and the schema tests without changing
-- what any of them do. The constraint below is what carries the meaning.

-- ---------------------------------------------------------------------------
-- The student's own view of their marks, out of the way
-- ---------------------------------------------------------------------------

-- `my_attendance_marks` selects both the rejection reason and the checkpoint
-- index, and this migration changes the type of one and drops the other. A
-- view holds a hard dependency on the columns it names, so it comes down first
-- and goes back up at the bottom of the file.
drop view if exists my_attendance_marks;

-- ---------------------------------------------------------------------------
-- Rejection reasons: what the student can now be told
-- ---------------------------------------------------------------------------

-- Two of the five reasons described a check that no longer runs. Postgres
-- cannot drop a value from an enum in place, so the type is rebuilt and the
-- retired reasons fold into the generic one — a historical rejection is still
-- a rejection, and the HOD reading it back needs it to resolve to something.
alter type mark_reject_reason rename to mark_reject_reason_retired;

create type mark_reject_reason as enum (
  'invalid_or_expired_token',
  -- New, and the one that carries the weight now: registration is the gate.
  'not_registered',
  'account_locked',
  'already_submitted'
);

alter table attendance_marks
  alter column reject_reason type mark_reject_reason
  using (
    case reject_reason::text
      when 'outside_geofence'  then 'invalid_or_expired_token'
      when 'failed_anti_spoof' then 'invalid_or_expired_token'
      else reject_reason::text
    end
  )::mark_reject_reason;

drop type mark_reject_reason_retired;

-- ---------------------------------------------------------------------------
-- The purge job goes before the columns it purged
-- ---------------------------------------------------------------------------

drop function if exists purge_expired_coordinates();

-- ---------------------------------------------------------------------------
-- Coordinates, distance and the device heuristic
-- ---------------------------------------------------------------------------

drop index if exists attendance_marks_flagged_idx;
drop index if exists attendance_marks_purge_idx;

alter table attendance_marks
  drop constraint if exists mark_lat_range,
  drop constraint if exists mark_lng_range,
  drop constraint if exists mark_purge_clears_coordinates,
  drop constraint if exists mark_flag_has_reason;

alter table attendance_marks
  drop column if exists gps_lat,
  drop column if exists gps_lng,
  drop column if exists gps_accuracy_m,
  drop column if exists distance_m,
  drop column if exists coordinates_purged_at,
  drop column if exists flagged_for_review,
  drop column if exists flag_reason,
  drop column if exists device_id;

comment on table attendance_marks is
  'One submission attempt per student per lecture. Rejections are kept because the student can dispute them. Nothing here records where the student was.';

drop index if exists students_device_idx;

alter table students
  drop column if exists device_id;

-- ---------------------------------------------------------------------------
-- Venues stop being secret
-- ---------------------------------------------------------------------------

-- `venue_directory` existed because a student who could read the fence centre
-- and radius knew exactly how far from the hall they could stand. With no
-- fence there is nothing on a venue to hide, but the view stays: every screen
-- reads through it, and it is now simply the venue list.
alter table venues
  drop constraint if exists venue_lat_range,
  drop constraint if exists venue_lng_range,
  drop constraint if exists venue_radius_range;

alter table venues
  drop column if exists centre_lat,
  drop column if exists centre_lng,
  drop column if exists radius_m,
  drop column if exists boundary;

comment on table venues is
  'Where a lecture is held. Names only — the geo-fence it used to carry was removed with location enforcement.';

comment on view venue_directory is
  'Venue id and name. Kept as the read path every screen already uses; there is no longer anything on venues it withholds.';

-- ---------------------------------------------------------------------------
-- Configuration for checks that no longer run
-- ---------------------------------------------------------------------------

alter table app_config
  drop constraint if exists app_config_retention_range,
  drop constraint if exists app_config_radius_range;

alter table app_config
  drop column if exists gps_retention_days,
  drop column if exists default_geofence_radius_m;

-- ---------------------------------------------------------------------------
-- One code per lecture
-- ---------------------------------------------------------------------------

-- The scoring trigger reads session_instances.checkpoint_mode, so it goes
-- before the column does.
drop trigger if exists session_scores_single_checkpoint_check on session_scores;
drop function if exists enforce_single_checkpoint_scoring();

alter table session_instances
  drop constraint if exists session_closed_has_mode;

-- A closed lecture still has to say when it closed; what it no longer has to
-- say is how many tokens were issued, because the answer is always one.
alter table session_instances
  add constraint session_closed_has_timestamp check (
    status <> 'closed' or closed_at is not null
  );

alter table session_instances
  drop column if exists checkpoint_mode;

drop type if exists checkpoint_mode;

-- Collapse any lecture that issued two codes onto the first. Second-code marks
-- are re-pointed rather than deleted: a student who answered only the second
-- code was present, and dropping the row would mark them absent.
--
-- A student holding a rejected first mark and an accepted second one is the
-- case that needs care — `unique (student_id, checkpoint_id)` would block the
-- re-point and leave the rejection standing as the whole record. The rejected
-- one goes first so the accepted one can take its place.
delete from attendance_marks losing
 using checkpoints one, checkpoints two, attendance_marks winning
 where losing.checkpoint_id = one.id
   and one.index = 1
   and not losing.accepted
   and two.session_instance_id = one.session_instance_id
   and two.index = 2
   and winning.checkpoint_id = two.id
   and winning.student_id = losing.student_id
   and winning.accepted;

update attendance_marks am
   set checkpoint_id = keep.id
  from checkpoints two
  join checkpoints keep
    on keep.session_instance_id = two.session_instance_id
   and keep.index = 1
 where am.checkpoint_id = two.id
   and two.index = 2
   and not exists (
     select 1 from attendance_marks prior
     where prior.student_id = am.student_id
       and prior.checkpoint_id = keep.id
   );

delete from attendance_marks am
 using checkpoints two
 where am.checkpoint_id = two.id
   and two.index = 2;

delete from checkpoints where index = 2;

alter table checkpoints
  drop constraint if exists checkpoints_session_instance_id_index_key,
  drop constraint if exists checkpoint_index_valid;

alter table checkpoints
  drop column if exists index;

alter table checkpoints
  add constraint checkpoints_one_per_session unique (session_instance_id);

comment on table checkpoints is
  'The attendance code: one short-lived 4-digit code per lecture, issued at the start and written on the board. Rotating an expired code updates this row rather than adding one.';

-- ---------------------------------------------------------------------------
-- A lecture is attended or it is not
-- ---------------------------------------------------------------------------

-- Half marks only ever meant "answered one of two codes". Rounded up, for the
-- reason in the header: under the new rule that student was in the room.
update session_scores set score = 1.0 where score = 0.5;

alter table session_scores
  drop constraint if exists score_value_valid;

alter table session_scores
  add constraint score_value_valid check (score in (0, 1.0));

comment on column session_scores.score is
  'Present (1.0) or absent (0). The 0.5 that a half-answered checkpoint pair used to earn went with the pair.';

-- ---------------------------------------------------------------------------
-- Scoring, without the pair
-- ---------------------------------------------------------------------------

-- Same signature as the version in ..._manual_batch.sql, so every existing
-- caller — resolve_dispute and submit_manual_batch among them — keeps working.
-- Two things change: a score is derived from "did an accepted mark exist"
-- rather than from counting two of them, and the readiness check moves from
-- checkpoint_mode (dropped above) to the lecture's own status.
create or replace function resolve_session_score(
  p_student_id uuid,
  p_session_instance_id uuid,
  p_source score_source default 'digital',
  p_manual_batch_id uuid default null,
  p_override_score numeric default null
)
returns numeric
language plpgsql
as $$
declare
  v_status_of_lecture session_instance_status;
  v_accepted      integer;
  v_score         numeric(2,1);
  v_status        score_status;
  v_academic_session uuid;
  v_compliance    compliance_state;
begin
  select si.status, c.academic_session_id
    into v_status_of_lecture, v_academic_session
  from session_instances si
  join courses c on c.id = si.course_id
  where si.id = p_session_instance_id;

  if v_status_of_lecture is null then
    raise exception 'no such lecture';
  end if;

  if v_status_of_lecture <> 'closed' then
    raise exception 'cannot score a session that has not closed';
  end if;

  if p_override_score is not null then
    if p_override_score not in (0, 1.0) then
      raise exception 'a lecture is attended (1.0) or it is not (0)';
    end if;
    v_score := p_override_score;
  else
    select count(*)
      into v_accepted
    from attendance_marks am
    join checkpoints cp on cp.id = am.checkpoint_id
    where am.student_id = p_student_id
      and cp.session_instance_id = p_session_instance_id
      and am.accepted;

    v_score := case when v_accepted >= 1 then 1.0 else 0 end;
  end if;

  -- Unchanged here, and removed one migration later: ..._payment_decoupled
  -- takes dues out of the counting rule entirely. Left in place for now so
  -- this migration is exactly one change.
  select cs.state into v_compliance
  from compliance_statuses cs
  where cs.student_id = p_student_id
    and cs.academic_session_id = v_academic_session;

  v_status := case when v_compliance = 'cleared' then 'confirmed' else 'provisional' end;

  insert into session_scores (
    student_id, session_instance_id, score, status, source, manual_batch_id, confirmed_at
  )
  values (
    p_student_id, p_session_instance_id, v_score, v_status, p_source, p_manual_batch_id,
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

revoke all on function resolve_session_score(uuid, uuid, score_source, uuid, numeric)
  from public, anon, authenticated;
grant execute on function resolve_session_score(uuid, uuid, score_source, uuid, numeric)
  to service_role;

comment on function resolve_session_score(uuid, uuid, score_source, uuid, numeric) is
  'One lecture, one student, present or absent. Derived from accepted marks unless a paper batch supplies the score.';

-- ---------------------------------------------------------------------------
-- The paper register, which wrote to a column that is now gone
-- ---------------------------------------------------------------------------

-- `submit_manual_batch` closed a transcribed lecture with
-- `checkpoint_mode = coalesce(checkpoint_mode, 'pair')`. That column has just
-- been dropped, and a plpgsql body is not checked until it runs, so leaving it
-- would have made the outage fallback fail at the exact moment it is needed.
--
-- Reordered as well as repaired. It used to score every student and then close
-- the lecture, which worked only because readiness was judged by
-- `checkpoint_mode` — a value the caller had already set. Readiness is now the
-- lecture's own status, so the close has to come first. That is the truer
-- order regardless: a lecture recorded on paper is closed by the act of
-- recording it, and scoring a lecture that is still open was always a
-- contradiction.
create or replace function submit_manual_batch(
  p_session_instance_id uuid,
  p_actor_id            uuid,
  p_justification       text,
  p_marks               jsonb
)
returns table (recorded integer, batch_id uuid)
language plpgsql
as $$
declare
  v_instance session_instances%rowtype;
  v_course   courses%rowtype;
  v_batch    uuid;
  v_count    integer;
  v_bad      integer;
begin
  if p_actor_id is null then
    raise exception 'a paper batch must record who entered it';
  end if;

  if length(btrim(coalesce(p_justification, ''))) < 20 then
    raise exception 'a paper batch must explain why the normal route could not be used';
  end if;

  select * into v_instance from session_instances where id = p_session_instance_id;
  if v_instance.id is null then return query select 0, null::uuid; return; end if;

  select * into v_course from courses where id = v_instance.course_id;
  if v_course.lecturer_id is distinct from p_actor_id then
    raise exception 'that is not your course';
  end if;

  if v_instance.status = 'cancelled' then
    raise exception 'that lecture was cancelled';
  end if;

  select count(*) into v_bad
  from jsonb_array_elements(p_marks) as m
  where not exists (
    select 1 from enrolments e
    where e.student_id = (m->>'student_id')::uuid
      and e.course_id = v_instance.course_id
      and e.dropped_at is null
  );

  if v_bad > 0 then
    raise exception 'the batch names % students who are not enrolled in this course', v_bad;
  end if;

  -- Closed before anything is scored, for the reason in the header.
  if v_instance.status <> 'closed' then
    update session_instances
       set status = 'closed',
           closed_at = coalesce(closed_at, now())
     where id = p_session_instance_id;
  end if;

  -- The batch row next, so nothing can be written that is not attributable to
  -- it. A score tagged `manually_entered` with no batch behind it would be an
  -- untraceable mark, which is the exact thing this table exists to prevent.
  insert into manual_attendance_batches (
    session_instance_id, submitted_by, justification_note, row_count
  )
  values (
    p_session_instance_id, p_actor_id, btrim(p_justification),
    (select count(*) from jsonb_array_elements(p_marks) as m where (m->>'score')::numeric > 0)
  )
  returning id into v_batch;

  -- Through resolve_session_score, so a paper mark obeys the same rules as a
  -- digital one rather than a second copy of them.
  select count(*) into v_count
  from jsonb_array_elements(p_marks) as m,
  lateral (
    select resolve_session_score(
      (m->>'student_id')::uuid,
      p_session_instance_id,
      'manually_entered'::score_source,
      v_batch,
      (m->>'score')::numeric
    )
  ) as scored
  where (m->>'score')::numeric > 0;

  perform write_audit(
    p_actor_id, 'lecturer', 'manual_batch.submit',
    'manual_attendance_batches', v_batch::text, btrim(p_justification),
    jsonb_build_object(
      'session_instance_id', p_session_instance_id,
      'course_code', v_course.code,
      'held_on', v_instance.held_on,
      'students_marked', v_count
    )
  );

  return query select v_count, v_batch;
end;
$$;

revoke all on function submit_manual_batch(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function submit_manual_batch(uuid, uuid, text, jsonb) to service_role;

comment on function submit_manual_batch(uuid, uuid, text, jsonb) is
  'The paper fallback. Closes the lecture, creates the batch, then scores through resolve_session_score so paper marks obey the same rules.';

-- ---------------------------------------------------------------------------
-- The student's own view of their marks, rebuilt
-- ---------------------------------------------------------------------------

-- Same view minus `checkpoint_index`, which no longer distinguishes anything:
-- there is one code per lecture, so the session instance identifies the mark.
create view my_attendance_marks
with (security_invoker = true)
as
  select
    am.id,
    am.checkpoint_id,
    cp.session_instance_id,
    am.accepted,
    am.reject_reason,
    am.submitted_at
  from attendance_marks am
  join checkpoints cp on cp.id = am.checkpoint_id
  where am.student_id = auth.uid();

grant select on my_attendance_marks to authenticated;

comment on view my_attendance_marks is
  'A student''s own submission attempts, accepted or not. Never held coordinates; now there are none to hold.';

-- ===========================================================================
-- 20260823000200_registration_gate.sql
-- ===========================================================================

-- Dept-Flow — semester registration becomes the gate
--
-- Something has to decide whether a lecture counts against a student, and
-- until now that was dues. The revised flow moves it: registration is the
-- gate, payment runs alongside and touches nothing here.
--
-- Registration was already half of this. A student picked electives and
-- carry-overs and the rows landed in `enrolments` as they clicked, which meant
-- there was no moment at which a student had *finished* registering — and so
-- no deadline that could mean anything, nothing to remind an unregistered
-- student about, and no answer to "were you registered when that lecture was
-- held". This migration supplies the moment.
--
-- Three pieces:
--
--   the window        an admin-set period per semester. Registration confirms
--                     inside it; attendance is ungated until it closes.
--
--   the confirmation  draft → confirmed, once, with `registered_at` stamped by
--                     the DATABASE. A client-supplied time is the difference
--                     between a deadline and a suggestion.
--
--   the backfill      a student who confirms late is marked ABSENT for every
--                     lecture held between the deadline and the moment they
--                     confirmed. Without it, registering in week eight is
--                     strictly better than registering on time, because the
--                     denominator only starts when you join.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- Two states and no third. "Partially registered" is what the old model had by
-- accident, and it is what this exists to remove.
create type registration_status as enum ('draft', 'confirmed');

-- ---------------------------------------------------------------------------
-- The window
-- ---------------------------------------------------------------------------

-- Per semester, not per session: a student registers twice a year, and the
-- second window has nothing to do with the first one's deadline.
create table registration_periods (
  id                  uuid primary key default gen_random_uuid(),
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  semester            smallint not null,
  opens_on            date not null,
  closes_on           date not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (academic_session_id, semester),
  constraint registration_semester_valid check (semester in (1, 2)),
  constraint registration_window_ordered check (closes_on >= opens_on)
);

create trigger registration_periods_updated_at
  before update on registration_periods
  for each row execute function set_updated_at();

comment on table registration_periods is
  'When students may confirm their courses. After closes_on, an unconfirmed student cannot record attendance.';

-- ---------------------------------------------------------------------------
-- The confirmation
-- ---------------------------------------------------------------------------

create table course_registrations (
  id                  uuid primary key default gen_random_uuid(),
  student_id          uuid not null references students (id) on delete cascade,
  academic_session_id uuid not null references academic_sessions (id) on delete cascade,
  semester            smallint not null,
  status              registration_status not null default 'draft',
  -- Written by confirm_registration() and by nothing else. Never accepted from
  -- a caller: the backfill is measured from this, so a client that could set it
  -- could erase its own absences.
  registered_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (student_id, academic_session_id, semester),
  constraint course_registration_semester_valid check (semester in (1, 2)),
  constraint course_registration_confirmed_is_stamped check (
    (status = 'confirmed' and registered_at is not null) or
    (status = 'draft' and registered_at is null)
  )
);

create index course_registrations_session_idx
  on course_registrations (academic_session_id, semester, status);

create trigger course_registrations_updated_at
  before update on course_registrations
  for each row execute function set_updated_at();

comment on column course_registrations.registered_at is
  'Server-stamped at confirmation. The backfill window runs from the deadline to this instant.';

-- ---------------------------------------------------------------------------
-- The registration exception
-- ---------------------------------------------------------------------------

-- The doc calls for the grace-period mechanism, repointed at registration and
-- narrowed to one student. Grace periods already suspend a consequence without
-- rewriting the state it came from, which is exactly the shape wanted here, so
-- this widens that table rather than adding a parallel one with the same
-- audit trail bolted on.
--
-- Rebuilt rather than extended. `alter type ... add value` cannot be followed
-- by a use of that value in the same transaction — Postgres rejects it as
-- "unsafe use of new value" — and setup.sql is a single paste into the SQL
-- Editor, which runs it as one. The check constraint below and
-- attendance_eligibility() both name 'student', so the extend-in-place form
-- worked from psql and failed for the one person following the setup guide.
alter type grace_scope rename to grace_scope_old;

create type grace_scope as enum ('department', 'level', 'student');

-- The two functions that take the type in their signature have to go before it
-- does; ..._grace_periods.sql created them and they are recreated below
-- against the new type, unchanged apart from the scope they can now be given.
drop function if exists grace_period_impact(uuid, grace_scope_old, integer);
drop function if exists open_grace_period(uuid, grace_scope_old, integer, date, text, uuid);

-- `grace_level_scope` compares scope against a literal, and that literal was
-- bound to the type when the constraint was created — it now reads as
-- grace_scope_old. Changing the column type re-validates the constraint, which
-- fails with "operator does not exist: grace_scope = grace_scope_old". So it
-- comes down first and goes back up below, widened for the new scope.
alter table grace_periods
  drop constraint if exists grace_level_scope;

alter table grace_periods
  alter column scope type grace_scope using scope::text::grace_scope;

drop type grace_scope_old;

alter table grace_periods
  add column student_id uuid references students (id) on delete cascade;

-- A department-wide period names neither a level nor a student; a level one
-- names a level; an individual exception names exactly one student. Enforced
-- here so a scope and its target cannot disagree.
alter table grace_periods
  add constraint grace_scope_targets check (
    (scope = 'department' and level is null and student_id is null) or
    (scope = 'level' and level in (100, 200, 300, 400) and student_id is null) or
    (scope = 'student' and level is null and student_id is not null)
  );

create index grace_periods_student_idx on grace_periods (student_id)
  where student_id is not null;

comment on column grace_periods.student_id is
  'Set only when scope is student — the HOD''s individual registration exception.';

-- ---------------------------------------------------------------------------
-- The two functions, rebuilt against the new type
-- ---------------------------------------------------------------------------

-- Repointed as well as rebuilt. Both used to answer a question about dues:
-- how many students are locked out of counted attendance until they pay, and
-- how many marks they have waiting. Neither question survives — payment stops
-- gating attendance one migration from here — so the impact figure is now the
-- one the HOD is actually weighing when they grant an exception: how many
-- students cannot record attendance at all because the deadline passed
-- without them confirming.
create or replace function grace_period_impact(
  p_academic_session_id uuid,
  p_scope grace_scope,
  p_level integer default null,
  p_student_id uuid default null
)
returns table (students_affected integer, sessions_waiting numeric)
language sql
stable
as $$
  with covered as (
    select s.id as student_id
    from students s
    where s.status <> 'deactivated'
      and (
        p_scope = 'department'
        or (p_scope = 'level' and s.level = p_level)
        or (p_scope = 'student' and s.id = p_student_id)
      )
      -- Unconfirmed in every semester whose window has closed. A student who
      -- registered is not affected by an exception and must not be counted as
      -- though they were.
      and exists (
        select 1
        from registration_periods rp
        where rp.academic_session_id = p_academic_session_id
          and rp.closes_on < current_date
          and not exists (
            select 1 from course_registrations cr
            where cr.student_id = s.id
              and cr.academic_session_id = p_academic_session_id
              and cr.semester = rp.semester
              and cr.status = 'confirmed'
          )
      )
  )
  select
    (select count(*)::integer from covered),
    -- Lectures they stand to be marked absent for while they remain shut out.
    -- The number that makes the decision concrete rather than procedural.
    coalesce((
      select count(*)::numeric
      from session_instances si
      join courses c on c.id = si.course_id
      join enrolments e on e.course_id = c.id and e.dropped_at is null
      where c.academic_session_id = p_academic_session_id
        and si.status = 'closed'
        and e.student_id in (select student_id from covered)
    ), 0);
$$;

comment on function grace_period_impact(uuid, grace_scope, integer, uuid) is
  'How many students an exception would let back in, and how many lectures they are shut out of. Counts registration, not dues.';

create or replace function open_grace_period(
  p_academic_session_id uuid,
  p_scope grace_scope,
  p_level integer,
  p_expires_on date,
  p_reason text,
  p_actor_id uuid,
  p_student_id uuid default null
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
    raise exception 'a registration exception must record who opened it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a registration exception must record why it was opened';
  end if;

  if p_scope = 'student' and p_student_id is null then
    raise exception 'an individual exception must name the student it is for';
  end if;

  -- A date in the past would read as an active exception that admits nobody.
  if p_expires_on <= current_date then
    raise exception 'a registration exception must expire in the future';
  end if;

  -- One at a time per scope. Two overlapping periods make "when does this end"
  -- unanswerable, which is the only question a student under one will ask. A
  -- per-student exception collides only with another for the same student, or
  -- with a wider one that already covers them.
  if exists (
    select 1 from grace_periods g
    left join students s on s.id = p_student_id
    where g.academic_session_id = p_academic_session_id
      and g.revoked_at is null
      and g.expires_on >= current_date
      and (
        g.scope = 'department'
        or p_scope = 'department'
        or (g.scope = 'level' and p_scope = 'level' and g.level = p_level)
        or (g.scope = 'level' and p_scope = 'student' and g.level = s.level)
        or (g.scope = 'student' and p_scope = 'level' and g.student_id in (
              select id from students where level = p_level))
        or (g.scope = 'student' and p_scope = 'student' and g.student_id = p_student_id)
      )
  ) then
    raise exception 'an exception covering these students is already open';
  end if;

  select students_affected, sessions_waiting
    into v_students, v_waiting
  from grace_period_impact(p_academic_session_id, p_scope, p_level, p_student_id);

  insert into grace_periods (
    academic_session_id, scope, level, student_id, expires_on, reason,
    granted_by, students_affected, sessions_waiting
  )
  values (
    p_academic_session_id, p_scope,
    case when p_scope = 'level' then p_level end,
    case when p_scope = 'student' then p_student_id end,
    p_expires_on, btrim(p_reason),
    p_actor_id, coalesce(v_students, 0), coalesce(round(v_waiting), 0)
  )
  returning id into v_id;

  perform write_audit(
    p_actor_id, 'hod', 'grace_period.opened', 'grace_periods', v_id::text, btrim(p_reason),
    jsonb_build_object(
      'scope', p_scope,
      'level', p_level,
      'student_id', p_student_id,
      'expires_on', p_expires_on,
      'students_affected', coalesce(v_students, 0)
    )
  );

  return v_id;
end;
$$;

revoke all on function open_grace_period(uuid, grace_scope, integer, date, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function open_grace_period(uuid, grace_scope, integer, date, text, uuid, uuid)
  to service_role;

revoke all on function grace_period_impact(uuid, grace_scope, integer, uuid) from public, anon;
grant execute on function grace_period_impact(uuid, grace_scope, integer, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Is the window open?
-- ---------------------------------------------------------------------------

create or replace function is_registration_open(
  p_academic_session_id uuid,
  p_semester smallint
)
returns boolean
language sql
stable
as $$
  -- No window configured means no deadline has arrived, so registration is
  -- open. Failing the other way would bar a whole department from recording
  -- attendance because a row was never inserted.
  select coalesce(
    (select current_date <= rp.closes_on
       from registration_periods rp
      where rp.academic_session_id = p_academic_session_id
        and rp.semester = p_semester),
    true
  );
$$;

comment on function is_registration_open(uuid, smallint) is
  'Open when today is within the window, or when no window is configured. Absence of a deadline is not a deadline that has passed.';

-- ---------------------------------------------------------------------------
-- May this student record attendance on this course?
-- ---------------------------------------------------------------------------

-- Returns the reason rather than a boolean, because every rejection the
-- student can meet has its own message on screen and a generic failure
-- generates disputes. The values line up with `mark_reject_reason`.
create or replace function attendance_eligibility(
  p_student_id uuid,
  p_course_id uuid
)
returns text
language plpgsql
stable
as $$
declare
  v_student   students%rowtype;
  v_course    courses%rowtype;
  v_enrolled  boolean;
  v_confirmed boolean;
begin
  select * into v_student from students where id = p_student_id;
  if v_student.id is null or v_student.status = 'deactivated' then
    return 'account_locked';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then
    return 'not_registered';
  end if;

  select exists (
    select 1 from enrolments e
    where e.student_id = p_student_id
      and e.course_id = p_course_id
      and e.dropped_at is null
  ) into v_enrolled;

  if not v_enrolled then
    return 'not_registered';
  end if;

  -- Inside the window a student is still assembling their list, and the core
  -- courses they were enrolled in automatically are real. Barring them from
  -- attendance during the very days they are meant to be registering would
  -- punish them for the department's calendar.
  if is_registration_open(v_course.academic_session_id, v_course.semester) then
    return 'ok';
  end if;

  select exists (
    select 1 from course_registrations cr
    where cr.student_id = p_student_id
      and cr.academic_session_id = v_course.academic_session_id
      and cr.semester = v_course.semester
      and cr.status = 'confirmed'
  ) into v_confirmed;

  if v_confirmed then
    return 'ok';
  end if;

  -- The HOD's exception, for the student whose case is genuine and whose
  -- deadline has gone.
  if exists (
    select 1 from grace_periods g
    where g.academic_session_id = v_course.academic_session_id
      and g.revoked_at is null
      and g.expires_on >= current_date
      and (
        g.scope = 'department'
        or (g.scope = 'level' and g.level = v_student.level)
        or (g.scope = 'student' and g.student_id = p_student_id)
      )
  ) then
    return 'ok';
  end if;

  return 'not_registered';
end;
$$;

comment on function attendance_eligibility(uuid, uuid) is
  'Why a student may or may not record attendance on a course. Values match mark_reject_reason so the screen can say something specific.';

revoke all on function attendance_eligibility(uuid, uuid) from public, anon;
grant execute on function attendance_eligibility(uuid, uuid) to authenticated, service_role;
grant execute on function is_registration_open(uuid, smallint) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Confirming, and the backfill that goes with it
-- ---------------------------------------------------------------------------

-- The one write that ends registration. Deliberately not a plain UPDATE from
-- the API: the timestamp, the back-dating and the absence rows all have to
-- happen together or the student's percentage is wrong in whichever direction
-- the partial failure left it.
create or replace function confirm_registration(
  p_student_id uuid,
  p_academic_session_id uuid,
  p_semester smallint
)
returns table (status text, courses_registered integer, absences_backfilled integer)
language plpgsql
as $$
declare
  v_existing  course_registrations%rowtype;
  v_deadline  date;
  v_now       timestamptz := now();
  v_courses   integer;
  v_absences  integer := 0;
begin
  if not exists (select 1 from students where id = p_student_id) then
    return query select 'no_such_student', 0, 0; return;
  end if;

  select * into v_existing
  from course_registrations
  where student_id = p_student_id
    and academic_session_id = p_academic_session_id
    and semester = p_semester;

  if v_existing.status = 'confirmed' then
    -- Idempotent, and deliberately so: a double-tapped button must not run the
    -- backfill twice or re-stamp a registration that already has a time.
    return query select 'already_confirmed', 0, 0; return;
  end if;

  select count(*)::integer into v_courses
  from enrolments e
  join courses c on c.id = e.course_id
  where e.student_id = p_student_id
    and e.dropped_at is null
    and c.academic_session_id = p_academic_session_id
    and c.semester = p_semester;

  if v_courses = 0 then
    -- Confirming an empty list is not a registration; it is a student who has
    -- not started. Saying so is more useful than recording it.
    return query select 'no_courses', 0, 0; return;
  end if;

  insert into course_registrations (
    student_id, academic_session_id, semester, status, registered_at
  )
  values (p_student_id, p_academic_session_id, p_semester, 'confirmed', v_now)
  on conflict (student_id, academic_session_id, semester) do update
    set status = 'confirmed', registered_at = v_now;

  select closes_on into v_deadline
  from registration_periods
  where academic_session_id = p_academic_session_id and semester = p_semester;

  -- On time, or no deadline was ever set: nothing to backfill, and the
  -- student's own join dates stand.
  if v_deadline is null or v_now::date <= v_deadline then
    return query select 'confirmed', v_courses, 0; return;
  end if;

  -- Late. Two halves, and both are needed.
  --
  -- First, back-date the denominator to the deadline. `attendance_pct` counts
  -- lectures held while the student was enrolled, so a row created in week
  -- eight carries a denominator that starts in week eight — and the absence
  -- rows written below would sit outside it, counting for nothing. Only rows
  -- that joined AFTER the deadline move; a student who added a carry-over in
  -- good time keeps the date they actually joined.
  update enrolments e
     set enrolled_on = v_deadline
    from courses c
   where c.id = e.course_id
     and e.student_id = p_student_id
     and e.dropped_at is null
     and c.academic_session_id = p_academic_session_id
     and c.semester = p_semester
     and e.enrolled_on > v_deadline;

  -- Second, the absences themselves: every lecture that actually ran in the
  -- window they missed by not registering. Only closed lectures — one that was
  -- cancelled did not happen, and one still open has not finished.
  --
  -- Written through resolve_session_score() rather than inserted here. That
  -- function owns what a score row looks like: it derives 0 from the absence of
  -- any accepted mark, and it decides the status and the confirmation
  -- timestamp. Inserting directly meant restating those rules, and the first
  -- attempt restated them wrong — a status of 'confirmed' with no
  -- `confirmed_at`, which the schema refused. One rule, one place.
  --
  -- Lectures the student already has a score for are skipped rather than
  -- re-scored: the backfill fills gaps, it does not overwrite a record of
  -- attendance.
  select count(*)::integer into v_absences
  from (
    select si.id
    from enrolments e
    join courses c on c.id = e.course_id
    join session_instances si on si.course_id = c.id
    where e.student_id = p_student_id
      and e.dropped_at is null
      and c.academic_session_id = p_academic_session_id
      and c.semester = p_semester
      and si.status = 'closed'
      and si.held_on > v_deadline
      and si.held_on <= v_now::date
      and not exists (
        select 1 from session_scores ss
        where ss.student_id = p_student_id
          and ss.session_instance_id = si.id
      )
  ) as missed,
  lateral (select resolve_session_score(p_student_id, missed.id)) as scored;

  return query select 'confirmed_late', v_courses, v_absences;
end;
$$;

comment on function confirm_registration(uuid, uuid, smallint) is
  'Ends registration for one student and semester. Stamps the time server-side, back-dates the denominator to the deadline and writes an absence for every lecture missed since it.';

revoke all on function confirm_registration(uuid, uuid, smallint) from public, anon, authenticated;
grant execute on function confirm_registration(uuid, uuid, smallint) to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table registration_periods  enable row level security;
alter table course_registrations  enable row level security;

-- The deadline is not a secret; every student needs to see it, and a student
-- who cannot read it is a student who finds out by being turned away.
create policy registration_periods_read on registration_periods
  for select to authenticated using (true);

create policy course_registrations_self_read on course_registrations
  for select to authenticated using (student_id = auth.uid());

create policy course_registrations_staff_read on course_registrations
  for select to authenticated using (is_hod() or is_admin());

-- Writes go through confirm_registration() under the service role. Nothing
-- here grants a student the ability to stamp their own registration time.

-- ===========================================================================
-- 20260823000300_payment_decoupled.sql
-- ===========================================================================

-- Dept-Flow — payment stops gating attendance
--
-- "Runs in parallel to everything above — paying dues no longer affects
-- whether a student can log attendance."
--
-- That sentence deletes the mechanism this system was built around. A score
-- used to be written PROVISIONAL and only counted once the student cleared,
-- which is why `clear_student()` flipped every row in one transaction and why
-- the student dashboard led with a banner explaining that their attendance was
-- recorded but worth nothing. Registration is the gate now; dues are a debt.
--
-- So `score_status` goes. Not left as a column that is always 'confirmed' —
-- a status with one value is a reader's trap, and the first person to see it
-- will assume the other value is reachable and write a query that filters on
-- it. Every score counts, and `attendance_pct` says so by not mentioning it.
--
-- What arrives in its place is the rest of §8, none of which the old
-- flat-paid-or-not model could express:
--
--   partial payments    a running balance rather than a boolean. Students pay
--                       dues in instalments; a schema that cannot hold that
--                       forces the office back into a notebook.
--   idempotency         Paystack resends webhooks. A resent event must not
--                       credit an account twice.
--   integrity           duplicate references, one card funding several matric
--                       numbers, amounts that are not the dues figure.
--   reversals           a chargeback re-opens the debt WITH NOTICE rather than
--                       silently revoking a clearance.
--   the manual route    a receipt upload and an admin approval, for the day
--                       the gateway is simply down. Flagged as such forever.

-- ---------------------------------------------------------------------------
-- Every recorded lecture counts
-- ---------------------------------------------------------------------------

-- Order matters: the view reads the column, the constraints reference it, and
-- the functions are replaced further down.
drop view if exists my_attendance_marks;

alter table session_scores
  drop constraint if exists score_confirmed_has_timestamp;

drop index if exists session_scores_provisional_idx;
drop index if exists session_scores_student_idx;

alter table session_scores
  drop column if exists status,
  drop column if exists confirmed_at;

create index session_scores_student_idx on session_scores (student_id);

drop type if exists score_status;

comment on table session_scores is
  'One lecture, one student, present or absent. Every row counts — whether the student has paid is a separate question with separate consequences.';

-- The formula, with the clause that made payment matter taken out of it. The
-- denominator is unchanged: lectures held while the student was on the course.
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
  )
  select case
           when held.n = 0 then 0::numeric
           else round(earned.total / held.n * 100, 2)
         end
  from held, earned;
$$;

comment on function attendance_pct(uuid, uuid) is
  'The exam-eligibility formula. Lectures attended over lectures held while the student was enrolled. Dues do not appear in it.';

-- Scoring, without the compliance lookup that used to decide the status.
create or replace function resolve_session_score(
  p_student_id uuid,
  p_session_instance_id uuid,
  p_source score_source default 'digital',
  p_manual_batch_id uuid default null,
  p_override_score numeric default null
)
returns numeric
language plpgsql
as $$
declare
  v_status_of_lecture session_instance_status;
  v_accepted integer;
  v_score    numeric(2,1);
begin
  select si.status into v_status_of_lecture
  from session_instances si
  where si.id = p_session_instance_id;

  if v_status_of_lecture is null then
    raise exception 'no such lecture';
  end if;

  if v_status_of_lecture <> 'closed' then
    raise exception 'cannot score a session that has not closed';
  end if;

  if p_override_score is not null then
    if p_override_score not in (0, 1.0) then
      raise exception 'a lecture is attended (1.0) or it is not (0)';
    end if;
    v_score := p_override_score;
  else
    select count(*)
      into v_accepted
    from attendance_marks am
    join checkpoints cp on cp.id = am.checkpoint_id
    where am.student_id = p_student_id
      and cp.session_instance_id = p_session_instance_id
      and am.accepted;

    v_score := case when v_accepted >= 1 then 1.0 else 0 end;
  end if;

  insert into session_scores (
    student_id, session_instance_id, score, source, manual_batch_id
  )
  values (p_student_id, p_session_instance_id, v_score, p_source, p_manual_batch_id)
  on conflict (student_id, session_instance_id) do update
    set score           = excluded.score,
        source          = excluded.source,
        manual_batch_id = excluded.manual_batch_id;

  return v_score;
end;
$$;

revoke all on function resolve_session_score(uuid, uuid, score_source, uuid, numeric)
  from public, anon, authenticated;
grant execute on function resolve_session_score(uuid, uuid, score_source, uuid, numeric)
  to service_role;

-- ---------------------------------------------------------------------------
-- Clearing, which no longer touches attendance
-- ---------------------------------------------------------------------------

-- Kept, because clearing is still a real event with a route and an actor and
-- an audit trail. What it no longer does is reach into `session_scores`. The
-- return value goes with the reaching: there is nothing to count.
create or replace function clear_student(
  p_student_id uuid,
  p_academic_session_id uuid,
  p_route clearance_route,
  p_actor_id uuid default null
)
returns integer
language plpgsql
as $$
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

  -- Zero, always. The signature is kept so every existing caller still
  -- compiles; the number it used to return was "sessions counted by this
  -- clearance", and no clearance counts a session any more.
  return 0;
end;
$$;

comment on function clear_student(uuid, uuid, clearance_route, uuid) is
  'Marks dues cleared. Touches no attendance: since payment was decoupled, clearing counts nothing that was not already counted.';

-- ---------------------------------------------------------------------------
-- The two other functions that read the status
-- ---------------------------------------------------------------------------

-- Both are plpgsql or SQL bodies referring to `ss.status`, and neither is
-- checked until it runs. Left alone they would fail the first time the HOD
-- authorized a list or corrected a dispute — the two moments in this system
-- with the least tolerance for a runtime error.

-- The eligibility list's score total. Copied verbatim from
-- ..._authorize_eligibility.sql with ONE clause removed — the `ss.status =
-- 'confirmed'` that no longer has a column behind it. Deliberately verbatim:
-- the first attempt rewrote the function from its description and quietly lost
-- the threshold snapshot, the frozen-list guard and half the audit metadata.
-- A function you are replacing to change one line is not a function you are
-- redesigning.
create or replace function authorize_eligibility_list(
  p_course_id uuid,
  p_actor_id  uuid,
  p_note      text
)
returns table (eligible integer, not_eligible integer)
language plpgsql
as $$
declare
  v_course    courses%rowtype;
  v_list_id   uuid;
  v_status    eligibility_status;
  v_threshold numeric;
  v_eligible  integer;
  v_total     integer;
begin
  if p_actor_id is null then
    raise exception 'an authorization must record who made it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'an authorization must record why';
  end if;

  if not exists (select 1 from profiles where id = p_actor_id and role = 'hod') then
    raise exception 'only the head of department can authorize an eligibility list';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then
    raise exception 'that course does not exist';
  end if;

  select el.id, el.status, el.threshold_pct
    into v_list_id, v_status, v_threshold
  from eligibility_lists el
  where el.course_id = p_course_id
    and el.academic_session_id = v_course.academic_session_id;

  -- Frozen means frozen. A correction is a NEW list, not an edit to this one,
  -- so that the version the board saw stays recoverable.
  if v_status = 'authorized' then
    return query select 0, 0;
    return;
  end if;

  if v_list_id is null then
    select attendance_threshold_pct into v_threshold from app_config where id = 1;

    insert into eligibility_lists (course_id, academic_session_id, status, threshold_pct)
    values (p_course_id, v_course.academic_session_id, 'draft', coalesce(v_threshold, 75))
    returning id into v_list_id;
  end if;

  -- Any earlier draft rows are replaced rather than added to. A list built
  -- twice must not contain a student twice, and the draft has no standing to
  -- preserve — only the authorized snapshot does.
  delete from eligibility_entries where list_id = v_list_id;

  -- The snapshot, computed through attendance_pct() so the frozen number is
  -- the same number every other screen showed. Dropped enrolments are excluded
  -- but their rows survive, exactly as they do everywhere else.
  insert into eligibility_entries (
    list_id, student_id, attendance_pct, score_total, sessions_held, eligible
  )
  select
    v_list_id,
    e.student_id,
    attendance_pct(e.student_id, p_course_id),
    coalesce((
      select sum(ss.score)
      from session_scores ss
      join session_instances si on si.id = ss.session_instance_id
      where ss.student_id = e.student_id
        and si.course_id = p_course_id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ), 0),
    (
      select count(*)
      from session_instances si
      where si.course_id = p_course_id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ),
    -- A course that has held nothing makes nobody eligible and nobody
    -- ineligible; 0 of 0 is not a failure to attend. The list records them as
    -- not eligible rather than inventing a pass, and the count on the screen
    -- says how many lectures it was computed from.
    attendance_pct(e.student_id, p_course_id) >= v_threshold
      and exists (
        select 1 from session_instances si
        where si.course_id = p_course_id and si.status = 'closed'
      )
  from enrolments e
  where e.course_id = p_course_id
    and e.dropped_at is null;

  update eligibility_lists
     set status        = 'authorized',
         authorized_by = p_actor_id,
         authorized_at = now()
   where id = v_list_id;

  select count(*) filter (where ee.eligible), count(*)
    into v_eligible, v_total
  from eligibility_entries ee
  where ee.list_id = v_list_id;

  perform write_audit(
    p_actor_id, 'hod', 'eligibility.authorize', 'eligibility_lists', v_list_id::text, btrim(p_note),
    jsonb_build_object(
      'course_id', p_course_id,
      'course_code', v_course.code,
      'threshold_pct', v_threshold,
      'eligible', v_eligible,
      'not_eligible', v_total - v_eligible
    )
  );

  return query select v_eligible, v_total - v_eligible;
end;
$$;

revoke all on function authorize_eligibility_list(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function authorize_eligibility_list(uuid, uuid, text) to service_role;

-- Correcting a dispute writes a score row directly when the lecture has no
-- attendance code to re-derive one from. Copied verbatim from
-- ..._correction_never_lowers.sql with ONE change: the insert loses the status
-- column and its value. Same discipline as above — the first attempt rewrote
-- it from memory and invented a column that has never existed.
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
  v_row         attendance_disputes%rowtype;
  v_score       numeric;
  v_before      numeric;
  v_checkpoints integer;
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
    select count(*) into v_checkpoints
    from checkpoints where session_instance_id = v_row.session_instance_id;

    if v_checkpoints = 0 then
      -- Nothing to accept and nothing to re-score from — a paper-register
      -- lecture, or one whose checkpoints were never issued. The HOD has said
      -- the student was there for it, and with no checkpoint structure to
      -- apportion, "there" means the whole lecture.
      insert into session_scores (student_id, session_instance_id, score, source)
      values (v_row.student_id, v_row.session_instance_id, 1.0, 'manually_entered')
      on conflict (student_id, session_instance_id) do update
        set score = 1.0, source = 'manually_entered';

      v_score := 1.0;
    else
      -- The named checkpoint is accepted; with no checkpoint named the student
      -- disputed the whole lecture, so every checkpoint of it is.
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

      -- The floor. Re-scoring can only be trusted to the extent the marks it
      -- reads are complete, and a correction is an instruction to credit the
      -- student, never to dock them. If the recomputation comes out lower than
      -- what was already recorded, the recomputation is what is wrong.
      if v_before is not null and v_score < v_before then
        update session_scores
           set score = v_before
         where student_id = v_row.student_id
           and session_instance_id = v_row.session_instance_id;

        v_score := v_before;
      end if;
    end if;
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

revoke all on function resolve_dispute(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function resolve_dispute(uuid, uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- Money owed, and money paid
-- ---------------------------------------------------------------------------

-- Instalments. `payment_matches_dues()` compared one payment against the whole
-- figure, which forces every student to pay in one go or be permanently short.
create or replace function dues_paid_kobo(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns double precision
language sql
stable
as $$
  select coalesce(sum(p.amount_kobo), 0)::double precision
  from payments p
  where p.student_id = p_student_id
    and p.academic_session_id = p_academic_session_id
    and p.status = 'success';
$$;

create or replace function dues_balance_kobo(
  p_student_id uuid,
  p_academic_session_id uuid
)
returns double precision
language sql
stable
as $$
  select greatest(
    0,
    coalesce((select dp.dues_amount_kobo from dues_periods dp
               where dp.academic_session_id = p_academic_session_id), 0)
      - dues_paid_kobo(p_student_id, p_academic_session_id)
  )::double precision;
$$;

comment on function dues_balance_kobo(uuid, uuid) is
  'What is still owed, in kobo. Floors at zero: an overpayment is a refund conversation, not a negative debt the screens have to render.';

grant execute on function dues_paid_kobo(uuid, uuid) to authenticated, service_role;
grant execute on function dues_balance_kobo(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A resent webhook must not credit twice
-- ---------------------------------------------------------------------------

-- Paystack retries. The reference is unique on `payments`, which stops a
-- second row, but not a second CREDIT against the existing one — and with
-- instalments summing to a balance, a double credit is now a student who
-- appears to have paid twice what they did.
create table payment_events (
  -- Paystack's own event id. Primary key, so the second delivery of the same
  -- event is refused by the database rather than by a check somebody
  -- remembered to write.
  event_id      text primary key,
  event_type    text not null,
  reference     text not null,
  payment_id    uuid references payments (id) on delete set null,
  payload       jsonb not null default '{}'::jsonb,
  received_at   timestamptz not null default now()
);

create index payment_events_reference_idx on payment_events (reference, received_at desc);

comment on table payment_events is
  'Every webhook Paystack has delivered, keyed on its own event id. Inserting is how a duplicate delivery is detected.';

-- ---------------------------------------------------------------------------
-- What a payment now carries
-- ---------------------------------------------------------------------------

alter table payments
  -- Paystack's card fingerprint. The same physical card across several matric
  -- numbers is the anomaly worth seeing, and it cannot be seen without this.
  add column card_signature   text,
  add column last4            text,
  -- The manual route: a receipt, an approver, and a permanent mark that this
  -- was not verified by the gateway.
  add column manually_verified boolean not null default false,
  add column verified_by       uuid references profiles (id),
  add column verification_note text,
  add column receipt_url       text,
  add column reversed_at       timestamptz,
  add column reversal_reason   text;

-- The existing constraint requires a verified_at on every success. A manually
-- verified payment has no Paystack verification to point at, so it stamps
-- verified_at itself and records who decided — the check below is what makes
-- "manually verified" mean a person rather than a missing field.
alter table payments
  add constraint payment_manual_names_approver check (
    not manually_verified
    or (verified_by is not null and length(btrim(coalesce(verification_note, ''))) >= 10)
  ),
  add constraint payment_reversal_has_reason check (
    reversed_at is null or length(btrim(coalesce(reversal_reason, ''))) > 0
  );

comment on column payments.manually_verified is
  'True when an admin accepted a receipt rather than Paystack confirming it. Never cleared: the record of how this was accepted outlives the office that accepted it.';

-- ---------------------------------------------------------------------------
-- The integrity check
-- ---------------------------------------------------------------------------

-- Three anomalies, from §8: a reference recorded more than once, one card
-- funding several different matric numbers, and an amount that is not the
-- dues figure. None of them is proof of anything — a family sharing a card is
-- ordinary — so this returns rows for a human to look at and blocks nothing.
create or replace function payment_anomalies(p_academic_session_id uuid)
returns table (
  kind        text,
  detail      text,
  reference   text,
  student_id  uuid,
  matric_no   text,
  amount_kobo double precision,
  seen_at     timestamptz
)
language sql
stable
as $$
  with dues as (
    select dues_amount_kobo from dues_periods where academic_session_id = p_academic_session_id
  ),
  mine as (
    select p.*, s.matric_no
    from payments p
    join students s on s.id = p.student_id
    where p.academic_session_id = p_academic_session_id
  )
  -- One card, several matric numbers.
  select
    'shared_card',
    format('Card ending %s funded %s different matric numbers',
           coalesce(m.last4, '????'),
           (select count(distinct m2.student_id) from mine m2
             where m2.card_signature = m.card_signature)),
    m.paystack_reference, m.student_id, m.matric_no, m.amount_kobo, m.initialized_at
  from mine m
  where m.card_signature is not null
    and (select count(distinct m2.student_id) from mine m2
          where m2.card_signature = m.card_signature) > 1

  union all

  -- An amount that is not the dues figure and does not close a balance
  -- either. An instalment is fine; a payment for an amount nobody asked for
  -- is worth a look.
  select
    'unexpected_amount',
    format('Paid %s kobo against a dues figure of %s',
           m.amount_kobo::bigint, (select dues_amount_kobo from dues)::bigint),
    m.paystack_reference, m.student_id, m.matric_no, m.amount_kobo, m.initialized_at
  from mine m
  where m.status = 'success'
    and (select dues_amount_kobo from dues) is not null
    and m.amount_kobo > (select dues_amount_kobo from dues)

  union all

  -- A reversal is not an anomaly in itself, but it is always worth the
  -- office's attention: the debt reopened and the student may not know.
  select
    'reversed',
    coalesce(m.reversal_reason, 'Reversed by the gateway'),
    m.paystack_reference, m.student_id, m.matric_no, m.amount_kobo, m.reversed_at
  from mine m
  where m.reversed_at is not null;
$$;

comment on function payment_anomalies(uuid) is
  'Flags for a human to judge, never a block. A family sharing one card is ordinary; the same card across ten matric numbers is not.';

revoke all on function payment_anomalies(uuid) from public, anon;
grant execute on function payment_anomalies(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Recording a payment, from whichever route
-- ---------------------------------------------------------------------------

-- One place decides what a successful payment does, so the gateway route and
-- the receipt route cannot drift. Clearing is a consequence of the BALANCE
-- reaching zero rather than of any single payment matching the dues figure,
-- which is what makes instalments work.
create or replace function apply_payment(
  p_payment_id uuid,
  p_actor_id   uuid default null
)
returns text
language plpgsql
as $$
declare
  v_payment payments%rowtype;
  v_balance double precision;
begin
  select * into v_payment from payments where id = p_payment_id;
  if v_payment.id is null then return 'not_found'; end if;
  if v_payment.status <> 'success' then return 'not_successful'; end if;

  v_balance := dues_balance_kobo(v_payment.student_id, v_payment.academic_session_id);

  if v_balance > 0 then
    -- Part paid. Deliberately NOT a compliance state of its own: the ladder
    -- has five states and inventing a sixth for "halfway" would be a hard-rule
    -- violation. The balance is the fact; the screens read it directly.
    return 'part_paid';
  end if;

  perform clear_student(
    v_payment.student_id,
    v_payment.academic_session_id,
    case when v_payment.manually_verified then 'hod_clearance' else 'payment' end::clearance_route,
    case when v_payment.manually_verified then p_actor_id end
  );

  return 'cleared';
end;
$$;

revoke all on function apply_payment(uuid, uuid) from public, anon, authenticated;
grant execute on function apply_payment(uuid, uuid) to service_role;

comment on function apply_payment(uuid, uuid) is
  'What a successful payment does. Clears only when the BALANCE reaches zero, so instalments accumulate instead of each one failing to match the dues figure.';

-- ---------------------------------------------------------------------------
-- A reversal reopens the debt, with notice
-- ---------------------------------------------------------------------------

-- Never a silent revoke. The student believed they had paid, and the first
-- they hear of a chargeback must not be an exam hall.
create or replace function reverse_payment(
  p_payment_id uuid,
  p_reason     text,
  p_actor_id   uuid default null
)
returns text
language plpgsql
as $$
declare
  v_payment payments%rowtype;
  v_balance double precision;
begin
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reversal must record why';
  end if;

  select * into v_payment from payments where id = p_payment_id;
  if v_payment.id is null then return 'not_found'; end if;
  if v_payment.reversed_at is not null then return 'already_reversed'; end if;

  update payments
     set status          = 'reversed',
         reversed_at     = now(),
         reversal_reason = btrim(p_reason),
         verified_at     = null
   where id = p_payment_id;

  v_balance := dues_balance_kobo(v_payment.student_id, v_payment.academic_session_id);

  -- Back to uncleared only if the reversal actually reopened a debt. A student
  -- who had overpaid, or who has since paid again, is left alone.
  if v_balance > 0 then
    update compliance_statuses
       set state       = 'uncleared',
           cleared_at  = null,
           cleared_via = null,
           cleared_by  = null
     where student_id = v_payment.student_id
       and academic_session_id = v_payment.academic_session_id
       and state = 'cleared';
  end if;

  insert into notifications (recipient_id, kind, title, body, link)
  values (
    v_payment.student_id,
    'payment_reminder',
    'A payment has been reversed',
    format(
      'A dues payment of ₦%s was reversed by the bank. You now owe ₦%s. Nothing about your attendance has changed.',
      trim(to_char(v_payment.amount_kobo / 100.0, '999G999G990D99')),
      trim(to_char(v_balance / 100.0, '999G999G990D99'))
    ),
    '/dues'
  );

  perform write_audit(
    p_actor_id, coalesce((select role from profiles where id = p_actor_id), 'admin'),
    'payment.reversed', 'payments', p_payment_id::text, btrim(p_reason),
    jsonb_build_object(
      'student_id', v_payment.student_id,
      'amount_kobo', v_payment.amount_kobo,
      'balance_after', v_balance
    )
  );

  return case when v_balance > 0 then 'reopened' else 'reversed_no_debt' end;
end;
$$;

revoke all on function reverse_payment(uuid, text, uuid) from public, anon, authenticated;
grant execute on function reverse_payment(uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The manual route
-- ---------------------------------------------------------------------------

-- For the day the gateway is down or a student paid at the bank counter. It is
-- an authority action in the same shape as every other one: an actor, a
-- mandatory reason, an audit row — and a permanent flag on the payment, so
-- nobody a year from now has to work out why there is no Paystack record.
create or replace function record_manual_payment(
  p_student_id          uuid,
  p_academic_session_id uuid,
  p_amount_kobo         double precision,
  p_reference           text,
  p_note                text,
  p_actor_id            uuid,
  p_receipt_url         text default null
)
returns table (payment_id uuid, outcome text)
language plpgsql
as $$
declare
  v_id uuid;
begin
  if p_actor_id is null then
    raise exception 'a manual payment must record who accepted it';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'a manual payment must record why it was accepted without the gateway';
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'a payment must be for a positive amount';
  end if;

  if exists (select 1 from payments where paystack_reference = btrim(p_reference)) then
    return query select null::uuid, 'duplicate_reference'; return;
  end if;

  insert into payments (
    student_id, academic_session_id, paystack_reference, channel, status,
    amount_kobo, verified_at, manually_verified, verified_by, verification_note,
    receipt_url
  )
  values (
    p_student_id, p_academic_session_id, btrim(p_reference), 'transfer', 'success',
    trunc(p_amount_kobo), now(), true, p_actor_id, btrim(p_note), p_receipt_url
  )
  returning id into v_id;

  perform write_audit(
    p_actor_id, coalesce((select role from profiles where id = p_actor_id), 'admin'),
    'payment.manual', 'payments', v_id::text, btrim(p_note),
    jsonb_build_object(
      'student_id', p_student_id,
      'amount_kobo', trunc(p_amount_kobo),
      'reference', btrim(p_reference),
      'receipt', p_receipt_url is not null
    )
  );

  return query select v_id, apply_payment(v_id, p_actor_id);
end;
$$;

revoke all on function record_manual_payment(uuid, uuid, double precision, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function record_manual_payment(uuid, uuid, double precision, text, text, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security for the new table
-- ---------------------------------------------------------------------------

alter table payment_events enable row level security;

-- Nobody reads this through PostgREST. It is written by the webhook route
-- under the service role and read by reconciliation; a student has no business
-- in it and neither has the HOD.
create policy payment_events_no_read on payment_events
  for select to authenticated using (false);

-- ---------------------------------------------------------------------------
-- The student's own view of their marks, rebuilt without the status
-- ---------------------------------------------------------------------------

create view my_attendance_marks
with (security_invoker = true)
as
  select
    am.id,
    am.checkpoint_id,
    cp.session_instance_id,
    am.accepted,
    am.reject_reason,
    am.submitted_at
  from attendance_marks am
  join checkpoints cp on cp.id = am.checkpoint_id
  where am.student_id = auth.uid();

grant select on my_attendance_marks to authenticated;

comment on view my_attendance_marks is
  'A student''s own submission attempts, accepted or not.';

-- ===========================================================================
-- 20260823000400_channels_and_numbers.sql
-- ===========================================================================

-- Dept-Flow — the numbers a student can be reached on, and the channels
--
-- The revised flow turns Dept-Flow from a tracker into a warning system, and a
-- warning system is only as good as its ability to reach somebody. Everything
-- from §5 — the tiered alerts, the escalation, the WhatsApp-then-SMS fallback —
-- rests on two things this schema does not have: a number per channel, and a
-- record of what was actually delivered.
--
-- THE NUMBERS (§1)
--
-- `profiles.phone` is the primary number: SMS reaches it, and it doubles as the
-- account's identity. Most students' WhatsApp runs on that same number, and for
-- them nothing changes. Some run WhatsApp on a data-only SIM that is not in the
-- phone they carry, so a separate WhatsApp number is optional and, when given,
-- separately verified — a number nobody has proved is reachable is worse than
-- no number, because the system will believe it delivered a warning.
--
-- THE CHANNELS (§5.3)
--
-- in-app always · Web Push at Watch · WhatsApp at Critical · SMS last.
-- The ordering is not decoration: SMS costs money and needs no data
-- connection, which is exactly why it is reserved for the most severe warning
-- and exactly why it must not be spent on a Monday digest.
--
-- WHAT IS NOT HERE
--
-- No provider. `notification_deliveries` records an attempt and its outcome;
-- what actually calls WhatsApp or an SMS gateway is application code with a
-- seam that throws in production until it is wired, the same way the OTP seam
-- has always worked. A schema that pretended to have a provider would be the
-- more dangerous of the two.

-- ---------------------------------------------------------------------------
-- The WhatsApp number
-- ---------------------------------------------------------------------------

alter table profiles
  add column whatsapp_phone text,
  add column phone_verified_at timestamptz,
  add column whatsapp_verified_at timestamptz;

alter table profiles
  add constraint profile_whatsapp_format check (
    whatsapp_phone is null or whatsapp_phone ~ '^\+234[0-9]{10}$'
  ),
  -- Storing the same number twice would mean two OTPs to one handset at
  -- registration and two sends for every Critical alert afterwards. Null means
  -- "the primary number is the WhatsApp number", which is the common case.
  add constraint profile_whatsapp_distinct check (
    whatsapp_phone is null or whatsapp_phone <> phone
  ),
  add constraint profile_whatsapp_verified_has_number check (
    whatsapp_verified_at is null or whatsapp_phone is not null
  );

comment on column profiles.whatsapp_phone is
  'Only when WhatsApp runs on a different SIM from the phone the student carries. Null means WhatsApp goes to the primary number.';

-- Where a WhatsApp message should go, resolved once so that no caller has to
-- remember the fallback. Every send reads this rather than reimplementing
-- `coalesce`, which is the kind of thing that gets it right in four places and
-- wrong in the fifth.
create or replace function whatsapp_number(p_profile_id uuid)
returns text
language sql
stable
as $$
  select coalesce(p.whatsapp_phone, p.phone)
  from profiles p
  where p.id = p_profile_id;
$$;

grant execute on function whatsapp_number(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- OTP, per channel
-- ---------------------------------------------------------------------------

-- A code sent by SMS to the primary number and a code sent by WhatsApp to the
-- WhatsApp number are two different codes with two different fates, and the
-- table had no way to tell them apart.
create type otp_channel as enum ('sms', 'whatsapp');

alter table otp_codes
  add column channel otp_channel not null default 'sms';

drop index if exists otp_codes_lookup_idx;
create index otp_codes_lookup_idx
  on otp_codes (phone, purpose, channel, created_at desc)
  where consumed_at is null;

comment on column otp_codes.channel is
  'How this code was sent. Both numbers are verified before either is trusted, so registration can have two live codes at once.';

-- ---------------------------------------------------------------------------
-- Channels, and what was actually delivered
-- ---------------------------------------------------------------------------

create type notification_channel as enum ('in_app', 'web_push', 'whatsapp', 'sms');

-- 'sent' is what a provider accepted, not what a student read. The distinction
-- matters for the fallback: WhatsApp accepting a message is the signal NOT to
-- spend an SMS, and WhatsApp rejecting it is the signal to spend one
-- immediately rather than waiting for the next scheduled alert.
create type delivery_status as enum ('queued', 'sent', 'failed', 'skipped');

-- Four new kinds. Rebuilt rather than extended, for the reason the grace scope
-- was: `alter type ... add value` cannot be followed by a use of that value in
-- the same transaction, and setup.sql is one paste into the SQL Editor. The
-- `notification_policy` seed below names all four, so the extend-in-place form
-- applied cleanly from psql and failed for anyone following the setup guide.
--
-- It got that far because the transaction check in scripts/schema-test.sh was
-- grepping for psql's "file:line:" error prefix, which psql only writes when
-- reading a file — from a pipe it prints a bare "ERROR:". The check matched
-- nothing and passed everything. Both are fixed.
alter type notification_kind rename to notification_kind_old;

create type notification_kind as enum (
  'payment_reminder',
  'payment_confirmed',
  'risk_nudge',
  'grace_period',
  'schedule_change',
  'clearance_granted',
  -- New with the warning system.
  'lecture_reminder',
  'attendance_warning',
  'weekly_report',
  'hod_message'
);

-- notify_enrolled() takes the type in its signature, so it goes before the type
-- does and is recreated below against the new one, unchanged.
drop function if exists notify_enrolled(uuid, notification_kind_old, text, text, text);

alter table notifications
  alter column kind type notification_kind using kind::text::notification_kind;

drop type notification_kind_old;

-- Recreated against the new type, verbatim apart from one change: it now
-- queues through queue_notification() rather than inserting the in-app row
-- itself, so a schedule change reaches students on the channels the policy
-- allows instead of only inside the app. That is defined further down this
-- file, so the recreation is at the bottom rather than here.

-- One row per channel per notification. The in-app copy still lives in
-- `notifications` — it is the thing the student opens — and this records every
-- attempt made to push that same notification outward.
create table notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications (id) on delete cascade,
  channel         notification_channel not null,
  status          delivery_status not null default 'queued',
  -- The number or endpoint it was addressed to, as it was at the time. A
  -- student who changes their number later must not silently rewrite the
  -- history of where a warning went.
  destination     text,
  provider_ref    text,
  error           text,
  -- Set when this send exists because another channel failed. The whole point
  -- of the WhatsApp→SMS rule is that it is visible afterwards.
  fell_back_from  notification_channel,
  attempted_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (notification_id, channel),
  constraint delivery_failed_has_error check (
    status <> 'failed' or length(btrim(coalesce(error, ''))) > 0
  ),
  constraint delivery_sent_has_timestamp check (
    status not in ('sent', 'failed') or attempted_at is not null
  )
);

create index notification_deliveries_notification_idx
  on notification_deliveries (notification_id);
create index notification_deliveries_queued_idx
  on notification_deliveries (channel, created_at)
  where status = 'queued';

comment on table notification_deliveries is
  'One attempt per channel per notification. A failed WhatsApp send is what triggers the SMS, and this is where that decision is recorded.';

-- ---------------------------------------------------------------------------
-- Web Push subscriptions
-- ---------------------------------------------------------------------------

-- A push endpoint belongs to a BROWSER, not to a person: the same student on a
-- phone and a laptop is two subscriptions, and reaching them on the device
-- they are holding is the entire value of the channel. So this is one row per
-- endpoint rather than one per student.
--
-- Endpoints expire. A push service answers a dead one with 410 Gone, which is
-- the signal to delete the row rather than to retry it — an expired
-- subscription retried forever is a channel that reports failures every night
-- for a student who simply cleared their browser data.
create table push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references profiles (id) on delete cascade,
  -- The push service's URL for this browser. Unique because re-subscribing the
  -- same browser must update the row rather than accumulate duplicates that
  -- each deliver the same notification.
  endpoint     text not null unique,
  subscription jsonb not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create index push_subscriptions_profile_idx on push_subscriptions (profile_id);

alter table push_subscriptions enable row level security;

-- A student manages their own devices and sees nobody else's. Staff have no
-- read policy at all: the list of browsers a student signs in from is not
-- something the department needs.
create policy push_subscriptions_self on push_subscriptions
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

comment on table push_subscriptions is
  'One row per browser, not per student. A 410 from the push service means delete this row, not retry it.';

-- ---------------------------------------------------------------------------
-- Which channels a tier earns
-- ---------------------------------------------------------------------------

-- §5.3, as data rather than as a branch buried in application code. The
-- department will want to change this — turning SMS off for a term is a budget
-- decision, not a deploy — and a table is the difference between that being a
-- config change and a release.
create table notification_policy (
  kind        notification_kind primary key,
  in_app      boolean not null default true,
  web_push    boolean not null default false,
  whatsapp    boolean not null default false,
  sms         boolean not null default false,
  updated_at  timestamptz not null default now()
);

create trigger notification_policy_updated_at
  before update on notification_policy
  for each row execute function set_updated_at();

insert into notification_policy (kind, in_app, web_push, whatsapp, sms) values
  -- Escalation lives on the risk tier rather than the kind, so the warning row
  -- enables every channel and `channels_for_tier()` narrows it.
  ('attendance_warning', true,  true,  true,  true),
  -- A reminder an hour before a lecture. WhatsApp, because it is free and the
  -- student is looking at their phone anyway; never SMS, which would spend the
  -- budget reserved for the warning that matters.
  ('lecture_reminder',   true,  true,  true,  false),
  ('weekly_report',      true,  false, true,  false),
  ('hod_message',        true,  true,  true,  false),
  ('payment_reminder',   true,  false, false, false),
  ('payment_confirmed',  true,  false, false, false),
  ('risk_nudge',         true,  true,  false, false),
  ('grace_period',       true,  false, true,  false),
  ('schedule_change',    true,  true,  true,  false),
  ('clearance_granted',  true,  false, false, false)
on conflict (kind) do nothing;

comment on table notification_policy is
  'Which channels each kind of notification may use. SMS costs money, so turning it off for a term is a row edit rather than a deploy.';

alter table notification_policy enable row level security;

create policy notification_policy_read on notification_policy
  for select to authenticated using (is_admin() or is_hod());

alter table notification_deliveries enable row level security;

-- A student sees where their own notifications were sent. Not a secret — it is
-- their number and their warning — and it answers "I never got that" without a
-- support ticket.
create policy notification_deliveries_self_read on notification_deliveries
  for select to authenticated using (
    exists (
      select 1 from notifications n
      where n.id = notification_deliveries.notification_id
        and n.recipient_id = auth.uid()
    )
  );

create policy notification_deliveries_staff_read on notification_deliveries
  for select to authenticated using (is_admin() or is_hod());

-- ---------------------------------------------------------------------------
-- Queueing one
-- ---------------------------------------------------------------------------

-- Writes the in-app notification and one queued delivery row per channel the
-- policy allows. Deliberately does NOT send anything: sending needs a network
-- call, and a database function that could block on one would hold a
-- transaction open for as long as a provider felt like taking.
--
-- `p_channels` overrides the policy, for the risk tiers — Watch and Critical
-- are the same KIND of notification and earn different channels.
create or replace function queue_notification(
  p_recipient_id uuid,
  p_kind         notification_kind,
  p_title        text,
  p_body         text,
  p_link         text default null,
  p_channels     notification_channel[] default null
)
returns uuid
language plpgsql
as $$
declare
  v_id       uuid;
  v_policy   notification_policy%rowtype;
  v_wanted   notification_channel[];
  v_channel  notification_channel;
  v_dest     text;
begin
  insert into notifications (recipient_id, kind, title, body, link)
  values (p_recipient_id, p_kind, p_title, p_body, p_link)
  returning id into v_id;

  if p_channels is not null then
    v_wanted := p_channels;
  else
    select * into v_policy from notification_policy where kind = p_kind;

    v_wanted := array_remove(array[
      case when coalesce(v_policy.in_app, true)   then 'in_app'   end,
      case when coalesce(v_policy.web_push, false) then 'web_push' end,
      case when coalesce(v_policy.whatsapp, false) then 'whatsapp' end,
      case when coalesce(v_policy.sms, false)      then 'sms'      end
    ]::notification_channel[], null);
  end if;

  foreach v_channel in array v_wanted loop
    v_dest := case v_channel
                when 'whatsapp' then whatsapp_number(p_recipient_id)
                when 'sms'      then (select phone from profiles where id = p_recipient_id)
                else null
              end;

    insert into notification_deliveries (notification_id, channel, status, destination, attempted_at)
    values (
      v_id,
      v_channel,
      -- The in-app copy is the notifications row itself, which now exists, so
      -- it is delivered by definition. Everything else waits for a sender.
      (case when v_channel = 'in_app' then 'sent' else 'queued' end)::delivery_status,
      v_dest,
      case when v_channel = 'in_app' then now() end
    )
    on conflict (notification_id, channel) do nothing;
  end loop;

  return v_id;
end;
$$;

revoke all on function queue_notification(uuid, notification_kind, text, text, text, notification_channel[])
  from public, anon, authenticated;
grant execute on function queue_notification(uuid, notification_kind, text, text, text, notification_channel[])
  to service_role;

comment on function queue_notification(uuid, notification_kind, text, text, text, notification_channel[]) is
  'Writes the in-app notification and queues a delivery per allowed channel. Sends nothing — a provider call inside a transaction holds it open for as long as the provider likes.';

-- ---------------------------------------------------------------------------
-- The fallback
-- ---------------------------------------------------------------------------

-- "If a WhatsApp send fails to deliver, the system falls back to SMS
-- immediately rather than waiting for the next scheduled alert."
--
-- Recorded here rather than decided by the sender, so the reason an SMS was
-- spent is visible on the row afterwards. It refuses to fall back for a
-- notification whose policy does not permit SMS at all: a lecture reminder that
-- fails on WhatsApp is a lecture reminder that does not arrive, not a reason to
-- spend money the department decided not to spend.
create or replace function record_delivery_failure(
  p_delivery_id uuid,
  p_error       text
)
returns text
language plpgsql
as $$
declare
  v_row     notification_deliveries%rowtype;
  v_kind    notification_kind;
  v_allowed boolean;
  v_dest    text;
begin
  select * into v_row from notification_deliveries where id = p_delivery_id;
  if v_row.id is null then return 'not_found'; end if;

  update notification_deliveries
     set status = 'failed',
         error = coalesce(nullif(btrim(p_error), ''), 'delivery failed'),
         attempted_at = coalesce(attempted_at, now())
   where id = p_delivery_id;

  if v_row.channel <> 'whatsapp' then return 'failed'; end if;

  select n.kind into v_kind from notifications n where n.id = v_row.notification_id;
  select sms into v_allowed from notification_policy where kind = v_kind;

  if not coalesce(v_allowed, false) then
    return 'failed_no_fallback';
  end if;

  -- Already tried, or already queued by something else. Falling back twice
  -- would send the student two texts for one warning.
  if exists (
    select 1 from notification_deliveries d
    where d.notification_id = v_row.notification_id and d.channel = 'sms'
  ) then
    return 'failed_fallback_exists';
  end if;

  select phone into v_dest
  from profiles p
  join notifications n on n.recipient_id = p.id
  where n.id = v_row.notification_id;

  insert into notification_deliveries (
    notification_id, channel, status, destination, fell_back_from
  )
  values (v_row.notification_id, 'sms', 'queued', v_dest, 'whatsapp');

  return 'fell_back_to_sms';
end;
$$;

revoke all on function record_delivery_failure(uuid, text) from public, anon, authenticated;
grant execute on function record_delivery_failure(uuid, text) to service_role;

comment on function record_delivery_failure(uuid, text) is
  'Marks a send failed and, for WhatsApp, queues the SMS immediately. Refuses to fall back where the policy forbids SMS — a failed reminder is not a reason to spend money the department chose not to spend.';

-- ---------------------------------------------------------------------------
-- notify_enrolled, rebuilt on the channel layer
-- ---------------------------------------------------------------------------

-- The schedule screen promises "every enrolled student is notified straight
-- away". Notifying from the database rather than the API keeps that promise
-- attached to the write itself: a caller that cancels a lecture cannot forget
-- the half that students actually experience.
--
-- Unchanged in what it does and who it reaches. What changed is the row it
-- writes: through queue_notification(), so a cancelled lecture goes out on
-- WhatsApp and Web Push as well as in-app. A student who does not open the
-- site before walking to a hall that is shut is exactly who this is for.
create or replace function notify_enrolled(
  p_course_id uuid,
  p_kind      notification_kind,
  p_title     text,
  p_body      text,
  p_link      text default null
)
returns integer
language plpgsql
as $$
declare
  v_student uuid;
  v_sent    integer := 0;
begin
  for v_student in
    select e.student_id
    from enrolments e
    where e.course_id = p_course_id
      and e.dropped_at is null
  loop
    perform queue_notification(v_student, p_kind, p_title, p_body, p_link);
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

revoke all on function notify_enrolled(uuid, notification_kind, text, text, text)
  from public, anon, authenticated;
grant execute on function notify_enrolled(uuid, notification_kind, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Throttling (§1.6)
-- ---------------------------------------------------------------------------

-- "The registration endpoint is rate-limited to stop scripted claiming of the
-- whole roster."
--
-- There is already a per-phone OTP limit, and it does not address this at all:
-- a script claiming the roster varies the phone number on every request, so
-- every request is the first one for its number. What has to be limited is the
-- CALLER — and specifically the register-match step, which is the one that
-- answers "is CMP/2021/047 a real unclaimed matric number" and can therefore
-- be walked through the whole department.
--
-- In the database rather than in memory: a Next.js instance is not the only
-- instance, and a limiter that resets on deploy is a limiter a patient script
-- outlasts. The stack names Redis and this is exactly what Redis is for —
-- swap the implementation, keep the interface, change no caller.
create table request_throttle (
  bucket       text not null,
  subject      text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, subject, window_start)
);

create index request_throttle_sweep_idx on request_throttle (window_start);

comment on table request_throttle is
  'Fixed-window counters, keyed on caller rather than on the thing being asked about. Redis would do this better; the interface is take_token().';

-- Returns true when the caller may proceed. Fixed windows rather than a
-- sliding log: a sliding window is more accurate and needs a row per request,
-- which for a login endpoint is a table that grows faster than the one it
-- protects.
create or replace function take_token(
  p_bucket        text,
  p_subject       text,
  p_limit         integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
as $$
declare
  v_start timestamptz;
  v_hits  integer;
begin
  if p_subject is null or btrim(p_subject) = '' then
    -- No identifiable caller. Allowed rather than blocked: failing closed here
    -- would lock out everyone behind a proxy that strips the header, which is
    -- a worse outcome than a script getting through.
    return true;
  end if;

  v_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into request_throttle (bucket, subject, window_start, hits)
  values (p_bucket, btrim(p_subject), v_start, 1)
  on conflict (bucket, subject, window_start) do update
    set hits = request_throttle.hits + 1
  returning hits into v_hits;

  -- Old windows, cleared opportunistically. A sweep job would be tidier and
  -- would be one more thing that has to be running for the table not to grow.
  delete from request_throttle
   where window_start < now() - interval '1 day';

  return v_hits <= p_limit;
end;
$$;

revoke all on function take_token(text, text, integer, integer) from public, anon, authenticated;
grant execute on function take_token(text, text, integer, integer) to service_role;

alter table request_throttle enable row level security;

create policy request_throttle_no_read on request_throttle
  for select to authenticated using (false);

-- ===========================================================================
-- 20260823000500_risk_forecast.sql
-- ===========================================================================

-- Dept-Flow — the forecast, and what it is allowed to do about it
--
-- "This is the core of Dept-Flow: a FORECAST, not a scoreboard. The model asks
-- 'where is this student headed?' rather than just reporting 'where are they
-- now?' — that's what makes it a warning system instead of a passive tracker."
--
-- The existing signal is a scoreboard wearing a forecast's name. It computes
-- the student's attendance rate so far and stores it as `predicted_pct`, which
-- is not a prediction — it is the same number the meter already shows, copied
-- into another table. A student who attended ten lectures and then stopped
-- reads 76% on both, and 76% is above the line, so nothing warns anybody.
--
-- WHAT REPLACES IT
--
-- Two numbers, computed differently and used for different things:
--
--   trend        the least-squares slope of attendance against lecture
--                number. Negative means falling away. This EXPLAINS the
--                warning — it is why a student is being told something — and
--                it decides which of the two patterns they are shown.
--   projected    where they finish, from a blend of their recent rate and
--                their overall rate, applied to the lectures still to come.
--
-- The projection is deliberately NOT the slope extrapolated forward, and the
-- first version of this made that mistake. A binary series' OLS slope is very
-- noisy: a student who attended nine of ten lectures has a slope steep enough
-- to project them to 54% over another seventeen, purely because of where in
-- the sequence the one absence fell. Warning that student is worse than
-- useless — an alert system that cries wolf in week six is one nobody reads in
-- week eleven, and by then it is the only thing that could have helped.
--
-- So the forward estimate is the average of the last five lectures and the
-- whole term. The recent window says what they are doing now; the overall rate
-- says what they do in general; neither deserves to dominate, and the truth is
-- between them. It is responsive enough to catch Chidera — ten straight, then
-- three missed — and steady enough not to panic over one bad morning.
--
-- It is a regression. It is not scikit-learn, and the seam for scikit-learn is
-- unchanged and still real: everything here writes `risk_predictions`, every
-- reader is indifferent to what produced the row, and the FastAPI service in
-- the stack can replace this function without touching a screen. What has not
-- changed since that argument was first written is that there is no history to
-- train on — one academic session, and a classifier fitted to it would be the
-- training set memorised. What HAS changed is that a rule can now be wrong in
-- a way that matters, so the rule had to become one that actually forecasts.
--
-- WHY A STRAIGHT LINE
--
-- Because it can be explained to the student it is about. "You have missed
-- three of the last four, and at that rate you finish at 61%" is a sentence a
-- student can act on and argue with. A gradient-boosted answer to the same
-- question is a number they have to take on trust, and this system's whole
-- claim on a student's attention is that it tells them WHY.

-- ---------------------------------------------------------------------------
-- Tiers
-- ---------------------------------------------------------------------------

-- §5.2, exactly. The boundaries are not arbitrary: 75% is the eligibility
-- rule, so Watch is the band where a student is on course to land ON the line
-- with no buffer at all — one illness from ineligible. Safe means there is
-- room for something to go wrong.
create type risk_tier as enum ('safe', 'watch', 'critical');

alter table risk_predictions
  add column tier             risk_tier,
  -- Slope of the fit, in percentage points per lecture. Kept because it is
  -- what distinguishes a student who has always been at 70% from one who was
  -- at 95% and is falling — the same projection, two different conversations.
  add column trend            numeric(6,3),
  add column lectures_held    integer,
  add column lectures_expected integer,
  -- The two numbers the alert copy is made of. Computed here so the sentence
  -- on the screen, the sentence in the WhatsApp message and the sentence in
  -- the SMS are the same sentence.
  add column must_attend      integer,
  add column can_still_miss   integer;

comment on column risk_predictions.predicted_pct is
  'Projected end-of-semester attendance, from the trend. NOT the current percentage — that is what attendance_pct() is for.';

comment on column risk_predictions.trend is
  'Percentage points per lecture. Negative is a student falling away, which is the case this whole system exists to catch early.';

-- ---------------------------------------------------------------------------
-- How many lectures a course still has to hold
-- ---------------------------------------------------------------------------

-- A projection needs a denominator, and "lectures held so far" is the wrong
-- one — that is what makes a scoreboard. What is needed is how many the course
-- will have held by the end, which comes from the timetable: a weekly slot
-- times the weeks left in the session.
create or replace function lectures_remaining(p_course_id uuid)
returns integer
language sql
stable
as $$
  with course_session as (
    select a.ends_on
    from courses c
    join academic_sessions a on a.id = c.academic_session_id
    where c.id = p_course_id
  ),
  slots as (
    select count(*)::numeric as per_week
    from timetable_entries t
    where t.course_id = p_course_id
  )
  select greatest(
    0,
    floor(
      slots.per_week
      * greatest(0, (course_session.ends_on - current_date))::numeric / 7.0
    )
  )::integer
  from course_session, slots;
$$;

comment on function lectures_remaining(uuid) is
  'Weekly slots times the weeks left in the session. A course with no timetable row returns 0, which makes its projection its current rate — the honest answer when nothing says another lecture is coming.';

grant execute on function lectures_remaining(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The forecast
-- ---------------------------------------------------------------------------

create or replace function compute_risk_predictions()
returns integer
language plpgsql
as $$
declare
  v_written   integer;
  v_threshold numeric;
begin
  select attendance_threshold_pct into v_threshold from app_config where id = 1;
  v_threshold := coalesce(v_threshold, 75);

  -- Wholesale rather than incremental. A prediction is only ever a statement
  -- about the present, and a stale row for a student who has since turned
  -- things around is worse than no row.
  delete from risk_predictions;

  with
  -- Every closed lecture the student was enrolled for, numbered in the order
  -- they were held. The number is the x-axis of the fit.
  ordered as (
    select
      e.student_id,
      e.course_id,
      row_number() over (partition by e.student_id, e.course_id order by si.held_on) as n,
      -- How far this lecture is from the most recent one, so "the last five"
      -- can be expressed without a window function inside a FILTER, which
      -- Postgres does not allow.
      row_number() over (
        partition by e.student_id, e.course_id order by si.held_on desc
      ) as from_end,
      coalesce(ss.score, 0)::numeric as attended
    from enrolments e
    join session_instances si
      on si.course_id = e.course_id
     and si.status = 'closed'
     and si.held_on >= e.enrolled_on
     and (e.dropped_at is null or si.held_on < e.dropped_at::date)
    left join session_scores ss
      on ss.session_instance_id = si.id
     and ss.student_id = e.student_id
    where e.dropped_at is null
  ),
  -- Ordinary least squares, by its closed form. slope = Sxy / Sxx, where the
  -- S terms are the deviations from the means. Postgres has regr_slope() for
  -- exactly this and it is used rather than spelled out, because a hand-rolled
  -- covariance is a place to put a bug that nobody would ever see.
  fitted as (
    select
      student_id,
      course_id,
      count(*)::integer                       as held,
      sum(attended)                           as attended_total,
      avg(attended)                           as rate,
      -- Null when there is one row or the outcomes are constant — a student
      -- who has attended everything has no trend, and inventing one for them
      -- would be noise.
      --
      -- Cast at the source. regr_slope() returns double precision, and one
      -- double anywhere downstream turns the whole expression into a double —
      -- at which point round(x, 2) does not exist and the nightly job fails on
      -- a function signature rather than on anything to do with risk.
      regr_slope(attended, n)::numeric        as slope,
      max(n)                                  as last_n,
      -- The last five lectures, which is what "recently" means here. Five is
      -- roughly a month of a weekly course: long enough that one absence does
      -- not halve it, short enough to move within a term.
      avg(attended) filter (where from_end <= 5)  as recent_rate
    from ordered
    group by student_id, course_id
  ),
  projected as (
    select
      f.student_id,
      f.course_id,
      f.held,
      f.attended_total,
      f.rate,
      coalesce(f.slope, 0) as slope,
      lectures_remaining(f.course_id) as remaining,
      -- The forward estimate: half what they have been doing lately, half what
      -- they have done all term. See the header for why this is not the slope
      -- extrapolated — in short, because doing that turns one missed lecture
      -- in ten into a projected failure.
      (coalesce(f.recent_rate, f.rate) + f.rate) / 2.0 as forward_rate
    from fitted f
    -- "From around week 5–6 onward." Below that there is nothing to project
    -- from: one missed lecture out of three is a rate that says almost
    -- nothing, and a warning system that fires in week two is one nobody reads
    -- in week nine.
    where f.held >= 5
  ),
  final as (
    select
      student_id,
      course_id,
      held,
      attended_total,
      rate,
      slope,
      remaining,
      held + remaining as expected_total,
      round(
        case
          when held + remaining = 0 then 0
          else (attended_total + remaining * forward_rate) / (held + remaining) * 100
        end, 2
      ) as predicted_pct
    from projected
  )
  insert into risk_predictions (
    student_id, course_id, predicted_pct, pattern, tier, trend,
    lectures_held, lectures_expected, must_attend, can_still_miss
  )
  select
    student_id,
    course_id,
    -- Bounded, because the arithmetic above can round a hair past 100.
    least(100, greatest(0, predicted_pct)),
    case
      when predicted_pct >= v_threshold then null
      -- Two ways to be heading for trouble, and they need different
      -- conversations.
      --
      -- Disengagement covers both students who are not there: the one whose
      -- trend is falling — was fine, stopped coming, something changed and
      -- asking what is the useful response — and the one who never started at
      -- all. A flat line at zero is not "partial" attendance in any sense a
      -- person would recognise, and labelling it that way would send the wrong
      -- conversation to the student who most needs the right one.
      when slope < -0.01 then 'disengagement'::risk_pattern
      when rate < 0.4 then 'disengagement'::risk_pattern
      -- What is left: turning up sometimes, steadily, and not enough.
      else 'partial_attendance'::risk_pattern
    end,
    case
      when predicted_pct < v_threshold then 'critical'::risk_tier
      when predicted_pct < 80 then 'watch'::risk_tier
      else 'safe'::risk_tier
    end,
    round(slope * 100, 3),
    held,
    expected_total,
    -- "The exact number of classes the student must still attend." Of the
    -- lectures still to come, how many are needed to finish at the threshold.
    -- Capped at what remains: a student who cannot reach it however hard they
    -- try must be told that, not handed an impossible number.
    least(
      remaining,
      greatest(0, ceil((v_threshold / 100.0) * (held + remaining) - attended_total))::integer
    ),
    -- "…or can still miss." The other half of the same sentence, and the half
    -- a student on track actually reads.
    greatest(
      0,
      remaining - greatest(0, ceil((v_threshold / 100.0) * (held + remaining) - attended_total))::integer
    )
  from final;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

comment on function compute_risk_predictions() is
  'Least-squares fit over the lectures held, projected to the end of the semester. Advisory only — attendance_pct() decides eligibility and never consults this.';

revoke all on function compute_risk_predictions() from public, anon, authenticated;
grant execute on function compute_risk_predictions() to service_role;

-- ---------------------------------------------------------------------------
-- The what-if calculator (§5.5)
-- ---------------------------------------------------------------------------

-- "An interactive what-if calculator on the student dashboard shows the effect
-- of missing upcoming classes before it happens."
--
-- In the database rather than in the browser, and it matters: the arithmetic
-- is the eligibility rule, and a second copy of the eligibility rule written
-- in TypeScript is a second copy that will one day disagree with the first.
-- The screen asks and renders; it does not compute.
create or replace function attendance_what_if(
  p_student_id uuid,
  p_course_id  uuid,
  p_miss_next  integer
)
returns table (
  resulting_pct  numeric,
  still_eligible boolean,
  must_attend    integer,
  remaining      integer
)
language sql
stable
as $$
  with base as (
    select
      coalesce((
        select sum(ss.score)
        from session_scores ss
        join session_instances si on si.id = ss.session_instance_id
        join enrolments e on e.student_id = ss.student_id and e.course_id = si.course_id
        where ss.student_id = p_student_id
          and si.course_id = p_course_id
          and si.status = 'closed'
          and si.held_on >= e.enrolled_on
      ), 0)::numeric as attended,
      coalesce((
        select count(*)
        from session_instances si
        join enrolments e on e.course_id = si.course_id and e.student_id = p_student_id
        where si.course_id = p_course_id
          and si.status = 'closed'
          and si.held_on >= e.enrolled_on
      ), 0)::numeric as held,
      lectures_remaining(p_course_id)::numeric as remaining,
      coalesce((select attendance_threshold_pct from app_config where id = 1), 75) as threshold
  ),
  answered as (
    select
      *,
      -- Missing more than there are left is not a scenario, it is a typo.
      least(greatest(coalesce(p_miss_next, 0), 0), remaining) as missed
    from base
  )
  select
    case
      when held + remaining = 0 then 0::numeric
      else round((attended + (remaining - missed)) / (held + remaining) * 100, 2)
    end,
    case
      when held + remaining = 0 then true
      else (attended + (remaining - missed)) / (held + remaining) * 100 >= threshold
    end,
    least(
      remaining,
      greatest(0, ceil((threshold / 100.0) * (held + remaining) - attended))
    )::integer,
    remaining::integer
  from answered;
$$;

comment on function attendance_what_if(uuid, uuid, integer) is
  'What missing N of the remaining lectures would do to this student on this course. The eligibility arithmetic lives here so the calculator and the permit cannot disagree.';

revoke all on function attendance_what_if(uuid, uuid, integer) from public, anon;
grant execute on function attendance_what_if(uuid, uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Turning a forecast into a warning
-- ---------------------------------------------------------------------------

-- §5.3 and §5.4 together: the channels scale with the tier, and the copy names
-- the course and the exact number of lectures. "Your attendance is low" is the
-- message this function exists to never send.
--
-- Warnings are sent once per tier per course. A student who is Critical for
-- six weeks gets one Critical warning, not forty-two — and if they climb to
-- Watch and fall back, they get a new one, because that is genuinely new
-- information.
create table risk_alerts_sent (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references students (id) on delete cascade,
  course_id    uuid not null references courses (id) on delete cascade,
  tier         risk_tier not null,
  predicted_pct numeric(5,2) not null,
  notification_id uuid references notifications (id) on delete set null,
  sent_at      timestamptz not null default now()
);

create index risk_alerts_sent_lookup_idx
  on risk_alerts_sent (student_id, course_id, sent_at desc);

alter table risk_alerts_sent enable row level security;

create policy risk_alerts_sent_self_read on risk_alerts_sent
  for select to authenticated using (student_id = auth.uid());

create policy risk_alerts_sent_staff_read on risk_alerts_sent
  for select to authenticated using (is_hod());

comment on table risk_alerts_sent is
  'One warning per tier per course. A student who is Critical for six weeks gets one Critical warning, not forty-two.';

create or replace function send_risk_alerts()
returns integer
language plpgsql
as $$
declare
  v_row      record;
  v_sent     integer := 0;
  v_note     uuid;
  v_title    text;
  v_body     text;
  v_channels notification_channel[];
begin
  for v_row in
    select
      rp.*,
      c.code as course_code,
      (select tier from risk_alerts_sent prev
        where prev.student_id = rp.student_id
          and prev.course_id = rp.course_id
        order by prev.sent_at desc
        limit 1) as last_tier
    from risk_predictions rp
    join courses c on c.id = rp.course_id
    join students s on s.id = rp.student_id
    where rp.tier in ('watch', 'critical')
      and s.status <> 'deactivated'
  loop
    -- Already told, at this tier, and nothing has changed. Silence is the
    -- correct output: an alert that repeats every night is an alert a student
    -- mutes, and a muted channel is one that cannot warn them in week eleven.
    if v_row.last_tier is not distinct from v_row.tier then
      continue;
    end if;

    if v_row.tier = 'critical' then
      -- §5.3: in-app, Web Push, WhatsApp. SMS is held back for the final
      -- warning rather than spent on the first Critical — a student who gets a
      -- text in week six has nothing left to escalate to in week eleven.
      v_channels := array['in_app', 'web_push', 'whatsapp']::notification_channel[];

      -- The final, most severe warning: there is no slack left at all — every
      -- remaining lecture is needed, so the next one missed ends it. This is
      -- the one that earns an SMS, because SMS needs no data connection and
      -- because there is nothing after it to escalate to.
      if v_row.can_still_miss = 0 then
        v_channels := v_channels || 'sms'::notification_channel;
      end if;

      v_title := format('%s: you must attend every remaining lecture', v_row.course_code);

      if v_row.can_still_miss = 0 then
        v_body := format(
          '%s is projected to finish at %s%%. You have %s lectures left and need every one of them to reach 75%%. Missing one more makes you ineligible for the exam.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_row.lectures_expected - v_row.lectures_held
        );
      else
        v_title := format('%s: you are on course to miss the 75%% mark', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. Attend %s of the %s lectures left and you reach 75%%. You can miss %s.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_row.must_attend,
          v_row.lectures_expected - v_row.lectures_held,
          v_row.can_still_miss
        );
      end if;
    else
      -- Watch: in-app and Web Push. No WhatsApp — a student who is on course
      -- to land exactly on the line needs to know, and does not need a
      -- message on the channel reserved for the students who are failing.
      v_channels := array['in_app', 'web_push']::notification_channel[];
      v_title := format('%s: no buffer left', v_row.course_code);
      v_body := format(
        '%s is projected to finish at %s%%, which is just above the 75%% line. You can miss %s more lectures — after that there is no room left.',
        v_row.course_code,
        trim(to_char(v_row.predicted_pct, '990D9')),
        v_row.can_still_miss
      );
    end if;

    v_note := queue_notification(
      v_row.student_id,
      'attendance_warning',
      v_title,
      v_body,
      '/courses/' || replace(v_row.course_code, ' ', '-'),
      v_channels
    );

    insert into risk_alerts_sent (student_id, course_id, tier, predicted_pct, notification_id)
    values (v_row.student_id, v_row.course_id, v_row.tier, v_row.predicted_pct, v_note);

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

revoke all on function send_risk_alerts() from public, anon, authenticated;
grant execute on function send_risk_alerts() to service_role;

comment on function send_risk_alerts() is
  'Turns forecasts into warnings, once per tier per course, on the channels that tier earns. The copy names the course and the exact number of lectures — "your attendance is low" is what this exists to never send.';

-- ---------------------------------------------------------------------------
-- Folded into the nightly job
-- ---------------------------------------------------------------------------

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

  -- Advisory, and deliberately last: a failure to refresh predictions must not
  -- stop the compliance ladder, which is the part with consequences.
  perform compute_risk_predictions();

  -- And the warnings, which are the point of the forecast. Also last, and for
  -- the same reason — but note that a failure HERE is a student not warned,
  -- which is the failure this system was rebuilt to avoid. It is loud rather
  -- than swallowed.
  perform send_risk_alerts();

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

-- ===========================================================================
-- 20260823000600_reminders_and_reports.sql
-- ===========================================================================

-- Dept-Flow — reminders before, reports after
--
-- §4 and §6. Both are the same idea at different tempos: tell the student
-- something while they can still act on it.
--
-- A reminder an hour before a lecture is the cheapest intervention this system
-- has. It costs nothing on WhatsApp, it needs no forecast behind it, and it
-- addresses the largest single cause of a missed lecture, which is not
-- reluctance — it is a student who lost track of the day. The warning system
-- catches the student who is falling away; this catches the one who simply
-- forgot, and there are more of them.
--
-- A report is the other end: what happened, at a tempo slow enough that a
-- student reads it. Weekly, monthly, and the full semester picture — which is
-- the same computation the exam permit does, and is written once here so the
-- two cannot disagree about whether somebody is eligible.

-- ---------------------------------------------------------------------------
-- Timezone
-- ---------------------------------------------------------------------------

-- Every time in this file is Lagos time. The database runs in UTC and the
-- department does not, so "lectures starting in the next hour" computed in UTC
-- is an hour's worth of reminders sent at the wrong time of day — and in the
-- wrong direction, arriving after the lecture rather than before it.
create or replace function lagos_now()
returns timestamp
language sql
stable
as $$
  select (now() at time zone 'Africa/Lagos');
$$;

comment on function lagos_now() is
  'Local wall-clock time. The database is UTC and the department is not, and an hour''s error in a reminder means it arrives after the lecture.';

-- ---------------------------------------------------------------------------
-- Reminders sent, so they are sent once
-- ---------------------------------------------------------------------------

-- The job runs every few minutes and the window is an hour wide, so without
-- this every student on a course would get twenty reminders for one lecture.
-- Keyed on the slot and the day rather than on a timestamp: the same lecture
-- reminded about twice is the failure, and "the same lecture" means this
-- timetable row on this date.
create table lecture_reminders_sent (
  timetable_entry_id uuid not null references timetable_entries (id) on delete cascade,
  held_on            date not null,
  students_notified  integer not null default 0,
  sent_at            timestamptz not null default now(),
  primary key (timetable_entry_id, held_on)
);

comment on table lecture_reminders_sent is
  'One row per slot per day. The reminder job runs every few minutes over an hour-wide window; without this, one lecture would produce twenty reminders.';

alter table lecture_reminders_sent enable row level security;

create policy lecture_reminders_sent_staff_read on lecture_reminders_sent
  for select to authenticated using (is_admin() or is_hod());

-- ---------------------------------------------------------------------------
-- What is about to happen
-- ---------------------------------------------------------------------------

create or replace function upcoming_lectures(p_within_minutes integer default 60)
returns table (
  timetable_entry_id uuid,
  course_id          uuid,
  course_code        text,
  starts_at          timestamp,
  venue              text
)
language sql
stable
as $$
  with clock as (select lagos_now() as now_local)
  select
    te.id,
    te.course_id,
    c.code,
    (clock.now_local::date + te.start_time)::timestamp,
    v.name
  from timetable_entries te
  join courses c on c.id = te.course_id
  join academic_sessions a on a.id = te.academic_session_id and a.is_active
  join venues v on v.id = te.venue_id
  cross join clock
  where te.day_of_week = extract(dow from clock.now_local)::integer
    -- Strictly ahead of now, so a lecture that started five minutes ago is not
    -- "upcoming". A reminder for a lecture already under way is worse than
    -- none: it tells a student they are late, which they can no longer fix.
    and (clock.now_local::date + te.start_time) > clock.now_local
    and (clock.now_local::date + te.start_time)
        <= clock.now_local + make_interval(mins => p_within_minutes)
    -- A cancelled lecture is not upcoming. The lecturer already told everyone
    -- it is off; reminding them to attend it would be the system contradicting
    -- the person who cancelled it.
    and not exists (
      select 1 from session_instances si
      where si.timetable_entry_id = te.id
        and si.held_on = clock.now_local::date
        and si.status = 'cancelled'
    )
    -- And not one already reminded about.
    and not exists (
      select 1 from lecture_reminders_sent r
      where r.timetable_entry_id = te.id
        and r.held_on = clock.now_local::date
    );
$$;

comment on function upcoming_lectures(integer) is
  'Slots starting within the window, in Lagos time, excluding cancelled lectures and ones already reminded about.';

grant execute on function upcoming_lectures(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Reminding
-- ---------------------------------------------------------------------------

create or replace function send_lecture_reminders(p_within_minutes integer default 60)
returns integer
language plpgsql
as $$
declare
  v_lecture  record;
  v_student  uuid;
  v_count    integer;
  v_total    integer := 0;
  v_minutes  integer;
begin
  for v_lecture in select * from upcoming_lectures(p_within_minutes) loop
    v_count := 0;
    v_minutes := greatest(1, extract(epoch from (v_lecture.starts_at - lagos_now()))::integer / 60);

    -- Marked as sent BEFORE the sends, not after. The job runs every few
    -- minutes; a crash halfway through a large course would otherwise leave
    -- the row unwritten and reminders would go out again on the next tick, to
    -- the students who already had one.
    insert into lecture_reminders_sent (timetable_entry_id, held_on)
    values (v_lecture.timetable_entry_id, lagos_now()::date)
    on conflict do nothing;

    -- Registered students only, and specifically the ones this lecture will
    -- actually count against. A reminder to a student who dropped the course
    -- is the system asking them to attend something they left.
    for v_student in
      select e.student_id
      from enrolments e
      join students s on s.id = e.student_id
      where e.course_id = v_lecture.course_id
        and e.dropped_at is null
        and s.status <> 'deactivated'
    loop
      perform queue_notification(
        v_student,
        'lecture_reminder',
        format('%s starts in %s minutes', v_lecture.course_code, v_minutes),
        format(
          '%s at %s, %s. Your lecturer will put the attendance code on the board.',
          v_lecture.course_code,
          to_char(v_lecture.starts_at, 'HH24:MI'),
          coalesce(v_lecture.venue, 'the usual hall')
        ),
        '/dashboard'
      );
      v_count := v_count + 1;
    end loop;

    update lecture_reminders_sent
       set students_notified = v_count
     where timetable_entry_id = v_lecture.timetable_entry_id
       and held_on = lagos_now()::date;

    v_total := v_total + v_count;
  end loop;

  return v_total;
end;
$$;

revoke all on function send_lecture_reminders(integer) from public, anon, authenticated;
grant execute on function send_lecture_reminders(integer) to service_role;

comment on function send_lecture_reminders(integer) is
  'Queues a reminder for every student on every lecture starting within the window. Marks the slot sent first, so a crash mid-course does not re-remind the students who already had one.';

-- ---------------------------------------------------------------------------
-- Reports (§6)
-- ---------------------------------------------------------------------------

-- The semester picture, per course. Written once and read by three things: the
-- student's own semester report, the Monday digest, and the exam permit. The
-- permit and the report disagreeing about whether somebody is eligible is the
-- single worst outcome available here, and one function is how that is
-- prevented rather than promised.
create or replace function student_semester_report(
  p_student_id uuid,
  p_academic_session_id uuid default null
)
returns table (
  course_id      uuid,
  course_code    text,
  course_title   text,
  lectures_held  integer,
  attended       numeric,
  attendance_pct numeric,
  eligible       boolean,
  must_attend    integer,
  projected_pct  numeric
)
language sql
stable
as $$
  with target as (
    select coalesce(
      p_academic_session_id,
      (select id from academic_sessions where is_active limit 1)
    ) as session_id
  ),
  threshold as (
    select coalesce((select attendance_threshold_pct from app_config where id = 1), 75) as pct
  )
  select
    c.id,
    c.code,
    c.title,
    (
      select count(*)::integer
      from session_instances si
      where si.course_id = c.id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ),
    coalesce((
      select sum(ss.score)
      from session_scores ss
      join session_instances si on si.id = ss.session_instance_id
      where ss.student_id = p_student_id
        and si.course_id = c.id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ), 0),
    attendance_pct(p_student_id, c.id),
    attendance_pct(p_student_id, c.id) >= threshold.pct,
    coalesce((
      select rp.must_attend from risk_predictions rp
      where rp.student_id = p_student_id and rp.course_id = c.id
    ), 0),
    (
      select rp.predicted_pct from risk_predictions rp
      where rp.student_id = p_student_id and rp.course_id = c.id
    )
  from enrolments e
  join courses c on c.id = e.course_id
  cross join target
  cross join threshold
  where e.student_id = p_student_id
    and e.dropped_at is null
    and c.academic_session_id = target.session_id
  order by c.code;
$$;

comment on function student_semester_report(uuid, uuid) is
  'Per-course attendance and eligibility for a semester. Read by the student report, the Monday digest and the exam permit — one computation, so they cannot disagree about who may sit.';

revoke all on function student_semester_report(uuid, uuid) from public, anon;
grant execute on function student_semester_report(uuid, uuid) to authenticated, service_role;

-- A window of the term, with the delta that makes it a report rather than a
-- number. "68% this week" says nothing on its own; "68%, down from 81%" is the
-- sentence a student reacts to.
create or replace function student_period_report(
  p_student_id uuid,
  p_days       integer default 7
)
returns table (
  lectures_held      integer,
  attended           numeric,
  period_pct         numeric,
  previous_pct       numeric,
  delta              numeric,
  overall_pct        numeric
)
language sql
stable
as $$
  with bounds as (
    select
      lagos_now()::date - p_days as this_from,
      lagos_now()::date          as this_to,
      lagos_now()::date - (p_days * 2) as prev_from,
      lagos_now()::date - p_days as prev_to
  ),
  mine as (
    select si.held_on, coalesce(ss.score, 0) as score
    from enrolments e
    join session_instances si
      on si.course_id = e.course_id
     and si.status = 'closed'
     and si.held_on >= e.enrolled_on
    left join session_scores ss
      on ss.session_instance_id = si.id and ss.student_id = e.student_id
    where e.student_id = p_student_id
      and e.dropped_at is null
  ),
  windows as (
    select
      count(*) filter (where held_on > bounds.this_from and held_on <= bounds.this_to) as held_now,
      coalesce(sum(score) filter (where held_on > bounds.this_from and held_on <= bounds.this_to), 0) as got_now,
      count(*) filter (where held_on > bounds.prev_from and held_on <= bounds.prev_to) as held_prev,
      coalesce(sum(score) filter (where held_on > bounds.prev_from and held_on <= bounds.prev_to), 0) as got_prev,
      count(*) as held_all,
      coalesce(sum(score), 0) as got_all
    from mine, bounds
  )
  select
    held_now::integer,
    got_now,
    case when held_now = 0 then null else round(got_now / held_now * 100, 2) end,
    case when held_prev = 0 then null else round(got_prev / held_prev * 100, 2) end,
    -- Null rather than zero when there is nothing to compare against. A first
    -- week reported as "no change" is a claim about a week that did not exist.
    case
      when held_now = 0 or held_prev = 0 then null
      else round((got_now / held_now - got_prev / held_prev) * 100, 2)
    end,
    case when held_all = 0 then 0 else round(got_all / held_all * 100, 2) end
  from windows;
$$;

comment on function student_period_report(uuid, integer) is
  'A window of the term against the one before it. The delta is what makes it a report — "68%" says nothing that "68%, down from 81%" does not say better.';

revoke all on function student_period_report(uuid, integer) from public, anon;
grant execute on function student_period_report(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The Monday digest (§6.2)
-- ---------------------------------------------------------------------------

-- "Reports are also pushed automatically on a schedule through the same
-- notification system used for alerts, AT LOWER URGENCY."
--
-- Lower urgency is the whole design constraint. A digest is not a warning, and
-- sending it on the warning channels would teach students that a WhatsApp
-- message from Dept-Flow is routine — at which point the Critical alert in
-- week eleven arrives on a channel they have learned to ignore. The policy row
-- for `weekly_report` allows in-app and WhatsApp and no SMS, and the digest
-- goes out on a Monday morning rather than whenever the job happens to run.
create or replace function send_weekly_digests()
returns integer
language plpgsql
as $$
declare
  v_student uuid;
  v_report  record;
  v_sent    integer := 0;
  v_body    text;
begin
  for v_student in
    select s.id
    from students s
    where s.status <> 'deactivated'
      -- Somebody with no enrolments has nothing to report on, and a digest
      -- saying so every Monday is the definition of noise.
      and exists (
        select 1 from enrolments e where e.student_id = s.id and e.dropped_at is null
      )
  loop
    select * into v_report from student_period_report(v_student, 7);

    -- A week in which no lecture was held is not a week worth a message.
    -- Reading week, strike, public holiday: a digest that says "0 of 0" is a
    -- message that trains people not to open the next one.
    if v_report.lectures_held is null or v_report.lectures_held = 0 then
      continue;
    end if;

    v_body := format(
      'You attended %s of %s lectures last week (%s%%). Your attendance across the term is %s%%.',
      trim(to_char(v_report.attended, '990')),
      v_report.lectures_held,
      trim(to_char(v_report.period_pct, '990D9')),
      trim(to_char(v_report.overall_pct, '990D9'))
    );

    if v_report.delta is not null and abs(v_report.delta) >= 5 then
      v_body := v_body || format(
        ' That is %s %s points on the week before.',
        case when v_report.delta > 0 then 'up' else 'down' end,
        trim(to_char(abs(v_report.delta), '990D9'))
      );
    end if;

    perform queue_notification(
      v_student,
      'weekly_report',
      'Your week in numbers',
      v_body,
      '/reports'
    );

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

revoke all on function send_weekly_digests() from public, anon, authenticated;
grant execute on function send_weekly_digests() to service_role;

comment on function send_weekly_digests() is
  'The Monday digest, at lower urgency than a warning. Skips a week with no lectures: a message saying "0 of 0" trains people not to open the next one.';

-- ===========================================================================
-- 20260823000700_hod_messaging.sql
-- ===========================================================================

-- Dept-Flow — the HOD talking to students (§7.3)
--
-- "HOD can message students at three scopes: an individual student, a whole
-- class/level, or a course group (everyone currently registered for a given
-- course). The registration data already provides this audience mapping.
-- Messages route through the same notification channels as alerts."
--
-- The last sentence is the load-bearing one. A separate messaging system would
-- be a second thing that can fail to deliver, a second place a student's
-- WhatsApp number is read, and a second set of channel rules that would drift
-- from the first. This routes through `queue_notification()` like everything
-- else, which means an HOD message gets the WhatsApp→SMS fallback and the
-- delivery record for free.
--
-- WHAT IT IS NOT ALLOWED TO BE
--
-- Not a broadcast tool. Every send is audited with the actor, the scope and
-- the audience size, because "message every student in the department" is an
-- authority action in the same family as a grace period — it reaches four
-- hundred phones, some of them at three in the morning, and the person who
-- did it should be recoverable a year later.
--
-- And never SMS. The policy row for `hod_message` allows in-app, Web Push and
-- WhatsApp. An HOD who could spend the SMS budget on a routine notice would
-- eventually spend it, and the students would learn that a text from Dept-Flow
-- is routine — at which point the final attendance warning arrives on a
-- channel nobody reads.

-- ---------------------------------------------------------------------------
-- Who a message reached
-- ---------------------------------------------------------------------------

create type message_scope as enum ('student', 'level', 'course');

create table hod_messages (
  id            uuid primary key default gen_random_uuid(),
  sent_by       uuid not null references profiles (id),
  scope         message_scope not null,
  -- Exactly one of these is set, matching the scope.
  student_id    uuid references students (id) on delete set null,
  level         integer,
  course_id     uuid references courses (id) on delete set null,
  subject       text not null,
  body          text not null,
  recipients    integer not null default 0,
  sent_at       timestamptz not null default now(),
  constraint hod_message_subject_present check (length(btrim(subject)) > 0),
  constraint hod_message_body_substantive check (length(btrim(body)) >= 10),
  constraint hod_message_scope_targets check (
    (scope = 'student' and student_id is not null and level is null and course_id is null) or
    (scope = 'level' and level in (100, 200, 300, 400) and student_id is null and course_id is null) or
    (scope = 'course' and course_id is not null and student_id is null and level is null)
  )
);

create index hod_messages_sent_idx on hod_messages (sent_at desc);

alter table hod_messages enable row level security;

create policy hod_messages_hod_read on hod_messages
  for select to authenticated using (is_hod());

comment on table hod_messages is
  'What the HOD sent, to whom, and how many it reached. A broadcast to four hundred phones is an authority action and leaves a record like one.';

-- ---------------------------------------------------------------------------
-- Sending
-- ---------------------------------------------------------------------------

create or replace function send_hod_message(
  p_actor_id  uuid,
  p_scope     message_scope,
  p_target    uuid,
  p_level     integer,
  p_subject   text,
  p_body      text
)
returns table (message_id uuid, recipients integer)
language plpgsql
as $$
declare
  v_id      uuid;
  v_student uuid;
  v_count   integer := 0;
  v_course  courses%rowtype;
begin
  if not exists (select 1 from profiles where id = p_actor_id and role = 'hod') then
    raise exception 'only the head of department can message students';
  end if;

  if length(btrim(coalesce(p_subject, ''))) = 0 then
    raise exception 'a message must have a subject';
  end if;

  -- Ten characters, the same floor every other written justification in this
  -- system has. A message reaching four hundred phones that says "see me" is
  -- not a message, it is a summons nobody can act on.
  if length(btrim(coalesce(p_body, ''))) < 10 then
    raise exception 'a message must say something';
  end if;

  if p_scope = 'course' then
    select * into v_course from courses where id = p_target;
    if v_course.id is null then
      raise exception 'that course does not exist';
    end if;
  end if;

  insert into hod_messages (sent_by, scope, student_id, level, course_id, subject, body)
  values (
    p_actor_id,
    p_scope,
    case when p_scope = 'student' then p_target end,
    case when p_scope = 'level' then p_level end,
    case when p_scope = 'course' then p_target end,
    btrim(p_subject),
    btrim(p_body)
  )
  returning id into v_id;

  -- The audience, from the registration data — which is exactly what the doc
  -- says it is for. A course group is "everyone CURRENTLY registered", so a
  -- student who dropped it last week is not on it: they left, and a message
  -- about a course they left is the system not having noticed.
  for v_student in
    select s.id
    from students s
    where s.status <> 'deactivated'
      and (
        (p_scope = 'student' and s.id = p_target)
        or (p_scope = 'level' and s.level = p_level)
        or (p_scope = 'course' and exists (
              select 1 from enrolments e
              where e.student_id = s.id
                and e.course_id = p_target
                and e.dropped_at is null
            ))
      )
  loop
    perform queue_notification(
      v_student,
      'hod_message',
      btrim(p_subject),
      btrim(p_body),
      '/notifications'
    );
    v_count := v_count + 1;
  end loop;

  update hod_messages set recipients = v_count where id = v_id;

  perform write_audit(
    p_actor_id, 'hod', 'hod_message.sent', 'hod_messages', v_id::text, btrim(p_subject),
    jsonb_build_object(
      'scope', p_scope,
      'student_id', case when p_scope = 'student' then p_target end,
      'level', case when p_scope = 'level' then p_level end,
      'course_code', case when p_scope = 'course' then v_course.code end,
      'recipients', v_count
    )
  );

  return query select v_id, v_count;
end;
$$;

revoke all on function send_hod_message(uuid, message_scope, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function send_hod_message(uuid, message_scope, uuid, integer, text, text)
  to service_role;

comment on function send_hod_message(uuid, message_scope, uuid, integer, text, text) is
  'One message, three audiences, drawn from the registration data. Routes through queue_notification() so it gets the same channels, fallback and delivery record as everything else.';

-- ---------------------------------------------------------------------------
-- How many a message would reach, before it is sent
-- ---------------------------------------------------------------------------

-- Shown on the confirmation. "Message 412 students" is a different decision
-- from "message 12 students", and the HOD should be making the one they think
-- they are making.
create or replace function hod_message_audience(
  p_scope  message_scope,
  p_target uuid,
  p_level  integer
)
returns integer
language sql
stable
as $$
  select count(*)::integer
  from students s
  where s.status <> 'deactivated'
    and (
      (p_scope = 'student' and s.id = p_target)
      or (p_scope = 'level' and s.level = p_level)
      or (p_scope = 'course' and exists (
            select 1 from enrolments e
            where e.student_id = s.id
              and e.course_id = p_target
              and e.dropped_at is null
          ))
    );
$$;

revoke all on function hod_message_audience(message_scope, uuid, integer) from public, anon;
grant execute on function hod_message_audience(message_scope, uuid, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The HOD's payment compliance report (§7.2)
-- ---------------------------------------------------------------------------

-- Dues no longer decide whether attendance counts, which is precisely why the
-- HOD needs this as a report of its own: it used to be visible as a side
-- effect of the attendance screens, and now it is not visible anywhere unless
-- somebody goes looking.
--
-- A balance rather than a flag, because students pay in instalments and "has
-- not paid" is not the same fact as "owes ₦1,500".
create or replace function payment_compliance_report(
  p_academic_session_id uuid default null
)
returns table (
  level          integer,
  students       integer,
  paid_in_full   integer,
  part_paid      integer,
  nothing_paid   integer,
  outstanding_kobo double precision
)
language sql
stable
as $$
  with target as (
    select coalesce(
      p_academic_session_id,
      (select id from academic_sessions where is_active limit 1)
    ) as session_id
  ),
  balances as (
    select
      s.level,
      dues_balance_kobo(s.id, target.session_id) as owed,
      dues_paid_kobo(s.id, target.session_id)    as paid
    from students s
    cross join target
    where s.status <> 'deactivated'
  )
  select
    level,
    count(*)::integer,
    count(*) filter (where owed = 0)::integer,
    -- Part paid is its own row because it is its own conversation. A student
    -- who has paid half is not a student who has not paid.
    count(*) filter (where owed > 0 and paid > 0)::integer,
    count(*) filter (where paid = 0)::integer,
    coalesce(sum(owed), 0)::double precision
  from balances
  group by level
  order by level;
$$;

revoke all on function payment_compliance_report(uuid) from public, anon;
grant execute on function payment_compliance_report(uuid) to authenticated, service_role;

comment on function payment_compliance_report(uuid) is
  'Dues by level, as a balance rather than a flag. Part paid is a row of its own — a student who has paid half is not a student who has not paid.';

-- ===========================================================================
-- 20260823000800_permit_dual_condition.sql
-- ===========================================================================

-- Dept-Flow — the exam permit (§9)
--
-- "Printing the permit requires BOTH conditions: dues paid in full AND ≥75%
-- attendance in each registered course."
--
-- Payment was decoupled from attendance two migrations ago, and this is where
-- it comes back. The two facts never touch on the way in — a lecture counts
-- whether or not the student has paid a naira, which is the whole point of the
-- decoupling — and they meet exactly once, here, at the door of the exam hall.
--
-- HOW "BOTH" IS APPLIED
--
-- Each condition gates what it actually governs:
--
--   * Dues gate the DOCUMENT. An outstanding balance means no permit at all,
--     for any paper. This is the department's one point of leverage and it is
--     applied as one.
--
--   * The 75% rule gates each PAPER. A student clear of dues and above the
--     line in four of five courses is issued a permit for the four, with the
--     fifth named on it as excluded and why.
--
-- The alternative reading — one short course voids the entire permit — would
-- bar a student from four exams they are entitled to sit because of a fifth,
-- and nothing in the department's rules asks for that. It is flagged here
-- because it is a reading, not a certainty: if the intent is the harsher rule,
-- it changes `issue_exam_permit` and nothing else.
--
-- AND WHY THERE IS A PANEL, NOT A VERDICT
--
-- §9.2: "shows exactly what's outstanding per student — e.g. STA204: 68%,
-- need 3 more classes; dues: ₦4,500 outstanding — instead of a flat yes/no."
--
-- A student told "not eligible" learns nothing they can act on. A student told
-- they need three more STA204 lectures and ₦4,500 has been handed the two
-- things standing between them and the hall. Every number on that panel is
-- deterministic arithmetic on the threshold — never the forecast. The model
-- may tell a student where they are heading; it may not tell them whether
-- they can sit an exam.

-- ---------------------------------------------------------------------------
-- How many of the lectures still to come a student must attend
-- ---------------------------------------------------------------------------

-- UNCAPPED, deliberately. Ask for 14 when 11 remain and the caller learns two
-- things at once: the requirement, and that it cannot be met. Capping here
-- would collapse "you need every one of the 11 left" and "you cannot get
-- there any more" into the same number, and those are opposite conversations.
--
-- N is the smallest integer with (attended + N) / (held + remaining) >= t,
-- which is ceil(t * (held + remaining) - attended). The denominator is the
-- lectures the course will have held BY THE END, not the ones it has held so
-- far — using the latter is what turns a forecast back into a scoreboard.
create or replace function lectures_needed(
  p_student_id uuid,
  p_course_id  uuid
)
returns integer
language sql
stable
as $$
  with threshold as (
    select coalesce((select attendance_threshold_pct from app_config where id = 1), 75) / 100.0 as t
  ),
  window_of as (
    select e.enrolled_on, e.dropped_at
    from enrolments e
    where e.student_id = p_student_id and e.course_id = p_course_id
  ),
  held as (
    select
      count(*)::numeric as lectures,
      coalesce(sum(ss.score), 0)::numeric as attended
    from session_instances si
    join window_of w on si.held_on >= w.enrolled_on
                    and (w.dropped_at is null or si.held_on < w.dropped_at::date)
    left join session_scores ss
      on ss.session_instance_id = si.id and ss.student_id = p_student_id
    where si.course_id = p_course_id
      and si.status = 'closed'
  )
  select greatest(
    0,
    ceil(
      threshold.t * (held.lectures + lectures_remaining(p_course_id)) - held.attended
    )
  )::integer
  from held cross join threshold;
$$;

revoke all on function lectures_needed(uuid, uuid) from public, anon;
grant execute on function lectures_needed(uuid, uuid) to authenticated, service_role;

comment on function lectures_needed(uuid, uuid) is
  'Of the lectures still to come, how many must be attended to finish at the threshold. Uncapped: a number larger than what remains is the answer "not any more", and the caller needs to be able to tell.';

-- ---------------------------------------------------------------------------
-- The semester report, with the model taken out of its arithmetic
-- ---------------------------------------------------------------------------

-- Same shape, same callers. `must_attend` came from `risk_predictions` before,
-- which was wrong twice over: the row only exists from week five, so a student
-- in week three was told they needed zero more lectures, and it put a table
-- the model writes inside the number a student plans their term around.
--
-- `projected_pct` still comes from the model and still may: it is labelled a
-- projection everywhere it is shown, and nothing decides anything on it.
create or replace function student_semester_report(
  p_student_id uuid,
  p_academic_session_id uuid default null
)
returns table (
  course_id      uuid,
  course_code    text,
  course_title   text,
  lectures_held  integer,
  attended       numeric,
  attendance_pct numeric,
  eligible       boolean,
  must_attend    integer,
  projected_pct  numeric
)
language sql
stable
as $$
  with target as (
    select coalesce(
      p_academic_session_id,
      (select id from academic_sessions where is_active limit 1)
    ) as session_id
  ),
  threshold as (
    select coalesce((select attendance_threshold_pct from app_config where id = 1), 75) as pct
  )
  select
    c.id,
    c.code,
    c.title,
    (
      select count(*)::integer
      from session_instances si
      where si.course_id = c.id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ),
    coalesce((
      select sum(ss.score)
      from session_scores ss
      join session_instances si on si.id = ss.session_instance_id
      where ss.student_id = p_student_id
        and si.course_id = c.id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ), 0),
    attendance_pct(p_student_id, c.id),
    attendance_pct(p_student_id, c.id) >= threshold.pct,
    -- Capped here, where the caller wants an instruction rather than a
    -- diagnosis. "Attend all 11" is what a student can act on; whether 11 is
    -- enough is the `reachable` flag on the permit panel.
    least(lectures_remaining(c.id), lectures_needed(p_student_id, c.id)),
    (
      select rp.predicted_pct from risk_predictions rp
      where rp.student_id = p_student_id and rp.course_id = c.id
    )
  from enrolments e
  join courses c on c.id = e.course_id
  cross join target
  cross join threshold
  where e.student_id = p_student_id
    and e.dropped_at is null
    and c.academic_session_id = target.session_id
  order by c.code;
$$;

-- ---------------------------------------------------------------------------
-- The live eligibility panel (§9.2)
-- ---------------------------------------------------------------------------

-- Built on `student_semester_report()` rather than beside it, which is §6.3
-- taken literally: "the semester report shares its generation logic with the
-- exam permit document — built once, reused." A permit and a report that
-- disagree about one course would be the system arguing with itself in front
-- of the student it is about.
create or replace function permit_eligibility(
  p_student_id uuid,
  p_academic_session_id uuid default null
)
returns table (
  course_id          uuid,
  course_code        text,
  course_title       text,
  attendance_pct     numeric,
  lectures_held      integer,
  attended           numeric,
  lectures_remaining integer,
  must_attend        integer,
  reachable          boolean,
  eligible           boolean
)
language sql
stable
as $$
  select
    r.course_id,
    r.course_code,
    r.course_title,
    r.attendance_pct,
    r.lectures_held,
    r.attended,
    lectures_remaining(r.course_id),
    r.must_attend,
    -- The sentence a student most needs and the one a yes/no cannot carry:
    -- whether there is still a route to 75% at all. False means every
    -- remaining lecture attended still finishes below the line, and the honest
    -- thing is to say so now rather than in the last week of term.
    lectures_needed(p_student_id, r.course_id) <= lectures_remaining(r.course_id),
    r.eligible
  from student_semester_report(p_student_id, p_academic_session_id) r
  order by r.course_code;
$$;

revoke all on function permit_eligibility(uuid, uuid) from public, anon;
grant execute on function permit_eligibility(uuid, uuid) to authenticated, service_role;

comment on function permit_eligibility(uuid, uuid) is
  'What is outstanding, per course, in the terms a student can act on: the percentage, how many of the remaining lectures they must attend, and whether the threshold is still reachable at all.';

-- ---------------------------------------------------------------------------
-- Issuing, now that dues gate the document
-- ---------------------------------------------------------------------------

create or replace function issue_exam_permit(
  p_student_id          uuid,
  p_academic_session_id uuid
)
returns text
language plpgsql
as $$
declare
  v_reference text;
  v_eligible  integer;
  v_year      text;
  v_owed      double precision;
begin
  select reference into v_reference
  from exam_permits
  where student_id = p_student_id and academic_session_id = p_academic_session_id;

  if v_reference is not null then
    return v_reference;
  end if;

  -- No authorized list marking them eligible for anything means no permit.
  select count(*) into v_eligible
  from eligibility_entries ee
  join eligibility_lists el on el.id = ee.list_id
  where ee.student_id = p_student_id
    and el.academic_session_id = p_academic_session_id
    and el.status = 'authorized'
    and ee.eligible;

  if v_eligible = 0 then
    return null;
  end if;

  -- §9.1, the dues half.
  --
  -- After the authorization check, not before it: while no list exists there
  -- is no permit for anybody, and answering "you owe money" to a student who
  -- would not have one either way is answering a question they did not ask.
  --
  -- Before the reference is allocated, though, and that order is not
  -- negotiable: a reference is permanent. Allocating one and then refusing to
  -- render the document leaves a record of a permit that was never issued and
  -- a student holding a reference that verifies against nothing.
  v_owed := dues_balance_kobo(p_student_id, p_academic_session_id);
  if v_owed > 0 then
    raise exception 'dues outstanding: % kobo', v_owed
      using errcode = 'check_violation';
  end if;

  select left(regexp_replace(name, '[^0-9]', '', 'g'), 4)
    into v_year
  from academic_sessions where id = p_academic_session_id;

  -- Retried rather than trusted: six characters from a 32-symbol alphabet is
  -- ample, but a collision must fail the download rather than hand two
  -- students one reference.
  for i in 1..10 loop
    v_reference := 'DF-' || coalesce(nullif(v_year, ''), '0000') || '-' ||
      upper(
        translate(
          substr(encode(gen_random_bytes(8), 'base64'), 1, 6),
          -- Removing the characters a person copying by hand confuses.
          '+/OIL01', 'XYZWVUT'
        )
      );

    begin
      insert into exam_permits (student_id, academic_session_id, reference)
      values (p_student_id, p_academic_session_id, v_reference);
      return v_reference;
    exception when unique_violation then
      -- Another download of the same permit won the race: return theirs.
      select reference into v_reference
      from exam_permits
      where student_id = p_student_id and academic_session_id = p_academic_session_id;
      if v_reference is not null then return v_reference; end if;
    end;
  end loop;

  raise exception 'could not allocate a permit reference';
end;
$$;

comment on function issue_exam_permit(uuid, uuid) is
  'One reference per student per session. Refuses while dues are outstanding — §9.1, the single place where payment and attendance meet.';

-- ===========================================================================
-- 20260823000900_alert_copy_reachability.sql
-- ===========================================================================

-- Dept-Flow — telling a student the truth when the line is out of reach
--
-- A bug found by reading the seeded demo output rather than the code.
--
-- `send_risk_alerts()` had two Critical messages: "attend N of the M left and
-- you reach 75%", and — when there was no slack at all — "you have M lectures
-- left and need every one of them to reach 75%".
--
-- The second is false whenever the threshold can no longer be reached. A
-- student on 5 of 13 with 17 lectures to come finishes at 22/30 = 73.3% having
-- attended every single one, and the message told her she would reach 75%.
--
-- That is the worst kind of wrong this system can be. It is not an error the
-- student can detect: she does the arithmetic the message asked her to do,
-- attends everything for eleven weeks, and finds out at the permit screen.
-- Every other warning is designed to be acted on, and this one could only be
-- acted on uselessly.
--
-- The honest message says the line is gone and names the route that is left. A
-- waiver and a dispute are real mechanisms this system already has, and both
-- of them need a conversation with the department rather than more attendance.
--
-- `must_attend` is capped at what remains, which is right for an instruction
-- and useless as a diagnosis — capped, "attend 21" and "attend 17" are the
-- same number. `lectures_needed()` is uncapped, which is exactly what makes it
-- able to answer this.

create or replace function send_risk_alerts()
returns integer
language plpgsql
as $$
declare
  v_row       record;
  v_sent      integer := 0;
  v_note      uuid;
  v_title     text;
  v_body      text;
  v_channels  notification_channel[];
  v_remaining integer;
  v_reachable boolean;
begin
  for v_row in
    select
      rp.*,
      c.code as course_code,
      (select tier from risk_alerts_sent prev
        where prev.student_id = rp.student_id
          and prev.course_id = rp.course_id
        order by prev.sent_at desc
        limit 1) as last_tier
    from risk_predictions rp
    join courses c on c.id = rp.course_id
    join students s on s.id = rp.student_id
    where rp.tier in ('watch', 'critical')
      and s.status <> 'deactivated'
  loop
    -- Already told, at this tier, and nothing has changed. Silence is the
    -- correct output: an alert that repeats every night is an alert a student
    -- mutes, and a muted channel is one that cannot warn them in week eleven.
    if v_row.last_tier is not distinct from v_row.tier then
      continue;
    end if;

    v_remaining := v_row.lectures_expected - v_row.lectures_held;
    v_reachable := lectures_needed(v_row.student_id, v_row.course_id) <= v_remaining;

    if v_row.tier = 'critical' then
      -- §5.3: in-app, Web Push, WhatsApp. SMS is held back for the final
      -- warning rather than spent on the first Critical — a student who gets a
      -- text in week six has nothing left to escalate to in week eleven.
      v_channels := array['in_app', 'web_push', 'whatsapp']::notification_channel[];

      if not v_reachable then
        -- Nothing they can do about it by attending, which is precisely why it
        -- earns the last channel: this is the message that has to arrive.
        v_channels := v_channels || 'sms'::notification_channel;

        v_title := format('%s: 75%% is no longer reachable', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. Even attending all %s remaining lectures finishes below 75%%. Attendance alone cannot fix this now — speak to the department office about a waiver or a dispute.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_remaining
        );

      elsif v_row.can_still_miss = 0 then
        -- Still reachable, with no slack at all: every remaining lecture is
        -- needed, so the next one missed ends it. Also an SMS, because there is
        -- nothing after it to escalate to.
        v_channels := v_channels || 'sms'::notification_channel;

        v_title := format('%s: you must attend every remaining lecture', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. You have %s lectures left and need every one of them to reach 75%%. Missing one more makes you ineligible for the exam.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_remaining
        );

      else
        v_title := format('%s: you are on course to miss the 75%% mark', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. Attend %s of the %s lectures left and you reach 75%%. You can miss %s.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_row.must_attend,
          v_remaining,
          v_row.can_still_miss
        );
      end if;
    else
      -- Watch: in-app and Web Push. No WhatsApp — a student who is on course
      -- to land exactly on the line needs to know, and does not need a
      -- message on the channel reserved for the students who are failing.
      v_channels := array['in_app', 'web_push']::notification_channel[];
      v_title := format('%s: no buffer left', v_row.course_code);
      v_body := format(
        '%s is projected to finish at %s%%, which is just above the 75%% line. You can miss %s more lectures — after that there is no room left.',
        v_row.course_code,
        trim(to_char(v_row.predicted_pct, '990D9')),
        v_row.can_still_miss
      );
    end if;

    v_note := queue_notification(
      v_row.student_id,
      'attendance_warning',
      v_title,
      v_body,
      '/courses/' || replace(v_row.course_code, ' ', '-'),
      v_channels
    );

    insert into risk_alerts_sent (student_id, course_id, tier, predicted_pct, notification_id)
    values (v_row.student_id, v_row.course_id, v_row.tier, v_row.predicted_pct, v_note);

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

comment on function send_risk_alerts() is
  'One alert per student per course per tier change. Never promises a threshold that cannot be reached — a student who attends everything the message asked for and still fails has been misled by the warning system itself.';

-- ===========================================================================
-- 20260823001000_payment_self_healing.sql
-- ===========================================================================

-- Dept-Flow — payments that reconcile themselves (§8.4)
--
-- "A reconciliation job polls Paystack periodically for anything still
-- pending, to catch webhooks that never arrive."
--
-- Nobody should ever have to press a re-verify button. A student who has paid
-- and is waiting on a webhook that got lost is a student whose money the
-- department is holding without crediting, and the fix must not depend on
-- somebody noticing.
--
-- WHY THE SCHEDULE LIVES HERE AND NOT IN THE JOB
--
-- Two callers ask the same question — the background sweep, and the student's
-- own dues screen when they come back to look. If each carried its own "is
-- this one due yet" rule they would drift, and the drift would show up as
-- Paystack rate-limiting one path or the other going quiet. `next_check_at` is
-- a column: the rule is written once, and both callers reduce to `where
-- next_check_at <= now()`, which is one indexed read.
--
-- THE TWO THINGS THIS GETS RIGHT THAT A NAIVE POLLER GETS WRONG
--
-- 1. **Giving up asking is not giving up accepting.** After two days of
--    Paystack answering "pending", a checkout is abandoned and the row is
--    marked so — the student's screen stops saying "Checking payment…" for
--    ever. But `settle` still verifies an abandoned row, so a webhook that
--    arrives on day four still credits them. The polling stops; the door
--    does not close.
--
-- 2. **"Could not ask" is never recorded as "no".** A 500 from Paystack, a DNS
--    failure, an expired key — none of those are evidence about a student's
--    money. Those rows are rescheduled and NEVER abandoned, however many times
--    it happens. Only Paystack actually answering resolves a payment.

alter table payments
  -- How many times we have asked. Not for the backoff — the age drives that —
  -- but so a human looking at a stuck row can tell "asked once and failed"
  -- from "asked forty times and Paystack keeps saying pending".
  add column check_attempts integer not null default 0,
  -- When to ask next. Null means never again: either it is resolved, or we
  -- have stopped asking. The whole scheduler is this one column.
  add column next_check_at  timestamptz;

comment on column payments.next_check_at is
  'When the reconciliation sweep should next ask Paystack about this row. Null means stop asking — which is not the same as stop accepting: a late webhook still resolves an abandoned row.';

-- Partial, because it is only ever queried for pending rows and a full index
-- over every payment ever taken would be mostly dead weight.
create index payments_due_for_check_idx
  on payments (next_check_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- The backoff curve
-- ---------------------------------------------------------------------------

-- Shaped to how the money actually moves. A card settles in seconds and a
-- transfer in minutes, so the first minute belongs to the webhook — asking
-- during it would be racing our own notification for no reason. After that the
-- interval widens with the age of the payment, because a row still pending
-- after six hours is far more likely to be an abandoned checkout than a slow
-- one, and there is no sense spending a request a minute on it.
--
--   age < 2 min    →  ask again in 90 seconds
--   age < 30 min   →  every 2 minutes
--   age < 6 hours  →  every 15 minutes
--   age < 48 hours →  every 2 hours
--   age >= 48 h    →  stop asking, and call it abandoned
create or replace function schedule_payment_check(
  p_payment_id uuid,
  -- True when Paystack actually answered. False when we could not reach it,
  -- which is a fact about the network and not about the student.
  p_answered   boolean default true
)
returns timestamptz
language plpgsql
as $$
declare
  v_payment payments%rowtype;
  v_age     interval;
  v_next    timestamptz;
begin
  select * into v_payment from payments where id = p_payment_id;
  if v_payment.id is null then
    raise exception 'no such payment';
  end if;

  update payments
     set check_attempts = check_attempts + 1,
         last_checked_at = now()
   where id = p_payment_id;

  -- Resolved rows are never asked about again. Reaching here with one means a
  -- caller settled it and then scheduled anyway; harmless, and worth handling
  -- rather than leaving a resolved row with a live schedule.
  if v_payment.status <> 'pending' then
    update payments set next_check_at = null where id = p_payment_id;
    return null;
  end if;

  -- Paystack unreachable. Retry steadily and never abandon: we have learned
  -- nothing about this payment, and recording "abandoned" on the strength of
  -- our own network trouble would tell a student who paid that they did not.
  if not p_answered then
    v_next := now() + interval '10 minutes';
    update payments set next_check_at = v_next where id = p_payment_id;
    return v_next;
  end if;

  v_age := now() - v_payment.initialized_at;

  if v_age < interval '2 minutes' then
    v_next := now() + interval '90 seconds';
  elsif v_age < interval '30 minutes' then
    v_next := now() + interval '2 minutes';
  elsif v_age < interval '6 hours' then
    v_next := now() + interval '15 minutes';
  elsif v_age < interval '48 hours' then
    v_next := now() + interval '2 hours';
  else
    -- Two days of Paystack saying "pending" is a checkout nobody completed.
    -- Marked so the student's screen stops claiming something is in flight,
    -- and the schedule cleared so we stop spending requests on it.
    --
    -- `verified_at` stays null, which the payment_success_is_verified
    -- constraint requires and which is the honest record: nothing was verified
    -- because there was nothing to verify.
    update payments
       set status = 'abandoned',
           next_check_at = null
     where id = p_payment_id;
    return null;
  end if;

  update payments set next_check_at = v_next where id = p_payment_id;
  return v_next;
end;
$$;

revoke all on function schedule_payment_check(uuid, boolean) from public, anon, authenticated;
grant execute on function schedule_payment_check(uuid, boolean) to service_role;

comment on function schedule_payment_check(uuid, boolean) is
  'Widens the polling interval with the age of the payment, and abandons after two days of Paystack answering "pending". Never abandons on an unreachable Paystack — that is a fact about the network, not about the student.';

-- ---------------------------------------------------------------------------
-- What the sweep should pick up
-- ---------------------------------------------------------------------------

create or replace function payments_due_for_check(p_limit integer default 25)
returns table (
  payment_id uuid,
  reference  text,
  student_id uuid,
  attempts   integer,
  age_seconds integer
)
language sql
stable
as $$
  select
    p.id,
    p.paystack_reference,
    p.student_id,
    p.check_attempts,
    extract(epoch from (now() - p.initialized_at))::integer
  from payments p
  where p.status = 'pending'
    and p.next_check_at is not null
    and p.next_check_at <= now()
  -- Oldest first. A student who has been waiting since this morning is ahead
  -- of one who checked out ninety seconds ago, whatever else is in the queue.
  order by p.initialized_at
  limit greatest(1, least(p_limit, 200));
$$;

revoke all on function payments_due_for_check(integer) from public, anon, authenticated;
grant execute on function payments_due_for_check(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Every new payment is scheduled the moment it is written
-- ---------------------------------------------------------------------------

-- A trigger rather than the application remembering to do it. There is one
-- place a pending payment is created today and there may be two tomorrow, and
-- a payment that was never scheduled is invisible to the sweep — which is
-- precisely the failure this whole migration exists to remove.
create or replace function schedule_new_payment()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'pending' and new.next_check_at is null then
    -- Ninety seconds: long enough that the webhook usually beats us to it, so
    -- the common case costs Paystack nothing.
    new.next_check_at := now() + interval '90 seconds';
  end if;
  return new;
end;
$$;

create trigger payments_schedule_first_check
  before insert on payments
  for each row execute function schedule_new_payment();

-- Rows that predate this migration. Without the backfill the sweep would only
-- ever see payments taken after deployment, and the stuck ones this was built
-- to rescue — which are all older than it — would stay stuck for ever.
update payments
   set next_check_at = now()
 where status = 'pending'
   and next_check_at is null;

-- ---------------------------------------------------------------------------
-- Is reconciliation actually working?
-- ---------------------------------------------------------------------------

-- The failure mode that looks like health: the sweep is not scheduled, every
-- screen renders, and pending payments quietly pile up. `/api/health` reads
-- this, so the answer is one number rather than an investigation.
create or replace function reconciliation_health()
returns table (
  pending          integer,
  overdue          integer,
  oldest_overdue_seconds integer,
  stuck            integer
)
language sql
stable
as $$
  select
    count(*) filter (where status = 'pending')::integer,
    count(*) filter (where status = 'pending' and next_check_at <= now())::integer,
    coalesce(
      max(extract(epoch from (now() - next_check_at))) filter (
        where status = 'pending' and next_check_at <= now()
      ), 0
    )::integer,
    -- Asked many times and still unresolved. Either Paystack has been
    -- unreachable for hours or something is wrong with the key, and both are
    -- worth a person looking.
    count(*) filter (where status = 'pending' and check_attempts >= 10)::integer
  from payments;
$$;

revoke all on function reconciliation_health() from public, anon;
grant execute on function reconciliation_health() to authenticated, service_role;

comment on function reconciliation_health() is
  'Overdue is the number that matters: rows the sweep should already have picked up. Persistently above zero means the sweep is not running, which is the failure that looks like health.';
