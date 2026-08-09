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
