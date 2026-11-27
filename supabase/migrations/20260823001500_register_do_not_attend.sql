-- Dept-Flow — tell an unregistered student to register, not to attend
--
-- `compute_risk_predictions()` reads enrolments and session scores. It has
-- never consulted `course_registrations`, and it should not: the projection is
-- arithmetic on what was recorded, and teaching it about the gate would make
-- the forecast disagree with the attendance figure it is forecasting.
--
-- The consequence lands one step later, in the alert. A student past the
-- registration deadline who has not confirmed is still enrolled in their core
-- courses. Lectures are held, they count in the denominator, and the student
-- has no accepted marks because `attendance_eligibility()` refuses every code
-- they type. Their projection collapses toward zero, the tier goes Critical,
-- and the message they receive is:
--
--     "Attend 13 of the 17 lectures left and you reach 75%."
--
-- Attending is the one thing they cannot do. The system spends its loudest
-- channels telling a student to do something the system itself is blocking, and
-- the student has no way to discover why. That is the same class of failure as
-- promising a threshold that is out of reach: a warning that can only be acted
-- on uselessly, which the migration before this one was written to remove.
--
-- So the copy is chosen by asking the SAME function the hall asks. Whatever
-- `attendance_eligibility()` says about a submission is what the alert says
-- about the remedy, and the two cannot drift apart into a screen that refuses a
-- code and a message that asks for one.
--
-- The channel ladder is untouched. A blocked student gets exactly the channels
-- their tier already earned — the words change, not the escalation. What tier
-- an unregistered student should reach is a separate question from what they
-- should be told, and folding the two together would hide the second decision
-- inside the first.
--
-- This also drops the waiver from the out-of-reach message. Waivers were
-- retired in the previous migration, and a message naming a route the
-- department no longer has is worse than one naming nothing: it sends the
-- student to an office that will turn them away.

create or replace function send_risk_alerts()
returns integer
language plpgsql
as $$
declare
  v_row       record;
  v_sent      integer := 0;
  v_note      uuid;
  v_title     text;
  v_body      text;
  v_link      text;
  v_channels  notification_channel[];
  v_remaining integer;
  v_reachable boolean;
  v_blocked   boolean;
begin
  for v_row in
    select
      rp.*,
      c.code as course_code,
      (select tier from risk_alerts_sent prev
        where prev.student_id = rp.student_id
          and prev.course_id = rp.course_id
        order by prev.sent_at desc
        limit 1) as last_tier
    from risk_predictions rp
    join courses c on c.id = rp.course_id
    join students s on s.id = rp.student_id
    where rp.tier in ('watch', 'critical')
      and s.status <> 'deactivated'
  loop
    if v_row.last_tier is not distinct from v_row.tier then
      continue;
    end if;

    v_remaining := v_row.lectures_expected - v_row.lectures_held;
    v_reachable := lectures_needed(v_row.student_id, v_row.course_id) <= v_remaining;
    v_link      := '/courses/' || replace(v_row.course_code, ' ', '-');

    -- Asked of the gate itself rather than re-derived from registration_periods
    -- and course_registrations here. One rule, one place: if the hall would
    -- refuse this student's code, this is the branch that speaks.
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

    -- Written last, over whatever the tier produced. The number the student can
    -- see on their dashboard is still explained, because an alert that ignores
    -- the figure beside it reads as a different system talking; but the remedy
    -- named is the one that works, and the link goes where it can be done.
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

    insert into risk_alerts_sent (student_id, course_id, tier, predicted_pct, notification_id)
    values (v_row.student_id, v_row.course_id, v_row.tier, v_row.predicted_pct, v_note);

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

comment on function send_risk_alerts() is
  'One alert per student per course per tier change. Never promises a threshold that cannot be reached, and never asks a student the registration gate is blocking to attend their way out of it — the remedy named is the one that works.';
