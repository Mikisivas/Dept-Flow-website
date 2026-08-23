-- Dept-Flow — the HOD talking to students (§7.3)
--
-- "HOD can message students at three scopes: an individual student, a whole
-- class/level, or a course group (everyone currently registered for a given
-- course). The registration data already provides this audience mapping.
-- Messages route through the same notification channels as alerts."
--
-- The last sentence is the load-bearing one. A separate messaging system would
-- be a second thing that can fail to deliver, a second place a student's
-- WhatsApp number is read, and a second set of channel rules that would drift
-- from the first. This routes through `queue_notification()` like everything
-- else, which means an HOD message gets the WhatsApp→SMS fallback and the
-- delivery record for free.
--
-- WHAT IT IS NOT ALLOWED TO BE
--
-- Not a broadcast tool. Every send is audited with the actor, the scope and
-- the audience size, because "message every student in the department" is an
-- authority action in the same family as a grace period — it reaches four
-- hundred phones, some of them at three in the morning, and the person who
-- did it should be recoverable a year later.
--
-- And never SMS. The policy row for `hod_message` allows in-app, Web Push and
-- WhatsApp. An HOD who could spend the SMS budget on a routine notice would
-- eventually spend it, and the students would learn that a text from Dept-Flow
-- is routine — at which point the final attendance warning arrives on a
-- channel nobody reads.

-- ---------------------------------------------------------------------------
-- Who a message reached
-- ---------------------------------------------------------------------------

create type message_scope as enum ('student', 'level', 'course');

create table hod_messages (
  id            uuid primary key default gen_random_uuid(),
  sent_by       uuid not null references profiles (id),
  scope         message_scope not null,
  -- Exactly one of these is set, matching the scope.
  student_id    uuid references students (id) on delete set null,
  level         integer,
  course_id     uuid references courses (id) on delete set null,
  subject       text not null,
  body          text not null,
  recipients    integer not null default 0,
  sent_at       timestamptz not null default now(),
  constraint hod_message_subject_present check (length(btrim(subject)) > 0),
  constraint hod_message_body_substantive check (length(btrim(body)) >= 10),
  constraint hod_message_scope_targets check (
    (scope = 'student' and student_id is not null and level is null and course_id is null) or
    (scope = 'level' and level in (100, 200, 300, 400) and student_id is null and course_id is null) or
    (scope = 'course' and course_id is not null and student_id is null and level is null)
  )
);

create index hod_messages_sent_idx on hod_messages (sent_at desc);

alter table hod_messages enable row level security;

create policy hod_messages_hod_read on hod_messages
  for select to authenticated using (is_hod());

comment on table hod_messages is
  'What the HOD sent, to whom, and how many it reached. A broadcast to four hundred phones is an authority action and leaves a record like one.';

-- ---------------------------------------------------------------------------
-- Sending
-- ---------------------------------------------------------------------------

create or replace function send_hod_message(
  p_actor_id  uuid,
  p_scope     message_scope,
  p_target    uuid,
  p_level     integer,
  p_subject   text,
  p_body      text
)
returns table (message_id uuid, recipients integer)
language plpgsql
as $$
declare
  v_id      uuid;
  v_student uuid;
  v_count   integer := 0;
  v_course  courses%rowtype;
begin
  if not exists (select 1 from profiles where id = p_actor_id and role = 'hod') then
    raise exception 'only the head of department can message students';
  end if;

  if length(btrim(coalesce(p_subject, ''))) = 0 then
    raise exception 'a message must have a subject';
  end if;

  -- Ten characters, the same floor every other written justification in this
  -- system has. A message reaching four hundred phones that says "see me" is
  -- not a message, it is a summons nobody can act on.
  if length(btrim(coalesce(p_body, ''))) < 10 then
    raise exception 'a message must say something';
  end if;

  if p_scope = 'course' then
    select * into v_course from courses where id = p_target;
    if v_course.id is null then
      raise exception 'that course does not exist';
    end if;
  end if;

  insert into hod_messages (sent_by, scope, student_id, level, course_id, subject, body)
  values (
    p_actor_id,
    p_scope,
    case when p_scope = 'student' then p_target end,
    case when p_scope = 'level' then p_level end,
    case when p_scope = 'course' then p_target end,
    btrim(p_subject),
    btrim(p_body)
  )
  returning id into v_id;

  -- The audience, from the registration data — which is exactly what the doc
  -- says it is for. A course group is "everyone CURRENTLY registered", so a
  -- student who dropped it last week is not on it: they left, and a message
  -- about a course they left is the system not having noticed.
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
      'level', case when p_scope = 'level' then p_level end,
      'course_code', case when p_scope = 'course' then v_course.code end,
      'recipients', v_count
    )
  );

  return query select v_id, v_count;
end;
$$;

revoke all on function send_hod_message(uuid, message_scope, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function send_hod_message(uuid, message_scope, uuid, integer, text, text)
  to service_role;

comment on function send_hod_message(uuid, message_scope, uuid, integer, text, text) is
  'One message, three audiences, drawn from the registration data. Routes through queue_notification() so it gets the same channels, fallback and delivery record as everything else.';

-- ---------------------------------------------------------------------------
-- How many a message would reach, before it is sent
-- ---------------------------------------------------------------------------

-- Shown on the confirmation. "Message 412 students" is a different decision
-- from "message 12 students", and the HOD should be making the one they think
-- they are making.
create or replace function hod_message_audience(
  p_scope  message_scope,
  p_target uuid,
  p_level  integer
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
    );
$$;

revoke all on function hod_message_audience(message_scope, uuid, integer) from public, anon;
grant execute on function hod_message_audience(message_scope, uuid, integer)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The HOD's payment compliance report (§7.2)
-- ---------------------------------------------------------------------------

-- Dues no longer decide whether attendance counts, which is precisely why the
-- HOD needs this as a report of its own: it used to be visible as a side
-- effect of the attendance screens, and now it is not visible anywhere unless
-- somebody goes looking.
--
-- A balance rather than a flag, because students pay in instalments and "has
-- not paid" is not the same fact as "owes ₦1,500".
create or replace function payment_compliance_report(
  p_academic_session_id uuid default null
)
returns table (
  level          integer,
  students       integer,
  paid_in_full   integer,
  part_paid      integer,
  nothing_paid   integer,
  outstanding_kobo double precision
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
  balances as (
    select
      s.level,
      dues_balance_kobo(s.id, target.session_id) as owed,
      dues_paid_kobo(s.id, target.session_id)    as paid
    from students s
    cross join target
    where s.status <> 'deactivated'
  )
  select
    level,
    count(*)::integer,
    count(*) filter (where owed = 0)::integer,
    -- Part paid is its own row because it is its own conversation. A student
    -- who has paid half is not a student who has not paid.
    count(*) filter (where owed > 0 and paid > 0)::integer,
    count(*) filter (where paid = 0)::integer,
    coalesce(sum(owed), 0)::double precision
  from balances
  group by level
  order by level;
$$;

revoke all on function payment_compliance_report(uuid) from public, anon;
grant execute on function payment_compliance_report(uuid) to authenticated, service_role;

comment on function payment_compliance_report(uuid) is
  'Dues by level, as a balance rather than a flag. Part paid is a row of its own — a student who has paid half is not a student who has not paid.';
