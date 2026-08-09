-- Dept-Flow — cancelling a lecture and scheduling a makeup
--
-- The timetable says a class is *meant* to happen. A `session_instances` row
-- says one *did*. Everything here lives in the gap between those two, which is
-- why cancelling cannot be a delete: there is usually nothing to delete yet.
--
-- Cancelling a future occurrence writes a row that records the absence. That
-- row is what stops the lecture appearing on a student's schedule, and it is
-- also what proves later that the lecture did not go untaught by accident.

-- ---------------------------------------------------------------------------
-- Telling the students
-- ---------------------------------------------------------------------------

-- The schedule screen promises "every enrolled student is notified straight
-- away". Notifying from the database rather than the API keeps that promise
-- attached to the write itself: a caller that cancels a lecture cannot forget
-- the half that students actually experience.
create or replace function notify_enrolled(
  p_course_id uuid,
  p_kind      notification_kind,
  p_title     text,
  p_body      text,
  p_link      text default null
)
returns integer
language plpgsql
as $$
declare
  v_sent integer;
begin
  with sent as (
    insert into notifications (recipient_id, kind, title, body, link)
    select e.student_id, p_kind, p_title, p_body, p_link
    from enrolments e
    where e.course_id = p_course_id
      and e.dropped_at is null
    returning 1
  )
  select count(*) into v_sent from sent;

  return v_sent;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cancelling
-- ---------------------------------------------------------------------------

create or replace function cancel_session(
  p_course_id          uuid,
  p_timetable_entry_id uuid,
  p_held_on            date,
  p_actor_id           uuid,
  p_reason             text
)
returns text
language plpgsql
as $$
declare
  v_existing session_instances%rowtype;
  v_entry    timetable_entries%rowtype;
  v_course   courses%rowtype;
  v_id       uuid;
begin
  if p_actor_id is null then
    raise exception 'a cancellation must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a cancellation must record why — students are shown this';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then return 'not_found'; end if;

  -- The service role has bypassed RLS to get here, so ownership is checked
  -- explicitly, exactly as the policy would have.
  if v_course.lecturer_id is distinct from p_actor_id then
    return 'not_your_course';
  end if;

  select * into v_existing
  from session_instances
  where course_id = p_course_id
    and held_on = p_held_on
    and (p_timetable_entry_id is null or timetable_entry_id = p_timetable_entry_id)
  limit 1;

  -- A lecture that was held cannot be un-held. Cancelling it would drop it out
  -- of every enrolled student's denominator and silently move their attendance
  -- percentage — including students who were there.
  if v_existing.id is not null and v_existing.status = 'closed' then
    return 'already_held';
  end if;

  if v_existing.id is not null and v_existing.status = 'open' then
    return 'in_progress';
  end if;

  if v_existing.id is not null and v_existing.status = 'cancelled' then
    return 'already_cancelled';
  end if;

  if v_existing.id is not null then
    update session_instances
       set status              = 'cancelled',
           cancelled_at        = now(),
           cancelled_by        = p_actor_id,
           cancellation_reason = btrim(p_reason)
     where id = v_existing.id
    returning id into v_id;
  else
    -- Nothing exists yet, which is the normal case: instances are created when
    -- a lecturer starts a lecture, so a future occurrence is only a timetable
    -- entry. The venue comes from that entry, since the column is not null and
    -- a cancelled lecture still had a room booked.
    select * into v_entry from timetable_entries where id = p_timetable_entry_id;
    if v_entry.id is null then return 'not_found'; end if;

    insert into session_instances (
      course_id, timetable_entry_id, held_on, scheduled_start, scheduled_end,
      venue_id, type, status, cancelled_at, cancelled_by, cancellation_reason, created_by
    )
    values (
      p_course_id, v_entry.id, p_held_on,
      (p_held_on + v_entry.start_time) at time zone 'Africa/Lagos',
      (p_held_on + v_entry.end_time) at time zone 'Africa/Lagos',
      v_entry.venue_id, 'recurring', 'cancelled', now(), p_actor_id, btrim(p_reason), p_actor_id
    )
    returning id into v_id;
  end if;

  perform notify_enrolled(
    p_course_id, 'schedule_change',
    v_course.code || ' on ' || to_char(p_held_on, 'DD Mon') || ' is cancelled',
    btrim(p_reason),
    '/schedule'
  );

  perform write_audit(
    p_actor_id, 'lecturer', 'session.cancel', 'session_instances', v_id::text, btrim(p_reason),
    jsonb_build_object('course_id', p_course_id, 'held_on', p_held_on)
  );

  return 'cancelled';
end;
$$;

comment on function cancel_session(uuid, uuid, date, uuid, text) is
  'Writes a cancelled instance rather than deleting one. Refuses a lecture that was already held — that would move every student''s percentage.';

-- ---------------------------------------------------------------------------
-- Makeup classes
-- ---------------------------------------------------------------------------

-- A makeup has no timetable entry, which is why `session_timetable_by_type`
-- only demands one for `recurring`. It is a real lecture in every other
-- respect: it counts, it is attended the same way, and it enters the
-- denominator when it is closed.
create or replace function schedule_makeup(
  p_course_id uuid,
  p_held_on   date,
  p_starts    time,
  p_ends      time,
  p_venue_id  uuid,
  p_actor_id  uuid,
  p_note      text
)
returns text
language plpgsql
as $$
declare
  v_course courses%rowtype;
  v_id     uuid;
begin
  if p_actor_id is null then
    raise exception 'a makeup class must record who scheduled it';
  end if;

  if p_held_on < current_date then
    raise exception 'a makeup class cannot be scheduled in the past';
  end if;

  if p_ends <= p_starts then
    raise exception 'a makeup class must end after it starts';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then return 'not_found'; end if;
  if v_course.lecturer_id is distinct from p_actor_id then return 'not_your_course'; end if;

  if not exists (select 1 from venues where id = p_venue_id) then
    return 'no_such_venue';
  end if;

  -- Two lectures for one course in one day is almost always a double-tap on a
  -- phone, not a genuine intention.
  if exists (
    select 1 from session_instances
    where course_id = p_course_id and held_on = p_held_on and status <> 'cancelled'
  ) then
    return 'already_scheduled';
  end if;

  insert into session_instances (
    course_id, held_on, scheduled_start, scheduled_end, venue_id, type, status, created_by
  )
  values (
    p_course_id, p_held_on,
    (p_held_on + p_starts) at time zone 'Africa/Lagos',
    (p_held_on + p_ends) at time zone 'Africa/Lagos',
    p_venue_id, 'makeup', 'scheduled', p_actor_id
  )
  returning id into v_id;

  perform notify_enrolled(
    p_course_id, 'schedule_change',
    'Makeup class for ' || v_course.code,
    to_char(p_held_on, 'Day DD Mon') || ', ' || to_char(p_starts, 'HH24:MI')
      || '–' || to_char(p_ends, 'HH24:MI')
      || coalesce('. ' || nullif(btrim(p_note), ''), ''),
    '/schedule'
  );

  perform write_audit(
    p_actor_id, 'lecturer', 'session.makeup', 'session_instances', v_id::text,
    nullif(btrim(coalesce(p_note, '')), ''),
    jsonb_build_object('course_id', p_course_id, 'held_on', p_held_on)
  );

  return 'scheduled';
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on function notify_enrolled(uuid, notification_kind, text, text, text) from public, anon, authenticated;
revoke all on function cancel_session(uuid, uuid, date, uuid, text) from public, anon, authenticated;
revoke all on function schedule_makeup(uuid, date, time, time, uuid, uuid, text) from public, anon, authenticated;

grant execute on function notify_enrolled(uuid, notification_kind, text, text, text) to service_role;
grant execute on function cancel_session(uuid, uuid, date, uuid, text) to service_role;
grant execute on function schedule_makeup(uuid, date, time, time, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Rescheduling
-- ---------------------------------------------------------------------------

-- Cancel-and-replace, in one transaction and with one notification.
--
-- A lecturer could do this in two steps, and the two steps would be correct.
-- What they would not be is atomic: a cancellation that lands while the makeup
-- fails leaves students told a lecture is off with no replacement, and two
-- notifications for one change reads as two changes.
create or replace function reschedule_session(
  p_course_id          uuid,
  p_timetable_entry_id uuid,
  p_from               date,
  p_to                 date,
  p_starts             time,
  p_ends               time,
  p_venue_id           uuid,
  p_actor_id           uuid,
  p_reason             text
)
returns text
language plpgsql
as $$
declare
  v_course   courses%rowtype;
  v_entry    timetable_entries%rowtype;
  v_existing session_instances%rowtype;
  v_id       uuid;
begin
  if p_actor_id is null then
    raise exception 'a reschedule must record who made it';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reschedule must record why — students are shown this';
  end if;

  if p_to < current_date then
    raise exception 'a lecture cannot be moved into the past';
  end if;

  if p_ends <= p_starts then
    raise exception 'a lecture must end after it starts';
  end if;

  select * into v_course from courses where id = p_course_id;
  if v_course.id is null then return 'not_found'; end if;
  if v_course.lecturer_id is distinct from p_actor_id then return 'not_your_course'; end if;

  if not exists (select 1 from venues where id = p_venue_id) then
    return 'no_such_venue';
  end if;

  select * into v_existing
  from session_instances
  where course_id = p_course_id and held_on = p_from
  limit 1;

  if v_existing.id is not null and v_existing.status = 'closed' then
    return 'already_held';
  end if;
  if v_existing.id is not null and v_existing.status = 'open' then
    return 'in_progress';
  end if;

  if exists (
    select 1 from session_instances
    where course_id = p_course_id and held_on = p_to and status <> 'cancelled'
  ) then
    return 'already_scheduled';
  end if;

  -- The original slot is marked cancelled so it disappears from the student's
  -- schedule and cannot be attended. Nothing is deleted: the move stays legible
  -- afterwards, which matters when a student says they went to the old room.
  if v_existing.id is not null then
    update session_instances
       set status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_id,
           cancellation_reason = btrim(p_reason)
     where id = v_existing.id;
  else
    select * into v_entry from timetable_entries where id = p_timetable_entry_id;
    if v_entry.id is null then return 'not_found'; end if;

    insert into session_instances (
      course_id, timetable_entry_id, held_on, scheduled_start, scheduled_end,
      venue_id, type, status, cancelled_at, cancelled_by, cancellation_reason, created_by
    )
    values (
      p_course_id, v_entry.id, p_from,
      (p_from + v_entry.start_time) at time zone 'Africa/Lagos',
      (p_from + v_entry.end_time) at time zone 'Africa/Lagos',
      v_entry.venue_id, 'recurring', 'cancelled', now(), p_actor_id, btrim(p_reason), p_actor_id
    );
  end if;

  insert into session_instances (
    course_id, held_on, scheduled_start, scheduled_end, venue_id, type, status, created_by
  )
  values (
    p_course_id, p_to,
    (p_to + p_starts) at time zone 'Africa/Lagos',
    (p_to + p_ends) at time zone 'Africa/Lagos',
    p_venue_id, 'reschedule', 'scheduled', p_actor_id
  )
  returning id into v_id;

  perform notify_enrolled(
    p_course_id, 'schedule_change',
    v_course.code || ' has moved to ' || to_char(p_to, 'DD Mon'),
    'Was ' || to_char(p_from, 'DD Mon') || '. Now ' || to_char(p_to, 'Day DD Mon')
      || ', ' || to_char(p_starts, 'HH24:MI') || '–' || to_char(p_ends, 'HH24:MI')
      || '. ' || btrim(p_reason),
    '/schedule'
  );

  perform write_audit(
    p_actor_id, 'lecturer', 'session.reschedule', 'session_instances', v_id::text, btrim(p_reason),
    jsonb_build_object('course_id', p_course_id, 'from', p_from, 'to', p_to)
  );

  return 'rescheduled';
end;
$$;

comment on function reschedule_session(uuid, uuid, date, date, time, time, uuid, uuid, text) is
  'Cancel-and-replace in one transaction, with one notification. Two steps would not be atomic.';

revoke all on function reschedule_session(uuid, uuid, date, date, time, time, uuid, uuid, text) from public, anon, authenticated;
grant execute on function reschedule_session(uuid, uuid, date, date, time, time, uuid, uuid, text) to service_role;
