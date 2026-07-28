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
