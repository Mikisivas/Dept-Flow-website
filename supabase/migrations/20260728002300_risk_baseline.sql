-- Dept-Flow — the advisory signal, computed
--
-- `risk_predictions` has been read by two screens since the first build — the
-- HOD's at-risk list and the student's nudge — and written by nothing except
-- `seed.sql`. Both screens have been showing two numbers somebody typed in by
-- hand. That is the same failure the rest of this branch spent its time
-- removing, one layer further down.
--
-- WHY THIS IS A RULE AND NOT scikit-learn
--
-- The stack names scikit-learn, and the seam for it is real — everything here
-- writes to the same table a model would write to, and every reader is already
-- indifferent to which produced the row. What does not exist is data to train
-- on. At the point this is written the department has one academic session,
-- three students and thirty-one marks. A classifier fitted to that is not a
-- model; it is the training set, memorised.
--
-- So the baseline is a rule, and it is a rule chosen to be explicable to the
-- student it is about: "at the rate you have been attending, you will finish
-- around here." A student who is told they are at risk can be told exactly why,
-- which a fitted model could not have done for its first several years.
--
-- Replace it when there is history to learn from. The contract is this table.
--
-- WHAT IT PREDICTS, AND WHAT IT DELIBERATELY IGNORES
--
-- Attendance behaviour, not compliance. An unpaid student's counted attendance
-- is zero and no prediction is needed to say so — the dashboard banner already
-- does, in plainer words. The useful question is whether they are turning up
-- often enough, which is why every mark counts here regardless of whether it
-- has been paid for.

create or replace function compute_risk_predictions()
returns integer
language plpgsql
as $$
declare
  v_written   integer;
  v_threshold numeric;
begin
  select attendance_threshold_pct into v_threshold from app_config where id = 1;
  v_threshold := coalesce(v_threshold, 75);

  -- Wholesale rather than incremental. A prediction is only ever a statement
  -- about the present, and a stale row for a student who has since turned
  -- things around is worse than no row.
  delete from risk_predictions;

  with attendance as (
    select
      e.student_id,
      e.course_id,
      count(si.id)                                            as held,
      count(ss.id) filter (where ss.score > 0)                as attended,
      count(ss.id) filter (where ss.score = 0.5)              as halves,
      coalesce(sum(ss.score), 0)                              as earned
    from enrolments e
    join session_instances si
      on si.course_id = e.course_id
     and si.status = 'closed'
     and si.held_on >= e.enrolled_on
    left join session_scores ss
      on ss.session_instance_id = si.id
     and ss.student_id = e.student_id
    where e.dropped_at is null
    group by e.student_id, e.course_id
  ),
  scored as (
    select
      student_id,
      course_id,
      held,
      halves,
      held - attended as absent,
      -- "At your current rate." Their rate so far, carried forward — which is
      -- the sentence the screen actually shows, so the number behind it should
      -- be the one that sentence describes.
      round((earned / held) * 100, 2) as predicted_pct
    from attendance
    -- Three lectures is the least that can distinguish a pattern from a bad
    -- morning. Below it the honest output is no prediction at all, which is
    -- why the screens are built to show nothing rather than a placeholder.
    where held >= 3
  )
  insert into risk_predictions (student_id, course_id, predicted_pct, pattern)
  select
    student_id,
    course_id,
    predicted_pct,
    case
      -- A pattern exists to explain why a student is falling short, so a
      -- student who is not falling short does not get one. Labelling somebody
      -- at 75% as "disengaged" because one lecture went badly is the kind of
      -- confident nonsense that teaches people to ignore the screen.
      when predicted_pct >= v_threshold then null
      -- Two ways to fall short, and they need different conversations. A
      -- student who comes and leaves at half time needs telling that the
      -- second checkpoint is half their mark. A student who is not coming at
      -- all needs something else entirely.
      when halves > absent then 'partial_attendance'::risk_pattern
      else 'disengagement'::risk_pattern
    end
  from scored;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

comment on function compute_risk_predictions() is
  'The advisory baseline: attendance rate carried forward. Advisory only — attendance_pct() decides eligibility and never consults this.';

-- ---------------------------------------------------------------------------
-- Refreshed by the same nightly job
-- ---------------------------------------------------------------------------

-- Folded into the existing scheduled call rather than given its own, so there
-- is one thing to schedule and one thing that can fail to be scheduled.
create or replace function advance_compliance_states()
returns table (moved_to_pending integer, locked integer)
language plpgsql
as $$
declare
  v_session uuid;
  v_pending integer;
  v_locked  integer;
begin
  select id into v_session from academic_sessions where is_active limit 1;

  if v_session is null then
    return query select 0, 0;
    return;
  end if;

  v_pending := begin_pending_verification(v_session);
  v_locked  := lock_after_buffer(v_session);

  -- Advisory, and deliberately last: a failure to refresh predictions must not
  -- stop the compliance ladder, which is the part with consequences.
  perform compute_risk_predictions();

  -- Audited only when something actually changed. A nightly no-op writing a
  -- row every night would bury the nights that mattered.
  if v_pending > 0 or v_locked > 0 then
    perform write_audit(
      null, 'admin', 'compliance.advanced', 'compliance_statuses', v_session::text,
      'Scheduled compliance transition',
      jsonb_build_object('moved_to_pending', v_pending, 'locked', v_locked)
    );
  end if;

  return query select v_pending, v_locked;
end;
$$;

revoke all on function compute_risk_predictions() from public, anon, authenticated;
grant execute on function compute_risk_predictions() to service_role;
