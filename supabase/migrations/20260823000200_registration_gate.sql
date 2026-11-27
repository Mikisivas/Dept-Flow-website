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
