-- Dept-Flow — reminders before, reports after
--
-- §4 and §6. Both are the same idea at different tempos: tell the student
-- something while they can still act on it.
--
-- A reminder an hour before a lecture is the cheapest intervention this system
-- has. It costs nothing on WhatsApp, it needs no forecast behind it, and it
-- addresses the largest single cause of a missed lecture, which is not
-- reluctance — it is a student who lost track of the day. The warning system
-- catches the student who is falling away; this catches the one who simply
-- forgot, and there are more of them.
--
-- A report is the other end: what happened, at a tempo slow enough that a
-- student reads it. Weekly, monthly, and the full semester picture — which is
-- the same computation the exam permit does, and is written once here so the
-- two cannot disagree about whether somebody is eligible.

-- ---------------------------------------------------------------------------
-- Timezone
-- ---------------------------------------------------------------------------

-- Every time in this file is Lagos time. The database runs in UTC and the
-- department does not, so "lectures starting in the next hour" computed in UTC
-- is an hour's worth of reminders sent at the wrong time of day — and in the
-- wrong direction, arriving after the lecture rather than before it.
create or replace function lagos_now()
returns timestamp
language sql
stable
as $$
  select (now() at time zone 'Africa/Lagos');
$$;

comment on function lagos_now() is
  'Local wall-clock time. The database is UTC and the department is not, and an hour''s error in a reminder means it arrives after the lecture.';

-- ---------------------------------------------------------------------------
-- Reminders sent, so they are sent once
-- ---------------------------------------------------------------------------

-- The job runs every few minutes and the window is an hour wide, so without
-- this every student on a course would get twenty reminders for one lecture.
-- Keyed on the slot and the day rather than on a timestamp: the same lecture
-- reminded about twice is the failure, and "the same lecture" means this
-- timetable row on this date.
create table lecture_reminders_sent (
  timetable_entry_id uuid not null references timetable_entries (id) on delete cascade,
  held_on            date not null,
  students_notified  integer not null default 0,
  sent_at            timestamptz not null default now(),
  primary key (timetable_entry_id, held_on)
);

comment on table lecture_reminders_sent is
  'One row per slot per day. The reminder job runs every few minutes over an hour-wide window; without this, one lecture would produce twenty reminders.';

alter table lecture_reminders_sent enable row level security;

create policy lecture_reminders_sent_staff_read on lecture_reminders_sent
  for select to authenticated using (is_admin() or is_hod());

-- ---------------------------------------------------------------------------
-- What is about to happen
-- ---------------------------------------------------------------------------

create or replace function upcoming_lectures(p_within_minutes integer default 60)
returns table (
  timetable_entry_id uuid,
  course_id          uuid,
  course_code        text,
  starts_at          timestamp,
  venue              text
)
language sql
stable
as $$
  with clock as (select lagos_now() as now_local)
  select
    te.id,
    te.course_id,
    c.code,
    (clock.now_local::date + te.start_time)::timestamp,
    v.name
  from timetable_entries te
  join courses c on c.id = te.course_id
  join academic_sessions a on a.id = te.academic_session_id and a.is_active
  join venues v on v.id = te.venue_id
  cross join clock
  where te.day_of_week = extract(dow from clock.now_local)::integer
    -- Strictly ahead of now, so a lecture that started five minutes ago is not
    -- "upcoming". A reminder for a lecture already under way is worse than
    -- none: it tells a student they are late, which they can no longer fix.
    and (clock.now_local::date + te.start_time) > clock.now_local
    and (clock.now_local::date + te.start_time)
        <= clock.now_local + make_interval(mins => p_within_minutes)
    -- A cancelled lecture is not upcoming. The lecturer already told everyone
    -- it is off; reminding them to attend it would be the system contradicting
    -- the person who cancelled it.
    and not exists (
      select 1 from session_instances si
      where si.timetable_entry_id = te.id
        and si.held_on = clock.now_local::date
        and si.status = 'cancelled'
    )
    -- And not one already reminded about.
    and not exists (
      select 1 from lecture_reminders_sent r
      where r.timetable_entry_id = te.id
        and r.held_on = clock.now_local::date
    );
$$;

comment on function upcoming_lectures(integer) is
  'Slots starting within the window, in Lagos time, excluding cancelled lectures and ones already reminded about.';

grant execute on function upcoming_lectures(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Reminding
-- ---------------------------------------------------------------------------

create or replace function send_lecture_reminders(p_within_minutes integer default 60)
returns integer
language plpgsql
as $$
declare
  v_lecture  record;
  v_student  uuid;
  v_count    integer;
  v_total    integer := 0;
  v_minutes  integer;
begin
  for v_lecture in select * from upcoming_lectures(p_within_minutes) loop
    v_count := 0;
    v_minutes := greatest(1, extract(epoch from (v_lecture.starts_at - lagos_now()))::integer / 60);

    -- Marked as sent BEFORE the sends, not after. The job runs every few
    -- minutes; a crash halfway through a large course would otherwise leave
    -- the row unwritten and reminders would go out again on the next tick, to
    -- the students who already had one.
    insert into lecture_reminders_sent (timetable_entry_id, held_on)
    values (v_lecture.timetable_entry_id, lagos_now()::date)
    on conflict do nothing;

    -- Registered students only, and specifically the ones this lecture will
    -- actually count against. A reminder to a student who dropped the course
    -- is the system asking them to attend something they left.
    for v_student in
      select e.student_id
      from enrolments e
      join students s on s.id = e.student_id
      where e.course_id = v_lecture.course_id
        and e.dropped_at is null
        and s.status <> 'deactivated'
    loop
      perform queue_notification(
        v_student,
        'lecture_reminder',
        format('%s starts in %s minutes', v_lecture.course_code, v_minutes),
        format(
          '%s at %s, %s. Your lecturer will put the attendance code on the board.',
          v_lecture.course_code,
          to_char(v_lecture.starts_at, 'HH24:MI'),
          coalesce(v_lecture.venue, 'the usual hall')
        ),
        '/dashboard'
      );
      v_count := v_count + 1;
    end loop;

    update lecture_reminders_sent
       set students_notified = v_count
     where timetable_entry_id = v_lecture.timetable_entry_id
       and held_on = lagos_now()::date;

    v_total := v_total + v_count;
  end loop;

  return v_total;
end;
$$;

revoke all on function send_lecture_reminders(integer) from public, anon, authenticated;
grant execute on function send_lecture_reminders(integer) to service_role;

comment on function send_lecture_reminders(integer) is
  'Queues a reminder for every student on every lecture starting within the window. Marks the slot sent first, so a crash mid-course does not re-remind the students who already had one.';

-- ---------------------------------------------------------------------------
-- Reports (§6)
-- ---------------------------------------------------------------------------

-- The semester picture, per course. Written once and read by three things: the
-- student's own semester report, the Monday digest, and the exam permit. The
-- permit and the report disagreeing about whether somebody is eligible is the
-- single worst outcome available here, and one function is how that is
-- prevented rather than promised.
create or replace function student_semester_report(
  p_student_id uuid,
  p_academic_session_id uuid default null
)
returns table (
  course_id      uuid,
  course_code    text,
  course_title   text,
  lectures_held  integer,
  attended       numeric,
  attendance_pct numeric,
  eligible       boolean,
  must_attend    integer,
  projected_pct  numeric
)
language sql
stable
as $$
  with target as (
    select coalesce(
      p_academic_session_id,
      (select id from academic_sessions where is_active limit 1)
    ) as session_id
  ),
  threshold as (
    select coalesce((select attendance_threshold_pct from app_config where id = 1), 75) as pct
  )
  select
    c.id,
    c.code,
    c.title,
    (
      select count(*)::integer
      from session_instances si
      where si.course_id = c.id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ),
    coalesce((
      select sum(ss.score)
      from session_scores ss
      join session_instances si on si.id = ss.session_instance_id
      where ss.student_id = p_student_id
        and si.course_id = c.id
        and si.status = 'closed'
        and si.held_on >= e.enrolled_on
    ), 0),
    attendance_pct(p_student_id, c.id),
    attendance_pct(p_student_id, c.id) >= threshold.pct,
    coalesce((
      select rp.must_attend from risk_predictions rp
      where rp.student_id = p_student_id and rp.course_id = c.id
    ), 0),
    (
      select rp.predicted_pct from risk_predictions rp
      where rp.student_id = p_student_id and rp.course_id = c.id
    )
  from enrolments e
  join courses c on c.id = e.course_id
  cross join target
  cross join threshold
  where e.student_id = p_student_id
    and e.dropped_at is null
    and c.academic_session_id = target.session_id
  order by c.code;
$$;

comment on function student_semester_report(uuid, uuid) is
  'Per-course attendance and eligibility for a semester. Read by the student report, the Monday digest and the exam permit — one computation, so they cannot disagree about who may sit.';

revoke all on function student_semester_report(uuid, uuid) from public, anon;
grant execute on function student_semester_report(uuid, uuid) to authenticated, service_role;

-- A window of the term, with the delta that makes it a report rather than a
-- number. "68% this week" says nothing on its own; "68%, down from 81%" is the
-- sentence a student reacts to.
create or replace function student_period_report(
  p_student_id uuid,
  p_days       integer default 7
)
returns table (
  lectures_held      integer,
  attended           numeric,
  period_pct         numeric,
  previous_pct       numeric,
  delta              numeric,
  overall_pct        numeric
)
language sql
stable
as $$
  with bounds as (
    select
      lagos_now()::date - p_days as this_from,
      lagos_now()::date          as this_to,
      lagos_now()::date - (p_days * 2) as prev_from,
      lagos_now()::date - p_days as prev_to
  ),
  mine as (
    select si.held_on, coalesce(ss.score, 0) as score
    from enrolments e
    join session_instances si
      on si.course_id = e.course_id
     and si.status = 'closed'
     and si.held_on >= e.enrolled_on
    left join session_scores ss
      on ss.session_instance_id = si.id and ss.student_id = e.student_id
    where e.student_id = p_student_id
      and e.dropped_at is null
  ),
  windows as (
    select
      count(*) filter (where held_on > bounds.this_from and held_on <= bounds.this_to) as held_now,
      coalesce(sum(score) filter (where held_on > bounds.this_from and held_on <= bounds.this_to), 0) as got_now,
      count(*) filter (where held_on > bounds.prev_from and held_on <= bounds.prev_to) as held_prev,
      coalesce(sum(score) filter (where held_on > bounds.prev_from and held_on <= bounds.prev_to), 0) as got_prev,
      count(*) as held_all,
      coalesce(sum(score), 0) as got_all
    from mine, bounds
  )
  select
    held_now::integer,
    got_now,
    case when held_now = 0 then null else round(got_now / held_now * 100, 2) end,
    case when held_prev = 0 then null else round(got_prev / held_prev * 100, 2) end,
    -- Null rather than zero when there is nothing to compare against. A first
    -- week reported as "no change" is a claim about a week that did not exist.
    case
      when held_now = 0 or held_prev = 0 then null
      else round((got_now / held_now - got_prev / held_prev) * 100, 2)
    end,
    case when held_all = 0 then 0 else round(got_all / held_all * 100, 2) end
  from windows;
$$;

comment on function student_period_report(uuid, integer) is
  'A window of the term against the one before it. The delta is what makes it a report — "68%" says nothing that "68%, down from 81%" does not say better.';

revoke all on function student_period_report(uuid, integer) from public, anon;
grant execute on function student_period_report(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The Monday digest (§6.2)
-- ---------------------------------------------------------------------------

-- "Reports are also pushed automatically on a schedule through the same
-- notification system used for alerts, AT LOWER URGENCY."
--
-- Lower urgency is the whole design constraint. A digest is not a warning, and
-- sending it on the warning channels would teach students that a WhatsApp
-- message from Dept-Flow is routine — at which point the Critical alert in
-- week eleven arrives on a channel they have learned to ignore. The policy row
-- for `weekly_report` allows in-app and WhatsApp and no SMS, and the digest
-- goes out on a Monday morning rather than whenever the job happens to run.
create or replace function send_weekly_digests()
returns integer
language plpgsql
as $$
declare
  v_student uuid;
  v_report  record;
  v_sent    integer := 0;
  v_body    text;
begin
  for v_student in
    select s.id
    from students s
    where s.status <> 'deactivated'
      -- Somebody with no enrolments has nothing to report on, and a digest
      -- saying so every Monday is the definition of noise.
      and exists (
        select 1 from enrolments e where e.student_id = s.id and e.dropped_at is null
      )
  loop
    select * into v_report from student_period_report(v_student, 7);

    -- A week in which no lecture was held is not a week worth a message.
    -- Reading week, strike, public holiday: a digest that says "0 of 0" is a
    -- message that trains people not to open the next one.
    if v_report.lectures_held is null or v_report.lectures_held = 0 then
      continue;
    end if;

    v_body := format(
      'You attended %s of %s lectures last week (%s%%). Your attendance across the term is %s%%.',
      trim(to_char(v_report.attended, '990')),
      v_report.lectures_held,
      trim(to_char(v_report.period_pct, '990D9')),
      trim(to_char(v_report.overall_pct, '990D9'))
    );

    if v_report.delta is not null and abs(v_report.delta) >= 5 then
      v_body := v_body || format(
        ' That is %s %s points on the week before.',
        case when v_report.delta > 0 then 'up' else 'down' end,
        trim(to_char(abs(v_report.delta), '990D9'))
      );
    end if;

    perform queue_notification(
      v_student,
      'weekly_report',
      'Your week in numbers',
      v_body,
      '/reports'
    );

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

revoke all on function send_weekly_digests() from public, anon, authenticated;
grant execute on function send_weekly_digests() to service_role;

comment on function send_weekly_digests() is
  'The Monday digest, at lower urgency than a warning. Skips a week with no lectures: a message saying "0 of 0" trains people not to open the next one.';
