-- Dept-Flow — retiring the waiver
--
-- The waiver was designed when dues decided whether a lecture counted.
-- Granting one converted a student's provisional scores and let them back into
-- counted attendance, which is why ..._waivers_and_disputes.sql describes it as
-- "identical in effect to a payment".
--
-- The August 2026 revision removed that job. Payment stopped gating attendance,
-- `clear_student()` was rebuilt to touch no score and return zero, and the
-- waiver was left holding a compliance state that no longer decides anything.
--
-- What it had left was the exam permit's dues condition, and it did not do that
-- either. Verified against a live database rather than inferred:
--
--     balance BEFORE waiver: 500000 kobo
--     decide_waiver returns: granted
--     compliance state AFTER waiver: cleared
--     balance AFTER waiver:  500000 kobo
--     permit dues gate would refuse? t
--
-- The chain is short. Granting set the compliance state and nothing else.
-- `dues_balance_kobo()` is the dues amount minus successful PAYMENT rows, and a
-- waiver writes no payment. `issue_exam_permit()` reads that balance and never
-- looks at compliance state. So the HOD granted a waiver, the student's badge
-- read cleared, and the permit still refused them for the money.
--
-- Two ways out: teach the balance about waivers, or remove the mechanism. This
-- is the second, by decision. A department that needs to forgive a fee can
-- record it on the payment side, where the balance is actually computed, and
-- where the admin already records manual payments with a reason and an audit
-- row. One place decides what is owed.
--
-- WHAT IS DELIBERATELY LEFT BEHIND
--
-- The audit rows. `audit_log` cannot be updated or deleted from, by trigger
-- rather than by convention, and that is correct here: waivers were granted,
-- and a history that quietly loses them is worse than one that records a
-- mechanism since retired.
--
-- The `clearance_route` enum keeps its 'waiver' value. It is data-bearing —
-- `compliance_statuses.cleared_via` may hold it in a project that granted one —
-- and removing a single value would leave 'hod_clearance' and 'grace_period'
-- beside it, both of which already have no caller. Whether that vocabulary
-- should shrink is a decision about the whole enum, not a side effect of this
-- change.

-- ---------------------------------------------------------------------------
-- The mechanism
-- ---------------------------------------------------------------------------

drop function if exists decide_waiver(uuid, uuid, boolean, text);

-- The policies go with the table; naming them would only be a second place to
-- keep the list correct.
drop table if exists waivers;

drop type if exists waiver_status;

-- ---------------------------------------------------------------------------
-- The health report has to stop expecting them
-- ---------------------------------------------------------------------------

-- Otherwise /api/health reports a missing function and a missing table for the
-- life of the project, which is precisely the signal it exists to give
-- truthfully. A health check that cries wolf is worse than none: the next
-- genuinely half-applied migration set would be read as the same old noise.
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
    'exam_permits', 'push_subscriptions'
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
  'What /api/health reports. Names the missing pieces so a half-applied migration set is diagnosable. Covers the revision''s own tables and functions, which the original list predated.';

revoke all on function dept_flow_schema_report() from public, anon, authenticated;
grant execute on function dept_flow_schema_report() to service_role;
