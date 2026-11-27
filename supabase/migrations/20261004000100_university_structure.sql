-- Dept-Flow — the university above the department
--
-- The thesis is now "an Examination-Eligibility Alert System for Rev. Fr.
-- Moses Orshio Adasu University, Makurdi", scoped to the Department of
-- Mathematics and Computer Science. The front door shows the university:
-- every faculty, and the departments under each. Exactly one of those
-- departments runs on this system.
--
-- This is a DIRECTORY, not a tenancy. Nothing else in the schema refers to it:
-- students, courses, attendance, dues and permits remain one department's, and
-- the MTH | CMP | STA checks stay exactly as they are. Bringing a second
-- department on would mean scoping all of those, which is a different and much
-- larger migration. What this buys is the honest version of that promise: the
-- landing page can show the whole university, and say plainly which
-- departments are not on the system yet, without a hardcoded list in a React
-- file pretending to be institutional data.
--
-- The list was supplied by the student from the university's published
-- faculty structure. Departments named only loosely there ("and related
-- disciplines") are not invented: their faculty is listed with no departments
-- until the real names are known.

create table faculties (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  sort_order  integer not null,
  created_at  timestamptz not null default now(),
  constraint faculty_name_present check (length(trim(name)) > 0)
);

create table departments (
  id          uuid primary key default gen_random_uuid(),
  faculty_id  uuid not null references faculties (id) on delete cascade,
  name        text not null,
  -- On the system. A department that is not active is shown and does nothing.
  is_active   boolean not null default false,
  sort_order  integer not null,
  created_at  timestamptz not null default now(),
  unique (faculty_id, name),
  constraint department_name_present check (length(trim(name)) > 0)
);

create index departments_faculty_idx on departments (faculty_id);

-- One department, because everything downstream of this table is one
-- department's. A second active row would tell the landing page to send a
-- Chemistry student to a login whose register rejects every matric number
-- that is not MTH, CMP or STA. Lift this in the same migration that scopes the
-- rest of the schema by department, and not before.
create unique index departments_one_active
  on departments ((true))
  where is_active;

comment on table faculties is
  'The university''s faculties, for the public directory on the landing page. Referenced by nothing operational.';
comment on table departments is
  'Departments under each faculty. is_active marks the one department this system serves; the rest are listed and inert.';

-- ---------------------------------------------------------------------------
-- The list
-- ---------------------------------------------------------------------------

insert into faculties (name, sort_order) values
  ('Faculty of Administration and Management', 10),
  ('Faculty of Arts',                          20),
  ('Faculty of Basic Medical Sciences',        30),
  ('Faculty of Clinical Sciences',             40),
  ('Faculty of Communication and Media Studies', 50),
  ('Faculty of Education',                     60),
  ('Faculty of Environmental Sciences',        70),
  ('Faculty of Law',                           80),
  ('Faculty of Science',                       90),
  ('Faculty of Social Sciences',               100);

insert into departments (faculty_id, name, sort_order, is_active)
select f.id, d.name, d.sort_order, d.is_active
from (values
  ('Faculty of Administration and Management', 'Accounting',                     10, false),
  ('Faculty of Administration and Management', 'Business Administration',        20, false),
  ('Faculty of Administration and Management', 'Public Administration',          30, false),

  ('Faculty of Arts', 'English Language and Literature', 10, false),
  ('Faculty of Arts', 'History',                         20, false),
  ('Faculty of Arts', 'Language and Linguistics',        30, false),
  ('Faculty of Arts', 'Religion and Cultural Studies',   40, false),
  ('Faculty of Arts', 'Philosophy',                      50, false),
  ('Faculty of Arts', 'Theatre Arts',                    60, false),

  ('Faculty of Communication and Media Studies', 'Advertising',                       10, false),
  ('Faculty of Communication and Media Studies', 'Broadcasting',                      20, false),
  ('Faculty of Communication and Media Studies', 'Development Communication Studies', 30, false),
  ('Faculty of Communication and Media Studies', 'Journalism and Media Studies',      40, false),
  ('Faculty of Communication and Media Studies', 'Public Relations',                  50, false),
  ('Faculty of Communication and Media Studies', 'Strategic Communications',          60, false),

  ('Faculty of Education', 'Vocational and Technical Education',      10, false),
  ('Faculty of Education', 'Curriculum and Teaching',                 20, false),
  ('Faculty of Education', 'Educational Foundations',                 30, false),
  ('Faculty of Education', 'Human Kinetics and Health Education',     40, false),
  ('Faculty of Education', 'Arts and Social Sciences Education',      50, false),
  ('Faculty of Education', 'Science and Mathematics Education',       60, false),
  ('Faculty of Education', 'Library and Information Science',         70, false),

  ('Faculty of Environmental Sciences', 'Geography',                   10, false),
  ('Faculty of Environmental Sciences', 'Urban and Regional Planning', 20, false),

  ('Faculty of Law', 'Public Law',                         10, false),
  ('Faculty of Law', 'Private Law',                        20, false),
  ('Faculty of Law', 'Commercial Law',                     30, false),
  ('Faculty of Law', 'International Law and Jurisprudence', 40, false),

  ('Faculty of Science', 'Biological Sciences',               10, false),
  ('Faculty of Science', 'Chemistry',                         20, false),
  ('Faculty of Science', 'Mathematics and Computer Science',  30, true),
  ('Faculty of Science', 'Physics',                           40, false),

  ('Faculty of Social Sciences', 'Economics',             10, false),
  ('Faculty of Social Sciences', 'Mass Communication',    20, false),
  ('Faculty of Social Sciences', 'Political Science',     30, false),
  ('Faculty of Social Sciences', 'Psychology',            40, false),
  ('Faculty of Social Sciences', 'Public Administration', 50, false),
  ('Faculty of Social Sciences', 'Sociology',             60, false)
) as d (faculty, name, sort_order, is_active)
join faculties f on f.name = d.faculty;

-- ---------------------------------------------------------------------------
-- Who reads it
-- ---------------------------------------------------------------------------

-- The first and only thing in this schema the anonymous role can read. It is
-- the list the university prints in its prospectus, and the landing page is
-- shown before anyone has logged in. Read-only to everyone; it changes by
-- migration, so nobody below the service role writes it.
alter table faculties   enable row level security;
alter table departments enable row level security;

revoke all on faculties, departments from public, anon, authenticated;
grant select on faculties, departments to anon, authenticated;

create policy faculties_read on faculties
  for select to anon, authenticated using (true);

create policy departments_read on departments
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- The health report learns the new tables
-- ---------------------------------------------------------------------------

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
    'resolve_dispute',
    'deactivate_student', 'reactivate_student', 'resolve_registration_dispute',
    'run_level_rollover',
    'cancel_session', 'schedule_makeup', 'reschedule_session', 'notify_enrolled',
    'authorize_eligibility_list',
    'enrol_in_core_courses', 'add_optional_course', 'drop_optional_course',
    'student_credit_units',
    -- the August 2026 revision, and the settings it made reachable
    'confirm_registration', 'attendance_eligibility', 'is_registration_open',
    'compute_risk_predictions', 'send_risk_alerts', 'lectures_needed',
    'dues_balance_kobo', 'apply_payment', 'issue_exam_permit',
    'send_hod_message', 'hod_message_audience',
    'set_registration_period', 'set_dues_period', 'dues_change_impact'
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
    'dues_periods', 'payments', 'attendance_disputes',
    'registration_disputes', 'grace_periods', 'eligibility_lists',
    'eligibility_entries', 'notifications', 'audit_log', 'otp_codes',
    'level_rollovers', 'app_config', 'risk_predictions',
    'manual_attendance_batches',
    -- the revision's own tables, absent from the original list
    'registration_periods', 'course_registrations', 'hod_messages',
    'exam_permits', 'push_subscriptions',
    -- the university directory on the landing page
    'faculties', 'departments'
  ]) as wanted
  where to_regclass('public.' || wanted) is null;

  return jsonb_build_object(
    'up_to_date', cardinality(v_missing_functions) = 0 and cardinality(v_missing_tables) = 0,
    'missing_functions', to_jsonb(v_missing_functions),
    'missing_tables', to_jsonb(v_missing_tables),
    'has_venue_directory', to_regclass('public.venue_directory') is not null,
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
  'What /api/health reports. Names the missing pieces so a half-applied migration set is diagnosable. Covers the revision''s own tables and functions, and the university directory.';
