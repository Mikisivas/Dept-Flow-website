-- Dept-Flow — telling a student the truth when the line is out of reach
--
-- A bug found by reading the seeded demo output rather than the code.
--
-- `send_risk_alerts()` had two Critical messages: "attend N of the M left and
-- you reach 75%", and — when there was no slack at all — "you have M lectures
-- left and need every one of them to reach 75%".
--
-- The second is false whenever the threshold can no longer be reached. A
-- student on 5 of 13 with 17 lectures to come finishes at 22/30 = 73.3% having
-- attended every single one, and the message told her she would reach 75%.
--
-- That is the worst kind of wrong this system can be. It is not an error the
-- student can detect: she does the arithmetic the message asked her to do,
-- attends everything for eleven weeks, and finds out at the permit screen.
-- Every other warning is designed to be acted on, and this one could only be
-- acted on uselessly.
--
-- The honest message says the line is gone and names the route that is left. A
-- waiver and a dispute are real mechanisms this system already has, and both
-- of them need a conversation with the department rather than more attendance.
--
-- `must_attend` is capped at what remains, which is right for an instruction
-- and useless as a diagnosis — capped, "attend 21" and "attend 17" are the
-- same number. `lectures_needed()` is uncapped, which is exactly what makes it
-- able to answer this.

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
  v_channels  notification_channel[];
  v_remaining integer;
  v_reachable boolean;
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
    -- Already told, at this tier, and nothing has changed. Silence is the
    -- correct output: an alert that repeats every night is an alert a student
    -- mutes, and a muted channel is one that cannot warn them in week eleven.
    if v_row.last_tier is not distinct from v_row.tier then
      continue;
    end if;

    v_remaining := v_row.lectures_expected - v_row.lectures_held;
    v_reachable := lectures_needed(v_row.student_id, v_row.course_id) <= v_remaining;

    if v_row.tier = 'critical' then
      -- §5.3: in-app, Web Push, WhatsApp. SMS is held back for the final
      -- warning rather than spent on the first Critical — a student who gets a
      -- text in week six has nothing left to escalate to in week eleven.
      v_channels := array['in_app', 'web_push', 'whatsapp']::notification_channel[];

      if not v_reachable then
        -- Nothing they can do about it by attending, which is precisely why it
        -- earns the last channel: this is the message that has to arrive.
        v_channels := v_channels || 'sms'::notification_channel;

        v_title := format('%s: 75%% is no longer reachable', v_row.course_code);
        v_body := format(
          '%s is projected to finish at %s%%. Even attending all %s remaining lectures finishes below 75%%. Attendance alone cannot fix this now — speak to the department office about a waiver or a dispute.',
          v_row.course_code,
          trim(to_char(v_row.predicted_pct, '990D9')),
          v_remaining
        );

      elsif v_row.can_still_miss = 0 then
        -- Still reachable, with no slack at all: every remaining lecture is
        -- needed, so the next one missed ends it. Also an SMS, because there is
        -- nothing after it to escalate to.
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
      -- Watch: in-app and Web Push. No WhatsApp — a student who is on course
      -- to land exactly on the line needs to know, and does not need a
      -- message on the channel reserved for the students who are failing.
      v_channels := array['in_app', 'web_push']::notification_channel[];
      v_title := format('%s: no buffer left', v_row.course_code);
      v_body := format(
        '%s is projected to finish at %s%%, which is just above the 75%% line. You can miss %s more lectures — after that there is no room left.',
        v_row.course_code,
        trim(to_char(v_row.predicted_pct, '990D9')),
        v_row.can_still_miss
      );
    end if;

    v_note := queue_notification(
      v_row.student_id,
      'attendance_warning',
      v_title,
      v_body,
      '/courses/' || replace(v_row.course_code, ' ', '-'),
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
  'One alert per student per course per tier change. Never promises a threshold that cannot be reached — a student who attends everything the message asked for and still fails has been misled by the warning system itself.';
