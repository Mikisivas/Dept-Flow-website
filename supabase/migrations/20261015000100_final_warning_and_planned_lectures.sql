-- Dept-Flow — the final warning is sent, and a course can say how long it is
--
-- Two corrections, found by checking the thesis's test plan against the code.
--
-- 1. THE FINAL WARNING WAS NEVER SENT
--
-- send_risk_alerts() writes one alert per tier change. Its own comments say SMS
-- is "held back for the final warning rather than spent on the first Critical
-- — a student who gets a text in week six has nothing left to escalate to in
-- week eleven." But a student who turns Critical in week six, while 75% is
-- still reachable, is Critical again in week eleven, and the function skipped
-- them: same tier, nothing sent. The SMS was held back for a message the
-- system then never wrote. The student who most needed the last channel was
-- the one guaranteed not to receive it.
--
-- The fix gives Critical three stages, in order of how little is left:
--
--     critical               below the line, with lectures to spare
--     critical_no_slack      every remaining lecture is needed
--     critical_unreachable   attending everything left still finishes below
--
-- A new alert goes out when the tier changes, as before, and ALSO when a
-- Critical student moves to a worse stage. A stage that improves within
-- Critical stays silent, so the "once per tier, not once per night" rule still
-- holds for everyone whose position has not worsened.
--
-- 2. REMAINING LECTURES CAME ONLY FROM THE CALENDAR
--
-- lectures_remaining() is weekly timetable slots times the weeks left in the
-- session. That is right for a real course, and it stays the default. It is
-- wrong for a course whose length is known and whose lectures do not follow
-- the calendar: a test course run in arranged sessions over a few days, or a
-- course the department has fixed at a number of lectures. Holding a lecture
-- never reduced the count, so the projection could not move the way the
-- lectures did.
--
-- courses.planned_lectures, when set, makes remaining = planned minus the
-- lectures already closed. Null (every existing course) keeps the calendar.
-- lectures_needed(), the what-if calculator and the permit panel all read
-- lectures_remaining(), so they move together and cannot disagree.

-- ---------------------------------------------------------------------------
-- A course can state its length
-- ---------------------------------------------------------------------------

alter table courses
  add column planned_lectures integer
    constraint courses_planned_lectures_range
    check (planned_lectures is null or planned_lectures between 1 and 200);

comment on column courses.planned_lectures is
  'Total lectures the course will hold, when known. Null means count the rest from the timetable and the session end date.';

create or replace function lectures_remaining(p_course_id uuid)
returns integer
language sql
stable
as $$
  with course_session as (
    select a.ends_on, c.planned_lectures
    from courses c
    join academic_sessions a on a.id = c.academic_session_id
    where c.id = p_course_id
  ),
  slots as (
    select count(*)::numeric as per_week
    from timetable_entries t
    where t.course_id = p_course_id
  ),
  closed as (
    select count(*)::integer as held
    from session_instances si
    where si.course_id = p_course_id
      and si.status = 'closed'
  )
  select case
    when course_session.planned_lectures is not null then
      greatest(0, course_session.planned_lectures - closed.held)
    else
      greatest(
        0,
        floor(
          slots.per_week
          * greatest(0, (course_session.ends_on - current_date))::numeric / 7.0
        )
      )::integer
  end
  from course_session, slots, closed;
$$;

comment on function lectures_remaining(uuid) is
  'Planned lectures minus those already closed, when the course states its length. Otherwise weekly slots times the weeks left in the session; a course with neither returns 0, which makes its projection its current rate.';

-- ---------------------------------------------------------------------------
-- The stage of a warning
-- ---------------------------------------------------------------------------

alter table risk_alerts_sent
  add column stage text
    constraint risk_alerts_sent_stage_check
    check (stage is null or stage in ('watch', 'critical', 'critical_no_slack', 'critical_unreachable'));

comment on column risk_alerts_sent.stage is
  'How bad the position was when this alert went out. Null on rows written before stages existed; those read as their tier.';

create or replace function risk_alert_stage(
  p_tier risk_tier,
  p_reachable boolean,
  p_can_still_miss integer
)
returns text
language sql
immutable
as $$
  select case
    when p_tier = 'watch' then 'watch'
    when p_tier <> 'critical' then null
    when not p_reachable then 'critical_unreachable'
    when coalesce(p_can_still_miss, 0) = 0 then 'critical_no_slack'
    else 'critical'
  end;
$$;

comment on function risk_alert_stage(risk_tier, boolean, integer) is
  'Watch, or one of three Critical stages ordered by how little is left. send_risk_alerts() sends again when a Critical student moves to a worse stage.';

create or replace function risk_alert_stage_rank(p_stage text)
returns integer
language sql
immutable
as $$
  select case p_stage
    when 'watch' then 1
    when 'critical' then 2
    when 'critical_no_slack' then 3
    when 'critical_unreachable' then 4
    else 0
  end;
$$;

-- Called from send_risk_alerts(), which the nightly job runs as service_role.
-- Default privileges revoke execute from public, so the grant is explicit.
grant execute on function risk_alert_stage(risk_tier, boolean, integer) to service_role;
grant execute on function risk_alert_stage_rank(text) to service_role;

-- ---------------------------------------------------------------------------
-- send_risk_alerts(), sending the final warning
-- ---------------------------------------------------------------------------
--
-- Everything else is as 20260823001500 left it: the channel ladder, the copy,
-- and the registration branch that tells a blocked student to register rather
-- than attend.

create or replace function send_risk_alerts()
returns integer
language plpgsql
as $$
declare
  v_row        record;
  v_sent       integer := 0;
  v_note       uuid;
  v_title      text;
  v_body       text;
  v_link       text;
  v_channels   notification_channel[];
  v_remaining  integer;
  v_reachable  boolean;
  v_blocked    boolean;
  v_stage      text;
begin
  for v_row in
    select
      rp.*,
      c.code as course_code,
      last.tier  as last_tier,
      last.stage as last_stage
    from risk_predictions rp
    join courses c on c.id = rp.course_id
    join students s on s.id = rp.student_id
    left join lateral (
      select prev.tier, coalesce(prev.stage, prev.tier::text) as stage
      from risk_alerts_sent prev
      where prev.student_id = rp.student_id
        and prev.course_id = rp.course_id
      order by prev.sent_at desc
      limit 1
    ) last on true
    where rp.tier in ('watch', 'critical')
      and s.status <> 'deactivated'
  loop
    v_remaining := v_row.lectures_expected - v_row.lectures_held;
    v_reachable := lectures_needed(v_row.student_id, v_row.course_id) <= v_remaining;
    v_stage     := risk_alert_stage(v_row.tier, v_reachable, v_row.can_still_miss);

    -- Same tier: silent, unless a Critical student has moved to a worse stage.
    -- That move is the final warning the SMS was held back for, and skipping
    -- it is the bug this migration exists to remove.
    if v_row.last_tier is not distinct from v_row.tier
       and risk_alert_stage_rank(v_stage) <= risk_alert_stage_rank(v_row.last_stage) then
      continue;
    end if;

    v_link := '/courses/' || replace(v_row.course_code, ' ', '-');

    v_blocked := attendance_eligibility(v_row.student_id, v_row.course_id) = 'not_registered';

    if v_row.tier = 'critical' then
      v_channels := array['in_app', 'web_push', 'whatsapp']::notification_channel[];

      if not v_reachable then
        v_channels := v_channels || 'sms'::notification_channel;

        v_title := format('%s: 75%% is no longer reachable', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. Even attending all %s remaining lectures finishes below 75%%. Attendance alone cannot fix this now — speak to the department office about a dispute.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_remaining
        );

      elsif v_row.can_still_miss = 0 then
        v_channels := v_channels || 'sms'::notification_channel;

        v_title := format('%s: you must attend every remaining lecture', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. You have %s lectures left and need every one of them to reach 75%%. Missing one more makes you ineligible for the exam.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_remaining
        );

      else
        v_title := format('%s: you are on course to miss the 75%% mark', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. Attend %s of the %s lectures left and you reach 75%%. You can miss %s.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_row.must_attend,
          v_remaining,
          v_row.can_still_miss
        );
      end if;
    else
      v_channels := array['in_app', 'web_push']::notification_channel[];
      v_title := format('%s: no buffer left', v_row.course_code);
      v_body := format(
        '%s is projected to finish at %s%%, which is just above the 75%% line. You can miss %s more lectures — after that there is no room left.',
        v_row.course_code,
        trim(to_char(v_row.predicted_pct, '990D9')),
        v_row.can_still_miss
      );
    end if;

    if v_blocked then
      v_title := format('%s: register before you attend', v_row.course_code);
      v_body := format(
        'You are not registered for this semester, so %s attendance cannot be recorded — the code on the board is refused when you enter it. Confirm your registration and it starts counting from that moment. Until then every %s lecture held is recorded as an absence, which is why the projection reads %s%%.',
        v_row.course_code,
        v_row.course_code,
        trim(to_char(v_row.predicted_pct, '990D9'))
      );
      v_link := '/courses/register';
    end if;

    v_note := queue_notification(
      v_row.student_id,
      'attendance_warning',
      v_title,
      v_body,
      v_link,
      v_channels
    );

    -- clock_timestamp(), not the column default now(): now() is fixed for the
    -- whole transaction, so two alerts written in one transaction would tie on
    -- sent_at and "the latest alert" above would be whichever row came first.
    insert into risk_alerts_sent (student_id, course_id, tier, stage, predicted_pct, notification_id, sent_at)
    values (v_row.student_id, v_row.course_id, v_row.tier, v_stage, v_row.predicted_pct, v_note, clock_timestamp());

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

comment on function send_risk_alerts() is
  'One alert per student per course per tier change, plus one when a Critical student moves to a worse stage (no slack left, then out of reach) — the final warning SMS was held back for. Never promises a threshold that cannot be reached, and never asks a student the registration gate is blocking to attend their way out of it.';

-- ---------------------------------------------------------------------------
-- The health report learns the new function
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
    'set_registration_period', 'set_dues_period', 'dues_change_impact',
    -- the final warning, and courses that state their length
    'risk_alert_stage'
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
  'What /api/health reports. Names the missing pieces so a half-applied migration set is diagnosable. Covers the revision''s own tables and functions, the university directory, and the final-warning stages.';
