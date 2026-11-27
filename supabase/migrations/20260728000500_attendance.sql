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
