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
