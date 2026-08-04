-- Dept-Flow — backfill after 20260728001300_course_registration.sql
--
-- Run this ONCE, on a project that already had data before that migration.
-- A fresh project seeded from seed.sql does not need it.
--
-- Why it is needed
-- ----------------
-- The migration adds `enrolments.enrolled_on` with `default current_date`,
-- because that is the right default for a student enrolling today. Applied to
-- rows that already existed, it says every student joined every course TODAY —
-- and the attendance denominator counts only lectures held from the join date.
--
-- So every lecture already on record falls outside every student's window, the
-- denominator becomes zero, and the whole cohort reads 0%. This puts the dates
-- back.
--
-- Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- Enrolment dates
-- ---------------------------------------------------------------------------

-- Every enrolment already in the database predates the feature that records
-- join dates, so none of them can be a genuine late enrolment — the flow that
-- creates those did not exist yet. They all belong at the start of the session.
--
-- `least` rather than a plain assignment so that re-running this cannot push a
-- date forward, and so a project that has since recorded a real late enrolment
-- is left alone.
--
-- Note the ordering: this runs BEFORE the block that enrols students who have
-- no courses at all. Those students really did join today, and back-dating
-- them would hand them a term of absences they were never present for.
update enrolments e
   set enrolled_on = least(e.enrolled_on, s.starts_on)
  from academic_sessions s
  join courses c on c.academic_session_id = s.id
 where c.id = e.course_id;

-- ---------------------------------------------------------------------------
-- Course metadata
-- ---------------------------------------------------------------------------

-- The migration defaulted every course to core, 3 units, first semester. That
-- is right for most of them and wrong for the seeded elective, and the 24-unit
-- cap is meaningless until the real numbers are in.
update courses set kind = 'elective', credit_units = 2 where code = 'STA 202';
update courses set kind = 'core',     credit_units = 3 where code in ('CMP 301', 'MTH 205');

-- ---------------------------------------------------------------------------
-- Enrolment sources
-- ---------------------------------------------------------------------------

-- Everything defaulted to 'core'. A course below the student's own level is a
-- carry-over, and an elective at their level is a choice — and the difference
-- decides whether they are allowed to drop it.
update enrolments e
   set source = 'carry_over'
  from courses c, students st
 where c.id = e.course_id
   and st.id = e.student_id
   and c.level < st.level;

update enrolments e
   set source = 'elective'
  from courses c, students st
 where c.id = e.course_id
   and st.id = e.student_id
   and c.level = st.level
   and c.kind = 'elective';

-- ---------------------------------------------------------------------------
-- Students registered before core enrolment existed
-- ---------------------------------------------------------------------------

-- Accounts created between the registration flow going live and this migration
-- have no enrolments at all, so no lecture can count for or against them. They
-- are invisible to the system they joined.
do $$
declare
  v_session uuid;
  r record;
begin
  select id into v_session from academic_sessions where is_active limit 1;
  if v_session is null then return; end if;

  for r in
    select st.id
    from students st
    where not exists (select 1 from enrolments e where e.student_id = st.id)
  loop
    perform enrol_in_core_courses(r.id, v_session);
  end loop;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- What it did
-- ---------------------------------------------------------------------------

select
  st.matric_no,
  c.code,
  e.source,
  e.enrolled_on,
  (select count(*) from session_instances si
    where si.course_id = e.course_id
      and si.status = 'closed'
      and si.held_on >= e.enrolled_on) as lectures_in_denominator
from enrolments e
join students st on st.id = e.student_id
join courses c on c.id = e.course_id
where e.dropped_at is null
order by st.matric_no, c.code;
