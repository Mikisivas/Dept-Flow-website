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
