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
