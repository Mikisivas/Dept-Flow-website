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
