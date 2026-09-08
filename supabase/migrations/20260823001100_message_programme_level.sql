-- Dept-Flow — messaging one level of one programme
--
-- The three scopes shipped in ..._hod_messaging.sql cover an individual, a
-- whole level, and a course group. Between them they miss the audience the HOD
-- actually names most often: "400 level Computer Science", "100 level
-- Statistics", "300 level Mathematics".
--
-- Neither existing scope reaches it, and the two failures are opposite:
--
--   `level` is too wide. Level 400 is every 400-level student in the
--   department — MTH, CMP and STA together. A notice about a CMP project
--   deadline sent this way reaches the mathematicians too, and a student who
--   learns that departmental messages are usually not for them stops opening
--   them. That is the same erosion the SMS ladder is built to avoid.
--
--   `course` is too narrow, and narrow in a way that is easy to miss. It
--   reaches everyone enrolled in ONE course, so it only coincides with "400L
--   CMP" when every 400L CMP student happens to be registered for that exact
--   course. Electives and carry-overs guarantee they are not: the student who
--   dropped the elective, or who is carrying a 300-level paper instead, is
--   precisely the student a 400L notice most needs to reach. Sending to CMP 401
--   and believing you have addressed 400L Computer Science is a silent
--   under-delivery, and nothing on the screen would have told the HOD.
--
-- So this adds a fourth scope rather than stretching either of the two. It
-- reads students.programme, which is generated from the matric-number prefix
-- and indexed, so the audience is a fact about who the student IS rather than
-- about what they enrolled in — which is the distinction that makes it correct
-- for carry-overs and dropped electives alike.

-- ---------------------------------------------------------------------------
-- The enum, widened the long way round
-- ---------------------------------------------------------------------------

-- `alter type ... add value` cannot be followed by a use of that value in the
-- same transaction, and setup.sql is applied as ONE transaction by the Supabase
-- SQL Editor — scripts/schema-test.sh asserts exactly that. So the type is
-- renamed, rebuilt with all four values and swapped in, the same dance
-- ..._registration_gate.sql performs on grace_scope and for the same reason.
alter type message_scope rename to message_scope_old;

create type message_scope as enum ('student', 'level', 'course', 'programme_level');

-- Dropped before the column is retyped: both signatures name the old type, and
-- a function whose argument type is about to disappear cannot be left standing.
drop function if exists send_hod_message(uuid, message_scope_old, uuid, integer, text, text);
drop function if exists hod_message_audience(message_scope_old, uuid, integer);

-- The check compares scope against literals, and re-validating it during the
-- type change fails with "operator does not exist: message_scope =
-- message_scope_old". Dropped first, restored below with the fourth arm.
alter table hod_messages
  drop constraint if exists hod_message_scope_targets;

alter table hod_messages
  alter column scope type message_scope using scope::text::message_scope;

drop type message_scope_old;

-- ---------------------------------------------------------------------------
-- What the new scope needs recorded
-- ---------------------------------------------------------------------------

alter table hod_messages
  add column if not exists programme text;

comment on column hod_messages.programme is
  'Set only when scope is programme_level — MTH, CMP or STA, alongside the level.';

-- Still exactly one target per scope, now across four. The programme arm is the
-- only one that sets two columns, because the audience genuinely is two facts:
-- neither the level nor the programme identifies it alone.
--
-- Every arm now guards its target with `is not null` BEFORE the `in` list, and
-- that is load-bearing rather than belt-and-braces. `null in (100, 200, 300,
-- 400)` is NULL, not false; `true and NULL` is NULL; and a CHECK constraint
-- ACCEPTS a NULL result. The original constraint carried the same shape, so a
-- level-scoped row naming no level satisfied it — the row inserted, the message
-- matched nobody, and the send reported success to an audience of zero. That
-- hole is closed here for all four scopes, not only the new one.
alter table hod_messages
  add constraint hod_message_scope_targets check (
    (scope = 'student' and student_id is not null and level is null
       and course_id is null and programme is null)
    or (scope = 'level' and level is not null and level in (100, 200, 300, 400)
       and student_id is null and course_id is null and programme is null)
    or (scope = 'course' and course_id is not null and student_id is null
       and level is null and programme is null)
    or (scope = 'programme_level'
       and programme is not null and programme in ('MTH', 'CMP', 'STA')
       and level is not null and level in (100, 200, 300, 400)
       and student_id is null and course_id is null)
  );

-- ---------------------------------------------------------------------------
-- Sending, rebuilt against the widened type
-- ---------------------------------------------------------------------------

-- Unchanged except for the fourth arm and the programme it carries. The body is
-- restated rather than patched because the type swap above dropped the original
-- and a function cannot be half-replaced.
create or replace function send_hod_message(
  p_actor_id  uuid,
  p_scope     message_scope,
  p_target    uuid,
  p_level     integer,
  p_subject   text,
  p_body      text,
  p_programme text default null
)
returns table (message_id uuid, recipients integer)
language plpgsql
as $$
declare
  v_id        uuid;
  v_student   uuid;
  v_count     integer := 0;
  v_course    courses%rowtype;
  v_programme text := upper(btrim(coalesce(p_programme, '')));
begin
  if not exists (select 1 from profiles where id = p_actor_id and role = 'hod') then
    raise exception 'only the head of department can message students';
  end if;

  if length(btrim(coalesce(p_subject, ''))) = 0 then
    raise exception 'a message must have a subject';
  end if;

  if length(btrim(coalesce(p_body, ''))) < 10 then
    raise exception 'a message must say something';
  end if;

  if p_scope = 'course' then
    select * into v_course from courses where id = p_target;
    if v_course.id is null then
      raise exception 'that course does not exist';
    end if;
  end if;

  -- Refused by name rather than by silently reaching nobody. CSC is the one a
  -- newcomer types, and this department's Computer Science prefix is CMP.
  if p_scope = 'programme_level' and v_programme not in ('MTH', 'CMP', 'STA') then
    raise exception 'programme must be MTH, CMP or STA — this department has no % programme', coalesce(nullif(v_programme, ''), 'unnamed');
  end if;

  insert into hod_messages (sent_by, scope, student_id, level, course_id, programme, subject, body)
  values (
    p_actor_id,
    p_scope,
    case when p_scope = 'student' then p_target end,
    case when p_scope in ('level', 'programme_level') then p_level end,
    case when p_scope = 'course' then p_target end,
    case when p_scope = 'programme_level' then v_programme end,
    btrim(p_subject),
    btrim(p_body)
  )
  returning id into v_id;

  for v_student in
    select s.id
    from students s
    where s.status <> 'deactivated'
      and (
        (p_scope = 'student' and s.id = p_target)
        or (p_scope = 'level' and s.level = p_level)
        or (p_scope = 'course' and exists (
              select 1 from enrolments e
              where e.student_id = s.id
                and e.course_id = p_target
                and e.dropped_at is null
            ))
        -- Who the student is, not what they enrolled in: a 400L CMP student
        -- carrying a 300L paper is still 400L CMP, and a course-based audience
        -- would have missed them.
        or (p_scope = 'programme_level' and s.programme = v_programme and s.level = p_level)
      )
  loop
    perform queue_notification(
      v_student,
      'hod_message',
      btrim(p_subject),
      btrim(p_body),
      '/notifications'
    );
    v_count := v_count + 1;
  end loop;

  update hod_messages set recipients = v_count where id = v_id;

  perform write_audit(
    p_actor_id, 'hod', 'hod_message.sent', 'hod_messages', v_id::text, btrim(p_subject),
    jsonb_build_object(
      'scope', p_scope,
      'student_id', case when p_scope = 'student' then p_target end,
      'level', case when p_scope in ('level', 'programme_level') then p_level end,
      'programme', case when p_scope = 'programme_level' then v_programme end,
      'course_code', case when p_scope = 'course' then v_course.code end,
      'recipients', v_count
    )
  );

  return query select v_id, v_count;
end;
$$;

revoke all on function send_hod_message(uuid, message_scope, uuid, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function send_hod_message(uuid, message_scope, uuid, integer, text, text, text)
  to service_role;

comment on function send_hod_message(uuid, message_scope, uuid, integer, text, text, text) is
  'One message, four audiences, drawn from the registration data and the matric number. Routes through queue_notification() so it gets the same channels, fallback and delivery record as everything else.';

-- ---------------------------------------------------------------------------
-- The count shown before it is sent
-- ---------------------------------------------------------------------------

create or replace function hod_message_audience(
  p_scope     message_scope,
  p_target    uuid,
  p_level     integer,
  p_programme text default null
)
returns integer
language sql
stable
as $$
  select count(*)::integer
  from students s
  where s.status <> 'deactivated'
    and (
      (p_scope = 'student' and s.id = p_target)
      or (p_scope = 'level' and s.level = p_level)
      or (p_scope = 'course' and exists (
            select 1 from enrolments e
            where e.student_id = s.id
              and e.course_id = p_target
              and e.dropped_at is null
          ))
      or (p_scope = 'programme_level'
            and s.programme = upper(btrim(coalesce(p_programme, '')))
            and s.level = p_level)
    );
$$;

revoke all on function hod_message_audience(message_scope, uuid, integer, text) from public, anon;
grant execute on function hod_message_audience(message_scope, uuid, integer, text)
  to authenticated, service_role;

comment on function hod_message_audience(message_scope, uuid, integer, text) is
  'How many students a message would reach, counted the same way the send counts them.';
